import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { TOKEN, loadPlugin, makeClock, makeDataRoot, makePlugin, makeServer, startStub, steamId } from './harness.mjs';

const { mod, logLines } = await loadPlugin();
const { LIMITS, Spool, openSpools, SPOOL_VERSION } = mod;
const HOUR = 3_600_000;

function sample(clock, n = 0) {
  return {
    at: new Date(clock.now() + n).toISOString(),
    serverName: 'ZSU Wardogs 1',
    map: 'Kavkazi',
    playersMax: 98,
    factionScores: [{ name: 'Lonestar', colorHex: '#1F6FEB', score: 1 }],
    players: [{ steamId: steamId(1), name: 'Alpha', faction: 'Lonestar', kills: 1, deaths: 0, cash: 10, pingMs: 30 }]
  };
}

function envelope(count = 1, serverId = 'boot-1') {
  return {
    serverId,
    serverName: 'ZSU Wardogs 1',
    events: Array.from({ length: count }, () => ({ eventId: randomUUID(), type: 'match_state', state: 'MatchState.Playing' }))
  };
}

function spoolAt(dir, clock, overrides = {}) {
  return new Spool({ dir, kind: 'samples', maxAgeMs: 24 * HOUR, now: clock.now, ...overrides }).load();
}

async function spooling(t, { clock = makeClock(), dataRoot = makeDataRoot(), server = makeServer(), stub } = {}) {
  const own = stub ?? (await startStub());
  if (!stub) t.after(() => own.close());
  const ctx = await makePlugin({ clock, dataRoot, server, options: { endpoint: own.url, spoolMaxHours: 24, forwardFeed: true } });
  return { ...ctx, stub: own, dataRoot, dir: ctx.plugin.spoolDir };
}

function queueLive(client, clock, count) {
  const ats = [];
  for (let i = 0; i < count; i += 1) {
    const item = sample(clock);
    ats.push(item.at);
    client.enqueueSample(item);
    clock.advance(10_000);
  }
  return ats;
}

async function drainAll(client, clock, rounds = 200) {
  for (let i = 0; i < rounds; i += 1) {
    await client.pump();
    clock.advance(LIMITS.replayIntervalMs);
  }
}

function postedAts(stub) {
  return stub.requests.filter((r) => r.url === '/v1/ingest/samples').flatMap((r) => r.body.samples.map((s) => s.at));
}

function postedEventIds(stub) {
  return stub.requests.filter((r) => r.url === '/v1/ingest').flatMap((r) => r.body.events.map((e) => e.eventId));
}

test('a retryable failure moves the batch to disk, and a restarted process replays it', async (t) => {
  const clock = makeClock();
  const dataRoot = makeDataRoot();
  const stub = await startStub();
  t.after(() => stub.close());
  stub.setFallback({ status: 503, headers: { 'retry-after': '60' }, body: { error: { code: 'overloaded' } } });

  const first = await spooling(t, { clock, dataRoot, stub });
  const ats = queueLive(first.plugin.client, clock, 4);
  await first.plugin.client.pump();
  assert.equal(first.plugin.client.samples.length, 0);
  assert.equal(first.plugin.client.spools.samples.length, 4);

  const env = envelope(3);
  first.plugin.client.enqueueFeed(env);
  ats.push(...queueLive(first.plugin.client, clock, 2));
  await first.plugin.unmount();
  assert.equal(first.plugin.client.spools.feed.length, 1);
  assert.equal(first.plugin.client.spools.samples.length, 6);

  stub.setFallback({ status: 200, body: { ok: true } });
  const second = await spooling(t, { clock, dataRoot, stub });
  assert.equal(second.plugin.client.spooled, 7);
  await drainAll(second.plugin.client, clock, 10);
  assert.deepEqual(postedAts(stub).filter((at) => ats.includes(at)).slice(-6), ats);
  assert.deepEqual(postedEventIds(stub), env.events.map((e) => e.eventId));
  assert.equal(second.plugin.client.spooled, 0);
  assert.equal(statSync(path.join(second.dir, 'samples.jsonl')).size, 0);

  const third = await spooling(t, { clock, dataRoot, stub });
  assert.equal(third.plugin.client.spooled, 0, 'a replayed line is not replayed again after another restart');
});

