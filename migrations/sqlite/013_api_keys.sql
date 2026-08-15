-- Chaves de API de SERVIÇO: como um sistema externo (sem usuário, sem login)
-- envia mensagem por este projeto. Espelho de postgres/013_api_keys.sql.
--
-- POR QUE não reaproveitar o JWT de usuário: ele expira em 7 dias e nasce de
-- um login com senha. Integração máquina-a-máquina que depende de renovar
-- token por gente é integração que cai num feriado.
--
-- POR QUE não reaproveitar o CRON_SECRET: ele é GLOBAL (uma env var para o
-- sistema inteiro). Uma chave global daria a qualquer portador acesso a
-- qualquer instância de qualquer org — o oposto do escopo por org que o
-- restante do sistema garante em requireInstance().
--
-- key_hash, nunca a chave: mesmo raciocínio de `invites.token_hash`. O valor em
-- claro existe UMA vez, na resposta da criação, e nunca mais. Vazamento desta
-- tabela não permite autenticar nada.
--
-- revoked_at (soft revoke), nunca DELETE: a chave revogada continua explicando
-- os envios que ela fez. Apagar a linha apagaria a resposta de "quem mandou
-- isto?".
CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  -- NULL = vale para qualquer instância DA MESMA ORG (nunca global).
  -- Preenchido = vale só para essa instância.
  instance_id  TEXT REFERENCES instances (id) ON DELETE CASCADE,
  key_hash     TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  created_by   TEXT,
  revoked_at   TEXT,
  last_used_at TEXT
);
-- A busca do middleware é sempre por hash: UNIQUE acima já serve de índice.
CREATE INDEX IF NOT EXISTS ix_api_keys_org ON api_keys (org_id, revoked_at);
