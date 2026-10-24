import { createPublicKey, verify as verifyEd25519 } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import BasePlugin from '../src/plugins/base-plugin.js';

export const PLUGIN_VERSION = '0.1.0';
export const AGENT_NAME = 'mwds-wardogsjs-plugin';
export const RELEASE_OWNER = 'MartinezAye';
export const RELEASE_REPO = 'mwds-wardogsjs-plugin';
export const RELEASE_FILE = 'mywardogsstats.js';
export const RELEASE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAbs/b03Qw9LbQH4UYWrLGatPWRLRglxbq4dpWPBAvFDw=
-----END PUBLIC KEY-----`;
export const DEFAULT_ENDPOINT = 'https://api.mywardogsstats.com';
export const DEFAULT_TOKEN_ENV = 'MWDS_FEED_TOKEN';

export const LIMITS = Object.freeze({
  samplesPerPost: 30,
  playersPerSample: 128,
  factionsPerSample: 8,
  occupiedIntervalMs: 10_000,
  emptyIntervalMs: 60_000,
  tickSlackMs: 500,
  staleStatusMs: 60_000,
  batchWindowMs: 30_000,
  bufferWindowMs: 15 * 60_000,
  bufferMaxSamples: 90,
  pumpIntervalMs: 5_000,
  requestTimeoutMs: 10_000,
  authBackoffMs: 10 * 60_000,
  backoffBaseMs: 5_000,
  backoffMaxMs: 5 * 60_000,
  retryAfterMinMs: 1_000,
  retryAfterMaxMs: 15 * 60_000,
  maxBodyBytes: 448 * 1024,
  responseBytes: 64 * 1024,
  feedEventsPerPost: 200,
  feedQueueMaxEnvelopes: 450,
  feedDedupeIds: 5000,
  nameLength: 64,
  serverNameLength: 128,
  updateFileBytes: 512 * 1024,
  updateSigBytes: 1024,
  updateApiBytes: 256 * 1024,
  updateRedirects: 3,
  updateFirstCheckMs: 60_000,
  updateIntervalMs: 12 * 60 * 60_000,
  updateTriggerGapMs: 10 * 60_000
});

const STEAM_ID = /^7656119\d{10}$/;
const TOKEN_SHAPE = /^[\x21-\x7E]{16,512}$/;
const STRICT_SEMVER = /^v?(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const EMBEDDED_VERSION = /^export const PLUGIN_VERSION = '([^'\n]{1,40})';$/m;
const NO_TEAM_FACTIONS = new Set(['', 'NONE', 'WHITE']);
const NO_TEAM_COLORS = new Set(['#FFFFFF']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
const DROP_STATUSES = new Set([400, 413, 415, 422]);
const KNOWN_ERROR_CODES = new Set([
  'invalid_request',
  'unauthorized',
  'server_not_approved',
  'server_suspended',
  'not_found',
  'method_not_allowed',
  'payload_too_large',
  'unsupported_media_type',
  'rate_limited',
  'internal',
  'overloaded'
]);
const KILL_TAG_PREFIX = 'Meta.Progression.Context.Player.KillContext.';
const GITHUB_API_HOST = 'api.github.com';
const RAW_HOST = 'raw.githubusercontent.com';
const MASK = '***';

export function validateEndpoint(value) {
  if (typeof value !== 'string') throw new Error('endpoint must be a string.');
  const text = value.trim();
  if (text.length === 0 || text.length > 200) throw new Error('endpoint must be 1 to 200 characters.');
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('endpoint is not a valid URL.');
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('endpoint must use https, or http only on 127.0.0.1 or localhost.');
  }
  if (url.username || url.password) throw new Error('endpoint must not carry credentials.');
  if (url.search || url.hash) throw new Error('endpoint must not carry a query or a fragment.');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function isValidToken(token) {
  return typeof token === 'string' && TOKEN_SHAPE.test(token);
}

export function redact(text, secret) {
  const value = String(text ?? '');
  if (typeof secret !== 'string' || secret.length === 0) return value;
  return value.split(secret).join(MASK);
}

function cut(value, max) {
  if (typeof value !== 'string') return null;
  const points = Array.from(value);
  return points.length > max ? points.slice(0, max).join('') : value;
}

function intOrNull(value) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? Math.round(number) : null;
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function hexOf(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim().toUpperCase();
  return text.startsWith('#') ? text : `#${text}`;
}

