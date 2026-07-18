-- WA Manager — schema inicial (SQLite / dev). Espelho de migrations/postgres/001_init.sql.
-- Convenções portáveis: id TEXT (UUID gerado no app), timestamps TEXT (ISO 8601),
-- JSON como TEXT, booleanos como INTEGER (0/1). Tabelas [V2] ficam para a Fase 5.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS instances (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  provider_type     TEXT NOT NULL DEFAULT 'meta',
  phone_number_id   TEXT,
  waba_id           TEXT,
  token             TEXT,
  verify_token      TEXT,
  active            INTEGER NOT NULL DEFAULT 1,
  connection_status TEXT NOT NULL DEFAULT 'disconnected',
  created_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_instances_phone_number_id
  ON instances (phone_number_id) WHERE phone_number_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS contacts (
  id          TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES instances (id) ON DELETE CASCADE,
  phone       TEXT NOT NULL,
  name        TEXT,
  last_seen   TEXT,
  UNIQUE (instance_id, phone)
);
CREATE INDEX IF NOT EXISTS ix_contacts_instance ON contacts (instance_id);

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,
  instance_id   TEXT NOT NULL REFERENCES instances (id) ON DELETE CASCADE,
  direction     TEXT NOT NULL,
  from_number   TEXT NOT NULL,
  to_number     TEXT NOT NULL,
  type          TEXT NOT NULL,
  content       TEXT,
  status        TEXT NOT NULL DEFAULT 'queued',
  error_code    TEXT,
  error_message TEXT,
  wa_message_id TEXT,
  campaign_id   TEXT,
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_messages_wamid
  ON messages (instance_id, wa_message_id) WHERE wa_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_messages_conv
  ON messages (instance_id, from_number, to_number, created_at);

CREATE TABLE IF NOT EXISTS templates (
  id             TEXT PRIMARY KEY,
  instance_id    TEXT NOT NULL REFERENCES instances (id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  category       TEXT,
  language       TEXT NOT NULL,
  status         TEXT,
  components     TEXT,
  wa_template_id TEXT,
  UNIQUE (instance_id, name, language)
);

CREATE TABLE IF NOT EXISTS tags (
  id          TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES instances (id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       TEXT,
  UNIQUE (instance_id, name)
);

CREATE TABLE IF NOT EXISTS contact_tags (
  contact_id TEXT NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  tag_id     TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  PRIMARY KEY (contact_id, tag_id)
);

CREATE TABLE IF NOT EXISTS crm_contacts (
  id            TEXT PRIMARY KEY,
  instance_id   TEXT NOT NULL REFERENCES instances (id) ON DELETE CASCADE,
  contact_id    TEXT NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  phone         TEXT NOT NULL,
  name          TEXT,
  stage         TEXT,
  score         INTEGER,
  custom_fields TEXT,
  UNIQUE (instance_id, contact_id)
);

CREATE TABLE IF NOT EXISTS contact_lists (
  id          TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES instances (id) ON DELETE CASCADE,
  name        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS list_contacts (
  list_id    TEXT NOT NULL REFERENCES contact_lists (id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  PRIMARY KEY (list_id, contact_id)
);

CREATE TABLE IF NOT EXISTS campaigns (
  id               TEXT PRIMARY KEY,
  instance_id      TEXT NOT NULL REFERENCES instances (id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  template_id      TEXT,
  sent_count       INTEGER NOT NULL DEFAULT 0,
  failed_count     INTEGER NOT NULL DEFAULT 0,
  total_recipients INTEGER NOT NULL DEFAULT 0,
  interval_ms      INTEGER NOT NULL DEFAULT 1000,
  status           TEXT NOT NULL DEFAULT 'draft',
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaign_sends (
  id            TEXT PRIMARY KEY,
  campaign_id   TEXT NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  contact_phone TEXT NOT NULL,
  status        TEXT NOT NULL,
  error_code    TEXT,
  error_message TEXT,
  sent_at       TEXT
);
CREATE INDEX IF NOT EXISTS ix_campaign_sends_campaign ON campaign_sends (campaign_id);

CREATE TABLE IF NOT EXISTS flows (
  id               TEXT PRIMARY KEY,
  instance_id      TEXT NOT NULL REFERENCES instances (id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  trigger_keywords TEXT,
  nodes            TEXT,
  edges            TEXT,
  active           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS flow_executions (
  id              TEXT PRIMARY KEY,
  flow_id         TEXT NOT NULL REFERENCES flows (id) ON DELETE CASCADE,
  instance_id     TEXT NOT NULL REFERENCES instances (id) ON DELETE CASCADE,
  contact_phone   TEXT NOT NULL,
  current_node_id TEXT,
  status          TEXT NOT NULL DEFAULT 'running',
  variables       TEXT,
  next_step_at    TEXT,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_flow_exec_due
  ON flow_executions (instance_id, status, next_step_at);
CREATE INDEX IF NOT EXISTS ix_flow_exec_lock
  ON flow_executions (flow_id, contact_phone, status);

CREATE TABLE IF NOT EXISTS flow_node_counters (
  flow_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (flow_id, node_id)
);
