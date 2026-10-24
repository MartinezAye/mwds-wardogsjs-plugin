# MyWardogsStats plugin for WardogsJS

One file, `mywardogsstats.js`, that sends your server's player, faction and score samples to MyWardogsStats, and can forward the game's event feed. It uses what WardogsJS already polls. It adds no RCON polling and no dependencies.

## Install

1. Get a feed token for the server from the MyWardogsStats owner portal. The server must be approved before data is accepted.
2. Copy `mywardogsstats.js` into the WardogsJS `plugins/` folder.
3. Add the token to the WardogsJS `.env`:

   ```
   MWDS_FEED_TOKEN=<token from the owner portal>
   ```

4. Add the plugin to `config/config.json` under `plugins` (a WardogsJS start also adds it, disabled, with these defaults):

   ```json
   {
     "plugin": "MyWardogsStats",
     "enabled": true,
     "endpoint": "https://ingest.mywardogsstats.com",
     "feedTokenEnv": "MWDS_FEED_TOKEN",
     "sendSamples": true,
     "forwardFeed": false,
     "autoUpdate": true
   }
   ```

5. Restart WardogsJS.

Several servers in one process: give each its own token and env var, and set `feedTokenEnv` per server (it is a per-server key, see WardogsJS `docs/MULTI-SERVER.md`).

## Options

| Option | Default | Meaning |
|---|---|---|
| `enabled` | `false` | The WardogsJS plugin entry flag |
| `endpoint` | `https://ingest.mywardogsstats.com` | Ingest origin. https only; `http://127.0.0.1` and `http://localhost` allowed for local testing |
| `feedTokenEnv` | `MWDS_FEED_TOKEN` | Name of the `.env` variable holding the token. The token itself never goes in `config.json` and is never logged. Locked: the website editor cannot change it |
| `sendSamples` | `true` | Post samples |
| `forwardFeed` | `false` | Forward the event feed WardogsJS receives |
| `autoUpdate` | `true` | Download signed releases |
| `spoolMaxHours` | `24` | Hours of unsent data kept on disk, 0 to 72. `0` turns the outage queue off |

## What is sent

**Samples**, `POST <endpoint>/v1/ingest/samples`, `Authorization: Bearer <token>`:

```
{ source: "wardogsjs", agent: { name: "mwds-wardogsjs-plugin", version },
  samples: [ { at, serverName, map, playersMax,
               factionScores: [ { name, colorHex, score } ],
               players: [ { steamId, name, faction, kills, deaths, cash, pingMs } ] } ] }
```

| Rule | Value |
|---|---|
| Cadence | every 10 s with players on, every 60 s when empty |
| Skipped | RCON disconnected, no status yet, or status older than 60 s |
| Batching | posted once the oldest queued sample is 30 s old |
| Per post | at most 30 samples, body kept under 448 KB |
| Per sample | at most 128 players, 8 faction rows; names cut to 64 characters |
| `faction` | `null` when the player is unassigned: empty, `NONE`, `WHITE` or colour `#FFFFFF` |
| Memory buffer | 15 minutes of samples (90). Overflow goes to the outage queue, or is dropped and counted when the queue is off or not allowed |

**Feed forwarding** (`forwardFeed: true`), `POST <endpoint>/v1/ingest` in the game's own shape `{ serverId, serverName, events }`, same token. Use it when WardogsJS is already the game's feed endpoint, so the game does not need a second `EventFeedEndpoints` entry. One game batch becomes one post (split at 200 events). Event ids are kept, and an id is forwarded once. The memory queue holds 450 batches; overflow goes to the outage queue.

WardogsJS does not keep the raw feed body, so the plugin rebuilds events from the bus. Not carried over:

- `killerId` and `victimId` (the short in-game ids)
- the original `contextTags` strings: tags are rebuilt with the `KillContext` prefix, and the `Local.Kill` and `Local.Death` noise tags are gone
- a kill where killer and victim are the same player gets a `Suicide` tag even if the game sent none
- `distance` below one centimetre
- names over 64 characters and causes over 200 characters, as WardogsJS cuts them
- events WardogsJS refused or skipped as malformed or of an unknown type
- the exact order between kills and other events of one batch: events are ordered by `eventTime`
- `serverId` on a batch that has no kills, until a batch with kills has been seen since start

## Errors

| Answer | Plugin does | Logged once per change |
|---|---|---|
| 401 | backs off 10 minutes | `MyWardogsStats token rejected, check the token in the owner portal` |
| 403 `server_not_approved` | backs off 10 minutes, keeps the newest 15 minutes of samples | `Server registered but not approved yet` |
| 403 `server_suspended` | backs off 10 minutes | `Server suspended by MyWardogsStats staff` |
| 429, 503 | waits `retry-after` (clamped 1 s to 15 minutes), exponential backoff when absent | rate limited or busy |
| 400, 413, 415, 422 | drops that batch, backs off | rejected a batch |
| anything else, timeout, network | exponential backoff from 5 s to 5 minutes, with jitter | unreachable |

