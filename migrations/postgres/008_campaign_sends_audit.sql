-- P3.1: auditoria completa por destinatário + claim atômico do lote.
-- contact_id     = liga o envio ao contato. NOT NULL: toda linha da fila nasce
--                  de um contato resolvido, nunca de um telefone solto.
-- wa_message_id  = id da Meta do envio bem-sucedido (correlação direta).
-- claimed_at     = quando o lote pegou esta linha (recupera tick que morreu).
-- Espelho de sqlite/008_campaign_sends_audit.sql.
ALTER TABLE campaign_sends ADD COLUMN IF NOT EXISTS contact_id TEXT;
ALTER TABLE campaign_sends ADD COLUMN IF NOT EXISTS wa_message_id TEXT;
ALTER TABLE campaign_sends ADD COLUMN IF NOT EXISTS claimed_at TEXT;

-- Backfill de linhas antigas: recupera o contato pelo telefone, no escopo da
-- instância da campanha. Em produção campaign_sends está vazia — isto é rede
-- de segurança para outros ambientes.
UPDATE campaign_sends s
   SET contact_id = c.id
  FROM contacts c, campaigns k
 WHERE k.id = s.campaign_id
   AND c.instance_id = k.instance_id
   AND c.phone = s.contact_phone
   AND s.contact_id IS NULL;

-- Se alguma linha órfã sobrar, este ALTER falha de propósito: melhor a
-- migration parar alto do que gravar auditoria sem dono.
ALTER TABLE campaign_sends ALTER COLUMN contact_id SET NOT NULL;
