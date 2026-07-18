-- V2 / P5.1 — Multi-tenancy: orgs + users + org_id em instances.
-- Espelho de postgres/006_orgs.sql.
-- Migração SEM PERDA: cria a org default e associa as instâncias existentes.

CREATE TABLE IF NOT EXISTS orgs (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  plan       TEXT NOT NULL DEFAULT 'free',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  email         TEXT NOT NULL UNIQUE,
  role          TEXT NOT NULL DEFAULT 'agent',
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

ALTER TABLE instances ADD COLUMN org_id TEXT;

-- Org default: destino das instâncias da V1 (uso próprio continua funcionando).
INSERT OR IGNORE INTO orgs (id, name, plan, created_at)
  VALUES ('org_default', 'Org Padrão', 'free', '2026-07-18T00:00:00.000Z');

UPDATE instances SET org_id = 'org_default' WHERE org_id IS NULL;

CREATE INDEX IF NOT EXISTS ix_instances_org ON instances (org_id);
CREATE INDEX IF NOT EXISTS ix_users_org ON users (org_id);
