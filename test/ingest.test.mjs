import test from 'node:test';
import assert from 'node:assert/strict';

import { TOKEN, loadPlugin, makeClock, makePlugin, makeServer, startStub } from './harness.mjs';

const { mod, logLines } = await loadPlugin();
const { LIMITS } = mod;

async function setup(t, options = {}) {
  const stub = await startStub();
  t.after(() => stub.close());
  const clock = makeClock();
  const { plugin, server } = await makePlugin({ clock, options: { endpoint: stub.url, ...options } });
  return { stub, clock, plugin, server, client: plugin.client };
}

function queueSamples(client, clock, count, stepMs = 10_000) {
  for (let i = 0; i < count; i += 1) {
    client.enqueueSample({ at: new Date(clock.now()).toISOString(), players: [] });
    clock.advance(stepMs);
  }
}

test('samples batch for 30 s before a post', async (t) => {
  const { stub, clock, client } = await setup(t);
  client.enqueueSample({ at: 'a', players: [] });
  await client.pump();
  clock.advance(10_000);
  client.enqueueSample({ at: 'b', players: [] });
  await client.pump();
  clock.advance(10_000);
  client.enqueueSample({ at: 'c', players: [] });
  await client.pump();
  assert.equal(stub.requests.length, 0);
  clock.advance(10_000);
  await client.pump();
  assert.equal(stub.requests.length, 1);
  const [request] = stub.requests;
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/v1/ingest/samples');
  assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(request.headers['content-type'], 'application/json');
  assert.deepEqual(request.body, {
    source: 'wardogsjs',
    agent: { name: 'mwds-wardogsjs-plugin', version: mod.PLUGIN_VERSION },
    samples: [
      { at: 'a', players: [] },
      { at: 'b', players: [] },
      { at: 'c', players: [] }
    ]
  });
  assert.equal(client.samples.length, 0);
  assert.equal(client.stats.samplesPosted, 3);
});

test('at most 30 samples per post, a backlog drains in order', async (t) => {
  const { stub, clock, client } = await setup(t);
  stub.reply({ status: 503, headers: { 'retry-after': '120' }, body: { error: { code: 'overloaded' } } });
  queueSamples(client, clock, 4);
  await client.pump();
  assert.equal(stub.requests.length, 1);
  for (let i = 0; i < 70; i += 1) client.enqueueSample({ at: `n${i}`, players: [] });
  clock.advance(120_000);
  await client.pump();
  const sizes = stub.requests.slice(1).map((request) => request.body.samples.length);
  assert.deepEqual(sizes, [30, 30, 14]);
  assert.equal(client.samples.length, 0);
});

test('a large backlog splits so a body stays under the size cap', async (t) => {
  const { stub, client } = await setup(t);
  const big = { at: 'x', players: Array.from({ length: 128 }, (_, n) => ({ steamId: String(n), name: 'n'.repeat(400) })) };
  for (let i = 0; i < 30; i += 1) client.enqueueSample(big);
  await client.pump();
  assert.ok(stub.requests.length > 1);
  for (const request of stub.requests) {
    assert.ok(Buffer.byteLength(JSON.stringify(request.body)) <= LIMITS.maxBodyBytes);
  }
  assert.equal(stub.requests.reduce((sum, request) => sum + request.body.samples.length, 0), 30);
});

test('buffer keeps 15 minutes of samples and counts what it drops', async (t) => {
  const { stub, clock, client } = await setup(t);
  stub.setFallback({ status: 401, body: { error: { code: 'unauthorized' } } });
  queueSamples(client, clock, 100);
  assert.equal(client.samples.length, LIMITS.bufferMaxSamples);
  assert.equal(client.droppedSamples, 10);
  clock.advance(LIMITS.bufferWindowMs);
  client.enqueueSample({ at: 'fresh', players: [] });
  assert.equal(client.samples.length, 1);
  assert.equal(client.droppedSamples, 100);
});

