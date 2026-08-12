-- P6.1 / L3 — instances.org_id passa a ser NOT NULL com FK para orgs.
-- Espelho de postgres/012_instances_org_not_null.sql.
--
-- POR QUÊ: o default 'org_default' morava no ADAPTER, não no banco. Qualquer
-- escrita que não passasse por repo.* (script, psql na mão, migration futura)
-- criava instância SEM DONO — invisível para todo usuário, mas ainda varrida
-- por cron, webhook e worker. Instância órfã é a forma mais silenciosa de
-- perder dado neste sistema.
--
-- ON DELETE RESTRICT (e não CASCADE) de propósito: apagar uma org que ainda
-- tem instância deve DOER, não sumir com conversas reais em cascata.
--
-- O SQLite não tem ALTER COLUMN / ADD CONSTRAINT: a mudança exige reconstruir
-- a tabela (procedimento oficial de 12 passos). foreign_keys=OFF durante a
-- troca impede que o DROP dispare cascata nas tabelas filhas.

-- Rede de segurança: qualquer linha órfã volta para a org default antes da
-- trava. Se sobrar org_id apontando para org inexistente, o passo do INSERT
-- falha ALTO — melhor a migration parar do que gravar dado sem dono.
UPDATE instances SET org_id = 'org_default' WHERE org_id IS NULL;

PRAGMA foreign_keys = OFF;

CREATE TABLE instances_new (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES orgs (id) ON DELETE RESTRICT,
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

INSERT INTO instances_new
  (id, org_id, name, provider_type, phone_number_id, waba_id, token,
   verify_token, active, connection_status, created_at)
  SELECT id, org_id, name, provider_type, phone_number_id, waba_id, token,
         verify_token, active, connection_status, created_at
    FROM instances;

DROP TABLE instances;
ALTER TABLE instances_new RENAME TO instances;

CREATE UNIQUE INDEX IF NOT EXISTS ux_instances_phone_number_id
  ON instances (phone_number_id) WHERE phone_number_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_instances_org ON instances (org_id);

PRAGMA foreign_keys = ON;
