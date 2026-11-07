-- People and access (spec D76): each passkey belongs to an account. The passkeys made before this
-- are mine, the account `owner`, which always has every permission.

CREATE TABLE accounts (id TEXT PRIMARY KEY, created TEXT NOT NULL, doc TEXT NOT NULL);
INSERT INTO accounts (id, created, doc) VALUES ('owner', '2026-10-21T00:00:00.000Z',
  '{"id":"owner","name":"You","created":"2026-10-21T00:00:00.000Z","expires":null,"preset":"owner","perms":{}}');

ALTER TABLE passkeys ADD COLUMN account TEXT NOT NULL DEFAULT 'owner';
CREATE INDEX passkeys_account ON passkeys (account);

-- Cards someone suggested for my want-list, waiting for Add or Dismiss.
CREATE TABLE suggestions (id TEXT PRIMARY KEY, account TEXT NOT NULL, at TEXT NOT NULL, doc TEXT NOT NULL);

-- What each person did (joined, signed in, changed the want-list, suggested, access changed); kept 90 days.
CREATE TABLE activity (n INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, at TEXT NOT NULL, what TEXT NOT NULL);
CREATE INDEX activity_account ON activity (account, at);