const authRows = [
  {
    name: '401 unauthorized',
    reply: { status: 401, body: { error: { code: 'unauthorized' } } },
    message: 'MyWardogsStats token rejected, check the token in the owner portal'
  },
  {
    name: '403 server_not_approved',
    reply: { status: 403, body: { error: { code: 'server_not_approved' } } },
    message: 'Server registered but not approved yet'
  },
  {
    name: '403 server_suspended',
    reply: { status: 403, body: { error: { code: 'server_suspended' } } },
    message: 'Server suspended by MyWardogsStats staff'
  },
  {
    name: '403 other code',
    reply: { status: 403, body: { error: { code: 'match_live', detail: 'secret detail' } } },
    message: 'MyWardogsStats refused this server (403 no code)'
  }
];

for (const row of authRows) {
  test(`${row.name}: log once, back off 10 minutes, keep samples`, async (t) => {
    const { stub, clock, client } = await setup(t);
    stub.setFallback(row.reply);
    const before = logLines.length;
    queueSamples(client, clock, 4);
    await client.pump();
    assert.equal(stub.requests.length, 1);
    assert.equal(client.blockedUntil, clock.now() + LIMITS.authBackoffMs);
    assert.equal(client.samples.length, 4);

    clock.advance(LIMITS.authBackoffMs - 1);
    await client.pump();
    assert.equal(stub.requests.length, 1);
    clock.advance(1);
    await client.pump();
    assert.equal(stub.requests.length, 2);

    const lines = logLines.slice(before);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].endsWith(row.message), lines[0]);
    assert.ok(!lines[0].includes('secret detail'));

    stub.setFallback({ status: 200, body: { ok: true } });
    clock.advance(LIMITS.authBackoffMs);
    queueSamples(client, clock, 4);
    await client.pump();
    assert.equal(client.samples.length, 0);
    assert.ok(logLines.at(-1).endsWith('Posting to MyWardogsStats'));
  });
}

for (const [status, code, label] of [
  [429, 'rate_limited', 'rate limited the plugin'],
  [503, 'overloaded', 'is busy']
]) {
  test(`${status} ${code}: honours retry-after in seconds and as a date`, async (t) => {
    const { stub, clock, client } = await setup(t);
    stub.reply({ status, headers: { 'retry-after': '42' }, body: { error: { code } } });
    const before = logLines.length;
    queueSamples(client, clock, 4);
    await client.pump();
    assert.equal(client.blockedUntil, clock.now() + 42_000);

    clock.advance(42_000);
    const date = new Date(clock.now() + 90_000).toUTCString();
    stub.reply({ status, headers: { 'retry-after': date }, body: { error: { code } } });
    await client.pump();
    assert.ok(Math.abs(client.blockedUntil - (clock.now() + 90_000)) <= 1000);

    const lines = logLines.slice(before);
    assert.equal(lines.length, 1);
    assert.match(lines[0], new RegExp(`${label}, retrying after 42s`));

    clock.advance(91_000);
    await client.pump();
    assert.equal(client.samples.length, 0);
  });
}

test('429 without retry-after falls back to exponential backoff', async (t) => {
  const { stub, clock, client } = await setup(t);
  stub.reply({ status: 429, body: { error: { code: 'rate_limited' } } });
  queueSamples(client, clock, 4);
  await client.pump();
  assert.equal(client.blockedUntil - clock.now(), LIMITS.backoffBaseMs);
});

test('retry-after is clamped to 15 minutes', async (t) => {
  const { stub, clock, client } = await setup(t);
  stub.reply({ status: 429, headers: { 'retry-after': '999999' }, body: { error: { code: 'rate_limited' } } });
  queueSamples(client, clock, 4);
  await client.pump();
  assert.equal(client.blockedUntil - clock.now(), LIMITS.retryAfterMaxMs);
});

test('other failures back off exponentially up to 5 minutes, logged once', async (t) => {
  const { stub, clock, client } = await setup(t);
  stub.setFallback({ status: 500, body: { error: { code: 'internal' } } });
  const before = logLines.length;
  queueSamples(client, clock, 4);
  const delays = [];
  for (let i = 0; i < 9; i += 1) {
    client.enqueueSample({ at: `r${i}`, players: [] });
    await client.pump();
    delays.push(client.blockedUntil - clock.now());
    clock.advance(client.blockedUntil - clock.now());
  }
  assert.deepEqual(delays, [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);
  const lines = logLines.slice(before);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /unreachable \(HTTP 500\), backing off/);
});

