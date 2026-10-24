import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadPlugin, repoRoot } from './harness.mjs';

const { mod } = await loadPlugin();
const { Updater, LIMITS } = mod;

const keys = generateKeyPairSync('ed25519');
const otherKeys = generateKeyPairSync('ed25519');
const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' });
const API = 'https://api.github.com/repos/MartinezAye/mwds-wardogsjs-plugin/releases/latest';
const RAW = 'https://raw.githubusercontent.com/MartinezAye/mwds-wardogsjs-plugin';
const ORIGINAL = "export const PLUGIN_VERSION = '0.1.0';\nexport default class Old {}\n";

function release(version) {
  return Buffer.from(`export const PLUGIN_VERSION = '${version}';\nexport default class New {}\n`);
}

function signature(bytes, privateKey = keys.privateKey) {
  return `${sign(null, bytes, privateKey).toString('base64')}\n`;
}

function respond(body, init = {}) {
  return () => new Response(body, init);
}

function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const route = routes[url];
    if (!route) return new Response('missing', { status: 404 });
    return route();
  };
  return { fetchImpl, calls };
}

function happyRoutes(tag = 'v0.2.0', bytes = release('0.2.0')) {
  return {
    [API]: respond(JSON.stringify({ tag_name: tag })),
    [`${RAW}/${tag}/mywardogsstats.js`]: respond(bytes),
    [`${RAW}/${tag}/mywardogsstats.js.sig`]: respond(signature(bytes))
  };
}

function makeUpdater(routes, overrides = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mwds-update-'));
  const targetPath = path.join(dir, 'mywardogsstats.js');
  writeFileSync(targetPath, ORIGINAL);
  const logs = [];
  const { fetchImpl, calls } = fakeFetch(routes);
  const updater = new Updater({
    currentVersion: '0.1.0',
    targetPath,
    publicKeyPem,
    fetchImpl,
    log: (line) => logs.push(line),
    ...overrides
  });
  return { updater, targetPath, dir, logs, calls };
}

function assertUntouched(ctx) {
  assert.equal(readFileSync(ctx.targetPath, 'utf8'), ORIGINAL);
  assert.deepEqual(readdirSync(ctx.dir), ['mywardogsstats.js']);
}

test('a valid signed release is written atomically and asks for a restart', async () => {
  const bytes = release('0.2.0');
  const ctx = makeUpdater(happyRoutes('v0.2.0', bytes));
  const result = await ctx.updater.check();
  assert.deepEqual(result, { status: 'updated', tag: 'v0.2.0' });
  assert.deepEqual(readFileSync(ctx.targetPath), bytes);
  assert.deepEqual(readdirSync(ctx.dir), ['mywardogsstats.js']);
  assert.match(ctx.logs.at(-1), /v0\.2\.0 downloaded and verified, restart WardogsJS to apply/);
  assert.equal(ctx.calls[0].init.redirect, 'error');
  assert.equal(ctx.calls[1].init.redirect, 'manual');
  const again = await ctx.updater.check();
  assert.deepEqual(again, { status: 'pending_restart', version: 'v0.2.0' });
  assert.equal(ctx.calls.length, 3);
});

test('a same-host redirect on raw.githubusercontent.com is followed', async () => {
  const bytes = release('0.2.0');
  const routes = happyRoutes('v0.2.0', bytes);
  const moved = `${RAW}/moved/mywardogsstats.js`;
  routes[moved] = routes[`${RAW}/v0.2.0/mywardogsstats.js`];
  routes[`${RAW}/v0.2.0/mywardogsstats.js`] = respond(null, { status: 302, headers: { location: moved } });
  const ctx = makeUpdater(routes);
  assert.equal((await ctx.updater.check()).status, 'updated');
});

test('the placeholder key turns auto update off', async () => {
  const ctx = makeUpdater(happyRoutes(), { publicKeyPem: 'REPLACE_WITH_RELEASE_PUBLIC_KEY' });
  assert.deepEqual(await ctx.updater.check(), { status: 'no_key' });
  assert.equal(ctx.calls.length, 0);
  assertUntouched(ctx);
});