test('memory overflow spills to disk instead of dropping', async (t) => {
  const { plugin, stub, clock } = await spooling(t);
  stub.setFallback({ status: 500 });
  queueLive(plugin.client, clock, LIMITS.bufferMaxSamples + 20);
  assert.equal(plugin.client.droppedSamples, 0);
  assert.ok(plugin.client.spools.samples.length >= 20);
});

test('live data goes first, the queue drains behind it at one post per second', async (t) => {
  const { plugin, stub, clock } = await spooling(t);
  const client = plugin.client;
  const old = [];
  for (let i = 0; i < 70; i += 1) {
    const item = sample(clock, -HOUR + i * 10_000);
    old.push(item.at);
    client.spools.samples.append(item, Date.parse(item.at));
  }
  const env = envelope(2);
  client.spools.feed.append(env, clock.now());
  const live = queueLive(client, clock, 4);

  await client.pump();
  assert.equal(stub.requests.length, 2);
  assert.deepEqual(stub.requests[0].body.samples.map((s) => s.at), live);
  assert.equal(stub.requests[1].url, '/v1/ingest');

  await client.pump();
  clock.advance(LIMITS.replayIntervalMs - 1);
  await client.pump();
  assert.equal(stub.requests.length, 2, 'no second replay inside one second');

  clock.advance(1);
  await client.pump();
  assert.equal(stub.requests.length, 3);
  assert.deepEqual(stub.requests[2].body.samples.map((s) => s.at), old.slice(0, 30));

  stub.reply({ status: 429, headers: { 'retry-after': '30' }, body: { error: { code: 'rate_limited' } } });
  clock.advance(LIMITS.replayIntervalMs);
  await client.pump();
  assert.equal(stub.requests.length, 4);
  for (let i = 0; i < 29; i += 1) {
    clock.advance(1000);
    await client.pump();
  }
  assert.equal(stub.requests.length, 4, 'retry-after holds the replay');
  clock.advance(1000);
  await client.pump();
  clock.advance(1000);
  await client.pump();
  const replayed = postedAts(stub).filter((at) => old.includes(at));
  assert.deepEqual(replayed.slice(30, 60), replayed.slice(60, 90), 'the refused batch is resent as it was');
  assert.deepEqual([...new Set(replayed)], old);
  assert.equal(client.spools.samples.length, 0);
});

test('feed replay merges spooled batches of one boot up to 200 events and keeps ids', async (t) => {
  const { plugin, stub, clock } = await spooling(t);
  const spool = plugin.client.spools.feed;
  const batches = [envelope(150), envelope(40), envelope(20), envelope(5, 'boot-2')];
  for (const batch of batches) spool.append(batch, clock.now());
  await drainAll(plugin.client, clock, 5);
  const feedPosts = stub.requests.filter((r) => r.url === '/v1/ingest');
  assert.deepEqual(feedPosts.map((r) => [r.body.serverId, r.body.events.length]), [
    ['boot-1', 190],
    ['boot-1', 20],
    ['boot-2', 5]
  ]);
  assert.deepEqual(postedEventIds(stub), batches.flatMap((b) => b.events.map((e) => e.eventId)));
});

test('not approved: nothing is written to disk', async (t) => {
  const { plugin, stub, clock, dir } = await spooling(t);
  stub.setFallback({ status: 403, body: { error: { code: 'server_not_approved' } } });
  queueLive(plugin.client, clock, 4);
  await plugin.client.pump();
  queueLive(plugin.client, clock, 120);
  plugin.client.enqueueFeed(envelope(2));
  await plugin.unmount();
  assert.equal(plugin.client.spools.samples.length, 0);
  assert.equal(plugin.client.spools.feed.length, 0);
  assert.ok(!existsSync(path.join(dir, 'samples.jsonl')));
  assert.ok(!existsSync(path.join(dir, 'feed.jsonl')));
  assert.ok(plugin.client.droppedSamples > 0);
});

for (const [status, code] of [
  [401, 'unauthorized'],
  [403, 'server_suspended']
]) {
  test(`${status} ${code}: the queue is kept, new samples stay in the 15 minute memory window`, async (t) => {
    const { plugin, stub, clock } = await spooling(t);
    const kept = sample(clock, -60_000);
    plugin.client.spools.samples.append(kept, Date.parse(kept.at));
    stub.setFallback({ status, body: { error: { code } } });
    queueLive(plugin.client, clock, 4);
    await plugin.client.pump();
    queueLive(plugin.client, clock, 200);
    await plugin.unmount();
    assert.equal(plugin.client.spools.samples.length, 1);
    assert.deepEqual(plugin.client.spools.samples.peek(1)[0], kept);
    assert.ok(plugin.client.samples.length <= LIMITS.bufferMaxSamples);
  });
}

