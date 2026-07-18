-- Disparo em massa (P3.2): campaign_sends vira a fila retomável.
-- Espelho de sqlite/005_campaign_sends_queue.sql.
ALTER TABLE campaign_sends ADD COLUMN IF NOT EXISTS vars TEXT;
ALTER TABLE campaign_sends ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS ix_campaign_sends_status ON campaign_sends (campaign_id, status);
