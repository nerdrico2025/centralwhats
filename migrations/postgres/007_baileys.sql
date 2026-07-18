-- V2 / P5.2 — Baileys: outbox (ponte web→worker) + sessão persistida.
-- Espelho de sqlite/007_baileys.sql.

CREATE TABLE IF NOT EXISTS outbox (
  id          TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES instances (id) ON DELETE CASCADE,
  to_number   TEXT NOT NULL,
  payload     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  error       TEXT,
  message_id  TEXT,
  created_at  TEXT NOT NULL,
  sent_at     TEXT
);
CREATE INDEX IF NOT EXISTS ix_outbox_pending ON outbox (instance_id, status, created_at);

CREATE TABLE IF NOT EXISTS baileys_auth (
  instance_id TEXT NOT NULL REFERENCES instances (id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (instance_id, key)
);