test('bounds: entries older than the age cap are dropped and counted', () => {
  const clock = makeClock();
  const dir = makeDataRoot();
  const spool = spoolAt(dir, clock, { maxAgeMs: 2 * HOUR });
  for (let i = 0; i < 5; i += 1) spool.append(sample(clock, -3 * HOUR), clock.now() - 3 * HOUR);
  assert.equal(spool.length, 0);
  assert.equal(spool.stats.dropped, 5);
  for (let i = 0; i < 5; i += 1) spool.append(sample(clock), clock.now());
  clock.advance(HOUR);
  spool.append(sample(clock), clock.now());
  assert.equal(spool.length, 6);
  clock.advance(HOUR + 1);
  spool.append(sample(clock), clock.now());
  assert.equal(spool.length, 2);
  assert.equal(spool.stats.dropped, 10);
  assert.equal(spoolAt(dir, clock, { maxAgeMs: 2 * HOUR }).length, 2);
});

test('bounds: the file stays under the size cap, oldest dropped first', () => {
  const clock = makeClock();
  const dir = makeDataRoot();
  const maxBytes = 8 * 1024;
  const spool = spoolAt(dir, clock, { maxBytes });
  const ats = [];
  for (let i = 0; i < 100; i += 1) {
    const item = sample(clock, i);
    ats.push(item.at);
    spool.append(item, clock.now());
    assert.ok(statSync(spool.file).size <= maxBytes);
  }
  assert.ok(spool.stats.dropped > 0);
  assert.equal(spool.length + spool.stats.dropped, 100);
  assert.deepEqual(spool.peek(spool.length).map((s) => s.at), ats.slice(-spool.length));
});

test('compaction rewrites the file once more than half is sent', () => {
  const clock = makeClock();
  const dir = makeDataRoot();
  const spool = spoolAt(dir, clock);
  const items = Array.from({ length: 10 }, (_, i) => sample(clock, i));
  for (const item of items) spool.append(item, clock.now());
  const full = statSync(spool.file).size;

  spool.ack(4);
  assert.equal(statSync(spool.file).size, full);
  assert.ok(spool.cursor > 0);
  assert.equal(JSON.parse(readFileSync(spool.cursorFile, 'utf8')).offset, spool.cursor);

  spool.ack(2);
  assert.equal(spool.cursor, 0);
  assert.ok(statSync(spool.file).size < full / 2);
  assert.equal(readFileSync(spool.file, 'utf8').trim().split('\n').length, 4);
  assert.deepEqual(spool.peek(4), items.slice(6));

  const reloaded = spoolAt(dir, clock);
  assert.deepEqual(reloaded.peek(10), items.slice(6));
});

test('a cursor that survived a crash mid-compaction only causes resends, never loss', () => {
  const clock = makeClock();
  const dir = makeDataRoot();
  const spool = spoolAt(dir, clock);
  const items = Array.from({ length: 4 }, (_, i) => sample(clock, i));
  for (const item of items) spool.append(item, clock.now());
  writeFileSync(spool.cursorFile, JSON.stringify({ v: SPOOL_VERSION, offset: 7 }));
  assert.deepEqual(spoolAt(dir, clock).peek(10), items);
});

test('corrupt lines are dropped on read, never evaluated', () => {
  const clock = makeClock();
  const dir = makeDataRoot();
  const good = sample(clock);
  const line = (d, extra = {}) => JSON.stringify({ v: SPOOL_VERSION, t: clock.now(), d, ...extra });
  globalThis.mwdsSpoolEvaluated = false;
  writeFileSync(
    path.join(dir, 'samples.jsonl'),
    [
      line(good),
      'not json at all',
      "require('node:child_process'); globalThis.mwdsSpoolEvaluated = true",
      line({ ...good, extra: 'field' }),
      line(good, { token: 'x' }),
      line({ ...good, players: [{ ...good.players[0], steamId: '123' }] }),
      JSON.stringify({ v: SPOOL_VERSION + 1, t: clock.now(), d: good }),
      line({ ...good, at: 'yesterday' }),
      '{"v":1,"t":1,"d":{"__proto__":{"polluted":true}}}',
      line(good),
      line(good).slice(0, 40)
    ].join('\n')
  );
  const spool = spoolAt(dir, clock);
  assert.equal(spool.length, 2);
  assert.equal(spool.stats.corrupt, 9);
  assert.equal(globalThis.mwdsSpoolEvaluated, false);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(spool.peek(2), [good, good]);
  assert.equal(readFileSync(spool.file, 'utf8').trim().split('\n').length, 2);
});

