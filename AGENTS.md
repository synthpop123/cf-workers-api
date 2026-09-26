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

D1 migrations are **not** applied by the deploy:
`npx wrangler d1 migrations apply <tokens-usage|switch-play> --remote`
after adding one. Migrations are append-only — D1 records applied ones by
filename, and both databases have a destructive `…_rebuild.sql` early in
their history, so renaming or collapsing files would re-run it against
production.

## Shape of the Worker

- One Worker, five services (`src/services/<name>/`), each exporting its
  `Route`s under its own path prefix; `src/index.ts` joins them into one
  table (`lib/router.ts`), which owns OPTIONS, 404/405, the JSON 500 and
  the CORS header set on every response. A new service is a directory
  plus one line in `index.ts` — and in `schedule.ts` if it polls.
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
- The scheduler: `SCHEDULE` in `src/schedule.ts` keys jobs by cron
  expression, and the keys must equal `triggers.crons` in `wrangler.jsonc`
  (`test/router.spec.ts` checks). One invocation per expression means one
  CPU/subrequest budget per expression (50 external subrequests on the
  free plan) — a heavy job gets a trigger to itself, as the Switch sync
  does. The account's cron-trigger quota is small (5 on free); adding an
  expression may need one freed elsewhere.
- Third-party artwork goes through `lib/images.ts` into the shared
  `imagebed` bucket under the service's prefix, content-addressed so it is
  copied once. A failed mirror omits the image; it never fails a
  composition or a sync.

## Rules that hold everywhere

- Verify with `npm run check` (wrangler types + `tsc -p test` over src and
  tests + `vitest run` inside workerd via `@cloudflare/vitest-pool-workers`,
  against real miniflare-backed D1/KV/R2). GitHub Actions runs the same
  gate. The compatibility date cannot be newer than the workerd bundled
  with the test pool supports — bump the pool first.
- Bindings, vars **and secrets** come from `wrangler.jsonc` through
  `wrangler types` (secrets via `secrets.required`), so `Env` is
  `Cloudflare.Env` and nothing hand-maintains a binding list. Config is
  code: a deploy replaces dashboard variables with `vars`. Secrets are set
  with `npx wrangler secret put <NAME>` and survive deploys; locally they
  live in the gitignored `.dev.vars`, and tests bind fakes in
  `vitest.config.mts`. They never appear in the repo, a response or a log.
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
- `/` is `public/index.html` (Workers Static Assets, matched before the
  router), one hand-written file reusing the lkwplus.com design tokens,
  with a live strip from `/tokens/site` and `/misc`. When routes or
  semantics change, update it with the README.

## tokens

- The CLI (missuo/tokens) joins `TOKENS_API_URL` with `/api/submit`,
  `/api/auth/token` and `/api/settings/…`, so hosts run with
  `TOKENS_API_URL=https://api.lkwplus.com/tokens` and those three routes
  are mounted under `/tokens/api/` verbatim. Routes this Worker names
  itself (`/tokens/site`, `/tokens/quota/:plan`) sit directly under
  `/tokens`. The quota collectors read the same variable.
- The subscription quota cards are **reported, not derived**: one host
  (OracleARM, two systemd user timers) reports Codex via
  `scripts/tokens/report-codex-quota.sh` (`tokens codex status --json`) and
  Claude via `scripts/tokens/report-claude-quota.py` (Anthropic's
  `/api/oauth/usage`), so no OAuth credential ever leaves that box and
  the tokens service needs no scheduled job. Four rules hold it together: each vendor's
  body is narrowed by hand in `services/tokens/quota-registry.ts`, the one place a
  provider is declared — id, vendor, label and narrower together, read by
  both the route and the composer (an upstream rename must become a 400,
  never a silent contract change — and that is where account identity is
  dropped, since `/tokens/site` is public); **one KV
  key per provider** (`tokens:quota:<provider>`), never one shared snapshot,
  because the legs use different credentials and must fail
  independently; no D1, because a percentage a collector can re-fetch is
  not history; and `capturedAt` is **per plan**, from the server clock,
  always shipped — two collectors on their own timers are two different
  answers to "how old is this". `refreshSiteCache(env, plan)` persists
  and recomposes in one call: KV is eventually consistent, so never
  write a plan and then read it back to compose the payload. `wipeQuota`
  is the full-wipe path.
