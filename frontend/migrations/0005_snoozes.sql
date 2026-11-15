-- Snoozed cards (spec D88): a card's deal alerts stay on the Alerts page without ringing until
-- `until` (ISO), or ring only below `below` (EUR), or both. `card` is the wish key.
CREATE TABLE snoozes (card TEXT PRIMARY KEY, until TEXT, below REAL, doc TEXT NOT NULL);
