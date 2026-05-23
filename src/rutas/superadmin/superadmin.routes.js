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
    let filtro;
    let params = [];
    
    if (estado === 'jugando') {
      // Incluir tanto 'jugando' como 'en_progreso'
      filtro = `WHERE s.estado IN ('jugando', 'en_progreso')`;
    } else if (estado) {
      filtro = `WHERE s.estado = $1`;
      params = [estado];
    } else {
      filtro = `WHERE s.estado IN ('esperando','jugando','terminada','finalizada','cancelada','en_progreso')`;
    }

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
            'id',       uj.id,
            'nombre',   uj.nombre_usuario,
            'avatar',   uj.avatar,
            'steam_id', uj.steam_id,
            'mmr',      COALESCE(uj.mmr, 0),
            'banda',    sj.banda,
            'equipo',   sj.equipo,
            'kills',     sjs.kills,
            'deaths',    sjs.deaths,
            'assists',   sjs.assists,
            'net_worth', sjs.net_worth,
            'gpm',       sjs.gpm,
            'xpm',       sjs.xpm
          ) ORDER BY sj.unido_en
        ) FILTER (WHERE uj.id IS NOT NULL), '[]') AS jugadores
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
      LEFT JOIN sala_jugadores_stats sjs ON sjs.id_sala = s.id AND sjs.id_usuario = uj.id
      WHERE s.id = $1
      GROUP BY s.id, u.nombre_usuario, u.avatar, pv.id, pv.titulo, pv.estado, pv.match_id, pv.delay_segundos
      LIMIT 1`,
      [id]
    );

    if (!r.rows.length) return res.status(404).json({ error: 'Sala no encontrada' });
    console.log(`[DEBUG API] Sala ${id} - match_id: ${r.rows[0].match_id}, lobby_id: ${r.rows[0].lobby_id}`);
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
    if (parseInt(salaBase.jugadores_actuales) < parseInt(salaBase.max_jugadores)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `La sala no está llena (${salaBase.jugadores_actuales}/${salaBase.max_jugadores}). Espera a que se complete.` });
    }

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

    // Obtener jugadores ANTES de cerrar la transacción
    const jugadoresQuery = await client.query(
      `SELECT u.id, u.nombre_usuario, u.steam_id, sj.equipo
       FROM sala_jugadores sj
       JOIN usuarios u ON u.id = sj.id_usuario
       WHERE sj.id_sala = $1 AND u.steam_id IS NOT NULL`,
      [id]
    );
    
    const jugadores = jugadoresQuery.rows.map(j => ({
      steamId: j.steam_id,
      name: j.nombre_usuario,
      team: j.equipo === 'dire' ? 1 : 0, // 0 = Radiant, 1 = Dire
      banda: j.equipo || 'radiant', // "radiant" o "dire"
      esCapitan: false // TODO: determinar por lógica de capitanes
    }));
    
    // Generar contraseña aleatoria para el lobby
    const lobbyPassword = Math.random().toString(36).substring(2, 8).toUpperCase();
    
    socketEmitter.emitirActualizacionSalaAdmin(salaActualizada);

    // Crear lobby en Dota 2 automáticamente mediante el bot Go
    // Usamos setImmediate para no bloquear la respuesta HTTP
    setImmediate(async () => {
      let updateClient;
      try {
        const dotaBotService = require('../../servicios/dota-bot/dotaBotGo.service');
        
        console.log(`[SALA] Creando lobby automático para sala #${id} con ${jugadores.length} jugadores...`);
        
        // Llamar al bot C# para crear el lobby
        const maxJugadores = salaActualizada.max_jugadores || 10;
        const gameMode = maxJugadores <= 2 ? 21 : 1; // 21 = 1v1 Solo Mid, 1 = All Pick
        
        console.log(`[SALA] Configurando lobby: ${maxJugadores} jugadores, modo ${gameMode}`);
        
        const botResponse = await dotaBotService.createLobby({
          salaId:       id,
          nombre:       tituloFinal,
          password:     lobbyPassword,
          gameMode:     gameMode,
          region:       7,  // South America
          maxJugadores: maxJugadores,
          jugadores:    jugadores
        });
        
        if (botResponse.success) {
          console.log(`[SALA] Lobby creado automáticamente: ${botResponse.lobbyId}`);
          
          // Actualizar sala con lobby_id, lobby_password y lobby_nombre
          updateClient = await db.pool.connect();
          console.log(`[SALA] Guardando lobby en DB: id=${id}, lobbyId=${String(botResponse.lobbyId)}, password=${lobbyPassword}, nombre=${tituloFinal}`);
          const updateResult = await updateClient.query(
            'UPDATE salas SET lobby_id = $1, lobby_password = $2, lobby_nombre = $3, lobby_estado = $4 WHERE id = $5 RETURNING lobby_id, lobby_password',
            [String(botResponse.lobbyId), lobbyPassword, tituloFinal, 'creado', id]
          );
          console.log(`[SALA] DB actualizada:`, updateResult.rows[0]);
          
          // Invitar a cada jugador con steam_id al lobby
          let invitados = 0;
          for (const j of jugadores) {
            if (!j.steamId) continue;
            try {
              await dotaBotService.invitePlayer(j.steamId, botResponse.lobbyId);
              invitados++;
              console.log(`[SALA] Invitación enviada a ${j.name} (${j.steamId})`);
              socketEmitter.emitirJugadorInvitado(Number(id), {
                idSala:   Number(id),
                steamId:  j.steamId,
                nombre:   j.name,
                mensaje:  `Invitación enviada a ${j.name} en Dota 2`
              });
            } catch (invErr) {
              console.error(`[SALA] Error invitando ${j.steamId}:`, invErr.message);
            }
          }
          
          // Notificar a todos los jugadores via socket
          const regionNombre = maxJugadores <= 2 ? 'Australia (1v1)' : 'Sudamérica (Perú)';
          socketEmitter.emitirLobbyCreado(Number(id), {
            idSala:        Number(id),
            lobbyId:       String(botResponse.lobbyId),
            lobbyNombre:   tituloFinal,
            lobbyPassword: lobbyPassword,
            region:        regionNombre,
            mensaje:       `¡Lobby creado! Busca "${tituloFinal}" en Dota 2 — Pass: ${lobbyPassword} — Región: ${regionNombre}`
          });
          
          console.log(`[SALA] Lobby ${botResponse.lobbyId} creado, ${invitados} jugadores invitados`);
        } else {
          console.error(`[SALA] Error creando lobby automático: ${botResponse.message}`);
          socketEmitter.emitirLobbyError(Number(id), {
            idSala: Number(id),
            error:  botResponse.message || 'Error desconocido al crear lobby'
          });
        }
      } catch (err) {
        console.error(`[SALA] Error en creación automática de lobby:`, err.message);
      } finally {
        if (updateClient) updateClient.release();
      }
    });

    return res.json({ 
      sala: salaActualizada, 
      partidaEnVivo: live,
      mensaje: 'Sala iniciada. El lobby se está creando automáticamente...'
    });
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

