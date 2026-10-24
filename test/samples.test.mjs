import test from 'node:test';
import assert from 'node:assert/strict';

import { loadPlugin, makeClock, makePlayer, makePlugin, makeServer, makeStatus, steamId } from './harness.mjs';

const { mod } = await loadPlugin();

test('option spec follows WardogsJS conventions', () => {
  const Plugin = mod.default;
  assert.equal(Plugin.name, 'MyWardogsStats');
  assert.equal(Plugin.defaultEnabled, false);
  assert.equal(typeof Plugin.description, 'string');
  const spec = Plugin.optionsSpecification;
  assert.deepEqual(Object.keys(spec), ['endpoint', 'feedTokenEnv', 'sendSamples', 'forwardFeed', 'autoUpdate']);
  assert.equal(spec.endpoint.default, 'https://api.mywardogsstats.com');
  assert.equal(spec.feedTokenEnv.perServer, true);
  assert.equal(spec.sendSamples.default, true);
  assert.equal(spec.forwardFeed.default, false);
  assert.equal(spec.autoUpdate.default, true);
  assert.equal(spec.endpoint.validate('https://api.mywardogsstats.com/'), 'https://api.mywardogsstats.com');
});

test('endpoint validation allows https and loopback http only', () => {
  const { validateEndpoint } = mod;
  assert.equal(validateEndpoint('http://127.0.0.1:4000'), 'http://127.0.0.1:4000');
  assert.equal(validateEndpoint('http://localhost:4000/'), 'http://localhost:4000');
  assert.equal(validateEndpoint('https://ingest.example.com/base/'), 'https://ingest.example.com/base');
  for (const bad of [
    'http://api.mywardogsstats.com',
    'http://127.0.0.2',
    'ftp://example.com',
    'https://user:pass@example.com',
    'https://example.com/?x=1',
    'not a url',
    '',
    42
  ]) {
    assert.throws(() => validateEndpoint(bad), `${bad} should be refused`);
  }
});

test('sample carries the PLAN 7.2 fields and nothing else', () => {
  const at = new Date('2026-10-25T12:00:00Z');
  const sample = mod.buildSample(makeStatus(), [makePlayer(1), makePlayer(2)], at);
  assert.deepEqual(Object.keys(sample), ['at', 'serverName', 'map', 'playersMax', 'factionScores', 'players']);
  assert.equal(sample.at, '2026-10-25T12:00:00.000Z');
  assert.equal(sample.serverName, 'ZSU Wardogs 1');
  assert.equal(sample.map, 'Kavkazi');
  assert.equal(sample.playersMax, 98);
  assert.deepEqual(sample.factionScores[0], { name: 'Lonestar', colorHex: '#1F6FEB', score: 120 });
  assert.deepEqual(sample.players[0], {
    steamId: steamId(1),
    name: 'Player 1',
    faction: 'Valkyra',
    kills: 3,
    deaths: 1,
    cash: 1200,
    pingMs: 40
  });
});

test('faction is null for missing and unassigned players', () => {
  const status = makeStatus();
  const players = [
    makePlayer(1, { faction: null, factionColorHex: null }),
    makePlayer(2, { faction: '', factionColorHex: null }),
    makePlayer(3, { faction: 'NONE', factionColorHex: null }),
    makePlayer(4, { faction: 'White', factionColorHex: '#FFFFFF' }),
    makePlayer(5, { faction: 'Spectators', factionColorHex: '#ffffff' }),
    makePlayer(6, { faction: 'Ghosts', factionColorHex: undefined }),
    makePlayer(7, { faction: 'Lonestar', factionColorHex: undefined })
  ];
  const sample = mod.buildSample({ ...status, factionScores: [...status.factionScores, { name: 'Ghosts', colorHex: 'FFFFFF', score: 0 }] }, players);
  assert.deepEqual(
    sample.players.map((player) => player.faction),
    [null, null, null, null, null, null, 'Lonestar']
  );
});

test('players are capped at 128, invalid and repeated steam ids are skipped', () => {
  const players = [makePlayer(0, { steamId: '123' }), makePlayer(1), makePlayer(1)];
  for (let n = 2; n < 200; n += 1) players.push(makePlayer(n));
  const sample = mod.buildSample(makeStatus(), players);
  assert.equal(sample.players.length, 128);
  assert.equal(sample.players[0].steamId, steamId(1));
  assert.equal(new Set(sample.players.map((player) => player.steamId)).size, 128);
});

test('names are cut to 64 code points and numbers are rounded', () => {
  const sample = mod.buildSample(makeStatus({ serverName: 'S'.repeat(300) }), [
    makePlayer(1, { name: 'x'.repeat(100), kills: '7', pingMs: 41.6, cash: Number.NaN })
  ]);
  assert.equal(sample.serverName.length, 128);
  assert.equal(sample.players[0].name.length, 64);
  assert.equal(sample.players[0].kills, 7);
  assert.equal(sample.players[0].pingMs, 42);
  assert.equal(sample.players[0].cash, null);
});

test('cadence: every 10 s with players on, every 60 s when empty', async () => {
  const clock = makeClock();
  const { plugin, server } = await makePlugin({ clock });
  plugin.lastStatusAt = clock.now();
  const taken = [];
  const tick = () => {
    plugin.lastStatusAt = clock.now();
    if (plugin.sampleTick()) taken.push(clock.now());
    clock.advance(10_000);
  };
  for (let i = 0; i < 6; i += 1) tick();
  assert.equal(taken.length, 6);

  server.players = [];
  server.status = makeStatus({ players: { current: 0, max: 98 } });
  taken.length = 0;
  for (let i = 0; i < 12; i += 1) tick();
  assert.equal(taken.length, 2);
  assert.equal(taken[1] - taken[0], 60_000);
});

test('no sample while disconnected, without status or with a stale status', async () => {
  const clock = makeClock();
  const { plugin, server } = await makePlugin({ clock });
  server.connected = false;
  plugin.lastStatusAt = clock.now();
  assert.equal(plugin.sampleTick(), null);
  server.connected = true;
  plugin.lastStatusAt = clock.now() - 61_000;
  assert.equal(plugin.sampleTick(), null);
  plugin.lastStatusAt = clock.now();
  server.status = null;
  assert.equal(plugin.sampleTick(), null);
  server.status = makeStatus();
  assert.ok(plugin.sampleTick());
});

test('missing or malformed token leaves the plugin inert without logging it', async () => {
  const { logLines } = await loadPlugin();
  const before = logLines.length;
  const missing = await makePlugin({ server: makeServer({ env: {} }) });
  assert.equal(missing.plugin.client, null);
  const malformed = await makePlugin({ server: makeServer({ env: { MWDS_FEED_TOKEN: 'short token' } }) });
  assert.equal(malformed.plugin.client, null);
  const lines = logLines.slice(before).join('\n');
  assert.match(lines, /No token in env \(MWDS_FEED_TOKEN\)/);
  assert.match(lines, /malformed/);
  assert.ok(!lines.includes('short token'));
});

test('mount and unmount leave no listeners or timers behind', async () => {
  const { plugin, server } = await makePlugin({ options: { forwardFeed: true } });
  await plugin.mount();
  assert.ok(server.listenerCount('FEED_BATCH') === 1);
  assert.ok(plugin.timers.length >= 2);
  await plugin.unmount();
  assert.equal(server.listenerCount('FEED_BATCH'), 0);
  assert.equal(server.listenerCount('STATUS_UPDATED'), 0);
  assert.equal(plugin.timers.length, 0);
});
