-- App notifications (spec D88): one row per device that turned them on. `doc` holds the browser's
-- subscription (endpoint and keys) and the device name; a push service answering "gone" deletes it.
CREATE TABLE push_devices (endpoint TEXT PRIMARY KEY, account TEXT NOT NULL, created TEXT NOT NULL, doc TEXT NOT NULL);
CREATE INDEX push_devices_account ON push_devices (account);
