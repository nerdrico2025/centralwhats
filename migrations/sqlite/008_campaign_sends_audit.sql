-- P3.1: auditoria completa por destinatário + claim atômico do lote.
-- contact_id     = liga o envio ao contato. NOT NULL: toda linha da fila nasce
--                  de um contato resolvido, nunca de um telefone solto.
-- wa_message_id  = id da Meta do envio bem-sucedido (correlação direta).
-- claimed_at     = quando o lote pegou esta linha (recupera tick que morreu).
--
-- O SQLite não deixa adicionar coluna NOT NULL via ALTER sem default, e um
-- default sentinela ('') derrotaria a constraint. Por isso a tabela é
-- reconstruída. Linhas antigas (sem contact_id) têm o contato recuperado pelo
-- telefone, no escopo da instância da campanha. Espelho de postgres/008.
PRAGMA foreign_keys=OFF;

CREATE TABLE campaign_sends_new (
  id            TEXT PRIMARY KEY,
  campaign_id   TEXT NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  contact_id    TEXT NOT NULL,
  contact_phone TEXT NOT NULL,
  status        TEXT NOT NULL,
  wa_message_id TEXT,
  error_code    TEXT,
  error_message TEXT,
  sent_at       TEXT,
  claimed_at    TEXT,
  vars          TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0
);

INSERT INTO campaign_sends_new
  (id, campaign_id, contact_id, contact_phone, status, wa_message_id,
   error_code, error_message, sent_at, claimed_at, vars, attempts)
SELECT
  s.id,
  s.campaign_id,
  (SELECT c.id FROM contacts c
     JOIN campaigns k ON k.id = s.campaign_id
    WHERE c.instance_id = k.instance_id AND c.phone = s.contact_phone),
  s.contact_phone,
  s.status,
  NULL,
  s.error_code,
  s.error_message,
  s.sent_at,
  NULL,
  s.vars,
  s.attempts
FROM campaign_sends s;

DROP TABLE campaign_sends;
ALTER TABLE campaign_sends_new RENAME TO campaign_sends;

CREATE INDEX IF NOT EXISTS ix_campaign_sends_campaign ON campaign_sends (campaign_id);
CREATE INDEX IF NOT EXISTS ix_campaign_sends_status ON campaign_sends (campaign_id, status);

PRAGMA foreign_keys=ON;
