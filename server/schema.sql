-- FlowState Testing — D1 schema (SPEC §6).
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS access_codes (
  code            TEXT PRIMARY KEY,
  label           TEXT,
  condition       TEXT,                -- nullable; default = full pool
  session_minutes INTEGER NOT NULL DEFAULT 30,
  max_uses        INTEGER,             -- NULL = unlimited
  uses_count      INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at      TEXT
);

CREATE TABLE IF NOT EXISTS participants (
  id          TEXT PRIMARY KEY,        -- client UUID
  access_code TEXT,
  platform    TEXT,                    -- ios | android | web
  app_version TEXT,
  device      TEXT,                    -- JSON: model, OS, etc. (expo-device)
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS demographics (
  participant_id      TEXT PRIMARY KEY,
  age_band            TEXT,
  sex_at_birth        TEXT,
  gender_identity     TEXT,
  daily_shortform_use TEXT,
  consent_18plus      INTEGER NOT NULL DEFAULT 0,
  submitted_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,     -- server UUID
  participant_id TEXT,
  access_code    TEXT,
  condition      TEXT,
  playlist_seed  TEXT,                 -- reproduces the shuffled order
  started_at     TEXT NOT NULL DEFAULT (datetime('now')),
  ends_at        TEXT NOT NULL,
  ended_at       TEXT,
  end_reason     TEXT                  -- timeout | manual | background
);

CREATE TABLE IF NOT EXISTS videos (
  id               TEXT PRIMARY KEY,
  slug             TEXT UNIQUE,
  title            TEXT,
  r2_key           TEXT NOT NULL,      -- object key in the R2 bucket
  duration_seconds REAL,
  content_type     TEXT,               -- the "kind of media" dimension
  condition        TEXT,
  sort_order       INTEGER,
  active           INTEGER NOT NULL DEFAULT 1,
  pinned           INTEGER NOT NULL DEFAULT 0  -- 1 = forced to the front of the feed, un-shuffled, in sort_order
);

CREATE TABLE IF NOT EXISTS events (
  id             TEXT PRIMARY KEY,     -- client UUID (idempotency)
  session_id     TEXT,
  participant_id TEXT,
  video_id       TEXT,
  event_type     TEXT NOT NULL,
  feed_position  INTEGER,
  client_ts      TEXT,
  server_ts      TEXT NOT NULL,
  payload        TEXT                  -- JSON blob
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_video   ON events(video_id);
