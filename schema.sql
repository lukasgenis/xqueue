-- xqueue storage: a personal X/Twitter post queue + scheduler settings.
-- Apply with:
--   npx wrangler d1 execute xqueue --remote --file=./schema.sql

-- One row per queued/posted/failed post.
CREATE TABLE IF NOT EXISTS queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'queued',  -- queued | posted | failed
  attempts   INTEGER NOT NULL DEFAULT 0,         -- post attempts so far (retry cap)
  error      TEXT,                               -- last error message, if any
  tweet_id   TEXT,                               -- X tweet id once posted
  created_at INTEGER NOT NULL,                   -- epoch ms, added-to-queue time
  posted_at  INTEGER,                            -- epoch ms, when it actually posted
  cost_usd   REAL,                               -- USD charged at post time (X pay-per-use)
  kind       TEXT,                               -- null | 'lightning' (personal feeling-post tag)
  media      TEXT                                -- JSON array of media ids (up to 4 images), or NULL
);

CREATE INDEX IF NOT EXISTS idx_queue_status ON queue (status, created_at);
CREATE INDEX IF NOT EXISTS idx_queue_posted ON queue (posted_at);

-- Single-row settings table (id is pinned to 1).
CREATE TABLE IF NOT EXISTS settings (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  interval_hours   INTEGER NOT NULL DEFAULT 6,      -- 1 | 3 | 6 | 9 | 12 | 24 | 0=paused
  last_posted_at   INTEGER,                         -- epoch ms of last successful post
  fx_usd_aud       REAL,                            -- legacy cached USD->AUD (still refreshed)
  fx_updated_at    INTEGER,                         -- epoch ms the rate was last fetched
  display_currency TEXT DEFAULT 'USD',              -- USD | EUR | GBP | AUD | CAD | NZD | JPY
  fx_rate          REAL                             -- cached USD -> display_currency rate
);

INSERT OR IGNORE INTO settings (id, interval_hours, display_currency) VALUES (1, 6, 'USD');

-- Failed passphrase attempts, for per-IP rate limiting. Pruned by the cron.
CREATE TABLE IF NOT EXISTS auth_attempts (
  ip TEXT    NOT NULL,
  ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_ip_ts ON auth_attempts (ip, ts);

-- Review deck: pending posts awaiting accept/reject triage (Tinder-style).
-- Accept queues immediately; reject discards. Over-280 items may sit here
-- (shown with a warning) but cannot be accepted until edited under the limit.
CREATE TABLE IF NOT EXISTS review_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT    NOT NULL,
  position   INTEGER NOT NULL,                   -- import order (lower = sooner)
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_review_position ON review_items (position, id);

-- Single-row undo slot for the most recent accept or reject in Review.
CREATE TABLE IF NOT EXISTS review_undo (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  action     TEXT,                               -- 'accept' | 'reject' | NULL
  text       TEXT,
  queue_id   INTEGER,                            -- set on accept (for undo)
  position   INTEGER,
  created_at INTEGER
);

INSERT OR IGNORE INTO review_undo (id) VALUES (1);

-- Demo AI rate limits (per IP, pruned by cron after 24h). Only used when DEMO=1.
CREATE TABLE IF NOT EXISTS demo_ai_calls (
  ip   TEXT    NOT NULL,
  kind TEXT    NOT NULL,  -- coach | generate
  ts   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_demo_ai_ip_kind_ts ON demo_ai_calls (ip, kind, ts);

-- Sparks vault: feeling-first drafts (Lightning), separate from the production queue.
-- status: draft | cooling | private | queued | posted
CREATE TABLE IF NOT EXISTS sparks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'draft',
  cool_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  posted_at  INTEGER,
  queue_id   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sparks_status ON sparks (status, updated_at);



-- Images attached to posts/drafts. The full file lives here until the post goes
-- out, then only the small JPEG thumb stays (for History). D1 rows cap at 2 MB,
-- so the UI resizes before upload (long side 2048, JPEG).
CREATE TABLE IF NOT EXISTS media (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  mime       TEXT    NOT NULL,                   -- image/jpeg | image/png | image/webp
  data       BLOB,                               -- full image; NULL once posted (if a thumb exists)
  thumb      BLOB,                               -- ~480px JPEG for the UI
  bytes      INTEGER,
  width      INTEGER,
  height     INTEGER,
  alt        TEXT,                               -- alt text (X bills $0.005 per image to set it)
  created_at INTEGER NOT NULL,
  posted_at  INTEGER
);

-- Drafts tab: suggestions (from AstroPiggy, or anything with the passphrase)
-- waiting to be checked. Queue/Post moves them into `queue`; Dismiss keeps the
-- row so its dedupe_key is never suggested again.
CREATE TABLE IF NOT EXISTS drafts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT    NOT NULL DEFAULT '',
  note       TEXT,                               -- why it was suggested (the fact behind it)
  source     TEXT,                               -- 'astropiggy' by default
  media      TEXT,                               -- JSON array of media ids
  dedupe_key TEXT    UNIQUE,                     -- e.g. 'region:IS' - never suggested twice
  status     TEXT    NOT NULL DEFAULT 'new',     -- new | queued | dismissed
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  queue_id   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts (status, created_at);
