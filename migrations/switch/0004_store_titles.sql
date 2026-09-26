-- The eShop's own name for a title.
--
-- znma reports whatever the console calls a game, which is per title rather
-- than per language: one library comes back part English, part Chinese. The
-- US storefront has one name for everything, so the same one-shot lookup
-- that reads the HK price also reads the US name (see src/store.ts) — which
-- is why the timestamp column now covers the lookup rather than the price.

ALTER TABLE games ADD COLUMN store_title TEXT;
ALTER TABLE games RENAME COLUMN price_checked_at TO store_checked_at;
