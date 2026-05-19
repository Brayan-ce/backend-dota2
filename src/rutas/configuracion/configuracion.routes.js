const express = require('express');
const router = express.Router();
const db = require('../../config/database');
const { verificarToken } = require('../../middleware/auth');
const emailService = require('../../servicios/email/email.service');
const steamService = require('../../servicios/steam/steam.service');

const MMR_USER_COOLDOWN_HOURS = 24;
const MMR_GLOBAL_SLOT_MINUTES = 20;
let mmrQueueBusy = false;
let mmrSchemaWarned = false;

async function ensureMMRTablesReady() {
  const requiredTables = [
    'public.mmr_actualizaciones',
    'public.mmr_control_usuario',
    'public.mmr_control_global',
    'public.mmr_acciones_usuario'
  ];

  const checks = await Promise.all(requiredTables.map((tableName) => db.query('SELECT to_regclass($1) AS reg', [tableName])));
  const missingTables = checks
    .map((r, idx) => ({ idx, exists: !!r.rows?.[0]?.reg }))
    .filter((row) => !row.exists)
    .map((row) => requiredTables[row.idx]);

  if (missingTables.length) {
    const err = new Error(`Faltan tablas MMR requeridas: ${missingTables.join(', ')}`);
    err.code = 'MMR_SCHEMA_MISSING';
    err.missingTables = missingTables;
    throw err;
  }
}

