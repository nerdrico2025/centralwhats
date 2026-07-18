-- Marca de leitura por conversa (Live Chat / P2.2). Espelho de postgres/003.
-- unread = mensagens inbound com created_at > last_read_at.
ALTER TABLE contacts ADD COLUMN last_read_at TEXT;