test('a line edited on disk after load is dropped at replay', async (t) => {
  const { plugin, stub, clock } = await spooling(t);
  const spool = plugin.client.spools.samples;
  spool.append(sample(clock, 1), clock.now());
  spool.append(sample(clock, 2), clock.now());
  const text = readFileSync(spool.file, 'utf8').split('\n');
  writeFileSync(spool.file, [text[0].replace('"v":1', '"v":9'), text[1], ''].join('\n'));
  await drainAll(plugin.client, clock, 2);
  assert.equal(postedAts(stub).length, 1);
  assert.equal(spool.length, 0);
  assert.equal(spool.stats.corrupt, 1);
});

test('the token is never written to disk and files are private', async (t) => {
  const { plugin, stub, clock, dir } = await spooling(t);
  stub.setFallback({ status: 503, headers: { 'retry-after': '5' }, body: { echo: TOKEN } });
  queueLive(plugin.client, clock, 40);
  await plugin.client.pump();
  plugin.client.enqueueFeed(envelope(3));
  await plugin.unmount();
  const files = readdirSync(dir);
  assert.ok(files.includes('samples.jsonl') && files.includes('feed.jsonl') && files.includes('spool.json'));
  for (const file of files) {
    const text = readFileSync(path.join(dir, file), 'utf8');
    assert.ok(!text.includes(TOKEN), file);
    assert.ok(!/bearer|authorization/i.test(text), file);
    if (process.platform !== 'win32') assert.equal(statSync(path.join(dir, file)).mode & 0o777, 0o600, file);
  }
  if (process.platform !== 'win32') assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test('a new spool format discards the old queue once', () => {
  const clock = makeClock();
  const dir = makeDataRoot();
  writeFileSync(path.join(dir, 'spool.json'), JSON.stringify({ spoolVersion: SPOOL_VERSION - 1 }));
  writeFileSync(path.join(dir, 'samples.jsonl'), `${JSON.stringify({ v: SPOOL_VERSION, t: clock.now(), d: sample(clock) })}\n`);
  const logs = [];
  const spools = openSpools({ dir, maxAgeMs: HOUR, now: clock.now, log: (line) => logs.push(line) });
  assert.equal(spools.samples.length, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /format changed, discarded the old queue/);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'spool.json'), 'utf8')).spoolVersion, SPOOL_VERSION);
  openSpools({ dir, maxAgeMs: HOUR, now: clock.now, log: (line) => logs.push(line) });
  assert.equal(logs.length, 1);
});

test('spoolMaxHours 0 turns the queue off and writes nothing', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  const dataRoot = makeDataRoot();
  const { plugin, clock } = await makePlugin({ dataRoot, options: { endpoint: stub.url, spoolMaxHours: 0 } });
  stub.setFallback({ status: 500 });
  queueLive(plugin.client, clock, 4);
  await plugin.client.pump();
  await plugin.unmount();
  assert.equal(plugin.client.spools, null);
  assert.ok(!existsSync(path.join(dataRoot, 'data')));
});

test('the queue lives under data/mywardogsstats/<server id> of the WardogsJS root', async (t) => {
  const { plugin, dataRoot } = await spooling(t, { server: makeServer({ id: 7 }) });
  assert.equal(plugin.spoolDir, path.join(dataRoot, 'data', 'mywardogsstats', '7'));
  assert.ok(existsSync(path.join(plugin.spoolDir, 'spool.json')));
  const before = logLines.length;
  const unsafe = await makePlugin({ server: makeServer({ id: '../x' }), options: { spoolMaxHours: 24 } });
  assert.equal(unsafe.plugin.client.spools, null);
  assert.match(logLines.slice(before).join('\n'), /not usable as a folder name/);
});