async function registrarAccionMMR(client, { usuarioId, steamId, boton, fuente, mmrValor = null, detalle = null }) {
  await client.query(
    `INSERT INTO mmr_acciones_usuario (usuario_id, steam_id, boton, fuente, mmr_valor, detalle)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [usuarioId, steamId || null, boton, fuente || null, mmrValor, detalle]
  );
}

async function liberarSolicitudActiva(usuarioId, solicitudId) {
  await db.query(
    `UPDATE mmr_control_usuario
     SET solicitud_activa_id = NULL, actualizado_en = NOW()
     WHERE usuario_id = $1 AND solicitud_activa_id = $2`,
    [usuarioId, solicitudId]
  );
}

async function procesarColaMMR() {
  if (mmrQueueBusy) return;
  mmrQueueBusy = true;

  try {
    await ensureMMRTablesReady();
    mmrSchemaWarned = false;

    while (true) {
      const claim = await db.query(
        `UPDATE mmr_actualizaciones
         SET estado = 'procesando', mensaje = 'Procesando solicitud en GameCoordinator...'
         WHERE id = (
           SELECT id
           FROM mmr_actualizaciones
           WHERE estado = 'pendiente'
             AND procesar_despues_en <= NOW()
           ORDER BY procesar_despues_en ASC, id ASC
           LIMIT 1
         )
         RETURNING *`
      );

      if (!claim.rows.length) break;

      const job = claim.rows[0];
      try {
        // Nota: GameCoordinator desactivado - usando OpenDota/STRATZ
        const result = await steamService.obtenerEstadisticasDota2(job.steam_id);

        if (result && result.mmr !== null && result.mmr !== undefined) {
          await db.query(`UPDATE usuarios SET mmr = $1, actualizado_en = NOW() WHERE id = $2`, [result.mmr, job.usuario_id]);
          await db.query(
            `UPDATE mmr_actualizaciones
             SET estado='completado', procesado_en=NOW(), mmr_obtenido=$1, fuente=$2, mensaje=$3
             WHERE id=$4`,
            [result.mmr, result.fuente || 'OpenDota/STRATZ', 'MMR actualizado correctamente', job.id]
          );
          await liberarSolicitudActiva(job.usuario_id, job.id);
        } else {
          await db.query(
            `UPDATE mmr_actualizaciones
             SET estado='fallido', procesado_en=NOW(), mensaje=$1
             WHERE id=$2`,
            ['No se pudo obtener MMR desde OpenDota/STRATZ. El perfil puede ser privado.', job.id]
          );
          await liberarSolicitudActiva(job.usuario_id, job.id);
        }
      } catch (err) {
        await db.query(
          `UPDATE mmr_actualizaciones
           SET estado='fallido', procesado_en=NOW(), mensaje=$1
           WHERE id=$2`,
          [err.message || 'Error interno al actualizar MMR', job.id]
        );
        await liberarSolicitudActiva(job.usuario_id, job.id);
      }
    }
  } catch (err) {
    if (err.code === 'MMR_SCHEMA_MISSING') {
      if (!mmrSchemaWarned) {
        console.error('MMR deshabilitado hasta aplicar migraciones SQL manuales:', err.missingTables || err.message);
        mmrSchemaWarned = true;
      }
      return;
    }
    throw err;
  } finally {
    mmrQueueBusy = false;
  }
}

// Worker simple: intenta procesar cola cada minuto.
setInterval(() => {
  procesarColaMMR().catch((e) => console.error('Error worker MMR:', e.message));
}, 60000);

function generarCodigo() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Verifica el código y lo marca como usado. Lanza error si inválido/expirado.
async function verificarCodigo(steamId, codigo) {
  const r = await db.query(
    `SELECT id FROM codigos_verificacion
     WHERE steam_id = $1 AND codigo = $2 AND usado = FALSE AND expira_en > NOW()`,
    [steamId, codigo]
  );
  if (r.rows.length === 0) return false;
  await db.query('UPDATE codigos_verificacion SET usado = TRUE WHERE id = $1', [r.rows[0].id]);
  return true;
}

// ── GET /api/configuracion/perfil ──────────────────────────────────────────
router.get('/perfil', verificarToken, async (req, res) => {
  try {
    const { id } = req.usuario;
    const r = await db.query(
      'SELECT nombre_usuario, email, telefono, nombre_real, pais, avatar, mmr, nivel, creado_en FROM usuarios WHERE id = $1',
      [id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ perfil: r.rows[0] });
  } catch (err) {
    console.error('Error GET /configuracion/perfil:', err);
    res.status(500).json({ error: 'Error al obtener perfil' });
  }
});

// ── GET /api/configuracion/perfil-publico/:id ───────────────────────────────
router.get('/perfil-publico/:id', async (req, res) => {
  const usuarioId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(usuarioId) || usuarioId <= 0) {
    return res.status(400).json({ error: 'Identificador de usuario inválido' });
  }

  try {
    const [perfilRes, estadisticasRes, ajustesRes] = await Promise.all([
      db.query(
        `SELECT id, nombre_usuario, steam_id, avatar, mmr, nivel, pais, creado_en
         FROM usuarios
         WHERE id = $1`,
        [usuarioId]
      ),
      db.query(
        `SELECT
          COUNT(*)::INT AS total_apuestas,
          COUNT(*) FILTER (WHERE estado = 'ganada')::INT AS apuestas_ganadas,
          COUNT(*) FILTER (WHERE estado = 'perdida')::INT AS apuestas_perdidas,
          COALESCE(SUM(CASE
            WHEN estado = 'ganada' THEN COALESCE(ganancia, 0)
            WHEN estado = 'perdida' THEN -COALESCE(monto, 0)
            ELSE 0
          END), 0)::NUMERIC(12,2) AS balance_apuestas
         FROM apuestas
         WHERE id_usuario = $1`,
        [usuarioId]
      ),
      db.query(
        `SELECT id,
                COALESCE(NULLIF(tipo, ''), 'abono') AS tipo,
                monto,
                mensaje,
                enviado_por,
                creado_en
         FROM bonos
         WHERE usuario_id = $1
         ORDER BY creado_en DESC
         LIMIT 30`,
        [usuarioId]
      ),
    ]);

    if (!perfilRes.rows.length) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const stats = estadisticasRes.rows[0] || {
      total_apuestas: 0,
      apuestas_ganadas: 0,
      apuestas_perdidas: 0,
      balance_apuestas: 0,
    };

    const totalApuestas = Number(stats.total_apuestas || 0);
    const apuestasGanadas = Number(stats.apuestas_ganadas || 0);

    return res.json({
      perfil: perfilRes.rows[0],
      estadisticas: {
        total_apuestas: totalApuestas,
        apuestas_ganadas: apuestasGanadas,
        apuestas_perdidas: Number(stats.apuestas_perdidas || 0),
        winrate: totalApuestas > 0 ? Math.round((apuestasGanadas / totalApuestas) * 100) : 0,
        balance_apuestas: Number(stats.balance_apuestas || 0),
      },
      historial_ajustes: ajustesRes.rows,
    });
  } catch (err) {
    console.error('Error GET /configuracion/perfil-publico/:id:', err);
    return res.status(500).json({ error: 'Error al obtener perfil público' });
  }
});

// ── GET /api/configuracion/mmr/estado ─────────────────────────────────────
router.get('/mmr/estado', verificarToken, async (req, res) => {
  try {
    await ensureMMRTablesReady();
    const { id, steamId } = req.usuario;

    const [u, control, lastReq, activa, ultimaAccion] = await Promise.all([
      db.query('SELECT mmr FROM usuarios WHERE id = $1', [id]),
      db.query('SELECT * FROM mmr_control_usuario WHERE usuario_id = $1', [id]),
      db.query(
        `SELECT * FROM mmr_actualizaciones
         WHERE usuario_id = $1
         ORDER BY solicitado_en DESC
         LIMIT 1`,
        [id]
      ),
      db.query(
        `SELECT id, estado, procesar_despues_en, solicitado_en
         FROM mmr_actualizaciones
         WHERE usuario_id = $1 AND estado IN ('pendiente', 'procesando')
         ORDER BY solicitado_en DESC
         LIMIT 1`,
        [id]
      ),
      db.query(
        `SELECT boton, fuente, mmr_valor, detalle, creado_en
         FROM mmr_acciones_usuario
         WHERE usuario_id = $1
         ORDER BY creado_en DESC
         LIMIT 1`,
        [id]
      )
    ]);

    if (!u.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });

    const last = lastReq.rows[0] || null;
    const controlRow = control.rows[0] || null;
    const activaRow = activa.rows[0] || null;
    const siguienteIntento = controlRow?.siguiente_permitido_en || null;
    const enCooldown = !!(siguienteIntento && new Date(siguienteIntento) > new Date());

    let colaPosicion = null;
    let estimadoProceso = null;

    if (activaRow) {
      estimadoProceso = activaRow.procesar_despues_en || null;
      const cola = await db.query(
        `SELECT COUNT(*)::INT AS n
         FROM mmr_actualizaciones
         WHERE estado IN ('pendiente', 'procesando')
           AND (
             procesar_despues_en < $1
             OR (procesar_despues_en = $1 AND id <= $2)
           )`,
        [activaRow.procesar_despues_en, activaRow.id]
      );
      colaPosicion = cola.rows[0]?.n || 1;
    }

    const puedeSolicitar = !enCooldown && !activaRow;
    const mensaje = activaRow
      ? 'Ya tienes una solicitud activa en cola.'
      : (puedeSolicitar
        ? 'Puedes solicitar actualización de MMR ahora.'
        : `Debes esperar para volver a solicitar. Próximo intento: ${new Date(siguienteIntento).toLocaleString('es-PE')}`);

    return res.json({
      steamId,
      mmr: u.rows[0].mmr,
      puedeSolicitar,
      cooldownHoras: MMR_USER_COOLDOWN_HOURS,
      siguienteIntento,
      ultimaSolicitud: last,
      solicitudActiva: activaRow,
      colaPosicion,
      estimadoProceso,
      ultimaEleccion: ultimaAccion.rows[0] || null,
      mensaje,
    });
  } catch (err) {
    if (err.code === 'MMR_SCHEMA_MISSING') {
      return res.status(503).json({
        error: 'Falta aplicar migraciones MMR en la base de datos.',
        codigo: 'MMR_SCHEMA_MISSING',
        faltantes: err.missingTables || []
      });
    }
    console.error('Error GET /configuracion/mmr/estado:', err);
    res.status(500).json({ error: 'Error al consultar estado de actualización MMR' });
  }
});

// ── POST /api/configuracion/mmr/solicitar ──────────────────────────────────
router.post('/mmr/solicitar', verificarToken, async (req, res) => {
  if (!db.pool || typeof db.pool.connect !== 'function') {
    return res.status(500).json({
      error: 'Configuración de base de datos inválida para transacciones MMR',
      codigo: 'DB_CLIENT_UNAVAILABLE'
    });
  }

  const client = await db.pool.connect();
  try {
    await ensureMMRTablesReady();
    const { id, steamId } = req.usuario;

    await client.query('BEGIN');

    const userRow = await client.query('SELECT steam_id, mmr FROM usuarios WHERE id = $1 FOR UPDATE', [id]);
    if (!userRow.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });

    const solicitudActiva = await client.query(
      `SELECT id, estado, procesar_despues_en
       FROM mmr_actualizaciones
       WHERE usuario_id = $1
         AND estado IN ('pendiente', 'procesando')
       ORDER BY solicitado_en DESC
       LIMIT 1`,
      [id]
    );

    if (solicitudActiva.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Ya tienes una solicitud activa de actualización de MMR.',
        solicitudActiva: solicitudActiva.rows[0],
      });
    }

    const controlUsuarioUpsert = await client.query(
      `INSERT INTO mmr_control_usuario (usuario_id, actualizado_en)
       VALUES ($1, NOW())
       ON CONFLICT (usuario_id) DO UPDATE SET actualizado_en = NOW()
       RETURNING usuario_id`,
      [id]
    );

    if (!controlUsuarioUpsert.rows.length) {
      throw new Error('No se pudo preparar control de usuario para MMR');
    }

    const controlUsuario = await client.query(
      `SELECT *
       FROM mmr_control_usuario
       WHERE usuario_id = $1
       FOR UPDATE`,
      [id]
    );

    const controlGlobal = await client.query(
      `SELECT *
       FROM mmr_control_global
       WHERE id = 1
       FOR UPDATE`
    );

    if (!controlGlobal.rows.length) {
      throw new Error('No se encontró fila de control global para MMR');
    }

    const ahora = new Date();
    const siguientePermitido = controlUsuario.rows[0]?.siguiente_permitido_en
      ? new Date(controlUsuario.rows[0].siguiente_permitido_en)
      : null;

    if (siguientePermitido && ahora < siguientePermitido) {
      await client.query('ROLLBACK');
      return res.status(429).json({
        error: 'Aún no puedes volver a solicitar actualización de MMR.',
        siguienteIntento: siguientePermitido.toISOString(),
        cooldownHoras: MMR_USER_COOLDOWN_HOURS,
      });
    }

    const proximoSlotGlobal = new Date(controlGlobal.rows[0].proximo_slot_en);
    const procesarDespues = new Date(Math.max(ahora.getTime(), proximoSlotGlobal.getTime()));

    const ins = await client.query(
      `INSERT INTO mmr_actualizaciones (usuario_id, steam_id, estado, mensaje, procesar_despues_en)
       VALUES ($1, $2, 'pendiente', $3, $4)
       RETURNING *`,
      [id, steamId, 'Solicitud recibida. En cola para actualización de MMR.', procesarDespues]
    );

    await registrarAccionMMR(client, {
      usuarioId: id,
      steamId,
      boton: 'exacto_gc',
      fuente: 'GameCoordinator (cola)',
      detalle: 'Usuario presionó botón exacto y entró a cola de actualización'
    });

    const siguienteIntento = new Date(ahora.getTime() + MMR_USER_COOLDOWN_HOURS * 60 * 60 * 1000);
    await client.query(
      `UPDATE mmr_control_usuario
       SET ultimo_solicitado_en = $1,
           siguiente_permitido_en = $2,
           solicitud_activa_id = $3,
           actualizado_en = NOW()
       WHERE usuario_id = $4`,
      [ahora, siguienteIntento, ins.rows[0].id, id]
    );

    const siguienteSlotGlobal = new Date(procesarDespues.getTime() + MMR_GLOBAL_SLOT_MINUTES * 60 * 1000);
    await client.query(
      `UPDATE mmr_control_global
       SET proximo_slot_en = $1,
           intervalo_minutos = $2,
           actualizado_en = NOW()
       WHERE id = 1`,
      [siguienteSlotGlobal, MMR_GLOBAL_SLOT_MINUTES]
    );

    const cola = await client.query(
      `SELECT COUNT(*)::INT AS n
       FROM mmr_actualizaciones
       WHERE estado IN ('pendiente', 'procesando')
         AND (
           procesar_despues_en < $1
           OR (procesar_despues_en = $1 AND id <= $2)
         )`,
      [procesarDespues, ins.rows[0].id]
    );

    await client.query('COMMIT');

    setImmediate(() => {
      procesarColaMMR().catch((e) => console.error('Error procesando cola MMR:', e.message));
    });

    return res.status(202).json({
      mensaje: 'Solicitud registrada',
      solicitud: ins.rows[0],
      siguienteIntento: siguienteIntento.toISOString(),
      estimadoProceso: procesarDespues.toISOString(),
      colaPosicion: cola.rows[0]?.n || 1,
      recomendacion: 'Este proceso puede tardar. Revisa tu estado de MMR desde el perfil.',
    });
  } catch (err) {
    if (err.code === 'MMR_SCHEMA_MISSING') {
      return res.status(503).json({
        error: 'Falta aplicar migraciones MMR en la base de datos.',
        codigo: 'MMR_SCHEMA_MISSING',
        faltantes: err.missingTables || []
      });
    }
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      // Sin acción: puede no haber transacción activa.
    }
    console.error('Error POST /configuracion/mmr/solicitar:', err);
    res.status(500).json({ error: 'No se pudo registrar la solicitud de actualización MMR' });
  } finally {
    client.release();
  }
});

// ── POST /api/configuracion/mmr/experimental ───────────────────────────────
router.post('/mmr/experimental', verificarToken, async (req, res) => {
  if (!db.pool || typeof db.pool.connect !== 'function') {
    return res.status(500).json({ error: 'Configuración de base de datos inválida', codigo: 'DB_CLIENT_UNAVAILABLE' });
  }

  const client = await db.pool.connect();
  try {
    await ensureMMRTablesReady();
    const { id, steamId } = req.usuario;

    const stats = await steamService.obtenerEstadisticasDota2(steamId);
    const mmr = stats?.mmr;
    const fuente = stats?.fuente || 'OpenDota/STRATZ (experimental)';

    await client.query('BEGIN');

    if (mmr !== null && mmr !== undefined) {
      await client.query('UPDATE usuarios SET mmr = $1, actualizado_en = NOW() WHERE id = $2', [mmr, id]);
    }

    await registrarAccionMMR(client, {
      usuarioId: id,
      steamId,
      boton: 'experimental_open',
      fuente,
      mmrValor: mmr ?? null,
      detalle: mmr !== null && mmr !== undefined
        ? 'Usuario actualizó MMR con API experimental'
        : 'Usuario intentó actualizar MMR con API experimental sin resultado'
    });

    await client.query('COMMIT');

    if (mmr === null || mmr === undefined) {
      return res.status(404).json({
        error: 'La API experimental no devolvió MMR para este perfil.',
        fuente,
        experimental: true,
      });
    }

    return res.json({
      mensaje: 'MMR actualizado con API experimental',
      mmr,
      fuente,
      experimental: true,
    });
  } catch (err) {
    if (err.code === 'MMR_SCHEMA_MISSING') {
      return res.status(503).json({
        error: 'Falta aplicar migraciones MMR en la base de datos.',
        codigo: 'MMR_SCHEMA_MISSING',
        faltantes: err.missingTables || []
      });
    }
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    console.error('Error POST /configuracion/mmr/experimental:', err);
    return res.status(500).json({ error: 'No se pudo actualizar MMR con API experimental' });
  } finally {
    client.release();
  }
});

// ── POST /api/configuracion/mmr/manual ─────────────────────────────────────
router.post('/mmr/manual', verificarToken, async (req, res) => {
  if (!db.pool || typeof db.pool.connect !== 'function') {
    return res.status(500).json({ error: 'Configuración de base de datos inválida', codigo: 'DB_CLIENT_UNAVAILABLE' });
  }

  const client = await db.pool.connect();
  try {
    await ensureMMRTablesReady();
    const { id, steamId } = req.usuario;
    const mmrManual = Number.parseInt(req.body?.mmr, 10);

    if (!Number.isFinite(mmrManual) || mmrManual < 0 || mmrManual > 20000) {
      return res.status(400).json({ error: 'MMR manual inválido. Debe ser un número entre 0 y 20000.' });
    }

    await client.query('BEGIN');
    await client.query('UPDATE usuarios SET mmr = $1, actualizado_en = NOW() WHERE id = $2', [mmrManual, id]);

    await registrarAccionMMR(client, {
      usuarioId: id,
      steamId,
      boton: 'manual_usuario',
      fuente: 'Manual usuario',
      mmrValor: mmrManual,
      detalle: 'Usuario asignó MMR manualmente desde perfil'
    });

    await client.query('COMMIT');

    return res.json({
      mensaje: 'MMR manual guardado',
      mmr: mmrManual,
      fuente: 'Manual usuario',
    });
  } catch (err) {
    if (err.code === 'MMR_SCHEMA_MISSING') {
      return res.status(503).json({
        error: 'Falta aplicar migraciones MMR en la base de datos.',
        codigo: 'MMR_SCHEMA_MISSING',
        faltantes: err.missingTables || []
      });
    }
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    console.error('Error POST /configuracion/mmr/manual:', err);
    return res.status(500).json({ error: 'No se pudo guardar MMR manual' });
  } finally {
    client.release();
  }
});

// ── POST /api/configuracion/enviar-codigo ─────────────────────────────────
// Envía código de verificación al email actual del usuario (o al nuevo email si lo está cambiando)
router.post('/enviar-codigo', verificarToken, async (req, res) => {
  try {
    const { id, steamId } = req.usuario;
    const { email_destino } = req.body; // opcional: si cambia email, verificar al nuevo

    const resU = await db.query('SELECT nombre_usuario, email FROM usuarios WHERE id = $1', [id]);
    if (!resU.rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });

    const { nombre_usuario, email: emailActual } = resU.rows[0];
    const emailEnviar = email_destino || emailActual;

    if (!emailEnviar) {
      return res.status(400).json({ error: 'No tienes un email registrado. Agrega uno primero.' });
    }

    // Si cambia email: verificar formato y que no esté en uso
    if (email_destino && email_destino !== emailActual) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email_destino)) return res.status(400).json({ error: 'Email inválido' });
      const dup = await db.query('SELECT id FROM usuarios WHERE email = $1 AND id != $2', [email_destino, id]);
      if (dup.rows.length > 0) return res.status(400).json({ error: 'Ese email ya está en uso' });
    }

    // Invalidar códigos anteriores y generar nuevo
    await db.query('UPDATE codigos_verificacion SET usado = TRUE WHERE steam_id = $1 AND usado = FALSE', [steamId]);
    const codigo = generarCodigo();
    const expira = new Date(Date.now() + 10 * 60 * 1000);
    await db.query(
      'INSERT INTO codigos_verificacion (steam_id, codigo, expira_en) VALUES ($1, $2, $3)',
      [steamId, codigo, expira]
    );

    await emailService.enviarCodigoVerificacion(emailEnviar, codigo, nombre_usuario);

    const mask = emailEnviar.replace(/(.{2}).+(@.+)/, '$1***$2');
    res.json({ mensaje: `Código enviado a ${mask}`, emailMask: mask });
  } catch (err) {
    console.error('Error POST /configuracion/enviar-codigo:', err);
    res.status(500).json({ error: 'Error al enviar el código' });
  }
});

// ── PATCH /api/configuracion/perfil ───────────────────────────────────────
router.patch('/perfil', verificarToken, async (req, res) => {
  try {
    const { id, steamId } = req.usuario;
    const { email, telefono, nombre_real, pais, codigo } = req.body;

    if (!codigo) return res.status(400).json({ error: 'Se requiere el código de verificación', requiereCodigo: true });
    const codigoValido = await verificarCodigo(steamId, codigo);
    if (!codigoValido) return res.status(400).json({ error: 'Código incorrecto o expirado', codigoInvalido: true });

    if (email !== undefined) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) return res.status(400).json({ error: 'Email inválido' });
      const dup = await db.query('SELECT id FROM usuarios WHERE email = $1 AND id != $2', [email, id]);
      if (dup.rows.length > 0) return res.status(400).json({ error: 'Ese email ya está en uso' });
    }
    if (telefono !== undefined && telefono && !/^\+?[\d\s\-]{6,20}$/.test(telefono)) {
      return res.status(400).json({ error: 'Teléfono inválido' });
    }

    const sets   = [];
    const params = [];
    let   idx    = 1;

    if (email       !== undefined) { sets.push(`email = $${idx++}`);       params.push(email); }
    if (telefono    !== undefined) { sets.push(`telefono = $${idx++}`);    params.push(telefono || null); }
    if (nombre_real !== undefined) { sets.push(`nombre_real = $${idx++}`); params.push(nombre_real || null); }
    if (pais        !== undefined) { sets.push(`pais = $${idx++}`);        params.push(pais || null); }

    if (sets.length === 0) return res.status(400).json({ error: 'Sin campos para actualizar' });
    sets.push(`actualizado_en = NOW()`);
    params.push(id);

    const r = await db.query(
      `UPDATE usuarios SET ${sets.join(', ')} WHERE id = $${idx} RETURNING nombre_usuario, email, telefono, nombre_real, pais, avatar, mmr, nivel`,
      params
    );
    res.json({ mensaje: 'Perfil actualizado', perfil: r.rows[0] });
  } catch (err) {
    console.error('Error PATCH /configuracion/perfil:', err);
    res.status(500).json({ error: 'Error al actualizar perfil' });
  }
});

// ── PATCH /api/configuracion/nombre-usuario ───────────────────────────────
router.patch('/nombre-usuario', verificarToken, async (req, res) => {
  try {
    const { id, steamId } = req.usuario;
    const { codigo } = req.body;

    if (!codigo) return res.status(400).json({ error: 'Se requiere el código de verificación', requiereCodigo: true });
    const codigoValido = await verificarCodigo(steamId, codigo);
    if (!codigoValido) return res.status(400).json({ error: 'Código incorrecto o expirado', codigoInvalido: true });

    const jugadorSteam = await steamService.obtenerJugador(steamId);
    const nombreSteam = (jugadorSteam?.personaname || '').trim();

    if (!nombreSteam) {
      return res.status(400).json({ error: 'No se pudo obtener tu nombre desde Steam' });
    }
    if (nombreSteam.length < 3) {
      return res.status(400).json({ error: 'Tu nombre de Steam tiene menos de 3 caracteres' });
    }
    if (nombreSteam.length > 30) {
      return res.status(400).json({ error: 'Tu nombre de Steam supera 30 caracteres. Cámbialo en Steam para sincronizarlo aquí.' });
    }

    const dup = await db.query('SELECT id FROM usuarios WHERE nombre_usuario = $1 AND id != $2', [nombreSteam, id]);
    if (dup.rows.length > 0) return res.status(400).json({ error: 'Ese nombre de usuario ya está en uso' });

    const r = await db.query(
      'UPDATE usuarios SET nombre_usuario = $1, actualizado_en = NOW() WHERE id = $2 RETURNING nombre_usuario',
      [nombreSteam, id]
    );
    res.json({ mensaje: 'Nombre sincronizado desde Steam', nombre_usuario: r.rows[0].nombre_usuario });
  } catch (err) {
    console.error('Error PATCH /configuracion/nombre-usuario:', err);
    res.status(500).json({ error: 'Error al actualizar nombre' });
  }
});

module.exports = router;
