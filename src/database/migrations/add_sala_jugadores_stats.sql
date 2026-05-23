-- Tabla de estadísticas por jugador por sala (poblada desde match_raw_data de Steam/OpenDota)
-- Soporta 1v1, 3v3 y 5v5

CREATE TABLE IF NOT EXISTS sala_jugadores_stats (
    id              SERIAL PRIMARY KEY,
    id_sala         INTEGER NOT NULL REFERENCES salas(id) ON DELETE CASCADE,
    id_usuario      INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
    steam_id        VARCHAR(20),                    -- para cruzar con OpenDota aunque el usuario no esté registrado
    banda           VARCHAR(10) NOT NULL,           -- 'radiant' | 'dire'
    -- Stats de la partida
    kills           INTEGER     NOT NULL DEFAULT 0,
    deaths          INTEGER     NOT NULL DEFAULT 0,
    assists         INTEGER     NOT NULL DEFAULT 0,
    net_worth       INTEGER     NOT NULL DEFAULT 0, -- oro total al final
    gpm             INTEGER     NOT NULL DEFAULT 0, -- gold per minute
    xpm             INTEGER     NOT NULL DEFAULT 0, -- experience per minute
    hero_damage     INTEGER     NOT NULL DEFAULT 0,
    tower_damage    INTEGER     NOT NULL DEFAULT 0,
    hero_healing    INTEGER     NOT NULL DEFAULT 0,
    last_hits       INTEGER     NOT NULL DEFAULT 0,
    denies          INTEGER     NOT NULL DEFAULT 0,
    level           INTEGER     NOT NULL DEFAULT 1,
    hero_id         INTEGER,                        -- hero_id de Dota 2
    -- Metadata
    creado_en       TIMESTAMP   NOT NULL DEFAULT NOW(),
    UNIQUE (id_sala, id_usuario),
    UNIQUE (id_sala, steam_id)
);

CREATE INDEX IF NOT EXISTS idx_sala_jugadores_stats_sala ON sala_jugadores_stats(id_sala);
CREATE INDEX IF NOT EXISTS idx_sala_jugadores_stats_usuario ON sala_jugadores_stats(id_usuario);