- On that host (per-host install and supervision: `docs/tokens-hosts.md`) the
  `agent` user runs **three** units, not two: the two quota timers
  above, plus a long-lived `tokens-serve.service` that submits this
  device's usage every 30 minutes. So after replacing
  `/usr/local/bin/tokens` there, always
  `systemctl --user restart tokens-serve.service`. The timers re-exec the
  binary per run and pick a new version up on their own; the serve
  process does not — it spawns each submit through `/proc/self/exe`, and
  installing over the binary unlinks the inode it is holding, so every
  submit fails `No such file or directory (os error 2)` until restart
  while the process itself stays `active (running)`. Two corollaries:
  the version on the dashboard's device card is self-reported by the
  serve process, so it keeps showing the *old* version — that stale
  number is the symptom, not a packaging bug; and `systemctl --user list-timers` does
  not list services, so enumerate with `list-units --all "*token*"`
  before concluding nothing needs a restart.
- Three devices submit — `OracleARM`, `UbuntuPC`, `MacbookPro` — so the
  `tokens serve` restart above applies per host, under a different unit
  name on each: UbuntuPC's is `tokens.service`, running
  `~/.local/bin/tokens serve`. Grepping for `tokens-serve.service` misses
  it.
- **Cursor is account-wide and must be reported from one device only.**
  It has no local session log: each submit refreshes the whole account's
  usage into `<config>/cursor-cache/usage.json`, and the scanner reads
  that file, never the credential. So two logged-in devices report the
  same rows under two `device_id`s and the dashboard adds them, and
  `cursor logout` does *not* stop it — it stops the refresh, while the
  stale `usage.json` replays every 30 minutes. Deleting
  `<config>/cursor-cache/` is what stops it. The dashboard cannot reveal
  the duplicate — the same model from two devices sums into one row — so
  check D1 instead: `SELECT date, COUNT(DISTINCT device_id) AS devices
  FROM daily_usage WHERE client = 'cursor' GROUP BY date HAVING devices > 1`
  must return nothing.
- `report-claude-quota.py` is the one place this repo can destroy a
  credential: **Anthropic rotates the refresh token on every exchange**.
  It therefore refreshes only within 10 minutes of expiry, writes the
  new pair back *atomically before using it* (temp file in the same dir
  → fsync → `os.replace`, 0600), and preserves every other field in
  `~/.claude/.credentials.json`, which belongs to Claude Code. Do not
  "simplify" any of that. The access token lasts ~12h and that host does
  not run `claude` daily, which is why the script must refresh at all.
- Every leg of the submission fan-out is bounded on purpose, because
  devices rescan every 30 minutes whether or not anything changed — over
  80% of submissions write no usage rows. So: the raw R2 archive uses one
  fixed key per device, `backup/` exports are pruned past 180 days, and
  the `submissions` audit log is a rolling 30-day window trimmed by the
  same D1 batch that appends to it. The daily export deliberately omits
  `submissions`: copying an append-only log into a fresh object every day
  is how R2 storage grows with the square of time. Anything new added to
  this fan-out needs the same treatment.
- The `/tokens/site` body is composed **as of today** (Asia/Shanghai):
  submissions may legitimately carry dates up to two days ahead, but
  every window the dashboard draws ends today, so all three composition
  statements are bounded by `u.date <= today`. Keep new ones bounded
  too, or the day panel will contradict its own active-time card.
- There is exactly one public read endpoint, `/tokens/site`, and that is a
  decision rather than a gap. A filterable aggregation API (stats /
  timeseries / breakdown / graph / meta / devices / submissions) was
  removed once it was clear nothing called it: the CLI computes those
  views locally and the dashboard reads the precomposed payload. The matrix is untouched in D1 at full fidelity, so ad-hoc
  questions go to `wrangler d1 execute`, not to a new endpoint. Do not
  re-add a general query surface without a caller that exists.

## switch

- Play data comes from Nintendo's **Parental Controls (znma) API**, not NSO:
  `PCTL_SESSION_TOKEN` is scoped to the Parental Controls app and cannot be
  reused from the NSO app. There is **no request signing** (no f-token,
  imink or nxapi in the request path; nxapi is used once, by hand, to get
  the token). App version/build are pinned in `services/switch/moon/config.ts`; bump
  when Nintendo returns `update_required`. The full data-source story is on
  the old switch-worker service page — don't restate it here.
- Don't go looking for more routes: the API answers for exactly
  `fetchUser`, `fetchOwnedDevices`, `fetchDailySummaries`,
  `fetchParentalControlSetting`. There is **no monthly-summary route**
  (every plausible path 404s), and `firstPlayDate` exists **only** on the
  setting's `whitelistedApplicationList`, which is why sync reads a settings
  document to enrich a games catalog.
