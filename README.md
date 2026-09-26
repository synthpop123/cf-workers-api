# cf-workers-api

Every backend [lkwplus.com](https://lkwplus.com) reads, in one Cloudflare Worker at [api.lkwplus.com](https://api.lkwplus.com).

| Service | Source | Storage | Fresh by | Page |
|---|---|---|---|---|
| `/tokens` | the [`tokens`](https://github.com/missuo/tokens) CLI on each machine, quota collectors | D1 `tokens-usage`, R2 `tokens-archive` | every submission and quota report | [/tokens](https://lkwplus.com/tokens) |
| `/switch` | Nintendo Parental Controls (znma) API, eShop | D1 `switch-play`, R2 `imagebed` | daily sync, 01:00 UTC | [/misc](https://lkwplus.com/misc) |
| `/flights` | self-hosted [AirTrail](https://github.com/johanohly/AirTrail) | — | heartbeat, every 5 min | [/misc](https://lkwplus.com/misc) |
| `/music` | self-hosted [Koito](https://github.com/gabehf/Koito) | — | heartbeat, every 5 min | [/misc](https://lkwplus.com/misc) |
| `/movies` | Letterboxd RSS | R2 `imagebed` (posters) | heartbeat, every 5 min | [/misc](https://lkwplus.com/misc) |

Every service's public view lives in one KV namespace (`CACHE`) as a snapshot, and `/misc` serves the four that lkwplus.com/misc draws in a single response.

## Layout

```
src/
  index.ts           fetch (the route table) + scheduled
  schedule.ts        cron expression → jobs
  misc.ts            GET /misc
  env.ts             Env, generated from wrangler.jsonc
  lib/
    router.ts        routing, 404/405, JSON 500, CORS on every response
    snapshot.ts      how every public view is stored, refreshed and served
    images.ts        the R2 artwork mirror
    http.ts          calendar, JSON, bearer check, ETags, CORS
  services/
    tokens/          CLI write path, merge engine, quota reports, dashboard view
    switch/          znma client, sync, eShop lookups, view
    flights/         AirTrail slice, composition
    music/           Koito slice, composition
    movies/          RSS parser, poster mirror, composition
migrations/{tokens,switch}/   one directory per D1 database
scripts/tokens/      quota collectors + their systemd units
docs/tokens-hosts.md how each reporting machine runs the CLI
public/index.html    the service page at /
test/                vitest inside workerd, mirroring src/
```

## API

Reads are public, open to any origin, and answer `Cache-Control: no-cache` + a strong `ETag` — browsers revalidate every load and an unchanged view is a ~0-byte `304`.

| Route | |
|---|---|
| `GET /misc` | `{"flights":…,"movies":…,"music":…,"switch":…}` — each section the same body as its `/site`, `null` if it has nothing to serve |
| `GET /tokens/site` | the tokens dashboard view |
| `GET /switch/site` | Switch play time and the catalog |
| `GET /flights/site` | the flight map (never a single flight, number or seat) |
| `GET /music/site` | Koito stats, a dense year of daily plays, the latest listens |
| `GET /movies/site` | the latest Letterboxd diary entries |
| `GET /health` | liveness |

Writes take a bearer token:

| Route | Token | |
|---|---|---|
| `POST /tokens/api/submit` | `TOKENS_API_TOKEN` | a CLI submission |
| `GET /tokens/api/auth/token` | `TOKENS_API_TOKEN` | `tokens login --token` |
| `DELETE /tokens/api/settings/submitted-data` | `TOKENS_API_TOKEN` | full wipe |
| `POST /tokens/quota/{codex,claude}` | `TOKENS_API_TOKEN` | a subscription quota report |
| `POST /switch/sync` | `SWITCH_API_TOKEN` | run the Switch sync now |

The CLI joins its base URL with `/api/…`, so machines run with `TOKENS_API_URL=https://api.lkwplus.com/tokens` and its three routes land under `/tokens/api/` verbatim; everything this Worker names itself sits directly under the service prefix.

## Snapshots

A snapshot (`src/lib/snapshot.ts`) is a service's precomposed JSON view, stored in KV under `<service>:site` with its schema version, the calendar day it was composed as of, its ETag and when its bytes last changed in the entry metadata. A read is one KV lookup and no parse.

Freshness is decided by events, never by a TTL:

- **writes** — a service that owns its writes (tokens submissions and quota reports, the Switch sync) stores a new snapshot as the last step of the write;
- **the heartbeat** — the services that poll an upstream (AirTrail, Koito, Letterboxd) are recomposed every five minutes, and a composition whose bytes did not move writes nothing, so the heartbeat spends upstream reads rather than KV writes;
- **reads** — only when there is no usable copy: none stored, one of another schema version (a deploy changed the shape, and the page would reject it), or one composed as of another day in Asia/Shanghai (every window the pages draw ends today). If that inline composition fails, an earlier day's copy still answers; only a service with nothing stored answers `503`.

There is deliberately no `caches.default` tier: it is the one layer no event can invalidate.

### Cross-repo contract

Each body carries `schemaVersion` (`SITE_VERSION` in the service's composer), which the homepage validates strictly and keys its local cache by. Bump both together on any shape change and refresh the homepage's committed fixture by capturing the live endpoint, never by hand. The two repos deploy independently, so **this Worker ships first** and the page falls back for the minute or two in between.

| Service | Producer | Consumer (lkwplus.com) |
|---|---|---|
| tokens | `services/tokens/site.ts` | `src/lib/client/tokens/schema.ts` + `tokens.site-fixture.json` |
| switch | `services/switch/site.ts` | `src/lib/client/switch.ts` + `switch.site-fixture.json` |
| flights | `services/flights/compose.ts` | `src/lib/client/flights.ts` + `flights.site-fixture.json` |
| music | `services/music/compose.ts` | `src/lib/client/music.ts` + `music.site-fixture.json` |
| movies | `services/movies/compose.ts` | `src/lib/client/movies.ts` + `movies.site-fixture.json` |

## Scheduler

`src/schedule.ts` maps each cron expression to its jobs, and its keys must be exactly `triggers.crons` in `wrangler.jsonc` (a test checks). Each expression is its own invocation with its own CPU and subrequest budget, which is why the Switch sync — the one heavy job — has a trigger to itself.

| Cron | Jobs |
|---|---|
| `*/5 * * * *` | recompose `flights:site`, `movies:site`, `music:site` |
| `0 1 * * *` | the Switch sync (09:00 Asia/Shanghai) |

The tokens view needs no job: submissions and quota reports are its write events.

## tokens

Implements the official server's submission contract and merge semantics — per-device, per-day, per-client replace with a regression guard, parser-revision floors, authoritative `clientManifest` coverage, the official consistency checks — and stores the full usage matrix, one row per (device, date, client, model, provider) with the full token breakdown, messages and cost. The view is an aggregation of that matrix, with model and provider ids canonicalized before aggregation; D1 keeps the raw spellings. Ad-hoc questions go to `wrangler d1 execute tokens-usage --remote`, not to a new endpoint.

Every accepted submission also archives the raw payload to R2 (`raw/<deviceId>/latest.json`, one key per device — submissions are full rescans) and, once per Asia/Shanghai day, exports the usage tables (`backup/YYYY-MM-DD.json`, pruned past 180 days). Every leg of that fan-out is bounded: devices rescan every 30 minutes whether or not anything changed.

### Quota collection

The dashboard's plan cards show how much of each subscription's rate-limit window is spent. The OAuth credentials never leave the machine that holds them: **OracleARM** reports both plans on 30-minute systemd user timers (`scripts/tokens/`), and this Worker stores percentages and timestamps and nothing else.

| Plan | Collector | Reaches the vendor via |
|---|---|---|
| Codex | `report-codex-quota.sh` | `tokens codex status --json` |
| Claude | `report-claude-quota.py` | `api.anthropic.com/api/oauth/usage` with `~/.claude/.credentials.json`, refreshed by the script |

Each plan is its own report to its own KV key (`tokens:quota:<provider>`) with its own server-stamped `capturedAt`, so a broken leg goes stale alone. Each vendor's body is narrowed by hand in `services/tokens/quota-registry.ts` — where account identity is dropped and an upstream rename becomes a `400`, never a silent contract change.

Anthropic rotates the refresh token on every exchange, so the Claude collector refreshes only within ten minutes of expiry and writes the new pair back atomically *before* using it. Do not simplify that.

Installing on a fresh host, as the `agent` user:

```sh
install -Dm755 scripts/tokens/report-codex-quota.sh ~/.local/bin/report-codex-quota.sh
install -Dm755 scripts/tokens/report-claude-quota.py ~/.local/bin/report-claude-quota.py
install -Dm644 scripts/tokens/tokens-quota-*.{service,timer} -t ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now tokens-quota-codex.timer tokens-quota-claude.timer
```

The bearer token is read from the CLI's own `~/.config/tokens/credentials.json`, so there is one thing to rotate per host.

## switch

Play data comes from Nintendo's Parental Controls (znma) API with a `PCTL_SESSION_TOKEN` scoped to that app. The sync stores everything the API returns in D1 (including each document verbatim, minus unlock codes), recomputes the catalog aggregates from `daily_games`, looks up each title once on the eShop — HK for the price, US for a consistent name — converts at one ECB rate per sync, and mirrors covers into R2. Play time is **time in games**, never console time, so the total, heatmap and list add up.

## flights · music · movies

- **flights** reads AirTrail's flight list with `AIRTRAIL_API_KEY` and ships the map, not the log: airports, routes, tallies and totals, built field by field from a typed slice of the upstream, so a PNR in a note or a seat number has no path into the payload.
- **music** composes Koito's stats, listen activity and latest listens into one document, zero-filling a dense 364-day series for the heatmap. Cover art stays on the self-hosted instance.
- **movies** parses the member's Letterboxd RSS, keeps diary entries only, orders them by watched date, and mirrors each poster's 460×690 crop into R2 under a key carrying Letterboxd's version hash.

Every upstream body is narrowed by hand: a field rename upstream fails a composition — and the last good snapshot keeps serving — rather than changing a payload this Worker owns.

## Security

- Secrets live on the Worker (`wrangler secret put`), and in the gitignored `.dev.vars` locally: `TOKENS_API_TOKEN`, `SWITCH_API_TOKEN`, `PCTL_SESSION_TOKEN`, `AIRTRAIL_API_KEY`. They are declared under `secrets.required` in `wrangler.jsonc`, which is what types them on `Env`.
- Bearer checks hash both sides and compare with the runtime's timing-safe primitive; an unset secret rejects everything.
- Reads are public by design. Internal device ids, account identities, PNRs, serial numbers and unlock codes never reach a public body — each is dropped at the service's narrowing step, and tests pin it.
- CORS is one static header set on every response, never derived from `Origin`: responses are cacheable, and an Origin-dependent variant poisons the HTTP cache.

## Deploy

**Pushing to `main` is the deploy** (Cloudflare Workers Builds, build command `npm run check`). There is no manual deploy path: a hand-run `wrangler deploy` puts code live that Git doesn't know about, and the next push silently overwrites it.

```sh
npm install
npm run check          # wrangler types + tsc + vitest (inside workerd)
npm run dev            # local, with .dev.vars
npx wrangler d1 migrations apply tokens-usage --remote   # after adding a migration
```

## License

MIT
