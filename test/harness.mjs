import EventEmitter from 'node:events';
import { createServer } from 'node:http';
import { cpSync, mkdirSync, mkdtempSync, copyFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..');
export const TOKEN = 'mwds_test_token_5f3c9a1b7e2d4c6a8b0f';

let loaded = null;

export async function loadPlugin() {
  if (loaded) return loaded;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mwds-plugin-'));
  cpSync(path.join(here, 'fixtures', 'wardogsjs', 'src'), path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), '{ "type": "module" }\n');
  mkdirSync(path.join(dir, 'plugins'));
  const pluginPath = path.join(dir, 'plugins', 'mywardogsstats.js');
  copyFileSync(path.join(repoRoot, 'mywardogsstats.js'), pluginPath);
  const base = await import(pathToFileURL(path.join(dir, 'src', 'plugins', 'base-plugin.js')).href);
  const mod = await import(pathToFileURL(pluginPath).href);
  loaded = { mod, logLines: base.logLines, dir, pluginPath };
  return loaded;
}

export function steamId(n) {
  return `7656119${String(8000000000 + n).padStart(10, '0')}`;
}

export function makeStatus(overrides = {}) {
  return {
    serverName: 'ZSU Wardogs 1',
    map: 'Kavkazi',
    experiences: ['Conquest'],
    players: { current: 2, max: 98 },
    factionScores: [
      { name: 'Lonestar', colorHex: '#1F6FEB', score: 120 },
      { name: 'Valkyra', colorHex: '#DA3633', score: 80 },
      { name: 'White', colorHex: '#FFFFFF', score: 0 }
    ],
    ...overrides
  };
}

export function makePlayer(n, overrides = {}) {
  return {
    steamId: steamId(n),
    name: `Player ${n}`,
    faction: n % 2 === 0 ? 'Lonestar' : 'Valkyra',
    factionColorHex: n % 2 === 0 ? '#1F6FEB' : '#DA3633',
    kills: 3,
    deaths: 1,
    cash: 1200,
    pingMs: 40,
    firstSeen: new Date(),
    lastSeen: new Date(),
    ...overrides
  };
}

export function makeServer(overrides = {}) {
  const server = new EventEmitter();
  server.setMaxListeners(64);
  server.id = 1;
  server.name = 'ZSU Wardogs 1';
  server.env = { MWDS_FEED_TOKEN: TOKEN };
  server.connected = true;
  server.status = makeStatus();
  server.players = [makePlayer(1), makePlayer(2)];
  server.feed = { listening: true };
  return Object.assign(server, overrides);
}

export function makeClock(start = Date.parse('2026-10-25T12:00:00Z')) {
  const clock = { t: start };
  clock.now = () => clock.t;
  clock.advance = (ms) => {
    clock.t += ms;
    return clock.t;
  };
  return clock;
}

export async function startStub() {
  const requests = [];
  const queue = [];
  let fallback = { status: 200, body: { ok: true } };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      const reply = queue.length > 0 ? queue.shift() : fallback;
      res.writeHead(reply.status, { 'content-type': 'application/json', ...(reply.headers ?? {}) });
      res.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    reply(...replies) {
      queue.push(...replies);
    },
    setFallback(reply) {
      fallback = reply;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      })
  };
}

export async function makePlugin({ server = makeServer(), options = {}, clock = makeClock(), random = () => 1 } = {}) {
  const { mod } = await loadPlugin();
  const plugin = new mod.default(server, { autoUpdate: false, ...options }, {});
  plugin.now = clock.now;
  plugin.random = random;
  await plugin.prepareToMount();
  return { plugin, server, clock, mod };
}

export function settle() {
  return new Promise(setImmediate);
}