function scoreRows(status) {
  return Array.isArray(status?.factionScores) ? status.factionScores : [];
}

export function factionOf(player, status) {
  const name = typeof player?.faction === 'string' ? player.faction.trim() : '';
  if (NO_TEAM_FACTIONS.has(name.toUpperCase())) return null;
  const row = scoreRows(status).find((entry) => entry?.name === player.faction);
  const color = player.factionColorHex ?? row?.colorHex ?? null;
  if (color !== null && NO_TEAM_COLORS.has(hexOf(color))) return null;
  return cut(name, LIMITS.nameLength);
}

export function buildSample(status, players, at = new Date()) {
  const factionScores = [];
  for (const row of scoreRows(status)) {
    if (factionScores.length >= LIMITS.factionsPerSample) break;
    const name = cut(row?.name, LIMITS.nameLength);
    if (!name) continue;
    factionScores.push({
      name,
      colorHex: cut(row?.colorHex, 16),
      score: finiteOrNull(row?.score)
    });
  }

  const sampled = [];
  const seen = new Set();
  for (const player of Array.isArray(players) ? players : []) {
    if (sampled.length >= LIMITS.playersPerSample) break;
    const steamId = typeof player?.steamId === 'string' ? player.steamId : '';
    if (!STEAM_ID.test(steamId) || seen.has(steamId)) continue;
    seen.add(steamId);
    sampled.push({
      steamId,
      name: cut(player.name, LIMITS.nameLength) ?? '',
      faction: factionOf(player, status),
      kills: intOrNull(player.kills),
      deaths: intOrNull(player.deaths),
      cash: intOrNull(player.cash),
      pingMs: intOrNull(player.pingMs)
    });
  }

  return {
    at: at.toISOString(),
    serverName: cut(status?.serverName, LIMITS.serverNameLength),
    map: cut(status?.map, LIMITS.nameLength),
    playersMax: intOrNull(status?.players?.max),
    factionScores,
    players: sampled
  };
}

export function buildSamplesBody(samples) {
  return {
    source: 'wardogsjs',
    agent: { name: AGENT_NAME, version: PLUGIN_VERSION },
    samples
  };
}

