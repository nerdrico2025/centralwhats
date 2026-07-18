-- Adiciona coluna de notas ao CRM (P1.5). Espelho de sqlite/002_crm_notes.sql.
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS notes TEXT;
