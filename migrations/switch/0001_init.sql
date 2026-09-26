-- Authoritative play-activity store synced from Nintendo Parental Controls.
-- playing_time columns store minutes (znma v2 API unit).

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  label TEXT,
  firmware_version TEXT,
  region TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

CREATE TABLE daily_summaries (
  device_id TEXT NOT NULL,
  date TEXT NOT NULL,
  playing_time INTEGER NOT NULL,
  misc_time INTEGER NOT NULL DEFAULT 0,
  result TEXT NOT NULL,
  last_played_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, date)
);

CREATE INDEX idx_daily_summaries_date ON daily_summaries (date);

CREATE TABLE daily_games (
  device_id TEXT NOT NULL,
  date TEXT NOT NULL,
  application_id TEXT NOT NULL,
  title TEXT NOT NULL,
  image_url TEXT,
  playing_time INTEGER NOT NULL,
  first_play_date TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, date, application_id)
);

CREATE INDEX idx_daily_games_app ON daily_games (application_id);

CREATE TABLE games (
  application_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  image_url TEXT,
  first_play_date TEXT,
  total_playing_time INTEGER NOT NULL DEFAULT 0,
  last_played_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE sync_runs (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,
  daily_count INTEGER,
  error TEXT
);

CREATE INDEX idx_sync_runs_started ON sync_runs (started_at);
