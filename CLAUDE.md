# mwds-wardogsjs-plugin

WardogsJS plugin that pushes samples and, optionally, the event feed to MyWardogsStats. Part of the MyWardogsStats workspace: read `../CLAUDE.md` and `../docs/PLAN.md` section 7.2 first. The sample contract there is binding.

## Layout

```
mywardogsstats.js          the plugin, the only file owners copy, signed per release
mywardogsstats.js.sig      ed25519 signature, base64, written by scripts/sign-release.mjs at release time
scripts/gen-keypair.mjs    writes a release keypair outside the repo
scripts/sign-release.mjs   signs the plugin file with the offline private key
test/                      node:test suites, harness, stub BasePlugin under test/fixtures
.github/workflows/ci.yml   check and test on Node 22 and 24, actions pinned by SHA
```

## Rules

1. No code comments, no em or en dashes, no emojis. Terse docs.
2. One file, no dependencies: Node built-ins, global `fetch`, and `../src/plugins/base-plugin.js` from WardogsJS. No other WardogsJS imports.
3. WardogsJS is read only. Never edit it. Read state from `server.status`, `server.players` and bus events; never poll RCON, never mutate framework state.
4. Option spec follows WardogsJS `src/plugins/option-spec.js`: `enabled` is the entry flag, secrets are referenced by an `*Env` key (`feedTokenEnv`, locked, per server).
5. The token is never logged and never written to disk. Every client log line goes through `redact`. Logs carry HTTP status and a known error code only, never a response body.
6. Ingest requests: 10 s timeout, `redirect: "error"`. Update downloads: https, `raw.githubusercontent.com` only, manual redirects within that host, 512 KB cap.
7. Never commit a private key. `RELEASE_PUBLIC_KEY_PEM` is the placeholder until the maintainer pastes the real public key.
8. Bump `PLUGIN_VERSION` and `package.json` together. The updater refuses a file whose `PLUGIN_VERSION` differs from the tag.
9. Commit `mywardogsstats.js` with LF endings (`.gitattributes`). The signature covers the exact bytes.

## Verify

`npm run check`, `npm test`. A real WardogsJS check: copy the file into a WardogsJS `plugins/` folder and start it against a dev server; `endpoint` may be `http://127.0.0.1:4000` for the local stack.

## Facts

- WardogsJS emits `FEED_BATCH` (kills, `instanceId`, `serverName`) then `FEED_PLAYER_JOINED`, `FEED_PLAYER_LEFT`, `FEED_MATCH_STATE`, `FEED_MATCH_ENDED` synchronously per game batch. The plugin groups them on `setImmediate` into one envelope.
- `FEED_BATCH` fires only for batches with kills, so `serverId` for a kill-free batch is the last one seen.
- WardogsJS dedupes feed ids over 5000 events; the plugin dedupes forwarded ids over 5000 more; ingest dedupes on `eventId`.
- Backend error bodies are `{ error: { code } }`. Codes: `../mwds-backend/src/api/errors.ts`.
- Outage queue: `<WardogsJS root>/data/mywardogsstats/<server id>/`, JSONL per kind plus an atomic cursor. WardogsJS has no plugin data dir convention; plugins store in MySQL. Spool I/O is synchronous on purpose: one writer per file, small appends, ordering is trivially correct.
- Bump `SPOOL_VERSION` whenever the line format or the sample or envelope shape changes. The first start on the new version discards the old queue: the squadstats "update cleared" idea.
- Post outcomes: `sent`, `dropped` (400, 413, 415, 422), `held` (401, 403, never spooled), `retry` (everything else, spooled).
