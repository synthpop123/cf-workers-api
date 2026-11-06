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
  (OracleARM, three systemd user timers) reports Codex via
  `scripts/tokens/report-codex-quota.sh` (`tokens codex status --json`),
  Claude via `scripts/tokens/report-claude-quota.py` (Anthropic's
  `/api/oauth/usage`) and OpenCode Go via
  `scripts/tokens/report-opencode-quota.sh` (`opencode.ai/zen/go/v1/usage`
  with an API key in `~/.config/tokens/opencode-api-key`), so no vendor
  credential ever leaves that box and
  the tokens service needs no scheduled job. Four rules hold it together: each vendor's
  body is narrowed by hand in `services/tokens/quota-registry.ts`, the one place a
  provider is declared — id, vendor, label and narrower together, read by
  both the route and the composer (an upstream rename must become a 400,
  never a silent contract change — and that is where account identity is
  dropped, since `/tokens/site` is public); **one row per provider**
  in D1's `quota_plans` (the latest report, overwritten in place — not
  history), never one shared snapshot, because the legs use different
  credentials and must fail independently; **not KV**, because a KV key
  made every report two KV writes (plan + view), ~190 a day against the
  account's 1,000 — more than every submission put together — and D1
  reads its own writes, so the view composed right after sees the plan;
  and `capturedAt` is **per plan**, from the server clock, always
  shipped — two collectors on their own timers are two different
  answers to "how old is this". The composer reads the plans in the same
  D1 batch as the usage matrix, and the full wipe deletes them with the
  other tables.
- Claude's cloud session credits are an **allowance with `expiresAt`**,
  not a window: a one-off grant whose unspent remainder lapses, not a
  quota that refills. Anthropic names the field `resets_at`; the narrower
  publishes it as `expiresAt` and the page says "expires".
- On that host (install and supervision: `docs/tokens-reporters.md`) the
  `agent` user runs the three quota timers above, plus a long-lived
  `tokens-serve.service` that submits this device's usage every 30
  minutes. So after replacing `/usr/local/bin/tokens` there, always
  `systemctl --user restart tokens-serve.service`. The timers re-exec the
  binary per run and pick a new version up on their own; the serve process
  does not — it spawns each submit through `/proc/self/exe`, and
  installing over the binary unlinks the inode it is holding, so every
  submit fails `No such file or directory (os error 2)` until restart
  while the process itself stays `active (running)`. Two corollaries: the
  version on the dashboard's device card is self-reported by the serve
  process, so it keeps showing the *old* version — that stale number is
  the symptom, not a packaging bug; and `systemctl --user list-timers`
  does not list services, so enumerate with `list-units --all "*token*"`
  before concluding nothing needs a restart.
- Three devices submit — `OracleARM`, `UbuntuPC`, `MacbookPro` — so the
  `tokens serve` restart above applies per host, under a different unit
  name on each: UbuntuPC's is `tokens.service`, running
  `~/.local/bin/tokens serve`. Grepping for `tokens-serve.service` misses
  it. MacbookPro's is the LaunchAgent `com.lkw123.tokens-serve`, which
  must be reloaded, not kickstarted (`docs/tokens-reporters.md`).
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
- **OracleARM's `serve` never syncs Cursor; a 3-hour timer does.** The
  implicit sync in every submit refetches the whole history under one
  hard-coded 15 s budget, which ~6,000 events no longer fit, so it failed
  silently onto a stale cache (a day of Cursor showing zero). `serve` runs
  with `TOKENS_CONFIG_DIR=~/.config/tokens-serve` — symlinks back to
  `~/.config/tokens` minus `cursor-credentials.json`, so no Cursor login —
  and `tokens-cursor-sync.timer` runs the explicit `tokens cursor sync`
  (120 s budget). Setup and checks: `docs/tokens-reporters.md`. Run
  `tokens cursor login` without the override.
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
- **Every tokens write bumps one counter** (`tokens_state.generation`,
  `services/tokens/state.ts`) in its own D1 batch: submissions, quota
  reports and the wipe. D1 makes each batch atomic, not the work around
  it, and the counter is what orders that work. A submission merges in
  memory against rows read earlier, so its write batch opens with
  `guard(read)` and rolls back whole when another write landed in
  between, then re-merges (overlapping `tokens serve` and manual submits
  of one device would otherwise defeat the regression guard). The
  `/tokens/site` snapshot declares `generation`, so `refresh` never
  leaves a body composed across a write as the published one — a refresh
  that read rows a wipe then deleted cannot republish them. Any new
  write path must bump it too.
