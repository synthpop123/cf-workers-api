# tokens

Loaded with the files in this directory; the root `AGENTS.md` has the rules that hold everywhere.

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
