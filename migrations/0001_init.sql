-- agentpeer D1 / SQLite schema (MVP)
-- Same SQL is used by Cloudflare D1 and local node:sqlite tests.

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'ounce',
  channel TEXT NOT NULL DEFAULT 'email',
  source TEXT NOT NULL DEFAULT 'forwardemail',
  message_id TEXT,
  thread_id TEXT,
  from_addr TEXT,
  from_name TEXT,
  recipients_json TEXT,
  recipient TEXT,
  kind TEXT,
  auth_json TEXT,
  subject TEXT,
  text TEXT,
  raw_ref TEXT,
  attachments_meta_json TEXT,
  headers_subset_json TEXT,
  received_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  route_id TEXT,
  dedup_key TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedup ON messages(dedup_key);
CREATE INDEX IF NOT EXISTS idx_messages_thread_ts ON messages(thread_id, received_at);
CREATE INDEX IF NOT EXISTS idx_messages_from_ts ON messages(from_addr, received_at);
CREATE INDEX IF NOT EXISTS idx_messages_recipient_ts ON messages(recipient, received_at);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);

CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  target TEXT,
  adapter TEXT,
  attempt INTEGER NOT NULL,
  http_status INTEGER,
  error TEXT,
  at INTEGER NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id)
);

CREATE INDEX IF NOT EXISTS idx_deliveries_message ON deliveries(message_id);

CREATE TABLE IF NOT EXISTS routes (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  type TEXT NOT NULL,
  target TEXT,
  allowed_senders_json TEXT,
  updated_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_routes_address ON routes(address);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT,
  type TEXT NOT NULL,
  detail TEXT,
  at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_message ON events(message_id);
CREATE INDEX IF NOT EXISTS idx_events_type_at ON events(type, at);