function dropNulls(record) {
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

export function killToRaw(kill) {
  const tags = [];
  if (kill?.headshot === true) tags.push(`${KILL_TAG_PREFIX}Headshot`);
  if (kill?.suicide === true) tags.push(`${KILL_TAG_PREFIX}Suicide`);
  for (const tag of Array.isArray(kill?.tags) ? kill.tags : []) {
    if (typeof tag === 'string' && tag.length > 0) tags.push(`${KILL_TAG_PREFIX}${tag}`);
  }
  const distanceM = finiteOrNull(kill?.distanceM);
  return dropNulls({
    eventId: kill?.eventId,
    type: 'killed',
    eventTime: finiteOrNull(kill?.eventTime),
    matchId: kill?.feedMatchId ?? null,
    mapName: kill?.map ?? null,
    killerName: kill?.killerSteamId ? kill?.killerName ?? null : null,
    killerSteamId: kill?.killerSteamId ?? null,
    victimName: kill?.victimName ?? null,
    victimSteamId: kill?.victimSteamId,
    cause: kill?.cause ?? null,
    distance: distanceM === null ? null : Math.round(distanceM * 100),
    contextTags: tags
  });
}

function commonToRaw(type, payload) {
  return {
    eventId: payload?.eventId,
    type,
    eventTime: finiteOrNull(payload?.eventTime),
    matchId: payload?.matchId ?? null,
    mapName: payload?.mapName ?? null
  };
}

export function presenceToRaw(type, payload) {
  return dropNulls({
    ...commonToRaw(type, payload),
    playerName: payload?.playerName ?? null,
    playerId: payload?.playerId ?? null,
    playerSteamId: payload?.playerSteamId,
    players: intOrNull(payload?.players)
  });
}

export function matchStateToRaw(payload) {
  return dropNulls({ ...commonToRaw('match_state', payload), state: payload?.state });
}

export function matchEndedToRaw(payload) {
  return dropNulls({
    ...commonToRaw('match_ended', payload),
    players: intOrNull(payload?.players),
    winningFaction: payload?.winningFaction ?? null,
    factionScores: Array.isArray(payload?.factionScores)
      ? payload.factionScores.map((row) => ({ faction: row?.faction, score: row?.score }))
      : []
  });
}

export function orderByClock(events) {
  let carried = Number.NEGATIVE_INFINITY;
  const keyed = events.map((event, index) => {
    if (typeof event.eventTime === 'number') carried = event.eventTime;
    return { event, index, key: carried };
  });
  keyed.sort((left, right) => left.key - right.key || left.index - right.index);
  return keyed.map((entry) => entry.event);
}

export function parseRetryAfter(header, now) {
  if (typeof header !== 'string' || header.trim() === '') return null;
  const text = header.trim();
  let ms = null;
  if (/^\d{1,9}$/.test(text)) {
    ms = Number(text) * 1000;
  } else {
    const at = Date.parse(text);
    if (Number.isFinite(at)) ms = at - now;
  }
  if (ms === null) return null;
  return Math.min(LIMITS.retryAfterMaxMs, Math.max(LIMITS.retryAfterMinMs, ms));
}

export async function readCapped(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      await response.body?.cancel();
    } catch {}
    throw new CappedReadError(declared);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {}
      throw new CappedReadError(total);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export class CappedReadError extends Error {
  constructor(bytes) {
    super(`response larger than allowed (${bytes} bytes or more)`);
    this.name = 'CappedReadError';
  }
}

async function errorCodeOf(response) {
  try {
    const body = await readCapped(response, 4096);
    const code = JSON.parse(body.toString('utf8'))?.error?.code;
    return KNOWN_ERROR_CODES.has(code) ? code : null;
  } catch {
    return null;
  }
}

function failureReason(err) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'timeout';
  const code = err?.cause?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code)) return code;
  return typeof err?.name === 'string' && /^[A-Za-z]{2,40}$/.test(err.name) ? err.name : 'error';
}

const STATE_MESSAGES = Object.freeze({
  ok: () => 'Posting to MyWardogsStats',
  unauthorized: () => 'MyWardogsStats token rejected, check the token in the owner portal',
  server_not_approved: () => 'Server registered but not approved yet',
  server_suspended: () => 'Server suspended by MyWardogsStats staff',
  forbidden: (detail) => `MyWardogsStats refused this server (403 ${detail})`,
  rate_limited: (detail) => `MyWardogsStats rate limited the plugin, retrying after ${detail}`,
  overloaded: (detail) => `MyWardogsStats is busy, retrying after ${detail}`,
  rejected: (detail) => `MyWardogsStats rejected a batch (${detail}), the batch was dropped`,
  failing: (detail) => `MyWardogsStats unreachable (${detail}), backing off`
});

export class IngestClient {
  constructor({
    endpoint,
    token,
    fetchImpl = (...args) => globalThis.fetch(...args),
    now = () => Date.now(),
    random = Math.random,
    log = () => {},
    onLatestVersion = () => {}
  }) {
    this.endpoint = endpoint;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.random = random;
    this.log = (message) => log(redact(message, token));
    this.onLatestVersion = onLatestVersion;

    this.samples = [];
    this.feed = [];
    this.forwardedIds = new Set();
    this.forwardedOrder = [];
    this.blockedUntil = 0;
    this.failures = 0;
    this.state = 'ok';
    this.busy = null;
    this.stats = {
      samplesPosted: 0,
      samplesDropped: 0,
      feedEventsPosted: 0,
      feedEventsDropped: 0,
      feedDuplicates: 0,
      posts: 0,
      failedPosts: 0
    };
  }

  get droppedSamples() {
    return this.stats.samplesDropped;
  }

  enqueueSample(sample) {
    this.samples.push({ sample, queuedAt: this.now() });
    this.trimSamples();
  }

  trimSamples() {
    const oldest = this.now() - LIMITS.bufferWindowMs;
    while (
      this.samples.length > 0 &&
      (this.samples.length > LIMITS.bufferMaxSamples || this.samples[0].queuedAt < oldest)
    ) {
      this.samples.shift();
      this.stats.samplesDropped += 1;
    }
  }