test('jitter only shortens the backoff', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  const clock = makeClock();
  const { plugin } = await makePlugin({ clock, random: () => 0, options: { endpoint: stub.url } });
  stub.setFallback({ status: 500 });
  queueSamples(plugin.client, clock, 4);
  await plugin.client.pump();
  assert.equal(plugin.client.blockedUntil - clock.now(), 4_000);
});

test('network failure backs off and keeps samples', async (t) => {
  const stub = await startStub();
  const url = stub.url;
  await stub.close();
  const clock = makeClock();
  const { plugin } = await makePlugin({ clock, options: { endpoint: url } });
  const before = logLines.length;
  queueSamples(plugin.client, clock, 4);
  await plugin.client.pump();
  assert.equal(plugin.client.samples.length, 4);
  assert.equal(plugin.client.blockedUntil - clock.now(), LIMITS.backoffBaseMs);
  assert.match(logLines.slice(before).join('\n'), /unreachable \(ECONNREFUSED\)/);
});

test('400 drops the batch so it cannot block the queue', async (t) => {
  const { stub, clock, client } = await setup(t);
  stub.reply({ status: 400, body: { error: { code: 'invalid_request' } } });
  const before = logLines.length;
  queueSamples(client, clock, 4);
  await client.pump();
  assert.equal(client.samples.length, 0);
  assert.equal(client.droppedSamples, 4);
  assert.match(logLines.slice(before)[0], /rejected a batch \(400 invalid_request\)/);
});

test('a redirect is a failure, never followed', async (t) => {
  const { stub, clock, client } = await setup(t);
  stub.reply({ status: 307, headers: { location: 'https://elsewhere.example.com/v1/ingest/samples' } });
  queueSamples(client, clock, 4);
  await client.pump();
  assert.equal(stub.requests.length, 1);
  assert.equal(client.samples.length, 4);
  assert.ok(client.blockedUntil > clock.now());
});

test('latestPluginVersion in the samples response triggers an update check', async (t) => {
  const { stub, clock, plugin, client } = await setup(t);
  const checks = [];
  plugin.options.autoUpdate = true;
  plugin.updater = { lastCheckAt: 0, inFlight: null, check: async () => checks.push('check') };
  stub.reply({ status: 200, body: { ok: true, latestPluginVersion: '9.9.9' } });
  queueSamples(client, clock, 4);
  await client.pump();
  assert.deepEqual(checks, ['check']);
  stub.reply({ status: 200, body: { ok: true, latestPluginVersion: mod.PLUGIN_VERSION } });
  queueSamples(client, clock, 4);
  await client.pump();
  assert.deepEqual(checks, ['check']);
});

test('the token never reaches a log line', async (t) => {
  const { stub, clock, client } = await setup(t);
  const before = logLines.length;
  const replies = [
    { status: 401, body: { error: { code: 'unauthorized' }, echo: TOKEN } },
    { status: 403, body: { error: { code: 'server_not_approved' }, echo: TOKEN } },
    { status: 403, body: { error: { code: TOKEN } } },
    { status: 429, headers: { 'retry-after': '5' }, body: { echo: TOKEN } },
    { status: 503, body: { echo: TOKEN } },
    { status: 500, body: { echo: TOKEN } },
    { status: 400, body: { error: { code: TOKEN } } }
  ];
  for (const reply of replies) {
    stub.reply(reply);
    queueSamples(client, clock, 4);
    await client.pump();
    clock.advance(LIMITS.authBackoffMs);
  }
  client.log(`direct ${TOKEN}`);
  const lines = logLines.slice(before);
  assert.ok(lines.length >= replies.length);
  for (const line of lines) assert.ok(!line.includes(TOKEN), line);
});

test('one token per server instance', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  const otherToken = 'mwds_other_token_aa11bb22cc33dd44';
  const server = makeServer({ id: 2, env: { MWDS_FEED_TOKEN_2: otherToken } });
  const { plugin, clock } = await makePlugin({ server, options: { endpoint: stub.url, feedTokenEnv: 'MWDS_FEED_TOKEN_2' } });
  queueSamples(plugin.client, clock, 4);
  await plugin.client.pump();
  assert.equal(stub.requests[0].headers.authorization, `Bearer ${otherToken}`);
});
