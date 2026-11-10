# switch

Loaded with the files in this directory; the root `AGENTS.md` has the rules that hold everywhere.

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