test('the shipped key is the placeholder or an ed25519 public key, never a private key', () => {
  const pem = mod.RELEASE_PUBLIC_KEY_PEM;
  assert.ok(!pem.includes('PRIVATE'));
  if (pem === 'REPLACE_WITH_RELEASE_PUBLIC_KEY') return;
  assert.equal(createPublicKey(pem).asymmetricKeyType, 'ed25519');
});

test('the current version is not downloaded', async () => {
  const ctx = makeUpdater(happyRoutes('v0.1.0', release('0.1.0')));
  assert.deepEqual(await ctx.updater.check(), { status: 'current', tag: 'v0.1.0' });
  assert.equal(ctx.calls.length, 1);
  assertUntouched(ctx);
});

const rejections = [
  {
    name: 'downgrade',
    reason: 'downgrade',
    routes: () => happyRoutes('v0.0.9', release('0.0.9'))
  },
  { name: 'prerelease tag', reason: 'bad_tag', routes: () => happyRoutes('v0.2.0-beta.1') },
  { name: 'leading zero tag', reason: 'bad_tag', routes: () => happyRoutes('v0.02.0') },
  { name: 'two part tag', reason: 'bad_tag', routes: () => happyRoutes('v0.2') },
  { name: 'path in tag', reason: 'bad_tag', routes: () => happyRoutes('../../x/0.2.0') },
  { name: 'non string tag', reason: 'bad_tag', routes: () => ({ [API]: respond(JSON.stringify({ tag_name: 7 })) }) },
  {
    name: 'missing signature',
    reason: 'download_failed',
    routes: () => {
      const routes = happyRoutes();
      delete routes[`${RAW}/v0.2.0/mywardogsstats.js.sig`];
      return routes;
    }
  },
  {
    name: 'malformed signature',
    reason: 'bad_signature',
    routes: () => ({ ...happyRoutes(), [`${RAW}/v0.2.0/mywardogsstats.js.sig`]: respond('not a signature') })
  },
  {
    name: 'signature from another key',
    reason: 'bad_signature',
    routes: () => ({
      ...happyRoutes(),
      [`${RAW}/v0.2.0/mywardogsstats.js.sig`]: respond(signature(release('0.2.0'), otherKeys.privateKey))
    })
  },
  {
    name: 'tampered file',
    reason: 'bad_signature',
    routes: () => {
      const routes = happyRoutes();
      routes[`${RAW}/v0.2.0/mywardogsstats.js`] = respond(Buffer.concat([release('0.2.0'), Buffer.from('evil();\n')]));
      return routes;
    }
  },
  {
    name: 'signed old file under a new tag',
    reason: 'version_mismatch',
    routes: () => happyRoutes('v0.2.0', release('0.1.5'))
  },
  {
    name: 'file over 512 KB by content-length',
    reason: 'too_large',
    routes: () => {
      const routes = happyRoutes();
      const big = Buffer.alloc(LIMITS.updateFileBytes + 1, 0x20);
      routes[`${RAW}/v0.2.0/mywardogsstats.js`] = respond(big, { headers: { 'content-length': String(big.length) } });
      return routes;
    }
  },
  {
    name: 'file over 512 KB streamed without content-length',
    reason: 'too_large',
    routes: () => {
      const routes = happyRoutes();
      routes[`${RAW}/v0.2.0/mywardogsstats.js`] = () => {
        let sent = 0;
        const stream = new ReadableStream({
          pull(controller) {
            if (sent > LIMITS.updateFileBytes) return controller.close();
            sent += 65536;
            controller.enqueue(new Uint8Array(65536));
          }
        });
        return new Response(stream);
      };
      return routes;
    }
  },
  {
    name: 'redirect off raw.githubusercontent.com',
    reason: 'off_host',
    routes: () => ({
      ...happyRoutes(),
      [`${RAW}/v0.2.0/mywardogsstats.js`]: respond(null, {
        status: 302,
        headers: { location: 'https://evil.example.com/mywardogsstats.js' }
      })
    })
  },
  {
    name: 'redirect to plain http',
    reason: 'not_https',
    routes: () => ({
      ...happyRoutes(),
      [`${RAW}/v0.2.0/mywardogsstats.js`]: respond(null, {
        status: 301,
        headers: { location: 'http://raw.githubusercontent.com/MartinezAye/mwds-wardogsjs-plugin/v0.2.0/mywardogsstats.js' }
      })
    })
  },
  {
    name: 'redirect loop',
    reason: 'too_many_redirects',
    routes: () => ({
      ...happyRoutes(),
      [`${RAW}/v0.2.0/mywardogsstats.js`]: respond(null, {
        status: 302,
        headers: { location: `${RAW}/v0.2.0/mywardogsstats.js` }
      })
    })
  },
  {
    name: 'release lookup failure',
    reason: 'release_lookup_failed',
    routes: () => ({ [API]: respond('{}', { status: 403 }) })
  }
];

