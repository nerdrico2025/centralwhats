-- P6.1 — Convites: como um segundo usuário entra numa conta existente.
-- Espelho de postgres/011_invites.sql.
--
-- Substitui a criação de usuário com senha ESCOLHIDA PELO OWNER (que fazia o
-- owner conhecer a senha do agente). Aqui o convidado define a própria senha.
--
-- token_hash, não o token: o link é o segredo e vive só no navegador de quem
-- convida. O banco guarda apenas o SHA-256 — vazamento da tabela não permite
-- aceitar convite nenhum. Uso único: o aceite muda status para 'accepted' na
-- MESMA operação que cria o vínculo.
CREATE TABLE IF NOT EXISTS invites (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  email            TEXT NOT NULL,
  role             TEXT NOT NULL DEFAULT 'agent',
  token_hash       TEXT NOT NULL UNIQUE,
  -- pending | accepted | revoked  (expirado é derivado de expires_at)
  status           TEXT NOT NULL DEFAULT 'pending',
  expires_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  created_by       TEXT,
  accepted_at      TEXT,
  accepted_user_id TEXT
);
CREATE INDEX IF NOT EXISTS ix_invites_org ON invites (org_id, status);
