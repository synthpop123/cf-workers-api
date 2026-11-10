# Agent notes

## Deploys are Git-driven — never run `wrangler deploy` manually

This Worker (`cf-workers-api`, at `api.lkwplus.com`) is connected to the
GitHub repo via Cloudflare Workers Builds. **Pushing to `main` is the
deploy**: every push builds and deploys to production, gated by the build
command `npm run check` (a red run aborts the deploy). Other branches get
preview versions only.

So when a change should go live: run `npm run check`, commit, push to
`main`. Do NOT run `npx wrangler deploy` locally — it deploys code Git
doesn't know about, and the next push silently overwrites it. There is
intentionally no `deploy` script. (`--dry-run` is fine: it only bundles.)
The build command lives in the Cloudflare dashboard (Workers →
`cf-workers-api` → Settings → Build), not in the repo; the wrangler OAuth
token has no Workers Builds scope, so it cannot be changed from here.

Commits follow Conventional Commits (`type(scope): summary`, scope = a
service or a shared part; see CONTRIBUTING.md), with the *why* in the
body.

D1 migrations are **not** applied by the deploy:
`npx wrangler d1 migrations apply <tokens-usage|switch-play> --remote`
after adding one. Migrations are append-only — D1 records applied ones by
filename, and both databases have a destructive `…_rebuild.sql` early in
their history, so renaming or collapsing files would re-run it against
production.

## Shape of the Worker

- One Worker, eight services. Each `src/services/<name>/` default-exports
  a `Service` (`lib/service.ts`): its name — also its path prefix and KV
  namespace — its snapshot, and any other routes. `src/services/index.ts`
  is the registry; `src/index.ts` derives `GET /<name>/site` for each and
  joins everything into one table (`lib/router.ts`), which owns OPTIONS,
  HEAD for GET routes, 404/405, the JSON 500, and the CORS set and
  `nosniff` on every response. A new service is a directory plus a line in
  the registry — and a job in `schedule.ts` if it polls.
  `test/services.spec.ts` holds every route and key under the service's
  own name.
- Every public view is a **snapshot** (`lib/snapshot.ts`): a
  `{ key, version, compose(env, today) }` whose body is stored in KV
  (`CACHE`, key `<service>:site`) with version/day/etag/changedAt in the
  metadata. Serve with `siteHandler(snapshot)`; write with `store` (a body
  already composed) or `refresh` (compose + store). Never hand-roll KV
  caching or ETags in a service — that is how three copies of the same
  logic drifted apart in the old per-service Workers (two of them never
  answered 304 in production).
- Freshness is event-driven: writes store, the scheduler refreshes
  pollers, reads compose only when nothing usable is stored (missing,
  other version, other day). `store` skips the KV write when bytes and
  day are unchanged — KV writes (1,000/day on the free plan, account-wide)
  are the scarce resource, and the five-minute heartbeat would otherwise
  spend them rewriting identical payloads. Keep it that way.
- `/misc` concatenates stored snapshot texts; it never parses them. A
  service added to lkwplus.com/misc goes into `SECTIONS` in `src/misc.ts`.
- The scheduler: `TRIGGERS` in `src/schedule.ts` keys jobs by cron
  expression (keys must equal `triggers.crons` in `wrangler.jsonc`), and
  each job declares a `cadence` inside its trigger — `{ every: minutes }`
  counted from local midnight, or `{ at: "HH:MM" }` daily, both in
  TIME_ZONE (`test/schedule.spec.ts` checks the keys and that every
  cadence lands on a tick). Prefer a cadence to a new trigger: the account
  has **five cron triggers in total** on the free plan, shared with other
  Workers (pb, sink and sub-store hold three), and a deploy that exceeds
  it fails at the trigger step *after* the code has gone live — the
  Worker then runs with no schedule at all. One invocation per trigger
  means one CPU/subrequest budget per trigger (50 external subrequests
  on free), which is why the Switch sync has a trigger to itself.
- Third-party artwork goes through `lib/images.ts` into the shared
  `imagebed` bucket under the service's prefix, content-addressed so it is
  copied once. On the way in the Images binding (`IMAGE_TRANSFORM`) crops
  it to what the page draws, with room for dense screens, as WebP
  (posters 320×480, Switch covers 128×128; memo photos are scaled down
  to 640 and 1600 wide instead, ratio kept); the size is part of the key,
  so resizing means new keys, never new bytes under old ones. A copy
  the caller already knows is stored — switch's keys in D1, or a key the
  view's last stored body links (`linkedKeys`) — is passed as `known` and
  costs no R2 lookup. A failed mirror (fetch or transform) stores nothing
  and omits the image; it never fails a composition or a sync.