for (const row of rejections) {
  test(`rejects: ${row.name}`, async () => {
    const ctx = makeUpdater(row.routes());
    const result = await ctx.updater.check();
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, row.reason);
    assertUntouched(ctx);
    assert.equal(ctx.logs.length, 1);
    ctx.updater.lastCheckAt = 0;
    await ctx.updater.check();
    assert.equal(ctx.logs.length, 1, 'a repeated rejection is logged once');
  });
}

test('rejects a non-https raw origin', async () => {
  const bytes = release('0.2.0');
  const ctx = makeUpdater(
    {
      [API]: respond(JSON.stringify({ tag_name: 'v0.2.0' })),
      [`http://raw.githubusercontent.com/MartinezAye/mwds-wardogsjs-plugin/v0.2.0/mywardogsstats.js`]: respond(bytes)
    },
    { rawOrigin: 'http://raw.githubusercontent.com' }
  );
  const result = await ctx.updater.check();
  assert.equal(result.reason, 'not_https');
  assert.equal(ctx.calls.length, 1);
  assertUntouched(ctx);
});

test('rejects a non-https or foreign release API origin', async () => {
  for (const [apiOrigin, reason] of [
    ['http://api.github.com', 'not_https'],
    ['https://api.github.com.evil.example', 'off_host']
  ]) {
    const ctx = makeUpdater(happyRoutes(), { apiOrigin });
    const result = await ctx.updater.check();
    assert.equal(result.reason, reason);
    assert.equal(ctx.calls.length, 0);
  }
});

test('release scripts: sign-release output verifies in the updater, keys stay out of the repo', async () => {
  const keyDir = mkdtempSync(path.join(os.tmpdir(), 'mwds-keys-'));
  execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'gen-keypair.mjs'), keyDir], { encoding: 'utf8' });
  const scriptPublic = readFileSync(path.join(keyDir, 'mwds-release-public.pem'), 'utf8').trim();

  const workDir = mkdtempSync(path.join(os.tmpdir(), 'mwds-sign-'));
  const pluginPath = path.join(workDir, 'mywardogsstats.js');
  const source = readFileSync(path.join(repoRoot, 'mywardogsstats.js'), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/^export const PLUGIN_VERSION = '[^']+';$/m, "export const PLUGIN_VERSION = '999.0.0';")
    .replace(/export const RELEASE_PUBLIC_KEY_PEM = `[^`]+`;/, `export const RELEASE_PUBLIC_KEY_PEM = \`${scriptPublic}\`;`);
  writeFileSync(pluginPath, source);
  execFileSync(process.execPath, [
    path.join(repoRoot, 'scripts', 'sign-release.mjs'),
    pluginPath,
    path.join(keyDir, 'mwds-release-private.pem')
  ]);
  const bytes = readFileSync(pluginPath);
  const sig = readFileSync(`${pluginPath}.sig`, 'utf8');

  const ctx = makeUpdater(
    {
      [API]: respond(JSON.stringify({ tag_name: '999.0.0' })),
      [`${RAW}/999.0.0/mywardogsstats.js`]: respond(bytes),
      [`${RAW}/999.0.0/mywardogsstats.js.sig`]: respond(sig)
    },
    { publicKeyPem: scriptPublic }
  );
  assert.equal((await ctx.updater.check()).status, 'updated');

  assert.throws(() =>
    execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'gen-keypair.mjs'), path.join(repoRoot, 'keys')], {
      stdio: 'pipe'
    })
  );
  assert.throws(() =>
    execFileSync(process.execPath, [
      path.join(repoRoot, 'scripts', 'sign-release.mjs'),
      path.join(repoRoot, 'mywardogsstats.js'),
      path.join(keyDir, 'mwds-release-private.pem')
    ], { stdio: 'pipe' })
  );
});
