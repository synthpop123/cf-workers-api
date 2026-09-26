-- eShop list price per title, and the rate that turns it into CNY.
--
-- The znma API knows nothing about money, so a price is resolved once from
-- the public store page (see src/prices.ts) and kept. Prices come from the
-- Hong Kong eShop — the region this account's console belongs to — so they
-- are HKD, and the column says so. `price_checked_at` records the attempt
-- rather than the answer, so a title the store has no page for is not
-- re-fetched on every sync.

ALTER TABLE games ADD COLUMN price_hkd_cents INTEGER;
ALTER TABLE games ADD COLUMN price_checked_at INTEGER;

ALTER TABLE sync_runs ADD COLUMN price_count INTEGER;

-- One row per currency pair, refreshed on every sync. The payload converts
-- at compose time so the whole library is valued at a single, current rate
-- rather than at whatever each title happened to cost the day it was seen.
CREATE TABLE exchange_rates (
  pair TEXT PRIMARY KEY,
  rate REAL NOT NULL,
  captured_at INTEGER NOT NULL
);