  rememberForwarded(eventId) {
    if (this.forwardedIds.has(eventId)) return false;
    this.forwardedIds.add(eventId);
    this.forwardedOrder.push(eventId);
    if (this.forwardedOrder.length > LIMITS.feedDedupeIds) {
      this.forwardedIds.delete(this.forwardedOrder.shift());
    }
    return true;
  }

  enqueueFeed({ serverId, serverName, events }) {
    const fresh = [];
    for (const event of events) {
      if (typeof event?.eventId !== 'string' || event.eventId.length === 0) continue;
      if (!this.rememberForwarded(event.eventId)) {
        this.stats.feedDuplicates += 1;
        continue;
      }
      fresh.push(event);
    }
    for (let start = 0; start < fresh.length; start += LIMITS.feedEventsPerPost) {
      this.feed.push(
        dropNulls({
          serverId: serverId ?? null,
          serverName: serverName ?? null,
          events: fresh.slice(start, start + LIMITS.feedEventsPerPost)
        })
      );
    }
    while (this.feed.length > LIMITS.feedQueueMaxEnvelopes) {
      this.stats.feedEventsDropped += this.feed.shift().events.length;
    }
    return fresh.length;
  }

  samplesDue() {
    if (this.samples.length === 0) return false;
    if (this.samples.length >= LIMITS.samplesPerPost) return true;
    return this.now() - this.samples[0].queuedAt >= LIMITS.batchWindowMs - LIMITS.tickSlackMs;
  }

  blocked() {
    return this.now() < this.blockedUntil;
  }