- Catalog metadata (title, art) follows the **newest day**, across devices
  and whatever order Nintendo returns days in — `Catalog.seenOn` in
  `services/switch/sync.ts`. Whitelists are applied only after every device's days are
  harvested, so a later device's newer day cannot wipe an earlier device's
  `first_play_date`. A whitelisted title nobody played is catalogued at zero
  minutes and dropped from the public payload by `buildLibrary`.
- Price and consistent name come from the storefront (`services/switch/store.ts`), not
  znma: **HK** for the price (HKD, `games.price_hkd_cents`), **US** for the
  name (`games.store_title`) — znma names a game whatever *that console*
  calls it, one language per title, and no `X-Moon-*-Language` header
  changes that (verified live). A title is looked up once;
  `store_checked_at` records the attempt so a miss retries monthly, at most
  12 titles per sync, two in flight. The `UPDATE` COALESCEs so a quiet
  storefront cannot erase an earlier answer. CNY is a conversion: one ECB
  rate from `frankfurter.dev` per sync into `exchange_rates`, applied in
  `buildLibrary`. A failed lookup must never fail a sync.
- The payload's play time is **time in games** — `daily_games`, never
  `daily_summaries.playing_time` (which also counts HOME, eShop and
  settings). Stats and the activity series read the same table so the
  total, heatmap and ranked list add up. `daily_summaries` still backs
  `observedAt`.
- Daily summaries are a **rolling window** Nintendo drops. A sync upserts
  and never deletes; D1 is the only copy of anything older. That is why
  `0002_rebuild.sql` could drop and recreate (the whole store was still
  inside the window) and why later migrations must be additive.
- D1 stores everything the API returns, including the verbatim upstream
  document in each table's `raw` column, so enriching `/switch/site` later is a
  query change rather than a migration. Unlock codes
  (`unlockCode` / `synchronizedUnlockCode`) are stripped before writing:
  they are a PIN and answer no question.
- `games` aggregate columns (`total_playing_time`, `day_count`,
  `first_played_date`, `last_played_date`) are recomputed from
  `daily_games` at the end of every sync, never incremented. The price
  columns are not: they are resolved once and kept.
- Artwork is mirrored into R2 (`IMAGES` → bucket `imagebed`, prefix
  `switch/`) at sync time and the payload serves `IMAGE_BASE_URL` links
  only. The bucket is bound by name, so **no S3 access keys exist** in this
  repo or on the Worker. Covers are content-addressed upstream, so their
  hash is the object key and they copy exactly once. Matching D1 image keys
  skip R2 existence checks. Device metadata stays in D1; device icons are no
  longer mirrored or served. A failed mirror leaves the key
  NULL and the payload omits the image — it must never fail a sync.
- The `src/prices.ts` reference in migration `0003_prices.sql` means
  `services/switch/store.ts`; the applied migration is intentionally unchanged.
- `services/switch/stats.ts` is the pure layer — no bindings, no clock, `today` always
  passed in — and is where the unit tests live. `services/switch/site.ts` composes,
  `services/switch/sync.ts` writes.

## flights · music · movies

- **The payload is the map, not the log.** `composeSite` in
  `services/flights/compose.ts` ships airports, routes (airport pairs, either direction
  merged), airline/aircraft tallies and totals — never a single flight, a
  flight number or a per-flight date. The homepage shows where, not when,
  and the payload claims no more than the page shows. Redaction is
  structural: `services/flights/airtrail.ts` types only the upstream fields composition
  reads (PNRs in `note`, seats, gates, registrations and passenger ids are
  never typed), and the payload is built field by field from that slice.
  `test/flights/compose.spec.ts` pins it with a flight carrying every secret.
- AirTrail is read with `AIRTRAIL_API_KEY` (sent as `Authorization:
  Bearer`); it is the one secret of the three pollers. Koito's web API and
  Letterboxd's RSS are public.
- music ships Koito's cover art as absolute URLs on the instance (it is
  self-hosted, so linking it is not hotlinking); movies mirrors posters,
  because Letterboxd's CDN is someone else's. The poster key carries
  Letterboxd's `v` hash, so a replaced poster lands under a new key.
- movies keeps diary entries only (items with `letterboxd:watchedDate`;
  the same feed carries lists) and orders them by watched date — the feed
  is ordered by when an entry was logged.
- music's `LISTENS` and movies' `FILMS` are exactly what /misc shows. If
  the page wants more rows, change the constant here (a payload change:
  bump `SITE_VERSION`).
