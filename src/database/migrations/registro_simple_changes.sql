-- ============================================================
--  registro_simple_changes.sql
--  Permite registro con email+password (sin Steam)
--  Ejecutar: psql -d dota_bets -f registro_simple_changes.sql
-- ============================================================

-- Hacer steam_id opcional (los registros simples no tendrán Steam)
ALTER TABLE usuarios
  ALTER COLUMN steam_id DROP NOT NULL;

-- Agregar campo de contraseña (solo lo usan los registros simples)
ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);

-- Índice para login por email
CREATE UNIQUE INDEX IF NOT EXISTS uq_usuarios_email
  ON usuarios(LOWER(email))
  WHERE email IS NOT NULL;

COMMENT ON COLUMN usuarios.password_hash IS 'Hash bcrypt — solo usuarios registrados sin Steam';