  pump() {
    if (this.busy) return this.busy;
    this.busy = this.drain().finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  async drain() {
    let backlog = false;
    for (;;) {
      this.trimSamples();
      if (this.blocked()) return;
      if (this.feed.length > 0) {
        const envelope = this.feed[0];
        const outcome = await this.post('/v1/ingest', envelope);
        if (outcome === 'sent' || outcome === 'dropped') {
          if (this.feed[0] === envelope) this.feed.shift();
          if (outcome === 'sent') this.stats.feedEventsPosted += envelope.events.length;
          else this.stats.feedEventsDropped += envelope.events.length;
        }
        if (outcome !== 'sent') return;
        continue;
      }
      if (this.samples.length > 0 && (backlog || this.samplesDue())) {
        const chunk = this.samplesChunk();
        const outcome = await this.post('/v1/ingest/samples', chunk.body, true);
        if (outcome === 'sent' || outcome === 'dropped') {
          const sent = new Set(chunk.entries);
          this.samples = this.samples.filter((entry) => !sent.has(entry));
          if (outcome === 'sent') this.stats.samplesPosted += chunk.entries.length;
          else this.stats.samplesDropped += chunk.entries.length;
        }
        if (outcome !== 'sent') return;
        backlog = true;
        continue;
      }
      return;
    }
  }

  samplesChunk() {
    let count = Math.min(LIMITS.samplesPerPost, this.samples.length);
    for (;;) {
      const entries = this.samples.slice(0, count);
      const body = buildSamplesBody(entries.map((entry) => entry.sample));
      if (count <= 1 || Buffer.byteLength(JSON.stringify(body)) <= LIMITS.maxBodyBytes) {
        return { entries, body };
      }
      count = Math.ceil(count / 2);
    }
  }

  setState(state, detail = '') {
    if (state === this.state) return;
    this.state = state;
    this.log(STATE_MESSAGES[state](detail));
  }

  backoffMs() {
    const raw = Math.min(LIMITS.backoffMaxMs, LIMITS.backoffBaseMs * 2 ** Math.max(0, this.failures - 1));
    return Math.round(raw * (0.8 + 0.2 * this.random()));
  }

  failExponential(state, detail) {
    this.failures += 1;
    this.stats.failedPosts += 1;
    const delay = this.backoffMs();
    this.blockedUntil = this.now() + delay;
    this.setState(state, detail);
  }

  async post(route, body, readsVersion = false) {
    let response;
    this.stats.posts += 1;
    try {
      response = await this.fetchImpl(`${this.endpoint}${route}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
          'user-agent': `${AGENT_NAME}/${PLUGIN_VERSION}`
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(LIMITS.requestTimeoutMs)
      });
    } catch (err) {
      this.failExponential('failing', failureReason(err));
      return 'failed';
    }

    const status = response.status;
    if (status >= 200 && status < 300) {
      if (readsVersion) await this.readLatestVersion(response);
      else await response.body?.cancel().catch(() => {});
      this.failures = 0;
      this.blockedUntil = 0;
      this.setState('ok');
      return 'sent';
    }

    const code = await errorCodeOf(response);
    if (status === 401) {
      this.stats.failedPosts += 1;
      this.blockedUntil = this.now() + LIMITS.authBackoffMs;
      this.setState('unauthorized');
      return 'failed';
    }
    if (status === 403) {
      this.stats.failedPosts += 1;
      this.blockedUntil = this.now() + LIMITS.authBackoffMs;
      if (code === 'server_not_approved' || code === 'server_suspended') this.setState(code);
      else this.setState('forbidden', code ?? 'no code');
      return 'failed';
    }
    if (status === 429 || status === 503) {
      const wait = parseRetryAfter(response.headers.get('retry-after'), this.now());
      const state = status === 429 ? 'rate_limited' : 'overloaded';
      if (wait === null) {
        this.failExponential(state, 'a backoff');
        return 'failed';
      }
      this.stats.failedPosts += 1;
      this.blockedUntil = this.now() + wait;
      this.setState(state, `${Math.ceil(wait / 1000)}s`);
      return 'failed';
    }
    if (DROP_STATUSES.has(status)) {
      this.failExponential('rejected', `${status} ${code ?? 'no code'}`);
      return 'dropped';
    }
    this.failExponential('failing', `HTTP ${status}`);
    return 'failed';
  }

  async readLatestVersion(response) {
    try {
      const body = JSON.parse((await readCapped(response, LIMITS.responseBytes)).toString('utf8'));
      const latest = body?.latestPluginVersion;
      if (typeof latest === 'string' && STRICT_SEMVER.test(latest)) this.onLatestVersion(latest);
    } catch {}
  }
}

export function parseSemver(text) {
  if (typeof text !== 'string') return null;
  const match = STRICT_SEMVER.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compareSemver(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

export function hasReleaseKey(pem) {
  return typeof pem === 'string' && pem.includes('BEGIN PUBLIC KEY');
}

export class UpdateRejected extends Error {
  constructor(reason, detail = '') {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'UpdateRejected';
    this.reason = reason;
  }
}

function assertHost(url, host) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new UpdateRejected('bad_url');
  }
  if (parsed.protocol !== 'https:') throw new UpdateRejected('not_https', parsed.protocol);
  if (parsed.hostname !== host || parsed.port !== '' || parsed.username || parsed.password) {
    throw new UpdateRejected('off_host', parsed.hostname);
  }
  return parsed.href;
}

export class Updater {
  constructor({
    currentVersion = PLUGIN_VERSION,
    targetPath,
    publicKeyPem = RELEASE_PUBLIC_KEY_PEM,
    fetchImpl = (...args) => globalThis.fetch(...args),
    log = () => {},
    owner = RELEASE_OWNER,
    repo = RELEASE_REPO,
    apiOrigin = `https://${GITHUB_API_HOST}`,
    rawOrigin = `https://${RAW_HOST}`
  }) {
    this.currentVersion = currentVersion;
    this.targetPath = targetPath;
    this.publicKeyPem = publicKeyPem;
    this.fetchImpl = fetchImpl;
    this.log = log;
    this.owner = owner;
    this.repo = repo;
    this.apiOrigin = apiOrigin;
    this.rawOrigin = rawOrigin;
    this.inFlight = null;
    this.applied = null;
    this.lastCheckAt = 0;
    this.lastNotice = null;
  }

  notice(key, message) {
    if (this.lastNotice === key) return;
    this.lastNotice = key;
    this.log(message);
  }

  check() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async run() {
    this.lastCheckAt = Date.now();
    if (this.applied) return { status: 'pending_restart', version: this.applied };
    if (!hasReleaseKey(this.publicKeyPem)) {
      this.notice('no_key', 'Auto update is off: this build has no release public key');
      return { status: 'no_key' };
    }
    let tag = null;
    try {
      tag = await this.latestTag();
      const result = await this.apply(tag);
      if (result.status === 'current') this.notice(`current:${tag}`, `MyWardogsStats plugin ${PLUGIN_VERSION} is current`);
      return result;
    } catch (err) {
      const reason = err instanceof UpdateRejected ? err.reason : 'error';
      const detail = err instanceof UpdateRejected ? err.message : failureReason(err);
      this.notice(`reject:${tag}:${reason}`, `MyWardogsStats update ${tag ?? 'check'} rejected (${detail})`);
      return { status: 'rejected', reason, tag };
    }
  }

  async latestTag() {
    const url = assertHost(
      `${this.apiOrigin}/repos/${this.owner}/${this.repo}/releases/latest`,
      GITHUB_API_HOST
    );
    const response = await this.fetchImpl(url, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `${AGENT_NAME}/${PLUGIN_VERSION}` },
      redirect: 'error',
      signal: AbortSignal.timeout(LIMITS.requestTimeoutMs)
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      throw new UpdateRejected('release_lookup_failed', `HTTP ${response.status}`);
    }
    const body = JSON.parse((await readCapped(response, LIMITS.updateApiBytes)).toString('utf8'));
    const tag = body?.tag_name;
    if (typeof tag !== 'string' || tag.length > 40) throw new UpdateRejected('bad_tag');
    return tag;
  }

  async download(url, maxBytes) {
    let current = assertHost(url, RAW_HOST);
    for (let hop = 0; hop <= LIMITS.updateRedirects; hop += 1) {
      const response = await this.fetchImpl(current, {
        headers: { 'user-agent': `${AGENT_NAME}/${PLUGIN_VERSION}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(LIMITS.requestTimeoutMs)
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {});
        const location = response.headers.get('location');
        if (!location) throw new UpdateRejected('bad_redirect');
        let next;
        try {
          next = new URL(location, current).href;
        } catch {
          throw new UpdateRejected('bad_redirect');
        }
        current = assertHost(next, RAW_HOST);
        continue;
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        throw new UpdateRejected('download_failed', `HTTP ${response.status}`);
      }
      try {
        return await readCapped(response, maxBytes);
      } catch (err) {
        if (err instanceof CappedReadError) throw new UpdateRejected('too_large');
        throw err;
      }
    }
    throw new UpdateRejected('too_many_redirects');
  }

  async apply(tag) {
    const target = parseSemver(tag);
    if (!target) throw new UpdateRejected('bad_tag', 'not strict semver');
    const current = parseSemver(this.currentVersion);
    const order = compareSemver(target, current);
    if (order === 0) return { status: 'current', tag };
    if (order < 0) throw new UpdateRejected('downgrade', `${tag} is older than ${this.currentVersion}`);

    const base = `${this.rawOrigin}/${this.owner}/${this.repo}/${tag}/${RELEASE_FILE}`;
    const file = await this.download(base, LIMITS.updateFileBytes);
    const sigText = (await this.download(`${base}.sig`, LIMITS.updateSigBytes)).toString('utf8').trim();
    if (!/^[A-Za-z0-9+/]{86}==$/.test(sigText)) throw new UpdateRejected('bad_signature', 'malformed');
    const signature = Buffer.from(sigText, 'base64');
    let valid = false;
    try {
      valid = verifyEd25519(null, file, createPublicKey(this.publicKeyPem), signature);
    } catch {
      valid = false;
    }
    if (!valid) throw new UpdateRejected('bad_signature', 'does not verify');

    const embedded = EMBEDDED_VERSION.exec(file.toString('utf8'))?.[1];
    const embeddedVersion = parseSemver(embedded);
    if (!embeddedVersion || compareSemver(embeddedVersion, target) !== 0) {
      throw new UpdateRejected('version_mismatch', `file says ${embedded ?? 'nothing'}`);
    }

    await this.write(file);
    this.applied = tag;
    this.log(`MyWardogsStats plugin ${tag} downloaded and verified, restart WardogsJS to apply`);
    return { status: 'updated', tag };
  }

  async write(bytes) {
    const dir = path.dirname(this.targetPath);
    const temp = path.join(
      dir,
      `.${path.basename(this.targetPath)}.${process.pid}.${Date.now()}.tmp`
    );
    try {
      await fsp.writeFile(temp, bytes, { flag: 'wx' });
      await fsp.rename(temp, this.targetPath);
    } catch (err) {
      await fsp.unlink(temp).catch(() => {});
      throw err;
    }
  }
}

let sharedUpdater = null;

function moduleUpdater(log) {
  if (!sharedUpdater) {
    sharedUpdater = new Updater({ targetPath: fileURLToPath(import.meta.url), log });
  }
  return sharedUpdater;
}

export default class MyWardogsStats extends BasePlugin {
  static get description() {
    return 'Sends player and faction samples, and optionally the event feed, to MyWardogsStats.';
  }

  static get defaultEnabled() {
    return false;
  }

  static get optionsSpecification() {
    return {
      endpoint: {
        required: false,
        default: DEFAULT_ENDPOINT,
        type: 'string',
        maxLength: 200,
        label: 'Endpoint',
        description: 'MyWardogsStats ingest origin. https only, http allowed for 127.0.0.1 and localhost.',
        validate: validateEndpoint
      },
      feedTokenEnv: {
        required: false,
        default: DEFAULT_TOKEN_ENV,
        perServer: true,
        label: 'Feed token env var',
        description: 'Env var holding this server MyWardogsStats feed token from the owner portal.'
      },
      sendSamples: {
        required: false,
        default: true,
        label: 'Send samples',
        description: 'Post player, faction and score samples every 10 s with players on, every 60 s when empty.'
      },
      forwardFeed: {
        required: false,
        default: false,
        label: 'Forward feed',
        description: 'Forward the game event feed this process receives to MyWardogsStats.'
      },
      autoUpdate: {
        required: false,
        default: true,
        label: 'Auto update',
        description: 'Download signed releases. A new version applies on the next restart.'
      }
    };
  }

  client = null;
  updater = null;
  timers = [];
  lastSampleAt = null;
  lastStatusAt = null;
  pendingFeed = null;
  feedServerId = null;
  feedServerName = null;
  lastVersionTrigger = null;
  now = () => Date.now();
  fetchImpl = (...args) => globalThis.fetch(...args);
  random = Math.random;

  get tokenEnv() {
    return typeof this.options.feedTokenEnv === 'string' ? this.options.feedTokenEnv.trim() : '';
  }

  async prepareToMount() {
    this.client = null;
    let endpoint;
    try {
      endpoint = validateEndpoint(this.options.endpoint);
    } catch (err) {
      this.verbose(1, `Invalid endpoint, the plugin is inert: ${err.message}`);
      return;
    }
    const token = this.tokenEnv ? this.server.env?.[this.tokenEnv] : undefined;
    if (token === undefined || token === null || token === '') {
      this.verbose(1, `No token in env (${this.tokenEnv || 'feedTokenEnv is empty'}), the plugin is inert until it is set`);
      return;
    }
    if (!isValidToken(token)) {
      this.verbose(1, `The token in ${this.tokenEnv} is malformed, the plugin is inert`);
      return;
    }
    this.client = new IngestClient({
      endpoint,
      token,
      fetchImpl: (...args) => this.fetchImpl(...args),
      now: () => this.now(),
      random: () => this.random(),
      log: (message) => this.verbose(1, message),
      onLatestVersion: (version) => this.onLatestVersion(version)
    });
  }

  async mount() {
    if (this.options.autoUpdate === true) {
      this.updater = this.updater ?? moduleUpdater((message) => this.verbose(1, message));
      this.every(LIMITS.updateIntervalMs, () => this.checkForUpdate());
      this.after(LIMITS.updateFirstCheckMs, () => this.checkForUpdate());
    }
    if (!this.client) return;

    this.lastStatusAt = this.server.status ? this.now() : null;
    this.on('STATUS_UPDATED', this.onStatusUpdated);

    if (this.options.sendSamples === true) {
      this.every(LIMITS.occupiedIntervalMs, () => this.sampleTick());
    }
    this.every(LIMITS.pumpIntervalMs, () => this.pump());

    if (this.options.forwardFeed === true) {
      if (!this.server.feed) {
        this.verbose(1, 'forwardFeed is on but this server has no feed listener, nothing to forward');
      }
      this.on('FEED_BATCH', this.onFeedBatch);
      this.on('FEED_PLAYER_JOINED', this.onFeedJoined);
      this.on('FEED_PLAYER_LEFT', this.onFeedLeft);
      this.on('FEED_MATCH_STATE', this.onFeedState);
      this.on('FEED_MATCH_ENDED', this.onFeedEnded);
    }
  }

  async unmount() {
    for (const timer of this.timers) {
      clearInterval(timer);
      clearTimeout(timer);
    }
    this.timers = [];
    this.removeAllTrackedListeners();
    this.closeFeedEnvelope();
  }

  every(ms, task) {
    const timer = setInterval(task, ms);
    timer.unref?.();
    this.timers.push(timer);
  }

  after(ms, task) {
    const timer = setTimeout(task, ms);
    timer.unref?.();
    this.timers.push(timer);
  }

  onStatusUpdated = () => {
    this.lastStatusAt = this.now();
  };

  sampleTick() {
    if (!this.client || this.options.sendSamples !== true) return null;
    const status = this.server.status;
    if (!status || this.server.connected === false) return null;
    const now = this.now();
    if (this.lastStatusAt !== null && now - this.lastStatusAt > LIMITS.staleStatusMs) return null;
    const players = Array.isArray(this.server.players) ? this.server.players : [];
    const occupied = players.length > 0 || (intOrNull(status.players?.current) ?? 0) > 0;
    const interval = occupied ? LIMITS.occupiedIntervalMs : LIMITS.emptyIntervalMs;
    if (this.lastSampleAt !== null && now - this.lastSampleAt < interval - LIMITS.tickSlackMs) return null;
    this.lastSampleAt = now;
    const sample = buildSample(status, players, new Date(now));
    this.client.enqueueSample(sample);
    return sample;
  }

  pump() {
    if (!this.client) return Promise.resolve();
    return this.client.pump().catch((err) => {
      this.verbose(1, `Post loop failed: ${redact(failureReason(err), this.client?.token)}`);
    });
  }

  onLatestVersion(version) {
    if (this.options.autoUpdate !== true || !this.updater) return;
    const latest = parseSemver(version);
    if (!latest || compareSemver(latest, parseSemver(PLUGIN_VERSION)) <= 0) return;
    if (this.lastVersionTrigger === version) return;
    if (this.now() - this.updater.lastCheckAt < LIMITS.updateTriggerGapMs) return;
    this.lastVersionTrigger = version;
    this.checkForUpdate();
  }

  checkForUpdate() {
    if (!this.updater || this.updater.inFlight) return Promise.resolve(null);
    if (this.updater.lastCheckAt > 0 && Date.now() - this.updater.lastCheckAt < LIMITS.updateTriggerGapMs) {
      return Promise.resolve(null);
    }
    return this.updater.check().catch(() => null);
  }

  feedEnvelope() {
    if (!this.pendingFeed) {
      this.pendingFeed = [];
      setImmediate(() => this.closeFeedEnvelope());
    }
    return this.pendingFeed;
  }

  closeFeedEnvelope() {
    const events = this.pendingFeed;
    this.pendingFeed = null;
    if (!events || events.length === 0 || !this.client) return;
    this.client.enqueueFeed({
      serverId: this.feedServerId,
      serverName: this.feedServerName ?? cut(this.server.status?.serverName, LIMITS.serverNameLength),
      events: orderByClock(events)
    });
    this.pump();
  }

  onFeedBatch = (payload) => {
    if (typeof payload?.instanceId === 'string' && payload.instanceId) this.feedServerId = payload.instanceId;
    if (typeof payload?.serverName === 'string' && payload.serverName) this.feedServerName = payload.serverName;
    const envelope = this.feedEnvelope();
    for (const kill of Array.isArray(payload?.kills) ? payload.kills : []) envelope.push(killToRaw(kill));
  };

  onFeedJoined = (payload) => {
    this.feedEnvelope().push(presenceToRaw('player_joined', payload));
  };

  onFeedLeft = (payload) => {
    this.feedEnvelope().push(presenceToRaw('player_left', payload));
  };

  onFeedState = (payload) => {
    this.feedEnvelope().push(matchStateToRaw(payload));
  };

  onFeedEnded = (payload) => {
    this.feedEnvelope().push(matchEndedToRaw(payload));
  };
}
