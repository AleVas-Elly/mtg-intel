-- The Alerts page (spec D88): every alert the bot sends, in its section (deals, digest, system).
-- `doc` is what the page shows; a live deal alert is updated in place as it changes. Kept 30 days.
CREATE TABLE alerts (id TEXT PRIMARY KEY, section TEXT NOT NULL, at TEXT NOT NULL, updated TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0, doc TEXT NOT NULL);
CREATE INDEX alerts_at ON alerts (at);
