-- ============================================================
--  stickers_premium_changes.sql
--  Agrega soporte premium (saldo >= 1000) y stickers en chat
--  Ejecutar: psql -d dota_bets -f stickers_premium_changes.sql
-- ============================================================

-- Campo para marcar si un mensaje del chat general es un sticker
ALTER TABLE mensajes_chat_general
  ADD COLUMN IF NOT EXISTS tipo VARCHAR(10) NOT NULL DEFAULT 'texto',
  ADD COLUMN IF NOT EXISTS sticker_id INTEGER;

COMMENT ON COLUMN mensajes_chat_general.tipo       IS 'texto | sticker';
COMMENT ON COLUMN mensajes_chat_general.sticker_id IS 'ID numérico del sticker (1-90), null si es texto';
