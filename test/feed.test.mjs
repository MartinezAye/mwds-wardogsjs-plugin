import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { loadPlugin, makePlugin, settle, startStub, steamId } from './harness.mjs';

const { mod } = await loadPlugin();

function kill(overrides = {}) {
  return {
    eventId: randomUUID(),
    feedMatchId: 'match-1',
    eventTime: 3317.77,
    map: 'Kavkazi',
    killerSteamId: steamId(1),
    killerName: 'Alpha',
    killerFaction: 'Lonestar',
    victimSteamId: steamId(2),
    victimName: 'Bravo',
    victimFaction: 'Valkyra',
    cause: 'Id.Item.AK74M',
    weapon: 'AK74M',
    distanceM: 7.05,
    headshot: true,
    suicide: false,
    teamKill: false,
    tags: ['Penetration'],
    catchUp: false,
    ...overrides
  };
}

function common(overrides = {}) {
  return {
    serverId: 1,
    eventId: randomUUID(),
    eventTime: 3318.5,
    matchId: 'match-1',
    mapName: 'Kavkazi',
    catchUp: false,
    ts: new Date(),
    ...overrides
  };
}

function emitGameBatch(server, { kills = [], joins = [], leaves = [], states = [], ends = [] }) {
  const ts = new Date();
  if (kills.length > 0) {
    server.emit('FEED_BATCH', { kills, instanceId: 'boot-uuid-1', serverName: 'ZSU Wardogs 1', skipped: 0, duplicates: 0, catchUp: false, ts });
  }
  for (const k of kills) server.emit('PLAYER_KILLED', { kill: k, ts });
  for (const event of joins) server.emit('FEED_PLAYER_JOINED', event);
  for (const event of leaves) server.emit('FEED_PLAYER_LEFT', event);
  for (const event of states) server.emit('FEED_MATCH_STATE', event);
  for (const event of ends) server.emit('FEED_MATCH_ENDED', event);
}

async function setup(t, options = { forwardFeed: true }) {
  const stub = await startStub();
  t.after(() => stub.close());
  const ctx = await makePlugin({ options: { endpoint: stub.url, sendSamples: false, ...options } });
  await ctx.plugin.mount();
  t.after(() => ctx.plugin.unmount());
  return { stub, ...ctx };
}

async function flush(plugin) {
  await settle();
  await plugin.pump();
}

test('one game batch becomes one envelope in the game shape with event ids kept', async (t) => {
  const { stub, plugin, server } = await setup(t);
  const k1 = kill({ eventTime: 100 });
  const k2 = kill({ eventTime: 104, killerSteamId: null, killerName: null, cause: null, distanceM: null, headshot: false, tags: ['Falling'] });
  const join = common({ eventTime: 102, playerName: 'Charlie', playerId: '-0000-000000000000', playerSteamId: steamId(3), players: 42 });
  const state = common({ eventTime: 101, state: 'MatchState.Playing.KOTH' });
  const end = common({
    eventTime: 105,
    players: 98,
    winningFaction: 'Lonestar',
    winner: 'Lonestar',
    factionScores: [{ faction: 'Lonestar', score: 100 }, { faction: 'Valkyra', score: 0 }]
  });
  emitGameBatch(server, { kills: [k1, k2], joins: [join], states: [state], ends: [end] });
  await flush(plugin);

  assert.equal(stub.requests.length, 1);
  const [request] = stub.requests;
  assert.equal(request.url, '/v1/ingest');
  assert.equal(request.body.serverId, 'boot-uuid-1');
  assert.equal(request.body.serverName, 'ZSU Wardogs 1');
  assert.deepEqual(Object.keys(request.body), ['serverId', 'serverName', 'events']);
  assert.deepEqual(
    request.body.events.map((event) => event.eventId),
    [k1.eventId, state.eventId, join.eventId, k2.eventId, end.eventId]
  );
  assert.deepEqual(request.body.events[0], {
    eventId: k1.eventId,
    type: 'killed',
    eventTime: 100,
    matchId: 'match-1',
    mapName: 'Kavkazi',
    killerName: 'Alpha',
    killerSteamId: steamId(1),
    victimName: 'Bravo',
    victimSteamId: steamId(2),
    cause: 'Id.Item.AK74M',
    distance: 705,
    contextTags: [
      'Meta.Progression.Context.Player.KillContext.Headshot',
      'Meta.Progression.Context.Player.KillContext.Penetration'
    ]
  });
  assert.deepEqual(request.body.events[3], {
    eventId: k2.eventId,
    type: 'killed',
    eventTime: 104,
    matchId: 'match-1',
    mapName: 'Kavkazi',
    victimName: 'Bravo',
    victimSteamId: steamId(2),
    contextTags: ['Meta.Progression.Context.Player.KillContext.Falling']
  });
  assert.deepEqual(request.body.events[2], {
    eventId: join.eventId,
    type: 'player_joined',
    eventTime: 102,
    matchId: 'match-1',
    mapName: 'Kavkazi',
    playerName: 'Charlie',
    playerId: '-0000-000000000000',
    playerSteamId: steamId(3),
    players: 42
  });
  assert.deepEqual(request.body.events[1], {
    eventId: state.eventId,
    type: 'match_state',
    eventTime: 101,
    matchId: 'match-1',
    mapName: 'Kavkazi',
    state: 'MatchState.Playing.KOTH'
  });
  assert.deepEqual(request.body.events[4], {
    eventId: end.eventId,
    type: 'match_ended',
    eventTime: 105,
    matchId: 'match-1',
    mapName: 'Kavkazi',
    players: 98,
    winningFaction: 'Lonestar',
    factionScores: [{ faction: 'Lonestar', score: 100 }, { faction: 'Valkyra', score: 0 }]
  });
});

