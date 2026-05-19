DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;

CREATE TABLE IF NOT EXISTS usuarios (
    id SERIAL PRIMARY KEY,
    steam_id VARCHAR(20) UNIQUE,
    nombre_usuario VARCHAR(100) NOT NULL,
    avatar VARCHAR(500),
    mmr INTEGER,
    saldo DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    bono DECIMAL(10,2) NOT NULL DEFAULT 10.00,
    nivel INTEGER NOT NULL DEFAULT 1,
    esta_baneado BOOLEAN NOT NULL DEFAULT FALSE,
    email VARCHAR(255),
    telefono VARCHAR(20),
    nombre_real VARCHAR(150),
    pais VARCHAR(60),
    password_hash VARCHAR(255),
    bono_bienvenida_alerta_mostrada BOOLEAN NOT NULL DEFAULT FALSE,
    steam_actualizado_en TIMESTAMP DEFAULT NOW(),
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS superadmin_usuarios (
    id SERIAL PRIMARY KEY,
    usuario VARCHAR(60) NOT NULL UNIQUE,
    password_hash VARCHAR(120) NOT NULL,
    rol VARCHAR(20) NOT NULL DEFAULT 'superadmin',
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (rol IN ('superadmin'))
);

CREATE TABLE IF NOT EXISTS codigos_verificacion (
    id SERIAL PRIMARY KEY,
    steam_id VARCHAR(20) NOT NULL,
    codigo VARCHAR(6) NOT NULL,
    expira_en TIMESTAMP NOT NULL,
    usado BOOLEAN NOT NULL DEFAULT FALSE,
    creado_en TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS partidas (
    id SERIAL PRIMARY KEY,
    match_id VARCHAR(20) UNIQUE NOT NULL,
    descripcion TEXT,
    estado VARCHAR(20) NOT NULL DEFAULT 'pendiente',
    resultado VARCHAR(20),
    datos_en_vivo JSONB,
    duracion INTEGER,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS salas (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL,
    descripcion TEXT,
    id_creador INTEGER REFERENCES usuarios(id),
    tipo VARCHAR(30) NOT NULL DEFAULT 'normal',
    modo VARCHAR(30) NOT NULL DEFAULT 'All Pick',
    max_jugadores INTEGER NOT NULL DEFAULT 10,
    jugadores_actuales INTEGER NOT NULL DEFAULT 0,
    estado VARCHAR(20) NOT NULL DEFAULT 'esperando',
    limite_mmr_min INTEGER NOT NULL DEFAULT 0,
    limite_mmr_max INTEGER NOT NULL DEFAULT 99999,
    entrada DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    premio DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    es_automatico BOOLEAN NOT NULL DEFAULT FALSE,
    fecha_inicio TIMESTAMP,
    aviso_admin BOOLEAN NOT NULL DEFAULT FALSE,
    configuracion JSONB,
    lobby_id VARCHAR(50),
    lobby_password VARCHAR(20),
    lobby_estado VARCHAR(30) NOT NULL DEFAULT 'sin_lobby',
    banda_vacante VARCHAR(20),
    sorteo_pendiente BOOLEAN NOT NULL DEFAULT TRUE,
    creada_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizada_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS partidas_en_vivo (
    id SERIAL PRIMARY KEY,
    id_sala INTEGER REFERENCES salas(id) ON DELETE SET NULL,
    titulo VARCHAR(120) NOT NULL,
    descripcion TEXT,
    match_id VARCHAR(20),
    lobby_id VARCHAR(30),
    estado VARCHAR(20) NOT NULL DEFAULT 'programada',
    modo_visualizacion VARCHAR(20) NOT NULL DEFAULT 'oficial_valve',
    delay_segundos INTEGER NOT NULL DEFAULT 120,
    stream_url TEXT,
    radiant_nombre VARCHAR(80),
    dire_nombre VARCHAR(80),
    score_radiant INTEGER NOT NULL DEFAULT 0,
    score_dire INTEGER NOT NULL DEFAULT 0,
    estado_partida VARCHAR(60),
    tiempo_partida_segundos INTEGER,
    items_resumen JSONB NOT NULL DEFAULT '[]'::jsonb,
    fuente_datos VARCHAR(40) NOT NULL DEFAULT 'manual',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    es_publica BOOLEAN NOT NULL DEFAULT TRUE,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    publicado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
    ultima_sincronizacion TIMESTAMP,
    creada_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizada_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (estado IN ('programada', 'en_vivo', 'pausada', 'finalizada', 'cancelada')),
    CHECK (modo_visualizacion IN ('oficial_valve', 'stats_delay', 'hibrido')),
    CHECK (delay_segundos >= 0 AND delay_segundos <= 7200),
    CHECK (score_radiant >= 0),
    CHECK (score_dire >= 0),
    CHECK (tiempo_partida_segundos IS NULL OR tiempo_partida_segundos >= 0)
);

CREATE TABLE IF NOT EXISTS apuestas (
    id SERIAL PRIMARY KEY,
    id_usuario INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
    id_partida INTEGER REFERENCES partidas(id) ON DELETE CASCADE,
    tipo_apuesta VARCHAR(50) NOT NULL,
    monto DECIMAL(10,2) NOT NULL,
    prediccion VARCHAR(50) NOT NULL,
    estado VARCHAR(20) NOT NULL DEFAULT 'pendiente',
    ganancia DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transacciones (
    id SERIAL PRIMARY KEY,
    id_usuario INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
    tipo VARCHAR(30) NOT NULL,
    monto DECIMAL(10,2) NOT NULL,
    descripcion TEXT,
    referencia_id INTEGER,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sala_jugadores (
    id SERIAL PRIMARY KEY,
    id_sala INTEGER REFERENCES salas(id) ON DELETE CASCADE,
    id_usuario INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
    banda VARCHAR(10) NOT NULL DEFAULT 'radiant',
    equipo VARCHAR(20),
    listo BOOLEAN NOT NULL DEFAULT FALSE,
    sorteado BOOLEAN NOT NULL DEFAULT FALSE,
    unido_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(id_sala, id_usuario)
);

CREATE TABLE IF NOT EXISTS amigos (
    id SERIAL PRIMARY KEY,
    id_usuario INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
    id_amigo INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
    estado VARCHAR(20) NOT NULL DEFAULT 'pendiente',
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(id_usuario, id_amigo)
);

CREATE TABLE IF NOT EXISTS mensajes_chat_general (
    id SERIAL PRIMARY KEY,
    id_usuario INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
    mensaje TEXT NOT NULL,
    tipo VARCHAR(10) NOT NULL DEFAULT 'texto',
    sticker_id INTEGER,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (tipo IN ('texto', 'sticker'))
);

CREATE TABLE IF NOT EXISTS mensajes_chat_privado (
    id SERIAL PRIMARY KEY,
    id_emisor INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
    id_receptor INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
    mensaje TEXT NOT NULL,
    leido BOOLEAN NOT NULL DEFAULT FALSE,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS mensajes_soporte (
    id SERIAL PRIMARY KEY,
    id_usuario INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
    mensaje TEXT NOT NULL,
    es_admin BOOLEAN NOT NULL DEFAULT FALSE,
    leido BOOLEAN NOT NULL DEFAULT FALSE,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS mensajes_chat_sala (
    id SERIAL PRIMARY KEY,
    id_sala INTEGER NOT NULL REFERENCES salas(id) ON DELETE CASCADE,
    id_usuario INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    mensaje TEXT NOT NULL,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS regalos (
    id SERIAL PRIMARY KEY,
    id_usuario INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
    tipo VARCHAR(50) NOT NULL,
    monto DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    descripcion TEXT,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS referidos (
    id SERIAL PRIMARY KEY,
    id_usuario INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
    id_referido INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
    bono_otorgado BOOLEAN NOT NULL DEFAULT FALSE,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(id_referido)
);

CREATE TABLE IF NOT EXISTS salas_resultados (
    id SERIAL PRIMARY KEY,
    id_sala INTEGER NOT NULL REFERENCES salas(id) ON DELETE CASCADE,
    id_partida INTEGER REFERENCES partidas(id) ON DELETE SET NULL,
    match_id VARCHAR(20),
    equipo_ganador VARCHAR(10) NOT NULL,
    marcador_radiant INTEGER NOT NULL DEFAULT 0,
    marcador_dire INTEGER NOT NULL DEFAULT 0,
    resumen_resultado TEXT,
    id_mvp_usuario INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    finalizada_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (equipo_ganador IN ('radiant', 'dire'))
);

CREATE TABLE IF NOT EXISTS usuarios_baneados_historial (
    id SERIAL PRIMARY KEY,
    id_usuario INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    id_admin INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
    motivo TEXT NOT NULL,
    detalle TEXT,
    evidencia JSONB NOT NULL DEFAULT '{}'::jsonb,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    baneado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    vence_en TIMESTAMP,
    levantado_en TIMESTAMP,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS guias (
    id SERIAL PRIMARY KEY,
    titulo VARCHAR(200) NOT NULL,
    resumen VARCHAR(500),
    contenido TEXT NOT NULL DEFAULT '',
    categoria VARCHAR(60) DEFAULT 'general',
    orden INTEGER NOT NULL DEFAULT 0,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en TIMESTAMP NOT NULL DEFAULT NOW(),
    actualizado_en TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS guias_paginas (
    id SERIAL PRIMARY KEY,
    slug VARCHAR(60) UNIQUE NOT NULL,
    titulo_menu VARCHAR(80) NOT NULL,
    topbar_titulo VARCHAR(120) NOT NULL,
    topbar_icono VARCHAR(80) NOT NULL DEFAULT 'fa-book-open',
    nav_titulo VARCHAR(80) NOT NULL DEFAULT 'NAVEGACION',
    hero_badge VARCHAR(80) NOT NULL,
    hero_titulo VARCHAR(220) NOT NULL,
    hero_subtitulo TEXT NOT NULL,
    hero_primario_label VARCHAR(80),
    hero_primario_href VARCHAR(160),
    hero_secundario_label VARCHAR(80),
    hero_secundario_href VARCHAR(160),
    hero_panel JSONB NOT NULL DEFAULT '[]'::jsonb,
    cta_titulo VARCHAR(180),
    cta_subtitulo TEXT,
    cta_label VARCHAR(80),
    cta_href VARCHAR(160),
    configuracion JSONB NOT NULL DEFAULT '{}'::jsonb,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS guias_secciones (
    id SERIAL PRIMARY KEY,
    id_guia_pagina INTEGER NOT NULL REFERENCES guias_paginas(id) ON DELETE CASCADE,
    clave VARCHAR(80) NOT NULL,
    etiqueta_nav VARCHAR(80) NOT NULL,
    titulo VARCHAR(180) NOT NULL,
    descripcion TEXT,
    icono VARCHAR(80) DEFAULT 'fa-circle-info',
    tipo_visual VARCHAR(30) NOT NULL DEFAULT 'cards',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    orden INTEGER NOT NULL DEFAULT 0,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(id_guia_pagina, clave)
);

CREATE TABLE IF NOT EXISTS guias_items (
    id SERIAL PRIMARY KEY,
    id_guia_seccion INTEGER NOT NULL REFERENCES guias_secciones(id) ON DELETE CASCADE,
    titulo VARCHAR(180) NOT NULL,
    descripcion TEXT,
    etiqueta VARCHAR(80),
    icono VARCHAR(80) DEFAULT 'fa-star',
    tono VARCHAR(30) DEFAULT 'neutro',
    accion_label VARCHAR(80),
    accion_href VARCHAR(160),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    orden INTEGER NOT NULL DEFAULT 0,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bonos (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    monto NUMERIC(12,2) NOT NULL,
    tipo VARCHAR(20) NOT NULL DEFAULT 'abono',
    mensaje TEXT,
    enviado_por TEXT DEFAULT 'superadmin',
    email_enviado BOOLEAN NOT NULL DEFAULT FALSE,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT bonos_tipo_check CHECK (tipo IN ('abono', 'sancion'))
);

CREATE TABLE IF NOT EXISTS bonos_promociones (
    id SERIAL PRIMARY KEY,
    codigo VARCHAR(40) UNIQUE NOT NULL,
    titulo VARCHAR(120) NOT NULL,
    descripcion TEXT NOT NULL,
    tipo VARCHAR(30) NOT NULL DEFAULT 'saldo',
    monto DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    maximo_bono DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    minimo_apuesta DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    requisitos JSONB NOT NULL DEFAULT '{}'::jsonb,
    icono VARCHAR(80) DEFAULT 'fa-solid fa-gift',
    etiqueta VARCHAR(30) DEFAULT 'ACTIVO',
    color_principal VARCHAR(20) DEFAULT '#f97316',
    color_secundario VARCHAR(20) DEFAULT '#0f172a',
    estado VARCHAR(20) NOT NULL DEFAULT 'activo',
    prioridad INTEGER NOT NULL DEFAULT 0,
    visible_desde TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    visible_hasta TIMESTAMP,
    creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CHECK (tipo IN ('saldo', 'cashback', 'referido', 'manual')),
    CHECK (estado IN ('activo', 'pausado', 'finalizado'))
);

CREATE TABLE IF NOT EXISTS bonos_usuario (
    id SERIAL PRIMARY KEY,
    id_usuario INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    id_bono_promocion INTEGER REFERENCES bonos_promociones(id) ON DELETE SET NULL,
    estado VARCHAR(20) NOT NULL DEFAULT 'pendiente',
    monto_otorgado DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    progreso_actual INTEGER NOT NULL DEFAULT 0,
    progreso_meta INTEGER NOT NULL DEFAULT 1,
    notas TEXT,
    vence_en TIMESTAMP,
    creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CHECK (estado IN ('pendiente', 'activo', 'en_progreso', 'elegible', 'acreditado', 'liberado', 'vencido', 'cancelado'))
);

CREATE TABLE IF NOT EXISTS bonos_movimientos (
    id SERIAL PRIMARY KEY,
    id_usuario INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    id_bono_usuario INTEGER REFERENCES bonos_usuario(id) ON DELETE SET NULL,
    tipo VARCHAR(30) NOT NULL DEFAULT 'ajuste',
    monto DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    descripcion TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CHECK (tipo IN ('ajuste', 'asignacion', 'liberacion', 'vencimiento', 'cashback'))
);

CREATE TABLE IF NOT EXISTS recargas_solicitudes (
    id SERIAL PRIMARY KEY,
    id_usuario INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    monto DECIMAL(10,2) NOT NULL,
    titular_yape VARCHAR(120) NOT NULL,
    celular_yape VARCHAR(20) NOT NULL,
    operacion_codigo VARCHAR(80) NOT NULL,
    observaciones TEXT,
    comprobante_path VARCHAR(500) NOT NULL,
    estado VARCHAR(20) NOT NULL DEFAULT 'pendiente',
    comentario_revision TEXT,
    revisado_por INTEGER REFERENCES usuarios(id),
    revisado_en TIMESTAMP,
    creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS retiros_solicitudes (
    id SERIAL PRIMARY KEY,
    id_usuario INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    monto DECIMAL(10,2) NOT NULL,
    billetera VARCHAR(20) NOT NULL,
    titular VARCHAR(120) NOT NULL,
    numero_cuenta VARCHAR(80) NOT NULL,
    observaciones TEXT,
    estado VARCHAR(20) NOT NULL DEFAULT 'pendiente',
    comentario_revision TEXT,
    revisado_por INTEGER REFERENCES usuarios(id),
    revisado_en TIMESTAMP,
    creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS mmr_actualizaciones (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    steam_id VARCHAR(32),
    estado VARCHAR(20) NOT NULL DEFAULT 'pendiente',
    mensaje TEXT,
    solicitado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    procesar_despues_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    procesado_en TIMESTAMPTZ,
    mmr_obtenido INTEGER,
    fuente VARCHAR(120)
);

CREATE TABLE IF NOT EXISTS mmr_control_usuario (
    usuario_id INTEGER PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
    ultimo_solicitado_en TIMESTAMPTZ,
    siguiente_permitido_en TIMESTAMPTZ,
    solicitud_activa_id INTEGER REFERENCES mmr_actualizaciones(id) ON DELETE SET NULL,
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mmr_control_global (
    id SMALLINT PRIMARY KEY,
    proximo_slot_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    intervalo_minutos INTEGER NOT NULL DEFAULT 20,
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mmr_acciones_usuario (
    id SERIAL PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    steam_id VARCHAR(32),
    boton VARCHAR(30) NOT NULL,
    fuente VARCHAR(120),
    mmr_valor INTEGER,
    detalle TEXT,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usuarios_steam_id ON usuarios(steam_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_usuarios_email ON usuarios(LOWER(email)) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_salas_lobby_id ON salas(lobby_id) WHERE lobby_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_usuarios_steam_actualizado ON usuarios(steam_actualizado_en);
CREATE INDEX IF NOT EXISTS idx_codigos_steam_id ON codigos_verificacion(steam_id);
CREATE INDEX IF NOT EXISTS idx_codigos_expira ON codigos_verificacion(expira_en);
CREATE INDEX IF NOT EXISTS idx_partidas_match_id ON partidas(match_id);
CREATE INDEX IF NOT EXISTS idx_partidas_estado ON partidas(estado);
CREATE INDEX IF NOT EXISTS idx_apuestas_usuario ON apuestas(id_usuario);
CREATE INDEX IF NOT EXISTS idx_apuestas_partida ON apuestas(id_partida);
CREATE INDEX IF NOT EXISTS idx_apuestas_estado ON apuestas(estado);
CREATE INDEX IF NOT EXISTS idx_transacciones_usuario ON transacciones(id_usuario);
CREATE INDEX IF NOT EXISTS idx_salas_estado ON salas(estado);
CREATE INDEX IF NOT EXISTS idx_sala_jugadores_sala ON sala_jugadores(id_sala);
CREATE INDEX IF NOT EXISTS idx_sala_jugadores_usuario ON sala_jugadores(id_usuario);
CREATE INDEX IF NOT EXISTS idx_sala_jugadores_banda ON sala_jugadores(banda);
CREATE INDEX IF NOT EXISTS idx_amigos_usuario ON amigos(id_usuario);
CREATE INDEX IF NOT EXISTS idx_amigos_amigo ON amigos(id_amigo);
CREATE INDEX IF NOT EXISTS idx_chat_general_creado ON mensajes_chat_general(creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_chat_privado_emisor ON mensajes_chat_privado(id_emisor);
CREATE INDEX IF NOT EXISTS idx_chat_privado_receptor ON mensajes_chat_privado(id_receptor);
CREATE INDEX IF NOT EXISTS idx_chat_sala_sala_fecha ON mensajes_chat_sala(id_sala, creado_en ASC);
CREATE INDEX IF NOT EXISTS idx_chat_sala_usuario ON mensajes_chat_sala(id_usuario);
CREATE INDEX IF NOT EXISTS idx_soporte_usuario ON mensajes_soporte(id_usuario);
CREATE INDEX IF NOT EXISTS idx_regalos_usuario ON regalos(id_usuario);
CREATE INDEX IF NOT EXISTS idx_referidos_usuario ON referidos(id_usuario);
CREATE INDEX IF NOT EXISTS idx_superadmin_usuarios_lookup ON superadmin_usuarios(LOWER(usuario), activo);
CREATE UNIQUE INDEX IF NOT EXISTS uq_salas_resultados_sala ON salas_resultados(id_sala);
CREATE INDEX IF NOT EXISTS idx_salas_resultados_fecha ON salas_resultados(finalizada_en DESC);
CREATE INDEX IF NOT EXISTS idx_salas_resultados_ganador ON salas_resultados(equipo_ganador, finalizada_en DESC);
CREATE INDEX IF NOT EXISTS idx_baneados_usuario_activo ON usuarios_baneados_historial(id_usuario, activo, baneado_en DESC);
CREATE INDEX IF NOT EXISTS idx_baneados_activo_fecha ON usuarios_baneados_historial(activo, baneado_en DESC);
CREATE INDEX IF NOT EXISTS idx_guias_paginas_slug ON guias_paginas(slug, activo);
CREATE INDEX IF NOT EXISTS idx_guias_secciones_pagina ON guias_secciones(id_guia_pagina, orden);
CREATE INDEX IF NOT EXISTS idx_guias_items_seccion ON guias_items(id_guia_seccion, orden);
CREATE INDEX IF NOT EXISTS idx_bonos_promociones_estado ON bonos_promociones(estado, prioridad DESC);
CREATE INDEX IF NOT EXISTS idx_bonos_promociones_visibilidad ON bonos_promociones(visible_desde, visible_hasta);
CREATE INDEX IF NOT EXISTS idx_bonos_usuario_usuario ON bonos_usuario(id_usuario, estado);
CREATE INDEX IF NOT EXISTS idx_bonos_usuario_promocion ON bonos_usuario(id_bono_promocion);
CREATE INDEX IF NOT EXISTS idx_bonos_movimientos_usuario ON bonos_movimientos(id_usuario, creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_recargas_solicitudes_usuario ON recargas_solicitudes(id_usuario);
CREATE INDEX IF NOT EXISTS idx_recargas_solicitudes_estado ON recargas_solicitudes(estado);
CREATE INDEX IF NOT EXISTS idx_recargas_solicitudes_creado ON recargas_solicitudes(creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_retiros_solicitudes_usuario ON retiros_solicitudes(id_usuario);
CREATE INDEX IF NOT EXISTS idx_retiros_solicitudes_estado ON retiros_solicitudes(estado);
CREATE INDEX IF NOT EXISTS idx_retiros_solicitudes_creado ON retiros_solicitudes(creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_partidas_en_vivo_estado ON partidas_en_vivo(estado, creada_en DESC);
CREATE INDEX IF NOT EXISTS idx_partidas_en_vivo_publicas ON partidas_en_vivo(es_publica, activo, creada_en DESC);
CREATE INDEX IF NOT EXISTS idx_partidas_en_vivo_match ON partidas_en_vivo(match_id);
CREATE INDEX IF NOT EXISTS idx_mmr_actualizaciones_usuario ON mmr_actualizaciones(usuario_id, solicitado_en DESC);
CREATE INDEX IF NOT EXISTS idx_mmr_actualizaciones_estado ON mmr_actualizaciones(estado, procesar_despues_en);
CREATE INDEX IF NOT EXISTS idx_mmr_acciones_usuario_fecha ON mmr_acciones_usuario(usuario_id, creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_mmr_acciones_boton ON mmr_acciones_usuario(boton, creado_en DESC);

CREATE OR REPLACE FUNCTION actualizar_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.actualizado_en = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION actualizar_timestamp_sala()
RETURNS TRIGGER AS $$
BEGIN
    NEW.actualizada_en = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_usuarios_actualizado ON usuarios;
CREATE TRIGGER trigger_usuarios_actualizado
BEFORE UPDATE ON usuarios
FOR EACH ROW EXECUTE FUNCTION actualizar_timestamp();

DROP TRIGGER IF EXISTS trigger_partidas_actualizado ON partidas;
CREATE TRIGGER trigger_partidas_actualizado
BEFORE UPDATE ON partidas
FOR EACH ROW EXECUTE FUNCTION actualizar_timestamp();

DROP TRIGGER IF EXISTS trigger_apuestas_actualizado ON apuestas;
CREATE TRIGGER trigger_apuestas_actualizado
BEFORE UPDATE ON apuestas
FOR EACH ROW EXECUTE FUNCTION actualizar_timestamp();

DROP TRIGGER IF EXISTS trigger_salas_actualizada ON salas;
CREATE TRIGGER trigger_salas_actualizada
BEFORE UPDATE ON salas
FOR EACH ROW EXECUTE FUNCTION actualizar_timestamp_sala();

INSERT INTO mmr_control_global (id, proximo_slot_en, intervalo_minutos)
VALUES (1, NOW(), 20)
ON CONFLICT (id) DO NOTHING;