-- P6.1 — Vínculo N:N usuário↔org (modelo agência) + campos de ciclo de vida.
-- Espelho de sqlite/010_org_members.sql.
--
-- POR QUÊ: até aqui o vínculo era a coluna users.org_id, o que amarrava um
-- usuário a exatamente uma conta. No modelo agência a mesma pessoa administra
-- várias contas de cliente, então o vínculo (e o PAPEL, que pode ser diferente
-- em cada conta) vira uma linha própria.
--
-- users.org_id NÃO é removida: vira CACHE da org de entrada (a última ativa /
-- a primeira que o usuário teve). A FONTE DA VERDADE do vínculo e do papel é
-- org_members — quem lê org_id direto para decidir acesso está errado.

CREATE TABLE IF NOT EXISTS org_members (
  org_id     TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'agent',
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS ix_org_members_user ON org_members (user_id);

-- MIGRAÇÃO SEM PERDA: todo vínculo que hoje existe em users vira uma linha
-- aqui, com o MESMO papel. Nenhum usuário perde acesso.
INSERT INTO org_members (org_id, user_id, role, created_at)
  SELECT org_id, id, role, created_at FROM users
  ON CONFLICT (org_id, user_id) DO NOTHING;

-- status: 'active' | 'disabled'. Desabilitar derruba a sessão (o middleware
-- checa a cada request) sem apagar a linha nem o histórico.
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
-- password_changed_at: token emitido ANTES desta marca é recusado. É a
-- revogação de sessão sem tabela de revogação.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TEXT;