// Endpoint para que superadmin ingrese el lobby_id de Dota 2 manualmente
router.post('/salas/:id/lobby', verificarSuperadminToken, async (req, res) => {
  const { id } = req.params;
  const { lobby_id, lobby_password } = req.body;
  
  if (!lobby_id) {
    return res.status(400).json({ error: 'lobby_id es requerido' });
  }
  
  let client;
  try {
    client = await db.pool.connect();
    
    // Verificar que la sala existe y está en estado jugando
    const salaR = await client.query('SELECT * FROM salas WHERE id=$1', [id]);
    if (!salaR.rows.length) {
      return res.status(404).json({ error: 'Sala no encontrada' });
    }
    
    const sala = salaR.rows[0];
    if (sala.estado !== 'jugando') {
      return res.status(400).json({ error: 'La sala debe estar en estado "jugando" para asignar un lobby' });
    }
    
    // Actualizar sala con el lobby_id
    const upd = await client.query(
      `UPDATE salas SET lobby_id=$1, lobby_password=$2, lobby_estado='creado', actualizada_en=NOW() WHERE id=$3 RETURNING *`,
      [lobby_id, lobby_password || null, id]
    );
    
    // Obtener jugadores para notificarles
    const jugadoresR = await client.query(
      `SELECT u.id, u.nombre_usuario, u.steam_id 
       FROM sala_jugadores sj 
       JOIN usuarios u ON u.id = sj.id_usuario 
       WHERE sj.id_sala=$1`,
      [id]
    );
    
    // Notificar a todos los jugadores via socket
    socketEmitter.emitirLobbyCreado(Number(id), {
      idSala: Number(id),
      lobbyId: lobby_id,
      lobbyPassword: lobby_password || null,
      jugadores: jugadoresR.rows,
      mensaje: `¡El lobby de Dota 2 está listo! ID: ${lobby_id}${lobby_password ? ` | Contraseña: ${lobby_password}` : ''}`
    });
    
    socketEmitter.emitirActualizacionSalaAdmin(upd.rows[0]);
    
    return res.json({ 
      ok: true, 
      sala: upd.rows[0],
      mensaje: 'Lobby asignado correctamente. Los jugadores han sido notificados.'
    });
  } catch (error) {
    console.error('Error al asignar lobby:', error);
    return res.status(500).json({ error: 'Error al asignar lobby' });
  } finally {
    if (client) client.release();
  }
});

