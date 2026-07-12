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
  posted_at  INTEGER                             -- epoch ms, when it actually posted
);

CREATE INDEX IF NOT EXISTS idx_queue_status ON queue (status, created_at);
CREATE INDEX IF NOT EXISTS idx_queue_posted ON queue (posted_at);

-- Single-row settings table (id is pinned to 1).
CREATE TABLE IF NOT EXISTS settings (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  interval_hours INTEGER NOT NULL DEFAULT 3,      -- 1 | 3 | 6 | 9 | 12 | 24
  last_posted_at INTEGER                          -- epoch ms of last successful post
);

INSERT OR IGNORE INTO settings (id, interval_hours) VALUES (1, 3);
