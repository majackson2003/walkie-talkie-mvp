CREATE TABLE IF NOT EXISTS channels (
  code TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel_code TEXT NOT NULL,
  from_user_id TEXT NOT NULL,
  from_nickname TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('routine', 'important', 'urgent')),
  mime_type TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  payload BLOB NOT NULL,
  FOREIGN KEY (channel_code) REFERENCES channels(code) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_channel_created
  ON messages(channel_code, created_at DESC);

CREATE TABLE IF NOT EXISTS emergency_log (
  id TEXT PRIMARY KEY,
  channel_code TEXT NOT NULL,
  from_user_id TEXT NOT NULL,
  from_nickname TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('routine', 'important', 'urgent')),
  message TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_emergency_created
  ON emergency_log(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_channels_last_activity
  ON channels(last_activity_at DESC);
