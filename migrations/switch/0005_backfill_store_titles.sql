-- 0004 added store_title to rows that had already been through a price
-- lookup — which is exactly the state resolveStoreFacts skips for a month,
-- since it only revisits a title whose last attempt has aged out. Clearing
-- the timestamp lets the next sync fill the names in.

UPDATE games SET store_checked_at = NULL WHERE store_title IS NULL;
