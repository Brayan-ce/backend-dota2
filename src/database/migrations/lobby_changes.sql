-- ============================================================
--  lobby_changes.sql
--  Agrega columnas de lobby de Dota 2 a la tabla salas
--  Ejecutar: psql -d dota_bets -f lobby_changes.sql
-- ============================================================

ALTER TABLE salas
  ADD COLUMN IF NOT EXISTS lobby_id        VARCHAR(50),
  ADD COLUMN IF NOT EXISTS lobby_password  VARCHAR(20),
  ADD COLUMN IF NOT EXISTS lobby_estado    VARCHAR(30) NOT NULL DEFAULT 'sin_lobby';

-- Índice para buscar salas por lobby_id rápido
CREATE INDEX IF NOT EXISTS idx_salas_lobby_id
  ON salas(lobby_id)
  WHERE lobby_id IS NOT NULL;

-- Comentarios descriptivos
COMMENT ON COLUMN salas.lobby_id       IS 'ID del lobby de Dota 2 creado por el bot Steam';
COMMENT ON COLUMN salas.lobby_password IS 'Contraseña del lobby generada automáticamente';
COMMENT ON COLUMN salas.lobby_estado   IS 'sin_lobby | creando | creado | jugadores_unidos | iniciado | error';