- Full-coverage manifest windows replace stored history only from a
  parser at least as new as the device's stored revision for that client,
  and never for a client the same submission had rejected
  (`extractCoverages`, the official server's revision filter): coverage
  deletes before the merge compares revisions.
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
  the token). App version/build are pinned in
  `services/switch/moon/config.ts`; bump them when Nintendo returns
  `update_required`.
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
  merged), airline/aircraft tallies and totals — no single flight, never
  a flight number or a time of day. The map shows where, not when, and the
  payload claims no more than the pages show. Redaction is
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

## portfolio

- The owner records the portfolio in **both** Wealthfolio and Ghostfolio
  (self-hosted on the arm host; composes in homelab-infra
  `stacks/wealthfolio`, with `WF_MCP_ENABLED`, and `stacks/ghostfolio`),
  and each answers what it is good at: **the money from Wealthfolio**
  (`WEALTHFOLIO_URL`), **the securities from Ghostfolio**
  (`GHOSTFOLIO_URL`). This Worker stores nothing but the snapshot.
- Wealthfolio is read through its MCP endpoint (`/mcp`, Streamable HTTP,
  one session per composition, closed after) with a personal access
  token minted in Settings → AI agent access with **read scopes only**
  (`WEALTHFOLIO_TOKEN`). The tools it calls: `get_accounts`,
  `get_cash_balances`, `get_valuation_history` and `get_holdings` (whole
  portfolio and each account). `get_valuation_history` answers only a
  range's earliest 400 points (`MAX_VALUATIONS_POINTS`, flagged
  `truncated`), so `readHistory` pages it from the day after the last
  one read and fails on a gap or overlap rather than ship a line that
  stops at day 400.
- Ghostfolio is read by a bot user (`GHOSTFOLIO_TOKEN` → `POST
  /api/v1/auth/anonymous` → JWT) through a PRIVATE read-only access the
  owner granted it (`Impersonation-Id: GHOSTFOLIO_ACCESS_ID`; it expires,
  `Access.expiresAt`, currently 2027-10): one `/api/v1/portfolio/holdings`
  for every held symbol's asset profile (name, kind, a stock's sector, its
  dominant country, its site — the public asset endpoint hides those from
  a non-admin) and `/api/v1/symbol/<source>/<symbol>` for closes and VOO.
  Ghostfolio keeps history only for symbols it gathers, so a symbol
  missing from its ledger ships with no line and nothing said of it;
  returns never depend on it.
- **The payload is returns, never amounts.** `wealthfolio.ts` types only
  what composition reads. Per account `compose.ts` ships two series on the
  axis, its value (holdings and cash) and the money put in to date, both
  divided by the most ever put in (`capital`), so they are ratios and no
  amount survives. A range's return is one over the other: its gain over
  the value it started from plus the money put in since (a deposit never
  reads as a gain). Over one session that is the day's time-weighted
  return (`dayReturn`), which this Worker chains (`growthIndex`) and ships
  on the axis as `growth`: the page's last session, strip and drawdown
  read it, never re-derive it from the ratios — those cannot carry the
  `MIN_CAPITAL` rule without the amount it is measured in, and must not.
  The weekly part of the axis also hides a week's peak and trough, so
  each axis day before the daily window ships its deepest fall to date at
  daily resolution (`falls`). Wealthfolio's own TWR/IRR are not read. The
  tests pin that no amount reaches the body.
- Per position it also ships the **average price paid per share**
  (`cost`: cost basis over quantity, divided in `wealthfolio.ts`), the
  position's own return (Wealthfolio's `totalReturnPct`: gain, realised,
  unrealised and income, over what went into it) and the first buy's day
  (`since`). A per-share price without a share count is not a
  sum — keep it that way: never ship the quantity or a trade.
  `get_holdings` lists a page of positions and leaves the smallest out;
  weights still divide by the account's full total.
- Accounts show under the short name and broker logo `BROKERS` gives by
  their Wealthfolio name (`Interactive Brokers` → `IBKR`,
  interactivebrokers.com); an account not there keeps its own name and no
  logo.