Requests time out after 10 s and never follow a redirect. Logs carry the status and the error code only, never the token or a response body.

## Outage queue

Unsent data is kept on disk so it survives ingest outages and WardogsJS restarts, like MySquadStats' `send-retry-requests.json`.

| Item | Value |
|---|---|
| Location | `<WardogsJS root>/data/mywardogsstats/<server id>/`. WardogsJS has no plugin data folder of its own, so the plugin makes one. Add `data/` to the WardogsJS `.gitignore` if the install is a git checkout |
| Files | `samples.jsonl` and `feed.jsonl` (one JSON line per sample or feed batch, append only), `samples.cursor.json` and `feed.cursor.json` (byte offset of the first unsent line, written atomically), `spool.json` (format version) |
| Written when | a post fails with a network error, timeout, 404, 429, 503 or another 5xx; the memory buffer overflows; the plugin unmounts with data still in memory |
| Not written when | the last answer was 401, 403 `server_suspended` or another 403: the existing queue is kept and new samples stay in the 15 minute memory window. 403 `server_not_approved`: nothing is written, data from before approval is not wanted |
| Bounds | `spoolMaxHours` of data and 50 MB per file, whichever comes first. Oldest dropped first and counted. Feed batches age from when they were queued, samples from their `at` |
| Compaction | once more than half the file has been sent, the unsent rest is rewritten to a new file and renamed over the old one |
| Replay | oldest first, at start and after recovery. Live data goes first; the queue drains behind it at one post per second, 30 samples or up to 200 feed events of one boot per post. `retry-after` and the 10 minute backoffs hold it like any other post |
| Dedupe | every sample keeps its own `at` (ingest dedupes on server and `at`), every feed event keeps its `eventId`. A crash between a post and the cursor write resends, never loses |
| Safety | the token is never written. Every line is parsed as JSON and checked against the sample or feed shape on load and again before replay; anything else is dropped and counted, never evaluated. Files are `0600` and the folder `0700` where the OS supports it |
| Upgrades | a release that changes the line format bumps `SPOOL_VERSION`; the first start on it discards the old queue and logs it once |

A burst replay can meet the ingest event rate limit. The plugin then waits out `retry-after` and carries on.

## Updates

With `autoUpdate: true` the plugin checks the latest GitHub release of `MartinezAye/mwds-wardogsjs-plugin` a minute after start, every 12 hours, and when the ingest answer reports a newer `latestPluginVersion`. It then:

1. reads the release tag, which must be strict semver (`1.2.3` or `v1.2.3`), and skips anything not newer
2. downloads `mywardogsstats.js` and `mywardogsstats.js.sig` from `raw.githubusercontent.com` at that tag, https only, redirects only within that host, at most 512 KB
3. verifies the ed25519 signature against the public key built into the running file
4. checks that the file's `PLUGIN_VERSION` equals the tag
5. writes a temp file next to the plugin and renames it over `mywardogsstats.js`
6. logs `restart WardogsJS to apply`. It never restarts anything itself

A missing or bad signature, a downgrade, a bad tag, a large file or an off-host redirect is refused and logged once. Releases are signed with a key the maintainer keeps offline, never in CI. The repo must be public for unauthenticated downloads.

Turn it off with `"autoUpdate": false`. Updates then only happen when you copy a new file in.

A build that still carries the placeholder key does not update at all.

## Release signing (maintainer)

One time:

1. `node scripts/gen-keypair.mjs <directory outside this repo>`. It refuses a path inside the repo and never overwrites.
2. Paste the printed public key into `RELEASE_PUBLIC_KEY_PEM` in `mywardogsstats.js`, between the backticks. The shipped build already carries the maintainer key; only a fork replaces it.
3. Store the private key offline. Never commit it, never give it to CI.

Every release:

1. Bump `PLUGIN_VERSION` in `mywardogsstats.js` and `version` in `package.json`.
2. `npm test`.
3. `node scripts/sign-release.mjs mywardogsstats.js <private key path>`. It refuses CR line endings, a file over 512 KB, the placeholder key, or a private key that does not match the embedded public key, and writes `mywardogsstats.js.sig`.
4. Commit both files, tag `vX.Y.Z` on that commit, push, publish the GitHub release.

Rotating the key: the new public key ships in a release signed with the old key. Servers on older builds verify that release, then trust the new key after restart.

## Development

```
npm test
npm run check
```

Tests run on `node:test` against a fake WardogsJS server, a stub `BasePlugin` in `test/fixtures`, a local HTTP stub for ingest, and an in-memory fake of GitHub for updates.