// Eliminar sala completa
router.delete('/salas/:id', verificarSuperadminToken, async (req, res) => {
  const { id } = req.params;
  let client;
  try {
    client = await db.pool.connect();
    await client.query('BEGIN');

    // Verificar sala existe
    const salaR = await client.query('SELECT * FROM salas WHERE id=$1', [id]);
    if (!salaR.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Sala no encontrada' });
    }

    // Devolver dinero a jugadores si hay entrada
    const entrada = parseFloat(salaR.rows[0].entrada) || 0;
    if (entrada > 0) {
      const jugadoresR = await client.query('SELECT id_usuario FROM sala_jugadores WHERE id_sala=$1', [id]);
      for (const jugador of jugadoresR.rows) {
        await client.query('UPDATE usuarios SET saldo=saldo+$1 WHERE id=$2', [entrada, jugador.id_usuario]);
        await client.query(
          `INSERT INTO transacciones (id_usuario, tipo, monto, descripcion, creado_en) VALUES ($1,'devolucion',$2,$3,NOW())`,
          [jugador.id_usuario, entrada, 'Eliminación de sala por admin']
        );
      }
    }

    // Eliminar mensajes de chat de la sala
    await client.query('DELETE FROM mensajes_chat_sala WHERE id_sala=$1', [id]);
    // Eliminar jugadores de la sala
    await client.query('DELETE FROM sala_jugadores WHERE id_sala=$1', [id]);
    // Eliminar apuestas asociadas (las de tipo sala se identifican por prediccion LIKE 'sala:id:%')
    await client.query("DELETE FROM apuestas WHERE prediccion LIKE 'sala:' || $1 || ':%'", [id]);
    // Eliminar la sala
    await client.query('DELETE FROM salas WHERE id=$1', [id]);

    await client.query('COMMIT');
    return res.json({ ok: true, message: 'Sala eliminada correctamente' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al eliminar sala:', error);
    return res.status(500).json({ error: 'Error al eliminar sala' });
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

// === SOPORTE - Sistema de chat ===

// Obtener lista de chats activos
router.get('/soporte/chats', verificarSuperadminToken, async (req, res) => {
  try {
    // Chats de usuarios (tipo='usuario') y admins (tipo='admin')
    const r = await db.query(`
      SELECT 
        c.id,
        c.tipo,
        c.usuario_id,
        c.admin_id,
        c.estado,
        c.creado_en,
        c.actualizado_en,
        COALESCE(u.nombre_usuario, a.usuario) as nombre,
        COALESCE(u.avatar, '/font/logo.png') as avatar,
        (
          SELECT LEFT(mensaje, 50) FROM soporte_mensajes 
          WHERE chat_id = c.id 
          ORDER BY creado_en DESC LIMIT 1
        ) as ultimo_mensaje,
        (
          SELECT creado_en FROM soporte_mensajes 
          WHERE chat_id = c.id 
          ORDER BY creado_en DESC LIMIT 1
        ) as ultima_actividad,
        (
          SELECT COUNT(*) FROM soporte_mensajes 
          WHERE chat_id = c.id AND es_admin = false AND visto = false
        ) > 0 as sin_responder
      FROM soporte_chats c
      LEFT JOIN usuarios u ON c.usuario_id = u.id
      LEFT JOIN superadmin_usuarios a ON c.admin_id = a.id
      ORDER BY 
        CASE WHEN c.estado = 'activo' THEN 0 ELSE 1 END,
        c.actualizado_en DESC
    `);

    res.json({ chats: r.rows });
  } catch (e) {
    console.error('Error obteniendo chats:', e);
    res.status(500).json({ error: e.message });
  }
});

// Obtener mensajes de un chat (con paginación)
router.get('/soporte/chats/:id/mensajes', verificarSuperadminToken, async (req, res) => {
  try {
    const chatId = parseInt(req.params.id);
    const limit = parseInt(req.query.limit) || 30;
    const before = req.query.before; // ID del mensaje antes del cual cargar (para scroll up)

    // Marcar mensajes como vistos
    await db.query(
      'UPDATE soporte_mensajes SET visto = true WHERE chat_id = $1 AND es_admin = false',
      [chatId]
    );

    let query;
    let params = [chatId, limit];
    
    if (before) {
      // Cargar mensajes antes del ID dado (scroll up - mensajes más antiguos)
      query = `
        SELECT 
          m.id,
          m.mensaje,
          m.es_admin,
          m.creado_en as fecha,
          COALESCE(u.nombre_usuario, a.usuario, 'Sistema') as autor
        FROM soporte_mensajes m
        LEFT JOIN usuarios u ON m.usuario_id = u.id
        LEFT JOIN superadmin_usuarios a ON m.admin_id = a.id
        WHERE m.chat_id = $1 AND m.id < $3
        ORDER BY m.creado_en DESC
        LIMIT $2
      `;
      params.push(parseInt(before));
    } else {
      // Cargar últimos mensajes (inicial o refresh)
      query = `
        SELECT * FROM (
          SELECT 
            m.id,
            m.mensaje,
            m.es_admin,
            m.creado_en as fecha,
            COALESCE(u.nombre_usuario, a.usuario, 'Sistema') as autor
          FROM soporte_mensajes m
          LEFT JOIN usuarios u ON m.usuario_id = u.id
          LEFT JOIN superadmin_usuarios a ON m.admin_id = a.id
          WHERE m.chat_id = $1
          ORDER BY m.creado_en DESC
          LIMIT $2
        ) sub
        ORDER BY sub.fecha ASC
      `;
    }

    const r = await db.query(query, params);
    
    // Obtener total de mensajes para saber si hay más
    const countRes = await db.query(
      'SELECT COUNT(*) as total FROM soporte_mensajes WHERE chat_id = $1',
      [chatId]
    );

    res.json({ 
      mensajes: r.rows, 
      hasMore: r.rows.length === limit,
      total: parseInt(countRes.rows[0].total)
    });
  } catch (e) {
    console.error('Error obteniendo mensajes:', e);
    res.status(500).json({ error: e.message });
  }
});

// Enviar mensaje
router.post('/soporte/chats/:id/mensajes', verificarSuperadminToken, async (req, res) => {
  try {
    const chatId = parseInt(req.params.id);
    const { mensaje } = req.body;
    const adminId = req.superadmin.id;

    if (!mensaje || !mensaje.trim()) {
      return res.status(400).json({ error: 'Mensaje requerido' });
    }

    // Insertar mensaje
    await db.query(
      `INSERT INTO soporte_mensajes (chat_id, admin_id, mensaje, es_admin, visto) 
       VALUES ($1, $2, $3, true, true)`,
      [chatId, adminId, mensaje.trim()]
    );

    // Actualizar chat
    await db.query(
      'UPDATE soporte_chats SET actualizado_en = NOW() WHERE id = $1',
      [chatId]
    );

    // Obtener mensajes actualizados
    const r = await db.query(`
      SELECT 
        m.id,
        m.mensaje,
        m.es_admin,
        m.creado_en as fecha,
        COALESCE(u.nombre_usuario, a.usuario, 'Sistema') as autor
      FROM soporte_mensajes m
      LEFT JOIN usuarios u ON m.usuario_id = u.id
      LEFT JOIN superadmin_usuarios a ON m.admin_id = a.id
      WHERE m.chat_id = $1
      ORDER BY m.creado_en ASC
    `, [chatId]);

    res.json({ mensajes: r.rows });
  } catch (e) {
    console.error('Error enviando mensaje:', e);
    res.status(500).json({ error: e.message });
  }
});

// Marcar chat como resuelto
router.post('/soporte/chats/:id/resolver', verificarSuperadminToken, async (req, res) => {
  try {
    const chatId = parseInt(req.params.id);
    const adminId = req.superadmin.id;

    // Obtener nombre del admin
    const adminRes = await db.query('SELECT usuario FROM superadmin_usuarios WHERE id = $1', [adminId]);
    const adminNombre = adminRes.rows[0]?.usuario || 'Admin';

    await db.query(
      'UPDATE soporte_chats SET estado = $1, actualizado_en = NOW(), admin_id = $2 WHERE id = $3',
      ['resuelto', adminId, chatId]
    );

    // Agregar mensaje de sistema especial
    await db.query(
      `INSERT INTO soporte_mensajes (chat_id, admin_id, mensaje, es_admin, visto, es_sistema) 
       VALUES ($1, $2, $3, true, true, true)`,
      [chatId, adminId, `✅ Chat marcado como resuelto por ${adminNombre}`]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error('Error resolviendo chat:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// Cerrar/Destruir lobby Dota 2
// ─────────────────────────────────────────

router.post('/salas/:id/cerrar-lobby', verificarSuperadminToken, async (req, res) => {
  const { id } = req.params;
  let client;
  try {
    const dotaBotService = require('../../servicios/dota-bot/dotaBot.service');
    
    // Obtener datos de la sala
    client = await db.pool.connect();
    const salaR = await client.query(
      'SELECT id, lobby_id, lobby_nombre, nombre FROM salas WHERE id = $1',
      [id]
    );
    
    if (!salaR.rows.length) {
      return res.status(404).json({ error: 'Sala no encontrada' });
    }
    
    const sala = salaR.rows[0];
    
    if (!sala.lobby_id) {
      return res.status(400).json({ error: 'Esta sala no tiene un lobby activo en Dota 2' });
    }
    
    // Llamar al bot para que abandone el lobby
    console.log(`[SUPERADMIN] Cerrando lobby ${sala.lobby_id} para sala #${id}`);
    const result = await dotaBotService.leaveLobby(sala.lobby_id);
    
    if (!result.success) {
      console.error(`[SUPERADMIN] Error cerrando lobby:`, result.message);
      // Continuamos igual para limpiar la DB, pero avisamos
    }
    
    // Limpiar datos del lobby en la base de datos
    await client.query(
      `UPDATE salas SET lobby_id = NULL, lobby_password = NULL, lobby_nombre = NULL, lobby_estado = 'sin_lobby', actualizada_en = NOW() WHERE id = $1`,
      [id]
    );
    
    // Notificar a los jugadores que el lobby fue cerrado
    socketEmitter.emitirLobbyEstado(Number(id), {
      idSala: Number(id),
      estado: 'lobby_cerrado',
      mensaje: `El lobby "${sala.lobby_nombre || sala.nombre}" fue cerrado por el administrador`
    });
    
    res.json({ 
      success: true, 
      mensaje: `Lobby cerrado exitosamente`,
      lobbyId: sala.lobby_id,
      botResult: result
    });
    
  } catch (error) {
    console.error(`[SUPERADMIN] Error en cerrar-lobby:`, error);
    res.status(500).json({ error: 'Error al cerrar el lobby de Dota 2' });
  } finally {
    if (client) client.release();
  }
});

// ─────────────────────────────────────────
// Obtener jugador host que quedó cuando el bot salió
// ─────────────────────────────────────────

router.get('/salas/:id/host-lobby', verificarSuperadminToken, async (req, res) => {
  const { id } = req.params;
  try {
    const dotaBotGoService = require('../../servicios/dota-bot/dotaBotGo.service');
    const host = dotaBotGoService.getHostPlayer(id);
    
    if (host) {
      res.json({ 
        success: true, 
        host: host,
        message: `Host asignado: ${host.name} (${host.steamId})`
      });
    } else {
      res.json({ 
        success: false, 
        message: 'No hay información de host guardada para esta sala'
      });
    }
  } catch (error) {
    console.error(`[SUPERADMIN] Error obteniendo host:`, error);
    res.status(500).json({ error: 'Error al obtener información del host' });
  }
});

// Iniciar partida en el lobby (lanzar el juego) via Redis
router.post('/salas/:id/iniciar-partida', verificarSuperadminToken, async (req, res) => {
  const { id } = req.params;
  try {
    const dotaBotGoService = require('../../servicios/dota-bot/dotaBotGo.service');
    
    // Obtener sala con datos del lobby
    const salaRes = await db.query('SELECT * FROM salas WHERE id = $1', [id]);
    const sala = salaRes.rows[0];
    
    if (!sala || !sala.lobby_id) {
      return res.status(400).json({ error: 'No hay lobby activo para iniciar' });
    }

    // Llamar al bot Go via Redis para iniciar la partida
    const result = await dotaBotGoService.iniciarPartida(id, sala.lobby_id);
    
    console.log(`[SUPERADMIN] Partida iniciada para sala ${id}, lobby ${sala.lobby_id}`);
    res.json({ success: true, mensaje: 'Partida iniciada correctamente', result });
    
  } catch (error) {
    console.error(`[SUPERADMIN] Error en iniciar-partida:`, error);
    res.status(500).json({ error: 'Error al iniciar la partida' });
  }
});

// Hacer que el bot salga del slot (se queda como espectador) via Redis
router.post('/salas/:id/salir-slot', verificarSuperadminToken, async (req, res) => {
  const { id } = req.params;
  try {
    const dotaBotGoService = require('../../servicios/dota-bot/dotaBotGo.service');
    
    // Obtener sala con datos del lobby
    const salaRes = await db.query('SELECT * FROM salas WHERE id = $1', [id]);
    const sala = salaRes.rows[0];
    
    if (!sala || !sala.lobby_id) {
      return res.status(400).json({ error: 'No hay lobby activo' });
    }

    // Llamar al bot Go via Redis para salir del slot
    const result = await dotaBotGoService.salirSlot(id, sala.lobby_id);
    
    console.log(`[SUPERADMIN] Bot salió del slot en sala ${id}, lobby ${sala.lobby_id}`);
    res.json({ success: true, mensaje: 'Bot movido a espectador correctamente', result });
    
  } catch (error) {
    console.error(`[SUPERADMIN] Error en salir-slot:`, error);
    res.status(500).json({ error: 'Error al mover el bot a espectador' });
  }
});

// Consultar resultado de partida via OpenDota API
// Si la sala tiene match_id guardado, consulta directo. Si no, busca por jugadores.
router.post('/salas/:id/consultar-resultado', verificarSuperadminToken, async (req, res) => {
  const { id } = req.params;
  
  try {
    // Obtener sala con jugadores y sus steam_ids
    const salaQuery = await db.query(`
      SELECT s.*, 
             COALESCE(
               json_agg(
                 json_build_object(
                   'usuario_id', sj.id_usuario,
                   'steam_id', u.steam_id,
                   'banda', sj.banda,
                   'nombre', u.nombre_usuario,
                   'mmr', u.mmr
                 ) ORDER BY sj.id
               ) FILTER (WHERE sj.id_usuario IS NOT NULL),
               '[]'
             ) as jugadores
      FROM salas s
      LEFT JOIN sala_jugadores sj ON s.id = sj.id_sala
      LEFT JOIN usuarios u ON sj.id_usuario = u.id
      WHERE s.id = $1
      GROUP BY s.id
    `, [id]);
    
    if (salaQuery.rows.length === 0) {
      return res.status(404).json({ error: 'Sala no encontrada' });
    }
    
    const sala = salaQuery.rows[0];
    let matchEncontrado = null;
    let matchIdUsado = null;
    
    // Variables de configuración de APIs
    const steamApiKey = process.env.STEAM_API_KEY;
    const stratzToken = process.env.STRATZ_TOKEN;
    
    // DEBUG: Verificar campos de la sala
    console.log(`[SUPERADMIN] DEBUG Sala ${id} - lobby_id: ${sala.lobby_id}, match_id: ${sala.match_id}, match_encontrado_en: ${sala.match_encontrado_en}, match_resultado: ${sala.match_resultado}`);
    
    // OPCIÓN 1: Si ya tenemos match_id guardado, consultar directo
    if (sala.match_id) {
      console.log(`[SUPERADMIN] Sala ${id} tiene match_id guardado: ${sala.match_id}. Consultando...`);
      matchIdUsado = sala.match_id;
      
      // === FUENTE 1: Steam Web API (oficial, inmediata, funciona con lobbies privados) ===
      if (steamApiKey) {
        try {
          console.log(`[SUPERADMIN] Intentando Steam Web API...`);
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000); // 5 seg timeout
          
          const steamResponse = await fetch(
            `https://api.steampowered.com/IDOTA2Match_570/GetMatchDetails/v1/?key=${steamApiKey}&match_id=${sala.match_id}`,
            { signal: controller.signal }
          );
          clearTimeout(timeout);
          
          if (steamResponse.ok) {
            const steamData = await steamResponse.json();
            const match = steamData.result;
            
            // Steam API devuelve error en result.status si no encuentra la partida
            if (match && match.error) {
              console.warn(`[SUPERADMIN] Steam API error: ${match.error}`);
            } else if (match && match.match_id) {
              matchEncontrado = {
                match_id: parseInt(sala.match_id),
                radiant_win: match.radiant_win,
                duration: match.duration,
                start_time: match.start_time,
                players: match.players || [],
                radiant_score: match.radiant_score || 0,
                dire_score: match.dire_score || 0,
                game_mode: match.game_mode,
                lobby_type: match.lobby_type,
                region: match.cluster
              };
              console.log(`[SUPERADMIN] ✅ Match ${sala.match_id} encontrado en Steam Web API`);
            }
          } else {
            const errorText = await steamResponse.text().catch(() => '');
            console.warn(`[SUPERADMIN] Steam API status ${steamResponse.status}: ${errorText.substring(0, 100)}`);
          }
        } catch (steamErr) {
          if (steamErr.name === 'AbortError') {
            console.warn(`[SUPERADMIN] Steam API timeout (5s)`);
          } else {
            console.warn(`[SUPERADMIN] Error Steam API:`, steamErr.message);
          }
        }
      } else {
        console.warn(`[SUPERADMIN] STEAM_API_KEY no configurada, saltando Steam API...`);
      }
      
      // === FUENTE 2: OpenDota (requiere solicitar parse primero para lobbies privados) ===
      if (!matchEncontrado) {
        try {
          console.log(`[SUPERADMIN] Intentando OpenDota...`);
          
          // Paso 1: Solicitar parse de la partida (necesario para lobbies privados)
          console.log(`[SUPERADMIN] Solicitando parse en OpenDota...`);
          const parseController = new AbortController();
          const parseTimeout = setTimeout(() => parseController.abort(), 3000);
          await fetch(`https://api.opendota.com/api/request/${sala.match_id}`, {
            method: 'POST',
            signal: parseController.signal
          }).catch(() => {}); // Ignorar error del parse
          clearTimeout(parseTimeout);
          
          // Paso 2: Esperar brevemente y consultar con timeout
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);
          
          const response = await fetch(`https://api.opendota.com/api/matches/${sala.match_id}`, {
            signal: controller.signal
          });
          clearTimeout(timeout);
          
          if (response.ok) {
            const matchData = await response.json();
            matchEncontrado = {
              match_id: parseInt(sala.match_id),
              radiant_win: matchData.radiant_win,
              duration: matchData.duration,
              start_time: matchData.start_time,
              players: matchData.players,
              radiant_score: matchData.radiant_score,
              dire_score: matchData.dire_score,
              game_mode: matchData.game_mode,
              lobby_type: matchData.lobby_type,
              region: matchData.region
            };
            console.log(`[SUPERADMIN] ✅ Match ${sala.match_id} encontrado en OpenDota`);
          } else {
            console.warn(`[SUPERADMIN] OpenDota status ${response.status}`);
          }
        } catch (err) {
          if (err.name === 'AbortError') {
            console.warn(`[SUPERADMIN] OpenDota timeout (5s)`);
          } else {
            console.warn(`[SUPERADMIN] Error OpenDota:`, err.message);
          }
        }
      }
      
      // === FUENTE 3: STRATZ (requiere token) ===
      if (!matchEncontrado && stratzToken) {
        try {
          console.log(`[SUPERADMIN] Intentando STRATZ API...`);
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);
          
          const stratzResponse = await fetch(`https://api.stratz.com/api/v1/match/${sala.match_id}`, {
            headers: {
              'Authorization': `Bearer ${stratzToken}`,
              'Accept': 'application/json'
            },
            signal: controller.signal
          });
          clearTimeout(timeout);
          
          if (stratzResponse.ok) {
            const stratzData = await stratzResponse.json();
            
            if (stratzData.didRadiantWin !== undefined && stratzData.durationSeconds) {
              matchEncontrado = {
                match_id: parseInt(sala.match_id),
                radiant_win: stratzData.didRadiantWin,
                duration: stratzData.durationSeconds,
                start_time: stratzData.startDateTime,
                players: [],
                radiant_score: stratzData.radiantKills || 0,
                dire_score: stratzData.direKills || 0,
                game_mode: stratzData.gameMode || 'Unknown',
                lobby_type: stratzData.lobbyType || 'Unknown',
                region: stratzData.regionId || 'Unknown'
              };
              console.log(`[SUPERADMIN] ✅ Match ${sala.match_id} encontrado en STRATZ`);
            }
          } else {
            console.warn(`[SUPERADMIN] STRATZ status ${stratzResponse.status}`);
          }
        } catch (stratzErr) {
          if (stratzErr.name === 'AbortError') {
            console.warn(`[SUPERADMIN] STRATZ timeout (5s)`);
          } else {
            console.warn(`[SUPERADMIN] Error STRATZ:`, stratzErr.message);
          }
        }
      }
    }
    
    if (!matchEncontrado) {
      return res.json({ 
        success: false, 
        message: sala.match_id 
          ? `El match_id ${sala.match_id} no fue encontrado en Steam API, OpenDota ni STRATZ. Verifica que STEAM_API_KEY esté configurada en el backend.`
          : 'No hay match_id guardado para esta sala.',
        match_id_guardado: sala.match_id || null,
        apis_intentadas: steamApiKey ? ['Steam API (falló)', 'OpenDota', 'STRATZ'] : ['Steam API (no configurada)', 'OpenDota', 'STRATZ']
      });
    }
    
    // Determinar ganador
    // radiant_win = true -> ganó Radiant, false -> ganó Dire
    const resultado = matchEncontrado.radiant_win ? 'radiant' : 'dire';
    
    // Guardar en base de datos (actualizar si ya existía, o guardar nuevo)
    await db.query(`
      UPDATE salas 
      SET match_id = $1,
          match_resultado = $2,
          match_consultado_en = NOW(),
          match_raw_data = $3,
          estado = 'finalizada'
      WHERE id = $4
    `, [
      String(matchEncontrado.match_id),
      resultado,
      JSON.stringify(matchEncontrado),
      id
    ]);
    
    console.log(`[SUPERADMIN] Resultado guardado para sala ${id}: ${resultado} (match ${matchEncontrado.match_id})`);

    // ── Poblar sala_jugadores_stats desde los players del match ──────────────
    let statsGuardados = 0;
    try {
      const players = matchEncontrado.players || [];
      if (players.length > 0) {
        // Borrar stats previos de esta sala (re-consulta limpia)
        await db.query('DELETE FROM sala_jugadores_stats WHERE id_sala = $1', [id]);

        for (const p of players) {
          // Steam API devuelve account_id (32-bit), convertir a steam_id 64-bit
          const accountId = p.account_id;
          let steamId64 = null;
          if (accountId && accountId !== 4294967295) { // 4294967295 = anónimo
            steamId64 = String(BigInt(accountId) + BigInt('76561197960265728'));
          }

          // Determinar banda por player_slot: 0-4 = radiant, 128-132 = dire
          const banda = (p.player_slot !== undefined && p.player_slot < 128) ? 'radiant' : 'dire';

          // Buscar id_usuario por steam_id
          let idUsuario = null;
          if (steamId64) {
            const uRes = await db.query('SELECT id FROM usuarios WHERE steam_id = $1 LIMIT 1', [steamId64]);
            if (uRes.rows.length > 0) idUsuario = uRes.rows[0].id;
          }

          await db.query(`
            INSERT INTO sala_jugadores_stats
              (id_sala, id_usuario, steam_id, banda, kills, deaths, assists, net_worth, gpm, xpm,
               hero_damage, tower_damage, hero_healing, last_hits, denies, level, hero_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
            ON CONFLICT (id_sala, steam_id) DO UPDATE SET
              kills=EXCLUDED.kills, deaths=EXCLUDED.deaths, assists=EXCLUDED.assists,
              net_worth=EXCLUDED.net_worth, gpm=EXCLUDED.gpm, xpm=EXCLUDED.xpm,
              hero_damage=EXCLUDED.hero_damage, tower_damage=EXCLUDED.tower_damage,
              hero_healing=EXCLUDED.hero_healing, last_hits=EXCLUDED.last_hits,
              denies=EXCLUDED.denies, level=EXCLUDED.level, hero_id=EXCLUDED.hero_id,
              id_usuario=COALESCE(EXCLUDED.id_usuario, sala_jugadores_stats.id_usuario)
          `, [
            id,
            idUsuario,
            steamId64,
            banda,
            p.kills || 0,
            p.deaths || 0,
            p.assists || 0,
            p.net_worth || 0,
            p.gold_per_min || 0,
            p.xp_per_min || 0,
            p.hero_damage || 0,
            p.tower_damage || 0,
            p.hero_healing || 0,
            p.last_hits || 0,
            p.denies || 0,
            p.level || 1,
            p.hero_id || null,
          ]);
          statsGuardados++;
        }
        console.log(`[SUPERADMIN] Stats guardados para ${statsGuardados} jugadores en sala ${id}`);
      }
    } catch (statsErr) {
      console.warn(`[SUPERADMIN] Error guardando stats de jugadores:`, statsErr.message);
    }
    // ────────────────────────────────────────────────────────────────────────

    res.json({
      success: true,
      match_id: matchEncontrado.match_id,
      resultado: resultado,
      duracion_segundos: matchEncontrado.duration,
      duracion_formateada: `${Math.floor(matchEncontrado.duration / 60)}:${(matchEncontrado.duration % 60).toString().padStart(2, '0')}`,
      fecha_inicio: new Date(matchEncontrado.start_time * 1000).toISOString(),
      jugadores_encontrados: (sala.jugadores || []).filter(j => j.steam_id).length,
      stats_guardados: statsGuardados,
      metodo_busqueda: sala.match_id && matchIdUsado === sala.match_id ? 'match_id_directo' : 'jugadores',
      datos_completos: matchEncontrado
    });
    
  } catch (error) {
    console.error(`[SUPERADMIN] Error consultando resultado:`, error);
    res.status(500).json({ error: 'Error al consultar resultado de la partida', details: error.message });
  }
});

// POST /api/superadmin/salas/:id/stats-manuales - Subir KDA/gold/gpm/xpm manualmente por jugador
router.post('/salas/:id/stats-manuales', verificarSuperadminToken, async (req, res) => {
  const { id } = req.params;
  const { jugadores } = req.body; // [{ id_usuario, banda, kills, deaths, assists, net_worth, gpm, xpm }]

  if (!Array.isArray(jugadores) || jugadores.length === 0) {
    return res.status(400).json({ error: 'Se requiere un array de jugadores' });
  }

  try {
    // Borrar stats previos y reinsertar
    await db.query('DELETE FROM sala_jugadores_stats WHERE id_sala = $1', [id]);

    for (const j of jugadores) {
      if (!j.id_usuario) continue;
      // Obtener steam_id del usuario
      const uRes = await db.query('SELECT steam_id FROM usuarios WHERE id = $1 LIMIT 1', [j.id_usuario]);
      const steamId = uRes.rows[0]?.steam_id || null;

      await db.query(`
        INSERT INTO sala_jugadores_stats
          (id_sala, id_usuario, steam_id, banda, kills, deaths, assists, net_worth, gpm, xpm)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (id_sala, id_usuario) DO UPDATE SET
          banda=EXCLUDED.banda, kills=EXCLUDED.kills, deaths=EXCLUDED.deaths,
          assists=EXCLUDED.assists, net_worth=EXCLUDED.net_worth,
          gpm=EXCLUDED.gpm, xpm=EXCLUDED.xpm
      `, [
        id,
        j.id_usuario,
        steamId,
        j.banda || 'radiant',
        parseInt(j.kills) || 0,
        parseInt(j.deaths) || 0,
        parseInt(j.assists) || 0,
        parseInt(j.net_worth) || 0,
        parseInt(j.gpm) || 0,
        parseInt(j.xpm) || 0,
      ]);
    }

    console.log(`[SUPERADMIN] Stats manuales guardados para sala ${id}: ${jugadores.length} jugadores`);
    res.json({ ok: true, guardados: jugadores.length });
  } catch (e) {
    console.error('[SUPERADMIN] Error stats-manuales:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/superadmin/salas/:id/guardar-resultado - Guardar resultado manual
router.post('/salas/:id/guardar-resultado', async (req, res) => {
  try {
    const { id } = req.params;
    const { radiant_win, duration, radiant_score, dire_score, notas } = req.body;
    
    console.log(`[SUPERADMIN] Guardando resultado manual para sala ${id}:`, { radiant_win, duration, radiant_score, dire_score });
    
    // Validar datos requeridos
    if (radiant_win === undefined || !duration) {
      return res.status(400).json({ 
        success: false, 
        message: 'Faltan datos requeridos: radiant_win (boolean) y duration (segundos)' 
      });
    }
    
    const db = require('../../config/database');
    
    // Guardar resultado en la sala
    const resultado = {
      radiant_win: Boolean(radiant_win),
      duration: parseInt(duration),
      radiant_score: parseInt(radiant_score) || 0,
      dire_score: parseInt(dire_score) || 0,
      notas: notas || 'Ingresado manualmente',
      ingresado_en: new Date().toISOString()
    };
    
    await db.query(
      `UPDATE salas 
       SET match_resultado = $1, 
           match_encontrado_en = NOW()
       WHERE id = $2`,
      [JSON.stringify(resultado), id]
    );
    
    console.log(`[SUPERADMIN] ✅ Resultado guardado manualmente para sala ${id}`);
    
    res.json({
      success: true,
      message: 'Resultado guardado correctamente',
      resultado: {
        ganador: radiant_win ? 'Radiant' : 'Dire',
        duracion: `${Math.floor(duration / 60)}m ${duration % 60}s`,
        score: `${radiant_score || 0} - ${dire_score || 0}`
      }
    });
    
  } catch (error) {
    console.error(`[SUPERADMIN] Error guardando resultado manual:`, error);
    res.status(500).json({ error: 'Error al guardar resultado', details: error.message });
  }
});

module.exports = router;