test('a batch with no kills reuses the last boot id and the server name', async (t) => {
  const { stub, plugin, server } = await setup(t);
  emitGameBatch(server, { kills: [kill()] });
  await flush(plugin);
  const pre = common({ eventTime: null, matchId: null, state: 'MatchState.PreMatch' });
  emitGameBatch(server, { states: [pre] });
  await flush(plugin);
  assert.equal(stub.requests.length, 2);
  assert.equal(stub.requests[1].body.serverId, 'boot-uuid-1');
  assert.deepEqual(stub.requests[1].body.events, [{ eventId: pre.eventId, type: 'match_state', mapName: 'Kavkazi', state: 'MatchState.PreMatch' }]);
});

test('an event id is forwarded once', async (t) => {
  const { stub, plugin, server } = await setup(t);
  const k = kill();
  emitGameBatch(server, { kills: [k] });
  await flush(plugin);
  emitGameBatch(server, { kills: [k, kill()] });
  await flush(plugin);
  assert.equal(stub.requests.length, 2);
  assert.equal(stub.requests[1].body.events.length, 1);
  assert.notEqual(stub.requests[1].body.events[0].eventId, k.eventId);
  assert.equal(plugin.client.stats.feedDuplicates, 1);
});

test('a large replay is split at 200 events per post', async (t) => {
  const { stub, plugin, server } = await setup(t);
  const kills = Array.from({ length: 450 }, (_, n) => kill({ eventTime: n }));
  emitGameBatch(server, { kills });
  await flush(plugin);
  assert.deepEqual(stub.requests.map((request) => request.body.events.length), [200, 200, 50]);
  const ids = stub.requests.flatMap((request) => request.body.events.map((event) => event.eventId));
  assert.deepEqual(ids, kills.map((k) => k.eventId));
});

test('feed queue is bounded and counts dropped events', async (t) => {
  const { stub, plugin, server } = await setup(t);
  stub.setFallback({ status: 503, headers: { 'retry-after': '600' }, body: { error: { code: 'overloaded' } } });
  for (let i = 0; i < mod.LIMITS.feedQueueMaxEnvelopes + 5; i += 1) {
    emitGameBatch(server, { kills: [kill()] });
    await settle();
  }
  await plugin.pump();
  assert.equal(plugin.client.feed.length, mod.LIMITS.feedQueueMaxEnvelopes);
  assert.equal(plugin.client.stats.feedEventsDropped, 5);
});

test('feed failures share the sample backoff', async (t) => {
  const { stub, plugin, server } = await setup(t);
  stub.reply({ status: 401, body: { error: { code: 'unauthorized' } } });
  emitGameBatch(server, { kills: [kill()] });
  await flush(plugin);
  assert.equal(plugin.client.state, 'unauthorized');
  plugin.client.enqueueSample({ at: 'x', players: [] });
  emitGameBatch(server, { kills: [kill()] });
  await flush(plugin);
  assert.equal(stub.requests.length, 1);
  assert.equal(plugin.client.feed.length, 2);
});

test('forwardFeed off listens to nothing', async (t) => {
  const { stub, plugin, server } = await setup(t, { forwardFeed: false });
  emitGameBatch(server, { kills: [kill()] });
  await flush(plugin);
  assert.equal(server.listenerCount('FEED_BATCH'), 0);
  assert.equal(stub.requests.length, 0);
});
