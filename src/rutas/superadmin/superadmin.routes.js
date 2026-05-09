const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../../config/database');
const { verificarSuperadminToken } = require('../../middleware/superadminAuth');
const socketEmitter = require('../../utils/socketEmitter');
const emailService  = require('../../servicios/email/email.service');

const router = express.Router();

const SUPERADMIN_JWT_SECRET = process.env.SUPERADMIN_JWT_SECRET || process.env.JWT_SECRET;
const SUPERADMIN_JWT_EXPIRES = process.env.SUPERADMIN_JWT_EXPIRES || '12h';

async function ensureRequiredTables(requiredTables, errorCode) {
  const checks = await Promise.all(requiredTables.map((name) => db.query('SELECT to_regclass($1) AS reg', [name])));
  const missing = checks
    .map((r, idx) => ({ idx, exists: !!r.rows?.[0]?.reg }))
    .filter((x) => !x.exists)
    .map((x) => requiredTables[x.idx]);

  if (missing.length) {
    const err = new Error(`Faltan tablas requeridas: ${missing.join(', ')}`);
    err.code = errorCode;
    err.missingTables = missing;
    throw err;
  }
}

function handleSchemaMissing(res, error) {
  return res.status(503).json({
    error: 'Falta aplicar migraciones en la base de datos.',
    codigo: error.code,
    faltantes: error.missingTables || [],
  });
}

function generarTokenSuperadmin(admin) {
  return jwt.sign(
    {
      id: admin.id,
      usuario: admin.usuario,
      rol: admin.rol,
      tipo: 'superadmin',
    },
    SUPERADMIN_JWT_SECRET,
    { expiresIn: SUPERADMIN_JWT_EXPIRES }
  );
}

