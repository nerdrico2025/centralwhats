-- Marca de leitura por conversa (Live Chat / P2.2). Espelho de sqlite/003.
-- unread = mensagens inbound com created_at > last_read_at.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_read_at TEXT;