## Rules that hold everywhere

- Verify with `npm run check` (wrangler types + `biome check` — format
  and the recommended lint rules, warnings fatal, tests exempt from
  `noNonNullAssertion`/`noExplicitAny` + `tsc -p test` (TypeScript 7)
  over src and tests + `vitest run` inside workerd via
  `@cloudflare/vitest-plugin` (formerly `@cloudflare/vitest-pool-workers`),
  against real miniflare-backed D1/KV/R2). GitHub Actions runs the same
  gate, split into a static job and four vitest shards (keep `ci.yml` in
  step with the `check` script). `npm run format` fixes formatting; Markdown is not formatted. The
  compatibility date cannot be newer than the workerd bundled with the
  plugin supports — bump the plugin first. Vitest majors move by hand,
  with the plugin (its peer range allows 4 and 5).
- Bindings, vars **and secrets** come from `wrangler.jsonc` through
  `wrangler types` (secrets via `secrets.required`), so `Env` is
  `Cloudflare.Env` and nothing hand-maintains a binding list. Config is
  code: a deploy replaces dashboard variables with `vars`. Secrets are set
  with `npx wrangler secret put <NAME>` and survive deploys; locally they
  live in the gitignored `.dev.vars`, and tests bind fakes in
  `vitest.config.mts`. They never appear in the repo, a response or a log.
- Every outbound request goes through `fetchUpstream` / `fetchOk`
  (`lib/http.ts`), which bound it with the upstream timeout: a hung host
  must cost a failed run, not the invocation. Narrowers share their type
  tests from `lib/narrow.ts`.
- Every public body is built **field by field** from a hand-narrowed
  upstream slice. An upstream rename must become a failed composition (or
  a `400` on a write), never a silent contract change — and the narrowing
  step is where private fields (device ids, account identity, PNRs, seats,
  serials, unlock codes) are dropped.
- Every `/site` body is a versioned cross-repo contract with lkwplus.com:
  `schemaVersion` (the service's `SITE_VERSION`) is validated strictly by
  the homepage decoder and keys its localStorage cache. Bump both together
  on any shape change and refresh the homepage's fixture by capturing the
  live endpoint, never by hand. Independent deploys mean a bump is never
  atomic: **this Worker ships first** (the fixture needs a live endpoint
  on the new schema), and the page falls back for the minutes in between.
  The producer shapes are pinned by the services' tests; the consumers by
  the homepage's contract tests.
- CORS is one static header set (`lib/http.ts`), applied by the router to
  every response, never derived from the request's `Origin`: reads are
  browser-cacheable, and an Origin-dependent variant once poisoned the
  HTTP cache (a same-origin fetch cached a no-CORS copy that broke the
  cross-origin read from lkwplus.com/tokens).
- Never key a plain object by request input (route, query enum, client /
  model / provider id). `Object.prototype` supplies `constructor`,
  `toString` and `__proto__`, so a lookup that should miss returns an
  inherited value instead: that once turned `?interval=constructor` into
  interpolated SQL and a 500, and a client id of `__proto__` into a slice
  that vanished from the JSON. Use a `Map`, or `Object.create(null)` where
  it must serialize as an object.
- D1 write paths are set-based: changed rows travel as JSON parameters
  expanded with `json_each`, one atomic batch per submission or sync.
  Never per-row statements — D1 caps queries per invocation (50 on the
  free plan, counted per statement across batches).
- All dates are calendar days in `Asia/Shanghai` (`TIME_ZONE` in
  `lib/http.ts`), the zone the collectors run in and lkwplus.com buckets
  by. Every view is composed as of today in that zone.
- `/` redirects to the service page, `lkwplus.com/api`
  (`src/pages/api.astro` in the homepage repo), drawn in the site's own
  design system. When routes or semantics change, update it with the
  README.
- A read that finds a copy of an earlier day serves it and recomposes
  behind the response (`load`'s `defer`, at most once a minute per
  isolate); only a missing or other-version copy composes inline.
- `/health` (`src/health.ts`) is 503 when a scheduled view's stored day
  is not today past its first run (`DUE_BY`); a new scheduled service
  adds its entry there.
- `contract/versions.json` lists every view's `SITE_VERSION`
  (`test/contract.spec.ts` holds it to the code); the homepage's CI
  reads it, so a bump lands here first.

## Per-service notes

Each service's own notes sit beside its code, in `src/services/<name>/AGENTS.md` (with a `CLAUDE.md` symlink), and load when that directory is read: `tokens`, `switch`, `portfolio`, `memos`, `now`, and one text shared by `flights`, `music` and `movies`. Read a service's notes before changing it.
