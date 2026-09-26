-- Full-fidelity rebuild of the play-activity store.
--
-- 0001 kept the handful of columns the first payload rendered; this keeps
-- everything znma returns, so enriching the API later is a query change and
-- not a migration. Every table that holds an upstream document also holds it
-- verbatim in `raw` (minus the unlock codes, which are a PIN and answer no
-- question), so a field nobody has modelled yet is still recoverable.
--
-- Rebuild rather than ALTER: at this point the whole store is inside
-- Nintendo's own rolling window, so dropping it loses nothing. Later
-- migrations must be additive — once the window has moved past the first
-- synced day, D1 is the only copy.
--
-- All playing_time columns are MINUTES (the znma v2 unit).

DROP TABLE IF EXISTS daily_games;
DROP TABLE IF EXISTS daily_summaries;
DROP TABLE IF EXISTS games;
DROP TABLE IF EXISTS devices;
DROP TABLE IF EXISTS sync_runs;

CREATE TABLE account (
  nintendo_account_id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  country TEXT,
  language TEXT,
  mii_url TEXT,
  updated_at INTEGER NOT NULL,
  raw TEXT NOT NULL
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  external_nickname TEXT,
  region TEXT,
  platform_generation TEXT,
  serial_number TEXT,
  setting_status TEXT,
  extra_playing_time INTEGER,
  icon_light_url TEXT,
  icon_dark_url TEXT,
  -- R2 object keys for the mirrored icons (icons are bearer-gated upstream).
  icon_light_key TEXT,
  icon_dark_key TEXT,
  paired_at INTEGER,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  raw TEXT NOT NULL
);

CREATE TABLE players (
  player_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  nsa_id TEXT,
  nickname TEXT NOT NULL,
  image_url TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

CREATE TABLE daily_summaries (
  device_id TEXT NOT NULL,
  date TEXT NOT NULL,
  -- ACHIEVED once the day is closed, CALCULATING while it is still open.
  result TEXT NOT NULL,
  playing_time INTEGER NOT NULL,
  misc_time INTEGER NOT NULL DEFAULT 0,
  exceeded_time INTEGER NOT NULL DEFAULT 0,
  disabled_time INTEGER NOT NULL DEFAULT 0,
  tz_offset_seconds INTEGER,
  featured_image_url TEXT,
  -- Nintendo's own recalculation clock (dailySummaries.lastUpdatedAt), ms.
  observed_at INTEGER,
  updated_at INTEGER NOT NULL,
  raw TEXT NOT NULL,
  PRIMARY KEY (device_id, date)
);

CREATE INDEX idx_daily_summaries_date ON daily_summaries (date);

CREATE TABLE daily_players (
  device_id TEXT NOT NULL,
  date TEXT NOT NULL,
  player_id TEXT NOT NULL,
  playing_time INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, date, player_id)
);

CREATE TABLE daily_games (
  device_id TEXT NOT NULL,
  date TEXT NOT NULL,
  player_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  playing_time INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, date, player_id, application_id)
);

CREATE INDEX idx_daily_games_app ON daily_games (application_id, date);
CREATE INDEX idx_daily_games_date ON daily_games (date);

-- Catalog: identity and art from the API, the tail columns rebuilt from
-- daily_games after every sync.
CREATE TABLE games (
  application_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  shop_url TEXT,
  has_ugc INTEGER,
  safe_launch TEXT,
  -- firstPlayDate exists only on the parental-control setting's whitelist.
  first_play_date TEXT,
  image_extra_small TEXT,
  image_small TEXT,
  image_medium TEXT,
  image_large TEXT,
  image_extra_large TEXT,
  -- R2 object key of the mirrored cover; NULL until the mirror succeeds.
  image_key TEXT,
  total_playing_time INTEGER NOT NULL DEFAULT 0,
  day_count INTEGER NOT NULL DEFAULT 0,
  first_played_date TEXT,
  last_played_date TEXT,
  first_seen INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_games_total ON games (total_playing_time DESC);

-- One row per distinct parental-control setting revision, so a restriction
-- change is a new row rather than an overwrite.
CREATE TABLE setting_snapshots (
  device_id TEXT NOT NULL,
  etag TEXT NOT NULL,
  restriction_level TEXT,
  captured_at INTEGER NOT NULL,
  raw TEXT NOT NULL,
  PRIMARY KEY (device_id, etag)
);

CREATE TABLE sync_runs (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,
  device_count INTEGER,
  day_count INTEGER,
  game_count INTEGER,
  image_count INTEGER,
  error TEXT
);

CREATE INDEX idx_sync_runs_started ON sync_runs (started_at DESC);