function limpiarTextoPlano(valor = '') {
  return String(valor || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[#!>*_~\-]+/g, ' ')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

async function sincronizarGuiasLegacyAPublicas() {
  await ensureRequiredTables(
    ['public.guias', 'public.guias_paginas', 'public.guias_secciones', 'public.guias_items'],
    'SUPERADMIN_GUIAS_SYNC_SCHEMA_MISSING'
  );

  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');

    const legacyR = await client.query(
      `SELECT id, titulo, resumen, contenido, categoria, orden
       FROM guias
       WHERE activo = TRUE
       ORDER BY orden ASC, creado_en DESC, id DESC`
    );

    let paginaR = await client.query(
      `SELECT id
       FROM guias_paginas
       WHERE slug = 'principal'
       LIMIT 1`
    );

    if (!paginaR.rows.length) {
      paginaR = await client.query(
        `INSERT INTO guias_paginas (
           slug,
           titulo_menu,
           topbar_titulo,
           topbar_icono,
           nav_titulo,
           hero_badge,
           hero_titulo,
           hero_subtitulo,
           hero_primario_label,
           hero_primario_href,
           hero_secundario_label,
           hero_secundario_href,
           hero_panel,
           cta_titulo,
           cta_subtitulo,
           cta_label,
           cta_href,
           configuracion,
           activo,
           actualizado_en
         ) VALUES (
           'principal',
           'GUIAS',
           'GUIAS DE JUEGO',
           'fa-book-open',
           'NAVEGACION',
           'CENTRO DE APRENDIZAJE',
           'GUIAS',
           '',
           'VER PASOS',
           '#pasos',
           'IR A SALAS',
           '/salas',
           '[]'::jsonb,
           'Listo para tu primera partida',
           'Entra a salas activas y aplica esta guia paso a paso para jugar con seguridad.',
           'EMPEZAR AHORA',
           '/salas',
           '{}'::jsonb,
           TRUE,
           NOW()
         )
         RETURNING id`
      );
    }

    const paginaId = paginaR.rows[0].id;
    const seccionR = await client.query(
      `SELECT id
       FROM guias_secciones
       WHERE id_guia_pagina = $1
         AND clave = 'guias-superadmin'
       LIMIT 1`,
      [paginaId]
    );

    let seccionId;

    if (!seccionR.rows.length) {
      const creada = await client.query(
        `INSERT INTO guias_secciones (
           id_guia_pagina,
           clave,
           etiqueta_nav,
           titulo,
           descripcion,
           icono,
           tipo_visual,
           metadata,
           orden,
           activo,
           actualizado_en
         ) VALUES (
           $1,
           'guias-superadmin',
           'GUIAS',
           'Guias publicadas',
           'Contenido creado desde el panel de superadmin.',
           'fa-file-lines',
           'cards',
           '{"origen":"legacy-superadmin"}'::jsonb,
           999,
           TRUE,
           NOW()
         )
         RETURNING id`,
        [paginaId]
      );
      seccionId = creada.rows[0].id;
    } else {
      seccionId = seccionR.rows[0].id;
      await client.query(
        `UPDATE guias_secciones
         SET activo = TRUE,
             titulo = 'Guias publicadas',
             descripcion = 'Contenido creado desde el panel de superadmin.',
             tipo_visual = 'cards',
             actualizado_en = NOW()
         WHERE id = $1`,
        [seccionId]
      );
    }

    await client.query('DELETE FROM guias_items WHERE id_guia_seccion = $1', [seccionId]);

    const rows = legacyR.rows;
    if (!rows.length) {
      await client.query(
        `UPDATE guias_secciones
         SET activo = FALSE,
             actualizado_en = NOW()
         WHERE id = $1`,
        [seccionId]
      );
      await client.query('COMMIT');
      return;
    }

    for (const [index, row] of rows.entries()) {
      const resumenPlano = limpiarTextoPlano(row.resumen || '');
      const contenidoPlano = limpiarTextoPlano(row.contenido || '');
      await client.query(
        `INSERT INTO guias_items (
           id_guia_seccion,
           titulo,
           descripcion,
           etiqueta,
           icono,
           tono,
           accion_label,
           accion_href,
           metadata,
           orden,
           activo,
           actualizado_en
         ) VALUES (
           $1,
           $2,
           $3,
           $4,
           'fa-bookmark',
           'neutro',
           NULL,
           NULL,
           $5::jsonb,
           $6,
           TRUE,
           NOW()
         )`,
        [
          seccionId,
          row.titulo,
          (resumenPlano || contenidoPlano || row.titulo || '').slice(0, 240),
          row.categoria ? String(row.categoria).toUpperCase() : null,
          JSON.stringify({
            origen: 'legacy-superadmin',
            legacyGuiaId: row.id,
            legacyResumen: row.resumen || '',
            legacyContenido: row.contenido || '',
          }),
          Number(row.orden ?? index + 1),
        ]
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

router.post('/login', async (req, res) => {
  try {
    const { usuario, password } = req.body;

    if (!usuario || !password) {
      return res.status(400).json({ error: 'Usuario y password son requeridos' });
    }

    const resultado = await db.query(
      `
      SELECT id, usuario, password_hash, rol, activo
      FROM superadmin_usuarios
      WHERE LOWER(usuario) = LOWER($1)
      LIMIT 1
      `,
      [String(usuario).trim()]
    );

    if (!resultado.rows.length) {
      return res.status(401).json({ error: 'Credenciales invalidas' });
    }

    const admin = resultado.rows[0];

    if (!admin.activo || admin.rol !== 'superadmin') {
      return res.status(403).json({ error: 'Cuenta superadmin inactiva' });
    }

    const passwordValido = await bcrypt.compare(String(password), admin.password_hash);
    if (!passwordValido) {
      return res.status(401).json({ error: 'Credenciales invalidas' });
    }

    const token = generarTokenSuperadmin(admin);

    return res.json({
      mensaje: 'Login superadmin exitoso',
      token,
      superadmin: {
        id: admin.id,
        usuario: admin.usuario,
        rol: admin.rol,
      },
    });
  } catch (error) {
    console.error('Error en login superadmin:', error);
    if (error?.code === '42P01') {
      return res.status(500).json({ error: 'Tabla superadmin_usuarios no existe. Ejecuta la migracion.' });
    }
    return res.status(500).json({ error: 'Error interno al autenticar superadmin' });
  }
});

router.get('/verificar', verificarSuperadminToken, async (req, res) => {
  try {
    const resultado = await db.query(
      `
      SELECT id, usuario, rol, activo
      FROM superadmin_usuarios
      WHERE id = $1
      LIMIT 1
      `,
      [req.superadmin.id]
    );

    if (!resultado.rows.length || !resultado.rows[0].activo) {
      return res.status(401).json({ error: 'Sesion superadmin no valida' });
    }

    return res.json({
      mensaje: 'Sesion superadmin valida',
      superadmin: {
        id: resultado.rows[0].id,
        usuario: resultado.rows[0].usuario,
        rol: resultado.rows[0].rol,
      },
    });
  } catch (error) {
    console.error('Error verificando sesion superadmin:', error);
    return res.status(500).json({ error: 'Error verificando sesion superadmin' });
  }
});

// ─── Dashboard ────────────────────────────────────────────────────────────────
router.get('/dashboard', verificarSuperadminToken, async (req, res) => {
  try {
    const [
      kpiUsuarios,
      kpiPartidas,
      kpiApuestas,
      kpiSalas,
      kpiTransacciones,
      kpiSoporte,
      recentUsuarios,
      recentPartidas,
      recentApuestas,
      recentTransacciones,
      saldoTotal,
      distribucionPartidas,
      distribucionApuestas,
    ] = await Promise.all([
      // KPIs usuarios
      db.query(`
        SELECT
          COUNT(*)                                              AS total,
          COUNT(*) FILTER (WHERE esta_baneado = TRUE)          AS baneados,
          COUNT(*) FILTER (WHERE creado_en >= NOW() - INTERVAL '24h') AS nuevos_hoy,
          COUNT(*) FILTER (WHERE creado_en >= NOW() - INTERVAL '7d')  AS nuevos_semana
        FROM usuarios
      `),
      // KPIs partidas
      db.query(`
        SELECT
          COUNT(*)                                            AS total,
          COUNT(*) FILTER (WHERE estado = 'en_curso')        AS activas,
          COUNT(*) FILTER (WHERE estado = 'pendiente')       AS pendientes,
          COUNT(*) FILTER (WHERE estado = 'finalizada')      AS finalizadas
        FROM partidas
      `),
      // KPIs apuestas
      db.query(`
        SELECT
          COUNT(*)                                            AS total,
          COUNT(*) FILTER (WHERE estado = 'pendiente')       AS pendientes,
          COUNT(*) FILTER (WHERE estado = 'ganada')          AS ganadas,
          COUNT(*) FILTER (WHERE estado = 'perdida')         AS perdidas,
          COALESCE(SUM(monto), 0)                            AS volumen_total
        FROM apuestas
      `),
      // KPIs salas
      db.query(`
        SELECT
          COUNT(*)                                            AS total,
          COUNT(*) FILTER (WHERE estado = 'esperando')       AS esperando,
          COUNT(*) FILTER (WHERE estado = 'en_curso')        AS activas,
          COUNT(*) FILTER (WHERE estado = 'finalizada')      AS finalizadas
        FROM salas
      `),
      // KPIs transacciones hoy
      db.query(`
        SELECT
          COUNT(*)                                            AS total_hoy,
          COALESCE(SUM(monto) FILTER (WHERE tipo = 'recarga'), 0)   AS recargas_hoy,
          COALESCE(SUM(monto) FILTER (WHERE tipo = 'retiro'), 0)    AS retiros_hoy,
          COALESCE(SUM(monto) FILTER (WHERE tipo = 'apuesta'), 0)   AS apuestas_hoy
        FROM transacciones
        WHERE creado_en >= CURRENT_DATE
      `),
      // Mensajes soporte sin leer
      db.query(`
        SELECT COUNT(*) AS sin_leer
        FROM mensajes_soporte
        WHERE leido = FALSE AND es_admin = FALSE
      `),
      // Últimos 8 usuarios
      db.query(`
        SELECT id, nombre_usuario, steam_id, mmr, saldo, nivel, esta_baneado, creado_en
        FROM usuarios
        ORDER BY creado_en DESC
        LIMIT 8
      `),
      // Últimas 8 partidas
      db.query(`
        SELECT id, match_id, descripcion, estado, resultado, creado_en
        FROM partidas
        ORDER BY creado_en DESC
        LIMIT 8
      `),
      // Últimas 8 apuestas
      db.query(`
        SELECT a.id, a.monto, a.tipo_apuesta, a.prediccion, a.estado, a.creado_en,
               u.nombre_usuario, p.match_id
        FROM apuestas a
        JOIN usuarios u  ON u.id = a.id_usuario
        JOIN partidas p  ON p.id = a.id_partida
        ORDER BY a.creado_en DESC
        LIMIT 8
      `),
      // Últimas 8 transacciones
      db.query(`
        SELECT t.id, t.tipo, t.monto, t.descripcion, t.creado_en,
               u.nombre_usuario
        FROM transacciones t
        JOIN usuarios u ON u.id = t.id_usuario
        ORDER BY t.creado_en DESC
        LIMIT 8
      `),
      // Saldo total en circulación
      db.query(`
        SELECT
          COALESCE(SUM(saldo), 0) AS saldo_total,
          COALESCE(SUM(bono),  0) AS bono_total
        FROM usuarios
      `),
      // Distribución de partidas por estado
      db.query(`
        SELECT estado, COUNT(*) AS cantidad
        FROM partidas
        GROUP BY estado
      `),
      // Distribución de apuestas por estado
      db.query(`
        SELECT estado, COUNT(*) AS cantidad
        FROM apuestas
        GROUP BY estado
      `),
    ]);

    return res.json({
      kpis: {
        usuarios: kpiUsuarios.rows[0],
        partidas: kpiPartidas.rows[0],
        apuestas: kpiApuestas.rows[0],
        salas: kpiSalas.rows[0],
        transacciones: kpiTransacciones.rows[0],
        soporte: kpiSoporte.rows[0],
        saldo: saldoTotal.rows[0],
      },
      recientes: {
        usuarios: recentUsuarios.rows,
        partidas: recentPartidas.rows,
        apuestas: recentApuestas.rows,
        transacciones: recentTransacciones.rows,
      },
      distribucion: {
        partidas: distribucionPartidas.rows,
        apuestas: distribucionApuestas.rows,
      },
    });
  } catch (error) {
    console.error('Error en dashboard superadmin:', error);
    return res.status(500).json({ error: 'Error al obtener datos del dashboard' });
  }
});

// ─── Salas admin ─────────────────────────────────────────────────────────────

// Crear sala desde panel superadmin
router.post('/salas', verificarSuperadminToken, async (req, res) => {
  try {
    const {
      nombre,
      descripcion,
      tipo = 'normal',
      modo = 'All Pick',
      limiteMmrMin = 0,
      limiteMmrMax = 99999,
      entrada = 0,
      maxJugadores = 10,
      esAutomatico = false,
      fechaInicio = null,
      porcentajeComision = 5,
    } = req.body || {};

    const nombreLimpio = String(nombre || '').trim();
    if (!nombreLimpio) {
      return res.status(400).json({ error: 'El nombre de la sala es obligatorio' });
    }

    const jugadoresNum = Number.parseInt(maxJugadores, 10);
    if (!Number.isFinite(jugadoresNum) || jugadoresNum < 2 || jugadoresNum > 10) {
      return res.status(400).json({ error: 'Máximo de jugadores inválido (2 a 10)' });
    }

    const entradaNum = Number.parseFloat(entrada) || 0;
    if (entradaNum < 0) {
      return res.status(400).json({ error: 'La entrada no puede ser negativa' });
    }

    const mmrMinNum = Number.parseInt(limiteMmrMin, 10) || 0;
    const mmrMaxNum = Number.parseInt(limiteMmrMax, 10) || 99999;
    if (mmrMinNum < 0 || mmrMaxNum < 0 || mmrMinNum > mmrMaxNum) {
      return res.status(400).json({ error: 'Rango de MMR inválido' });
    }

    const comisionNum = Number.parseFloat(porcentajeComision);
    if (!Number.isFinite(comisionNum) || comisionNum < 0 || comisionNum > 100) {
      return res.status(400).json({ error: 'Porcentaje de comisión inválido (0 a 100)' });
    }

    const fechaInicioValida = fechaInicio ? new Date(fechaInicio) : null;
    if (fechaInicio && Number.isNaN(fechaInicioValida.getTime())) {
      return res.status(400).json({ error: 'Fecha de inicio inválida' });
    }

    const pozo = entradaNum * jugadoresNum;
    const factorPremio = 1 - (comisionNum / 100);
    const premioCalculado = Number.parseFloat((pozo * factorPremio).toFixed(2));
    const comisionMonto = Number.parseFloat((pozo - premioCalculado).toFixed(2));

    const insert = await db.query(
      `INSERT INTO salas (
        nombre, descripcion, id_creador, tipo, modo,
        limite_mmr_min, limite_mmr_max, entrada, premio,
        es_automatico, max_jugadores, jugadores_actuales,
        estado, fecha_inicio, aviso_admin, configuracion,
        creada_en, actualizada_en
      ) VALUES (
        $1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,0,'esperando',$11,FALSE,$12::jsonb,NOW(),NOW()
      )
      RETURNING *`,
      [
        nombreLimpio,
        descripcion ? String(descripcion).trim() : null,
        tipo || 'normal',
        modo || 'All Pick',
        mmrMinNum,
        mmrMaxNum,
        entradaNum,
        premioCalculado,
        !!esAutomatico,
        jugadoresNum,
        fechaInicioValida,
        JSON.stringify({
          creado_por: 'superadmin',
          comision_porcentaje: comisionNum,
          comision_monto: comisionMonto,
          pozo_total_estimado: Number.parseFloat(pozo.toFixed(2)),
        }),
      ]
    );

    const sala = insert.rows[0];
    socketEmitter.emitirActualizacionSalaAdmin(sala);

    return res.status(201).json({
      sala,
      calculo: {
        pozo: Number.parseFloat(pozo.toFixed(2)),
        comisionPorcentaje: comisionNum,
        comisionMonto,
        premio: premioCalculado,
      },
      mensaje: 'Sala creada desde superadmin',
    });
  } catch (error) {
    console.error('Error creando sala desde superadmin:', error);
    return res.status(500).json({ error: 'Error al crear la sala' });
  }
});

// Listar todas las salas (activas + recientes)
router.get('/salas', verificarSuperadminToken, async (req, res) => {
  try {
    const { estado } = req.query; // opcional: 'esperando','jugando','terminada','cancelada'
    const filtro = estado
      ? `WHERE s.estado = $1`
      : `WHERE s.estado IN ('esperando','jugando','terminada','cancelada')`;
    const params = estado ? [estado] : [];

    const r = await db.query(`
      SELECT s.*,
        u.nombre_usuario AS creador_nombre,
        u.avatar         AS creador_avatar,
        pv.id            AS partida_vivo_id,
        pv.titulo        AS partida_vivo_titulo,
        pv.estado        AS partida_vivo_estado,
        pv.match_id      AS partida_vivo_match_id,
        pv.delay_segundos AS partida_vivo_delay_segundos,
        COUNT(sj.id)     AS jugadores_count,
        COALESCE(json_agg(
          json_build_object(
            'id',     uj.id,
            'nombre', uj.nombre_usuario,
            'avatar', uj.avatar,
            'mmr',    COALESCE(uj.mmr, 0),
            'banda',  sj.banda,
            'equipo', sj.equipo
          ) ORDER BY sj.unido_en
        ) FILTER (WHERE uj.id IS NOT NULL), '[]') AS jugadores_info
      FROM salas s
      LEFT JOIN usuarios       u  ON u.id  = s.id_creador
      LEFT JOIN LATERAL (
        SELECT pvv.*
        FROM partidas_en_vivo pvv
        WHERE pvv.id_sala = s.id
        ORDER BY pvv.activo DESC, pvv.creada_en DESC
        LIMIT 1
      ) pv ON TRUE
      LEFT JOIN sala_jugadores sj ON sj.id_sala  = s.id
      LEFT JOIN usuarios       uj ON uj.id = sj.id_usuario
      ${filtro}
      GROUP BY s.id, u.nombre_usuario, u.avatar, pv.id, pv.titulo, pv.estado, pv.match_id, pv.delay_segundos
      ORDER BY s.creada_en DESC
      LIMIT 100
    `, params);

    return res.json({ salas: r.rows });
  } catch (error) {
    console.error('Error listando salas admin:', error);
    return res.status(500).json({ error: 'Error al obtener salas' });
  }
});

router.get('/salas/:id', verificarSuperadminToken, async (req, res) => {
  try {
    const { id } = req.params;
    const r = await db.query(
      `SELECT s.*,
        u.nombre_usuario AS creador_nombre,
        u.avatar         AS creador_avatar,
        pv.id            AS partida_vivo_id,
        pv.titulo        AS partida_vivo_titulo,
        pv.estado        AS partida_vivo_estado,
        pv.match_id      AS partida_vivo_match_id,
        pv.delay_segundos AS partida_vivo_delay_segundos,
        COUNT(sj.id)     AS jugadores_count,
        COALESCE(json_agg(
          json_build_object(
            'id',     uj.id,
            'nombre', uj.nombre_usuario,
            'avatar', uj.avatar,
            'mmr',    COALESCE(uj.mmr, 0),
            'banda',  sj.banda,
            'equipo', sj.equipo
          ) ORDER BY sj.unido_en
        ) FILTER (WHERE uj.id IS NOT NULL), '[]') AS jugadores_info
      FROM salas s
      LEFT JOIN usuarios       u  ON u.id = s.id_creador
      LEFT JOIN LATERAL (
        SELECT pvv.*
        FROM partidas_en_vivo pvv
        WHERE pvv.id_sala = s.id
        ORDER BY pvv.activo DESC, pvv.creada_en DESC
        LIMIT 1
      ) pv ON TRUE
      LEFT JOIN sala_jugadores sj ON sj.id_sala = s.id
      LEFT JOIN usuarios       uj ON uj.id = sj.id_usuario
      WHERE s.id = $1
      GROUP BY s.id, u.nombre_usuario, u.avatar, pv.id, pv.titulo, pv.estado, pv.match_id, pv.delay_segundos
      LIMIT 1`,
      [id]
    );

    if (!r.rows.length) return res.status(404).json({ error: 'Sala no encontrada' });
    return res.json({ sala: r.rows[0] });
  } catch (error) {
    console.error('Error obteniendo sala admin:', error);
    return res.status(500).json({ error: 'Error al obtener sala' });
  }
});

// Cambiar estado de una sala (iniciar / cancelar / finalizar)
router.patch('/salas/:id/estado', verificarSuperadminToken, async (req, res) => {
  const { id } = req.params;
  const { estado, motivo } = req.body;

  const ESTADOS_VALIDOS = ['esperando', 'jugando', 'terminada', 'cancelada'];
  if (!ESTADOS_VALIDOS.includes(estado)) {
    return res.status(400).json({ error: `Estado inválido. Válidos: ${ESTADOS_VALIDOS.join(', ')}` });
  }

  let client;
  try {
    client = await db.pool.connect();
    await client.query('BEGIN');

    const salaR = await client.query(
      `SELECT s.*,
        COALESCE(json_agg(
          json_build_object('id', sj.id_usuario)
        ) FILTER (WHERE sj.id_usuario IS NOT NULL), '[]') AS jugadores_raw
       FROM salas s
       LEFT JOIN sala_jugadores sj ON sj.id_sala = s.id
       WHERE s.id = $1
       GROUP BY s.id`,
      [id]
    );
    if (!salaR.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Sala no encontrada' });
    }
    const sala = salaR.rows[0];

    // Si se cancela, devolver entrada a cada jugador
    if (estado === 'cancelada') {
      const entrada = parseFloat(sala.entrada) || 0;
      const jugadoresR = await client.query(
        'SELECT id_usuario FROM sala_jugadores WHERE id_sala=$1', [id]
      );
      if (entrada > 0 && jugadoresR.rows.length > 0) {
        for (const j of jugadoresR.rows) {
          const saldoR = await client.query(
            'UPDATE usuarios SET saldo = saldo + $1 WHERE id=$2 RETURNING saldo',
            [entrada, j.id_usuario]
          );
          await client.query(
            `INSERT INTO transacciones (id_usuario, tipo, monto, descripcion, creado_en)
             VALUES ($1,'devolucion',$2,$3,NOW())`,
            [j.id_usuario, entrada, `Sala "${sala.nombre}" cancelada por admin${motivo ? ': ' + motivo : ''}`]
          );
          socketEmitter.emitirSaldoActualizado(j.id_usuario, saldoR.rows[0].saldo);
        }
      }
    }

    const actualizada = await client.query(
      `UPDATE salas SET estado=$1, actualizada_en=NOW() WHERE id=$2 RETURNING *`,
      [estado, id]
    );
    await client.query('COMMIT');

    const salaFinal = actualizada.rows[0];

    // Emitir a todos los clientes conectados
    socketEmitter.emitirActualizacionSalaAdmin(salaFinal);

    return res.json({ sala: salaFinal });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('Error cambiando estado sala:', error);
    return res.status(500).json({ error: 'Error al cambiar estado de la sala' });
  } finally {
    if (client) client.release();
  }
});

// Forzar inicio de sala (atajos)
router.post('/salas/:id/iniciar', verificarSuperadminToken, async (req, res) => {
  const { id } = req.params;
  const {
    titulo,
    descripcion,
    matchId,
    lobbyId,
    modoVisualizacion,
    delaySegundos,
    streamUrl,
    radiantNombre,
    direNombre,
    fuenteDatos,
    esPublica,
  } = req.body || {};

  const tituloFinal = String(titulo || '').trim();
  if (!tituloFinal) {
    return res.status(400).json({ error: 'El titulo de la partida en vivo es obligatorio' });
  }

  const modoFinal = ['oficial_valve', 'stats_delay', 'hibrido'].includes(modoVisualizacion)
    ? modoVisualizacion
    : 'oficial_valve';
  const delayFinal = Number.isFinite(Number(delaySegundos))
    ? Math.max(0, Math.min(7200, parseInt(delaySegundos, 10)))
    : 120;

  let client;
  try {
    client = await db.pool.connect();
    await client.query('BEGIN');

    const salaR = await client.query('SELECT * FROM salas WHERE id=$1 AND estado=$2 LIMIT 1', [id, 'esperando']);
    if (!salaR.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'La sala no está en estado esperando' });
    }
    const salaBase = salaR.rows[0];

    const liveExistente = await client.query(
      'SELECT id FROM partidas_en_vivo WHERE id_sala=$1 ORDER BY activo DESC, creada_en DESC LIMIT 1',
      [id]
    );

    let live;
    if (liveExistente.rows.length) {
      const liveUpd = await client.query(
        `UPDATE partidas_en_vivo
         SET titulo=$1,
             descripcion=$2,
             match_id=$3,
             lobby_id=$4,
             estado='en_vivo',
             modo_visualizacion=$5,
             delay_segundos=$6,
             stream_url=$7,
             radiant_nombre=$8,
             dire_nombre=$9,
             fuente_datos=$10,
             es_publica=$11,
             activo=TRUE,
             ultima_sincronizacion=NOW(),
             actualizada_en=NOW()
         WHERE id=$12
         RETURNING *`,
        [
          tituloFinal,
          descripcion || null,
          matchId || null,
          lobbyId || null,
          modoFinal,
          delayFinal,
          streamUrl || null,
          radiantNombre || 'Radiant',
          direNombre || 'Dire',
          fuenteDatos || 'manual',
          esPublica !== false,
          liveExistente.rows[0].id,
        ]
      );
      live = liveUpd.rows[0];
    } else {
      const liveIns = await client.query(
        `INSERT INTO partidas_en_vivo (
            id_sala, titulo, descripcion, match_id, lobby_id, estado,
            modo_visualizacion, delay_segundos, stream_url, radiant_nombre, dire_nombre,
            fuente_datos, es_publica, activo, ultima_sincronizacion, metadata
         ) VALUES (
            $1,$2,$3,$4,$5,'en_vivo',
            $6,$7,$8,$9,$10,
            $11,$12,TRUE,NOW(), '{}'::jsonb
         ) RETURNING *`,
        [
          id,
          tituloFinal,
          descripcion || null,
          matchId || null,
          lobbyId || null,
          modoFinal,
          delayFinal,
          streamUrl || null,
          radiantNombre || 'Radiant',
          direNombre || 'Dire',
          fuenteDatos || 'manual',
          esPublica !== false,
        ]
      );
      live = liveIns.rows[0];
    }

    const salaUpd = await client.query(
      `UPDATE salas
       SET estado='jugando', fecha_inicio=COALESCE(fecha_inicio, NOW()), actualizada_en=NOW()
       WHERE id=$1
       RETURNING *`,
      [id]
    );

    await client.query('COMMIT');

    const salaActualizada = {
      ...salaBase,
      ...salaUpd.rows[0],
      partida_vivo_id: live.id,
      partida_vivo_titulo: live.titulo,
      partida_vivo_estado: live.estado,
      partida_vivo_match_id: live.match_id,
      partida_vivo_delay_segundos: live.delay_segundos,
    };

    socketEmitter.emitirActualizacionSalaAdmin(salaActualizada);
    return res.json({ sala: salaActualizada, partidaEnVivo: live });
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    console.error('Error al iniciar sala:', error);
    return res.status(500).json({ error: 'Error al iniciar sala' });
  } finally {
    if (client) client.release();
  }
});

// Expulsar a un jugador de una sala
router.delete('/salas/:id/jugadores/:idUsuario', verificarSuperadminToken, async (req, res) => {
  const { id, idUsuario } = req.params;
  let client;
  try {
    client = await db.pool.connect();
    await client.query('BEGIN');

    const salaR = await client.query('SELECT * FROM salas WHERE id=$1', [id]);
    if (!salaR.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Sala no encontrada' });
    }
    const sala = salaR.rows[0];
    const entrada = parseFloat(sala.entrada) || 0;

    await client.query('DELETE FROM sala_jugadores WHERE id_sala=$1 AND id_usuario=$2', [id, idUsuario]);
    const upd = await client.query(
      `UPDATE salas SET jugadores_actuales=(SELECT COUNT(*) FROM sala_jugadores WHERE id_sala=$1), actualizada_en=NOW() WHERE id=$1 RETURNING *`,
      [id]
    );

    if (entrada > 0) {
      const saldoR = await client.query(
        'UPDATE usuarios SET saldo=saldo+$1 WHERE id=$2 RETURNING saldo',
        [entrada, idUsuario]
      );
      await client.query(
        `INSERT INTO transacciones (id_usuario, tipo, monto, descripcion, creado_en) VALUES ($1,'devolucion',$2,$3,NOW())`,
        [idUsuario, entrada, `Expulsado de sala "${sala.nombre}" por admin`]
      );
      socketEmitter.emitirSaldoActualizado(idUsuario, saldoR.rows[0].saldo);
    }

    await client.query('COMMIT');
    socketEmitter.emitirActualizacionSalaAdmin(upd.rows[0]);
    return res.json({ ok: true });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    return res.status(500).json({ error: 'Error al expulsar jugador' });
  } finally {
    if (client) client.release();
  }
});

// Cambiar rol (equipo) de un jugador dentro de una sala
router.patch('/salas/:id/jugadores/:idUsuario/rol', verificarSuperadminToken, async (req, res) => {
  const { id, idUsuario } = req.params;
  const ROLES_VALIDOS = ['Carry', 'Mid', 'Off', 'Pos 4', 'Pos 5'];
  const equipoRaw = typeof req.body?.equipo === 'string' ? req.body.equipo.trim() : '';
  const equipo = equipoRaw || null;

  if (equipo !== null && !ROLES_VALIDOS.includes(equipo)) {
    return res.status(400).json({ error: 'Rol inválido' });
  }

  try {
    const existeR = await db.query('SELECT 1 FROM sala_jugadores WHERE id_sala=$1 AND id_usuario=$2', [id, idUsuario]);
    if (!existeR.rows.length) return res.status(404).json({ error: 'Jugador no encontrado en la sala' });

    await db.query(
      'UPDATE sala_jugadores SET equipo=$1 WHERE id_sala=$2 AND id_usuario=$3',
      [equipo, id, idUsuario]
    );

    const salaUpd = await db.query('UPDATE salas SET actualizada_en=NOW() WHERE id=$1 RETURNING *', [id]);
    socketEmitter.emitirActualizacionSalaAdmin(salaUpd.rows[0]);
    return res.json({ ok: true, equipo });
  } catch (error) {
    console.error('Error actualizando rol de jugador:', error);
    return res.status(500).json({ error: 'Error al actualizar rol del jugador' });
  }
});

// Cambiar bando de un jugador dentro de una sala
router.patch('/salas/:id/jugadores/:idUsuario/bando', verificarSuperadminToken, async (req, res) => {
  const { id, idUsuario } = req.params;
  const banda = String(req.body?.banda || '').trim().toLowerCase();
  if (!['radiant', 'dire'].includes(banda)) {
    return res.status(400).json({ error: 'Bando inválido' });
  }

  try {
    const existeR = await db.query('SELECT 1 FROM sala_jugadores WHERE id_sala=$1 AND id_usuario=$2', [id, idUsuario]);
    if (!existeR.rows.length) return res.status(404).json({ error: 'Jugador no encontrado en la sala' });

    await db.query(
      'UPDATE sala_jugadores SET banda=$1 WHERE id_sala=$2 AND id_usuario=$3',
      [banda, id, idUsuario]
    );

    const salaUpd = await db.query('UPDATE salas SET actualizada_en=NOW() WHERE id=$1 RETURNING *', [id]);
    socketEmitter.emitirActualizacionSalaAdmin(salaUpd.rows[0]);
    return res.json({ ok: true, banda });
  } catch (error) {
    console.error('Error actualizando bando de jugador:', error);
    return res.status(500).json({ error: 'Error al actualizar bando del jugador' });
  }
});

// ─── Ganadores admin ─────────────────────────────────────────────────────────

router.get('/ganadores', verificarSuperadminToken, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const activoRaw = String(req.query.activo || '').trim().toLowerCase();
    const pageRaw = parseInt(req.query.page, 10);
    const limitRaw = parseInt(req.query.limit, 10);

    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 12;
    const offset = (page - 1) * limit;

    const where = [];
    const params = [];

    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      where.push(`(
        LOWER(COALESCE(s.nombre, '')) LIKE $${params.length}
        OR LOWER(COALESCE(sr.resumen_resultado, '')) LIKE $${params.length}
        OR LOWER(COALESCE(sr.match_id, '')) LIKE $${params.length}
        OR LOWER(COALESCE(sr.equipo_ganador, '')) LIKE $${params.length}
      )`);
    }

    if (activoRaw === 'true' || activoRaw === 'false') {
      params.push(activoRaw === 'true');
      where.push(`sr.activo = $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const totalR = await db.query(
      `SELECT COUNT(*)::int AS total
       FROM salas_resultados sr
       INNER JOIN salas s ON s.id = sr.id_sala
       ${whereSql}`,
      params
    );

    const total = totalR.rows[0]?.total || 0;

    params.push(limit, offset);

    const listR = await db.query(
      `SELECT
         sr.id,
         sr.id_sala,
         sr.id_partida,
         sr.match_id,
         sr.equipo_ganador,
         sr.marcador_radiant,
         sr.marcador_dire,
         sr.resumen_resultado,
         sr.id_mvp_usuario,
         sr.metadata,
         sr.activo,
         sr.finalizada_en,
         sr.creado_en,
         sr.actualizado_en,
         s.nombre AS sala_nombre,
         mvp.nombre_usuario AS mvp_nombre
       FROM salas_resultados sr
       INNER JOIN salas s ON s.id = sr.id_sala
       LEFT JOIN usuarios mvp ON mvp.id = sr.id_mvp_usuario
       ${whereSql}
       ORDER BY sr.finalizada_en DESC, sr.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return res.json({
      items: listR.rows,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (error) {
    console.error('Error listando ganadores admin:', error);
    return res.status(500).json({ error: 'Error al obtener ganadores' });
  }
});

router.get('/ganadores/:id', verificarSuperadminToken, async (req, res) => {
  try {
    const { id } = req.params;
    const r = await db.query(
      `SELECT
         sr.id,
         sr.id_sala,
         sr.id_partida,
         sr.match_id,
         sr.equipo_ganador,
         sr.marcador_radiant,
         sr.marcador_dire,
         sr.resumen_resultado,
         sr.id_mvp_usuario,
         sr.metadata,
         sr.activo,
         sr.finalizada_en,
         sr.creado_en,
         sr.actualizado_en,
         s.nombre AS sala_nombre,
         mvp.nombre_usuario AS mvp_nombre
       FROM salas_resultados sr
       INNER JOIN salas s ON s.id = sr.id_sala
       LEFT JOIN usuarios mvp ON mvp.id = sr.id_mvp_usuario
       WHERE sr.id = $1
       LIMIT 1`,
      [id]
    );

    if (!r.rows.length) return res.status(404).json({ error: 'Registro no encontrado' });
    return res.json({ item: r.rows[0] });
  } catch (error) {
    console.error('Error obteniendo ganador admin:', error);
    return res.status(500).json({ error: 'Error al obtener ganador' });
  }
});

router.get('/ganadores/catalogo', verificarSuperadminToken, async (req, res) => {
  try {
    const [salasR, usuariosR] = await Promise.all([
      db.query(`
        SELECT id, nombre, estado, creada_en
        FROM salas
        ORDER BY creada_en DESC
        LIMIT 200
      `),
      db.query(`
        SELECT id, nombre_usuario
        FROM usuarios
        ORDER BY nombre_usuario ASC
        LIMIT 500
      `),
    ]);

    return res.json({ salas: salasR.rows, usuarios: usuariosR.rows });
  } catch (error) {
    console.error('Error obteniendo catalogo ganadores:', error);
    return res.status(500).json({ error: 'Error al obtener catalogo' });
  }
});

router.post('/ganadores', verificarSuperadminToken, async (req, res) => {
  const {
    idSala,
    idPartida,
    matchId,
    equipoGanador,
    marcadorRadiant,
    marcadorDire,
    resumenResultado,
    idMvpUsuario,
    metadata,
    activo,
    finalizadaEn,
  } = req.body || {};

  if (!idSala) {
    return res.status(400).json({ error: 'idSala es requerido' });
  }
  if (!['radiant', 'dire'].includes(equipoGanador)) {
    return res.status(400).json({ error: 'equipoGanador debe ser radiant o dire' });
  }

  try {
    const r = await db.query(
      `INSERT INTO salas_resultados (
        id_sala, id_partida, match_id, equipo_ganador,
        marcador_radiant, marcador_dire, resumen_resultado,
        id_mvp_usuario, metadata, activo, finalizada_en, creado_en, actualizado_en
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7,
        $8, COALESCE($9::jsonb, '{}'::jsonb), COALESCE($10, TRUE), COALESCE($11, NOW()), NOW(), NOW()
      )
      RETURNING *`,
      [
        idSala,
        idPartida || null,
        matchId || null,
        equipoGanador,
        Number.isFinite(Number(marcadorRadiant)) ? parseInt(marcadorRadiant, 10) : 0,
        Number.isFinite(Number(marcadorDire)) ? parseInt(marcadorDire, 10) : 0,
        resumenResultado || null,
        idMvpUsuario || null,
        metadata ? JSON.stringify(metadata) : null,
        typeof activo === 'boolean' ? activo : true,
        finalizadaEn || null,
      ]
    );

    return res.status(201).json({ item: r.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'La sala ya tiene un resultado registrado' });
    }
    console.error('Error creando ganador admin:', error);
    return res.status(500).json({ error: 'Error al crear ganador' });
  }
});

router.patch('/ganadores/:id', verificarSuperadminToken, async (req, res) => {
  const { id } = req.params;
  const {
    idSala,
    idPartida,
    matchId,
    equipoGanador,
    marcadorRadiant,
    marcadorDire,
    resumenResultado,
    idMvpUsuario,
    metadata,
    activo,
    finalizadaEn,
  } = req.body || {};

  if (equipoGanador && !['radiant', 'dire'].includes(equipoGanador)) {
    return res.status(400).json({ error: 'equipoGanador debe ser radiant o dire' });
  }

  try {
    const r = await db.query(
      `UPDATE salas_resultados
       SET
         id_sala = COALESCE($1, id_sala),
         id_partida = $2,
         match_id = $3,
         equipo_ganador = COALESCE($4, equipo_ganador),
         marcador_radiant = COALESCE($5, marcador_radiant),
         marcador_dire = COALESCE($6, marcador_dire),
         resumen_resultado = $7,
         id_mvp_usuario = $8,
         metadata = COALESCE($9::jsonb, metadata),
         activo = COALESCE($10, activo),
         finalizada_en = COALESCE($11, finalizada_en),
         actualizado_en = NOW()
       WHERE id = $12
       RETURNING *`,
      [
        idSala || null,
        idPartida || null,
        matchId || null,
        equipoGanador || null,
        Number.isFinite(Number(marcadorRadiant)) ? parseInt(marcadorRadiant, 10) : null,
        Number.isFinite(Number(marcadorDire)) ? parseInt(marcadorDire, 10) : null,
        resumenResultado || null,
        idMvpUsuario || null,
        metadata ? JSON.stringify(metadata) : null,
        typeof activo === 'boolean' ? activo : null,
        finalizadaEn || null,
        id,
      ]
    );

    if (!r.rows.length) return res.status(404).json({ error: 'Registro no encontrado' });
    return res.json({ item: r.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'La sala ya tiene un resultado registrado' });
    }
    console.error('Error editando ganador admin:', error);
    return res.status(500).json({ error: 'Error al editar ganador' });
  }
});

router.patch('/ganadores/:id/activo', verificarSuperadminToken, async (req, res) => {
  const { id } = req.params;
  const { activo } = req.body || {};
  if (typeof activo !== 'boolean') {
    return res.status(400).json({ error: 'activo debe ser boolean' });
  }

  try {
    const r = await db.query(
      `UPDATE salas_resultados
       SET activo = $1, actualizado_en = NOW()
       WHERE id = $2
       RETURNING *`,
      [activo, id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Registro no encontrado' });
    return res.json({ item: r.rows[0] });
  } catch (error) {
    console.error('Error cambiando activo ganador admin:', error);
    return res.status(500).json({ error: 'Error al cambiar estado' });
  }
});

router.delete('/ganadores/:id', verificarSuperadminToken, async (req, res) => {
  const { id } = req.params;
  try {
    const r = await db.query('DELETE FROM salas_resultados WHERE id = $1 RETURNING id', [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Registro no encontrado' });
    return res.json({ ok: true });
  } catch (error) {
    console.error('Error eliminando ganador admin:', error);
    return res.status(500).json({ error: 'Error al eliminar ganador' });
  }
});

// ─────────────────────────────────────────
// BANEADOS
// ─────────────────────────────────────────

// GET /baneados — listado paginado de usuarios con filtro
router.get('/baneados', verificarSuperadminToken, async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 15);
  const offset = (page - 1) * limit;
  const q      = (req.query.q || '').trim();
  const solo   = req.query.solo_baneados; // 'true' | 'false' | ''

  try {
    const conditions = [];
    const vals = [];
    let idx = 1;

    if (q) {
      conditions.push(`(u.nombre_usuario ILIKE $${idx} OR u.steam_id ILIKE $${idx} OR u.email ILIKE $${idx})`);
      vals.push(`%${q}%`);
      idx++;
    }
    if (solo === 'true')  { conditions.push(`u.esta_baneado = TRUE`); }
    if (solo === 'false') { conditions.push(`u.esta_baneado = FALSE`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [rowsRes, countRes] = await Promise.all([
      db.query(
        `SELECT u.id, u.nombre_usuario, u.steam_id, u.avatar,
                u.mmr, u.saldo, u.nivel, u.esta_baneado,
                u.email, u.pais, u.creado_en, u.actualizado_en,
                (SELECT COUNT(*) FROM apuestas WHERE id_usuario = u.id)::int   AS total_apuestas,
                (SELECT COUNT(*) FROM sala_jugadores WHERE id_usuario = u.id)::int AS total_partidas
         FROM usuarios u
         ${where}
         ORDER BY u.esta_baneado DESC, u.creado_en DESC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...vals, limit, offset]
      ),
      db.query(
        `SELECT COUNT(*) FROM usuarios u ${where}`,
        vals
      ),
    ]);

    const total = parseInt(countRes.rows[0].count);
    return res.json({
      items: rowsRes.rows,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('Error listando baneados:', error);
    return res.status(500).json({ error: 'Error al obtener usuarios' });
  }
});

// GET /baneados/:id — detalle de un usuario
router.get('/baneados/:id', verificarSuperadminToken, async (req, res) => {
  const { id } = req.params;
  try {
    const [userRes, apuestasRes, salasRes, transRes] = await Promise.all([
      db.query(
        `SELECT id, nombre_usuario, steam_id, avatar, mmr, saldo, bono,
                nivel, esta_baneado, email, telefono, nombre_real, pais,
                creado_en, actualizado_en
         FROM usuarios WHERE id = $1`,
        [id]
      ),
      db.query(
        `SELECT a.id, a.tipo_apuesta, a.monto, a.prediccion, a.estado, a.ganancia, a.creado_en,
                p.match_id
         FROM apuestas a JOIN partidas p ON p.id = a.id_partida
         WHERE a.id_usuario = $1 ORDER BY a.creado_en DESC LIMIT 10`,
        [id]
      ),
      db.query(
        `SELECT sj.id_sala, s.nombre, sj.banda, sj.unido_en, s.estado
         FROM sala_jugadores sj JOIN salas s ON s.id = sj.id_sala
         WHERE sj.id_usuario = $1 ORDER BY sj.unido_en DESC LIMIT 10`,
        [id]
      ),
      db.query(
        `SELECT id, tipo, monto, descripcion, creado_en
         FROM transacciones WHERE id_usuario = $1 ORDER BY creado_en DESC LIMIT 10`,
        [id]
      ),
    ]);

    if (!userRes.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });

    return res.json({
      usuario: userRes.rows[0],
      apuestas: apuestasRes.rows,
      salas: salasRes.rows,
      transacciones: transRes.rows,
    });
  } catch (error) {
    console.error('Error detalle usuario baneados:', error);
    return res.status(500).json({ error: 'Error al obtener detalle' });
  }
});

// PATCH /baneados/:id/banear
router.patch('/baneados/:id/banear', verificarSuperadminToken, async (req, res) => {
  const { id } = req.params;
  try {
    const r = await db.query(
      `UPDATE usuarios SET esta_baneado = TRUE WHERE id = $1 RETURNING id, nombre_usuario, esta_baneado`,
      [id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    return res.json({ usuario: r.rows[0] });
  } catch (error) {
    console.error('Error baneando usuario:', error);
    return res.status(500).json({ error: 'Error al banear usuario' });
  }
});

// PATCH /baneados/:id/desbanear
router.patch('/baneados/:id/desbanear', verificarSuperadminToken, async (req, res) => {
  const { id } = req.params;
  try {
    const r = await db.query(
      `UPDATE usuarios SET esta_baneado = FALSE WHERE id = $1 RETURNING id, nombre_usuario, esta_baneado`,
      [id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    return res.json({ usuario: r.rows[0] });
  } catch (error) {
    console.error('Error desbaneando usuario:', error);
    return res.status(500).json({ error: 'Error al desbanear usuario' });
  }
});

// ─────────────────────────────────────────
// MMR
// ─────────────────────────────────────────

// GET /mmr/usuarios — listado paginado con búsqueda para ajustar MMR
router.get('/mmr/usuarios', verificarSuperadminToken, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, parseInt(req.query.limit, 10) || 15);
  const offset = (page - 1) * limit;
  const q = (req.query.q || '').trim();

  try {
    const conds = [];
    const vals = [];
    let idx = 1;

    if (q) {
      conds.push(`(
        u.nombre_usuario ILIKE $${idx}
        OR u.steam_id ILIKE $${idx}
        OR u.email ILIKE $${idx}
        OR CAST(u.id AS TEXT) ILIKE $${idx}
      )`);
      vals.push(`%${q}%`);
      idx++;
    }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const [rowsRes, countRes] = await Promise.all([
      db.query(
        `SELECT
           u.id,
           u.nombre_usuario,
           u.steam_id,
           u.avatar,
           u.email,
           u.pais,
           COALESCE(u.mmr, 0) AS mmr,
           u.esta_baneado,
           u.actualizado_en
         FROM usuarios u
         ${where}
         ORDER BY COALESCE(u.mmr, 0) DESC, u.nombre_usuario ASC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...vals, limit, offset]
      ),
      db.query(`SELECT COUNT(*)::int AS total FROM usuarios u ${where}`, vals),
    ]);

    return res.json({
      items: rowsRes.rows,
      meta: {
        page,
        limit,
        total: countRes.rows[0].total,
        totalPages: Math.max(1, Math.ceil(countRes.rows[0].total / limit)),
      },
    });
  } catch (error) {
    console.error('Error listando usuarios MMR:', error);
    return res.status(500).json({ error: 'Error al obtener usuarios para MMR' });
  }
});

// PATCH /mmr/usuarios/:id — actualizar MMR de usuario
router.patch('/mmr/usuarios/:id', verificarSuperadminToken, async (req, res) => {
  const { id } = req.params;
  const mmrRaw = req.body?.mmr;
  const mmr = Number(mmrRaw);

  if (!Number.isFinite(mmr) || mmr < 0 || mmr > 15000) {
    return res.status(400).json({ error: 'MMR invalido. Debe estar entre 0 y 15000.' });
  }

  try {
    const r = await db.query(
      `UPDATE usuarios
       SET mmr = $1, actualizado_en = NOW()
       WHERE id = $2
       RETURNING id, nombre_usuario, steam_id, mmr, actualizado_en`,
      [Math.round(mmr), id]
    );

    if (!r.rows.length) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    return res.json({ usuario: r.rows[0] });
  } catch (error) {
    console.error('Error actualizando MMR:', error);
    return res.status(500).json({ error: 'Error al actualizar MMR del usuario' });
  }
});

// ─────────────────────────────────────────
// GUÍAS
// ─────────────────────────────────────────

// GET /guias — listado paginado
router.get('/guias', verificarSuperadminToken, async (req, res) => {
  const page   = Math.max(1, parseInt(req.query.page) || 1);
  const limit  = Math.min(50, parseInt(req.query.limit) || 15);
  const offset = (page - 1) * limit;
  const q      = (req.query.q || '').trim();
  const cat    = (req.query.categoria || '').trim();
  const activo = req.query.activo; // 'true' | 'false' | ''

  const conds = [];
  const vals  = [];
  let idx = 1;

  if (q) {
    conds.push(`(titulo ILIKE $${idx} OR resumen ILIKE $${idx} OR contenido ILIKE $${idx})`);
    vals.push(`%${q}%`); idx++;
  }
  if (cat) { conds.push(`categoria = $${idx}`); vals.push(cat); idx++; }
  if (activo === 'true')  { conds.push(`activo = TRUE`); }
  if (activo === 'false') { conds.push(`activo = FALSE`); }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  try {
    await ensureRequiredTables(['public.guias'], 'SUPERADMIN_GUIAS_SCHEMA_MISSING');
    const [rowsRes, countRes] = await Promise.all([
      db.query(
        `SELECT id, titulo, resumen, categoria, orden, activo, creado_en, actualizado_en
         FROM guias ${where}
         ORDER BY orden ASC, creado_en DESC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...vals, limit, offset]
      ),
      db.query(`SELECT COUNT(*)::int AS total FROM guias ${where}`, vals),
    ]);
    const total = countRes.rows[0].total;
    return res.json({ items: rowsRes.rows, meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) {
    if (error.code === 'SUPERADMIN_GUIAS_SCHEMA_MISSING') return handleSchemaMissing(res, error);
    console.error('Error listando guias:', error);
    return res.status(500).json({ error: 'Error al obtener guías' });
  }
});

// GET /guias/categorias — lista de categorías únicas
router.get('/guias/categorias', verificarSuperadminToken, async (req, res) => {
  try {
    await ensureRequiredTables(['public.guias'], 'SUPERADMIN_GUIAS_SCHEMA_MISSING');
    const r = await db.query(`SELECT DISTINCT categoria FROM guias ORDER BY categoria ASC`);
    return res.json({ categorias: r.rows.map((x) => x.categoria) });
  } catch (error) {
    if (error.code === 'SUPERADMIN_GUIAS_SCHEMA_MISSING') return handleSchemaMissing(res, error);
    return res.status(500).json({ error: 'Error al obtener categorías' });
  }
});

// GET /guias/:id — detalle completo
router.get('/guias/:id', verificarSuperadminToken, async (req, res) => {
  try {
    await ensureRequiredTables(['public.guias'], 'SUPERADMIN_GUIAS_SCHEMA_MISSING');
    const r = await db.query(`SELECT * FROM guias WHERE id = $1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Guía no encontrada' });
    return res.json({ item: r.rows[0] });
  } catch (error) {
    if (error.code === 'SUPERADMIN_GUIAS_SCHEMA_MISSING') return handleSchemaMissing(res, error);
    return res.status(500).json({ error: 'Error al obtener guía' });
  }
});

// POST /guias — crear
router.post('/guias', verificarSuperadminToken, async (req, res) => {
  const { titulo, resumen, contenido, categoria, orden, activo } = req.body || {};
  if (!titulo || !String(titulo).trim()) return res.status(400).json({ error: 'titulo es requerido' });
  if (!contenido || !String(contenido).trim()) return res.status(400).json({ error: 'contenido es requerido' });
  try {
    await ensureRequiredTables(['public.guias'], 'SUPERADMIN_GUIAS_SCHEMA_MISSING');
    const r = await db.query(
      `INSERT INTO guias (titulo, resumen, contenido, categoria, orden, activo, creado_en, actualizado_en)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW()) RETURNING *`,
      [
        String(titulo).trim(),
        resumen ? String(resumen).trim() : null,
        String(contenido).trim(),
        categoria ? String(categoria).trim() : 'general',
        Number.isFinite(Number(orden)) ? parseInt(orden) : 0,
        activo !== false,
      ]
    );
    await sincronizarGuiasLegacyAPublicas();
    return res.status(201).json({ item: r.rows[0] });
  } catch (error) {
    if (error.code === 'SUPERADMIN_GUIAS_SYNC_SCHEMA_MISSING') return handleSchemaMissing(res, error);
    if (error.code === 'SUPERADMIN_GUIAS_SCHEMA_MISSING') return handleSchemaMissing(res, error);
    console.error('Error creando guia:', error);
    return res.status(500).json({ error: 'Error al crear guía' });
  }
});

// PATCH /guias/:id — editar
router.patch('/guias/:id', verificarSuperadminToken, async (req, res) => {
  const { id } = req.params;
  const { titulo, resumen, contenido, categoria, orden, activo } = req.body || {};
  try {
    await ensureRequiredTables(['public.guias'], 'SUPERADMIN_GUIAS_SCHEMA_MISSING');
    const r = await db.query(
      `UPDATE guias SET
         titulo     = COALESCE($1, titulo),
         resumen    = COALESCE($2, resumen),
         contenido  = COALESCE($3, contenido),
         categoria  = COALESCE($4, categoria),
         orden      = COALESCE($5, orden),
         activo     = COALESCE($6, activo),
         actualizado_en = NOW()
       WHERE id = $7 RETURNING *`,
      [
        titulo ? String(titulo).trim() : null,
        resumen !== undefined ? (resumen ? String(resumen).trim() : null) : undefined,
        contenido ? String(contenido).trim() : null,
        categoria ? String(categoria).trim() : null,
        Number.isFinite(Number(orden)) ? parseInt(orden) : null,
        typeof activo === 'boolean' ? activo : null,
        id,
      ]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Guía no encontrada' });
    await sincronizarGuiasLegacyAPublicas();
    return res.json({ item: r.rows[0] });
  } catch (error) {
    if (error.code === 'SUPERADMIN_GUIAS_SYNC_SCHEMA_MISSING') return handleSchemaMissing(res, error);
    if (error.code === 'SUPERADMIN_GUIAS_SCHEMA_MISSING') return handleSchemaMissing(res, error);
    console.error('Error editando guia:', error);
    return res.status(500).json({ error: 'Error al editar guía' });
  }
});

// PATCH /guias/:id/activo — toggle visible
router.patch('/guias/:id/activo', verificarSuperadminToken, async (req, res) => {
  const { activo } = req.body || {};
  if (typeof activo !== 'boolean') return res.status(400).json({ error: 'activo debe ser boolean' });
  try {
    await ensureRequiredTables(['public.guias'], 'SUPERADMIN_GUIAS_SCHEMA_MISSING');
    const r = await db.query(
      `UPDATE guias SET activo=$1, actualizado_en=NOW() WHERE id=$2 RETURNING *`,
      [activo, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Guía no encontrada' });
    await sincronizarGuiasLegacyAPublicas();
    return res.json({ item: r.rows[0] });
  } catch (error) {
    if (error.code === 'SUPERADMIN_GUIAS_SYNC_SCHEMA_MISSING') return handleSchemaMissing(res, error);
    if (error.code === 'SUPERADMIN_GUIAS_SCHEMA_MISSING') return handleSchemaMissing(res, error);
    return res.status(500).json({ error: 'Error al cambiar estado' });
  }
});

// DELETE /guias/:id
router.delete('/guias/:id', verificarSuperadminToken, async (req, res) => {
  try {
    await ensureRequiredTables(['public.guias'], 'SUPERADMIN_GUIAS_SCHEMA_MISSING');
    const r = await db.query(`DELETE FROM guias WHERE id=$1 RETURNING id`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Guía no encontrada' });
    await sincronizarGuiasLegacyAPublicas();
    return res.json({ ok: true });
  } catch (error) {
    if (error.code === 'SUPERADMIN_GUIAS_SYNC_SCHEMA_MISSING') return handleSchemaMissing(res, error);
    if (error.code === 'SUPERADMIN_GUIAS_SCHEMA_MISSING') return handleSchemaMissing(res, error);
    return res.status(500).json({ error: 'Error al eliminar guía' });
  }
});

// ─────────────────────────────────────────────
// BONOS
// ─────────────────────────────────────────────

// GET /bonos/usuarios/buscar?q=texto  — buscar usuarios para seleccionar
router.get('/bonos/usuarios/buscar', verificarSuperadminToken, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ items: [] });
  try {
    const like = `%${q}%`;
    const starts = `${q}%`;
    const r = await db.query(
      `SELECT id, nombre_usuario, steam_id, avatar, email, saldo, esta_baneado,
        CASE
          WHEN CAST(id AS TEXT) = $3 THEN 0
          WHEN nombre_usuario ILIKE $2 THEN 1
          WHEN email ILIKE $2 THEN 2
          WHEN steam_id ILIKE $2 THEN 3
          WHEN CAST(id AS TEXT) ILIKE $2 THEN 4
          WHEN nombre_usuario ILIKE $1 THEN 5
          WHEN email ILIKE $1 THEN 6
          WHEN steam_id ILIKE $1 THEN 7
          ELSE 9
        END AS rank_order
       FROM usuarios
       WHERE nombre_usuario ILIKE $1
          OR email ILIKE $1
          OR steam_id ILIKE $1
          OR CAST(id AS TEXT) ILIKE $1
       ORDER BY rank_order ASC, nombre_usuario ASC
       LIMIT 10`,
      [like, starts, q]
    );
    return res.json({ items: r.rows.map(({ rank_order, ...u }) => u) });
  } catch (error) {
    console.error('Error buscando usuarios para bono:', error);
    return res.status(500).json({ error: 'Error al buscar usuarios' });
  }
});

// GET /bonos — historial paginado
router.get('/bonos', verificarSuperadminToken, async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 15);
  const offset = (page - 1) * limit;
  try {
    await ensureRequiredTables(['public.bonos'], 'SUPERADMIN_BONOS_SCHEMA_MISSING');
    const [rows, cnt] = await Promise.all([
      db.query(
        `SELECT b.id, b.usuario_id, b.monto, b.mensaje, b.enviado_por, b.email_enviado, b.creado_en,
          COALESCE(NULLIF(b.tipo, ''), 'abono') AS tipo,
          u.nombre_usuario, u.email
         FROM bonos b
         LEFT JOIN usuarios u ON u.id = b.usuario_id
         ORDER BY b.creado_en DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
      db.query(`SELECT COUNT(*) FROM bonos`),
    ]);
    return res.json({ items: rows.rows, total: parseInt(cnt.rows[0].count), page, limit });
  } catch (error) {
    if (error.code === 'SUPERADMIN_BONOS_SCHEMA_MISSING') return handleSchemaMissing(res, error);
    console.error('Error listando bonos:', error);
    return res.status(500).json({ error: 'Error al listar bonos' });
  }
});

// POST /bonos — dar bono a usuario + abonar saldo + enviar email
router.post('/bonos', verificarSuperadminToken, async (req, res) => {
  const { usuario_id, monto, mensaje, tipo } = req.body || {};
  if (!usuario_id) return res.status(400).json({ error: 'Falta usuario_id' });
  const montoNum = parseFloat(monto);
  if (!montoNum || montoNum <= 0) return res.status(400).json({ error: 'El monto debe ser mayor a 0' });
  const tipoAjuste = String(tipo || 'abono').toLowerCase() === 'sancion' ? 'sancion' : 'abono';
  const mensajeLimpio = mensaje ? String(mensaje).trim() : '';
  if (!mensajeLimpio) return res.status(400).json({ error: 'Debes indicar un motivo para el ajuste' });

  try {
    await ensureRequiredTables(['public.bonos'], 'SUPERADMIN_BONOS_SCHEMA_MISSING');
    // Obtener usuario
    const uRes = await db.query(
      `SELECT id, nombre_usuario, email, saldo FROM usuarios WHERE id = $1`,
      [usuario_id]
    );
    if (!uRes.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    const usuario = uRes.rows[0];

    if (tipoAjuste === 'sancion' && Number(usuario.saldo) < montoNum) {
      return res.status(400).json({ error: 'El usuario no tiene saldo suficiente para esta sanción' });
    }

    // Aplicar impacto en saldo
    await db.query(
      `UPDATE usuarios SET saldo = saldo + $1 WHERE id = $2`,
      [tipoAjuste === 'sancion' ? -montoNum : montoNum, usuario_id]
    );

    await db.query(
      `INSERT INTO transacciones (id_usuario, tipo, monto, descripcion, creado_en)
       VALUES ($1, $2, $3, $4, NOW())`,
      [
        usuario_id,
        tipoAjuste === 'sancion' ? 'sancion' : 'bono',
        montoNum,
        tipoAjuste === 'sancion'
          ? `Sanción aplicada por superadmin. Motivo: ${mensajeLimpio}`
          : `Abono aplicado por superadmin. Motivo: ${mensajeLimpio}`,
      ]
    );

    // Registrar bono
    let emailEnviado = false;
    const bonoRes = await db.query(
      `INSERT INTO bonos (usuario_id, monto, mensaje, tipo, email_enviado)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [usuario_id, montoNum, mensajeLimpio, tipoAjuste, false]
    );
    const bono = bonoRes.rows[0];

    // Enviar email solo para abonos
    if (tipoAjuste === 'abono') {
      try {
        await emailService.enviarBono(usuario.email, usuario.nombre_usuario, montoNum, mensajeLimpio);
        emailEnviado = true;
        await db.query(`UPDATE bonos SET email_enviado=TRUE WHERE id=$1`, [bono.id]);
      } catch (emailErr) {
        console.error('Error enviando email de bono:', emailErr.message);
      }
    }

    return res.status(201).json({
      ok: true,
      bono: { ...bono, email_enviado: emailEnviado },
      usuario: { id: usuario.id, nombre_usuario: usuario.nombre_usuario, email: usuario.email },
    });
  } catch (error) {
    if (error.code === 'SUPERADMIN_BONOS_SCHEMA_MISSING') return handleSchemaMissing(res, error);
    console.error('Error dando bono:', error);
    return res.status(500).json({ error: 'Error al dar bono' });
  }
});

module.exports = router;