- Cash ships only in US dollars (`CASH_CURRENCY`): what else a broker
  leaves (IBKR's CNH interest, an HKD conversion's change) is dust, kept
  out of the cash rows and out of the weights' total. The value series
  still include it, as Wealthfolio values it.
- Days on less than `MIN_CAPITAL` (100, base currency) earn no return, so
  an account that held only dust starts the day real money went in.
- The ledger is entered in **split-adjusted** terms: Yahoo rewrites price
  history after a split and the ledger keeps what was entered, so a trade
  from before a split is entered at its post-split quantity and price
  (MVIS's 1:15 of 2026-08-01, in Schwab, with the original in the
  comment). A position valued far from what was paid on its first day is
  the symptom.
- Days are **US market sessions**, not Shanghai days. Wealthfolio dates
  its valuations by its server zone (Asia/Shanghai) and values the last
  day at the latest quote, so from Shanghai midnight until the next New
  York open that day is the previous session again. `toSessions` folds
  every day from `marketSession(now)` on into that session; holiday
  calendars are not modelled. Weekends drop off the axis; days older than
  `DAILY_DAYS` thin to one a week, except that every day money moved in
  any account stays, with the axis day before it. The page reads deposits
  and withdrawals off adjacent axis days, so a week's money out and back
  in folded into one step would net out and read as gain or loss; kept
  apart, every return the page measures there is the daily one.
- Each account also ships its **best days** (`best`, `bestDays`): newest
  first, every session whose return beat all the ones after it, read off
  the daily returns before the axis thins them. The page's Best day for a
  range is the earliest entry dated after the range's start.
- A composition is about two dozen requests (a Wealthfolio session: the
  accounts, cash, a history and holdings for the portfolio and each
  account; a Ghostfolio sign-in, the holdings' profiles and one price
  history per holding plus VOO), hence its own `offset: 5` minute
  in the hourly slot. A holding whose history fails ships without a line;
  anything else fails the composition.
- Logos come from logo.dev's ticker lookup (`LOGO_DEV_TOKEN`, a
  publishable key that still never reaches a browser), mirrored once per
  ticker as `portfolio/logos/<TICKER>-96.webp`, brokers by domain as
  `portfolio/brokers/<domain>-96.webp`. Delete the object to pick up a new
  logo. `lib/images.ts` logs a failed mirror by key, not source URL,
  because this source carries the key.

## memos

- The latest `MEMOS` public statuses, boosts and replies excluded, from
  the self-hosted Mastodon (`MASTODON_URL`, `MASTODON_ACCOUNT`), narrowed
  in `services/memos/mastodon.ts`. The status HTML ships as Mastodon
  renders it; the page's allow-list sanitizer owns it. Everything else on
  a status (account, application, mentions, counts) is never typed.
- Photos are copied as WebP at 640 and 1600 wide, scaled down with their
  ratio kept (`services/memos/media.ts`), keyed by attachment id and
  width. The previous stored body stands for the copies that exist, so
  a run asks R2 about new attachments only, and copies at most `MAX_NEW`
  of them; one that waits is served from the instance meanwhile (it is
  self-hosted, like Koito). Video, gifv and audio stream from the
  instance: the Images binding transforms stills only.
- Alt text ships as the attachment's own description or null; the page
  falls back to the memo's words, never to words behind a warning.

## now

- The home page's Now tiles. It **reads the other services' stored
  snapshots** (`read`, any day), music, movies, tokens and portfolio, and
  never composes them or asks an upstream: composing a source from here
  would put that upstream on this service's clock. Tokens adds the last
  `TOKENS_DAYS` (14) daily totals for the tile's bars and `top`, the week
  range's busiest model (placeholder ids skipped) with its share; portfolio is the
  whole portfolio's index and the benchmark cut to /misc's 3M range
  (`pickPortfolio`, `shiftMonths` mirroring the page's `rangeCutoff`), so
  the tile's return is the last value over the first.
- The heartbeat refreshes it right after music, in one job, so the home
  page is never a run behind it. Tokens, films and the portfolio (hourly,
  at :05) reach it within five minutes of their own writes.
- Keep the body small and only what the tiles show. It is a KV write
  whenever any field moves, so a field that changes on every tokens
  submission or every listen costs a write each time.
