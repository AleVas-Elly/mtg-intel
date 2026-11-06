-- Small state that changes often (spec D67): moved out of KV, whose free plan allows only 1,000
-- writes and 1,000 lists a day and ran out of reads on 2026-11-06. The big documents stay in KV.

-- Passkeys: one row each, the JSON as the site stored it in KV (`auth:passkeys`).
CREATE TABLE passkeys (id TEXT PRIMARY KEY, created TEXT NOT NULL, doc TEXT NOT NULL);

-- When each device was last here (was `auth:seen:<passkey>`).
CREATE TABLE seen (cred TEXT PRIMARY KEY, doc TEXT NOT NULL);

-- Setup links already used (was `auth:used:<id>`); `until` in ms since the epoch.
CREATE TABLE used_invites (id TEXT PRIMARY KEY, until INTEGER NOT NULL);

-- The want-list edit queue (D50, was `edit:<at>:<id>`). `name` keeps the old key without the prefix,
-- so the Undo button on Telegram alerts sent before the move still finds its edit.
CREATE TABLE edits (name TEXT PRIMARY KEY, id TEXT NOT NULL, at TEXT NOT NULL, hold_until TEXT, doc TEXT NOT NULL);
CREATE INDEX edits_id ON edits (id);

-- The version and upload time of each KV document, so an unchanged one is answered 304 from here.
CREATE TABLE docs (key TEXT PRIMARY KEY, etag TEXT NOT NULL, at TEXT NOT NULL);

-- Small named values: failed edits, the fast-lane list, the watchdog, the last catch-up run.
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
