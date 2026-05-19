-- Migración para sistema de sorteo 1v1 con sanciones
-- Agregar campo para marcar si un jugador ya fue sorteado en sala_jugadores
-- Agregar campo para banda vacante en salas (cuando alguien se sale después del sorteo)

-- Verificar y agregar columna sorteado a sala_jugadores si no existe
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'sala_jugadores' AND column_name = 'sorteado'
    ) THEN
        ALTER TABLE sala_jugadores ADD COLUMN sorteado BOOLEAN NOT NULL DEFAULT FALSE;
    END IF;
END $$;

-- Verificar y agregar columna banda_vacante a salas si no existe
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'salas' AND column_name = 'banda_vacante'
    ) THEN
        ALTER TABLE salas ADD COLUMN banda_vacante VARCHAR(20) DEFAULT NULL;
    END IF;
END $$;

-- Verificar y agregar columna sorteo_pendiente a salas si no existe (para control de sorteo)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'salas' AND column_name = 'sorteo_pendiente'
    ) THEN
        ALTER TABLE salas ADD COLUMN sorteo_pendiente BOOLEAN NOT NULL DEFAULT TRUE;
    END IF;
END $$;

-- Comentarios
COMMENT ON COLUMN sala_jugadores.sorteado IS 'Indica si el jugador ya participó en el sorteo de equipos (1v1)';
COMMENT ON COLUMN salas.banda_vacante IS 'Guarda la banda del jugador que se salió después del sorteo (para que el siguiente entre sin sorteo)';
COMMENT ON COLUMN salas.sorteo_pendiente IS 'Indica si el sorteo aún no se ha realizado en esta sala';
