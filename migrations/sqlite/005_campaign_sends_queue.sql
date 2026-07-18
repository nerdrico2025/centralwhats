-- Disparo em massa (P3.2): campaign_sends vira a fila retomável.
-- vars = variáveis resolvidas por destinatário (congeladas no início).
-- attempts = tentativas (para retry só em rate-limit). Espelho de postgres/005.
ALTER TABLE campaign_sends ADD COLUMN vars TEXT;
ALTER TABLE campaign_sends ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS ix_campaign_sends_status ON campaign_sends (campaign_id, status);
