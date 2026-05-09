const express = require('express');
const router = express.Router();
const db = require('../../config/database');
const { verificarToken, esSuperadmin } = require('../../middleware/auth');

const ESTADOS_VALIDOS = ['programada', 'en_vivo', 'pausada', 'finalizada', 'cancelada'];
const MODOS_VALIDOS = ['oficial_valve', 'stats_delay', 'hibrido'];

const parseItemsResumen = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 12);
  }
  return [];
};

const normalizarPartida = (row) => ({
  id: row.id,
  salaId: row.id_sala,
  salaNombre: row.sala_nombre,
  titulo: row.titulo,
  descripcion: row.descripcion,
  matchId: row.match_id,
  lobbyId: row.lobby_id,
  estado: row.estado,
  modoVisualizacion: row.modo_visualizacion,
  delaySegundos: Number(row.delay_segundos || 0),
  streamUrl: row.stream_url,
  radiantNombre: row.radiant_nombre,
  direNombre: row.dire_nombre,
  scoreRadiant: Number(row.score_radiant || 0),
  scoreDire: Number(row.score_dire || 0),
  estadoPartida: row.estado_partida,
  tiempoPartidaSegundos: row.tiempo_partida_segundos,
  itemsResumen: Array.isArray(row.items_resumen) ? row.items_resumen : [],
  fuenteDatos: row.fuente_datos,
  metadata: row.metadata || {},
  esPublica: row.es_publica,
  activo: row.activo,
  publicadoPor: row.publicado_por,
  ultimaSincronizacion: row.ultima_sincronizacion,
  creadaEn: row.creada_en,
  actualizadaEn: row.actualizada_en,
});

const construirFiltros = ({ search, estado, admin }) => {
  const conditions = ['p.activo = TRUE'];
  const values = [];

  if (!admin) {
    conditions.push('p.es_publica = TRUE');
    conditions.push(`p.estado IN ('programada', 'en_vivo', 'pausada')`);
  }

  if (estado) {
    values.push(estado);
    conditions.push(`p.estado = $${values.length}`);
  }

  if (search) {
    values.push(search);
    const idx = values.length;
    conditions.push(`(
      LOWER(COALESCE(p.titulo, '')) LIKE $${idx}
      OR LOWER(COALESCE(p.match_id, '')) LIKE $${idx}
      OR LOWER(COALESCE(p.lobby_id, '')) LIKE $${idx}
      OR LOWER(COALESCE(s.nombre, '')) LIKE $${idx}
      OR LOWER(COALESCE(p.radiant_nombre, '')) LIKE $${idx}
      OR LOWER(COALESCE(p.dire_nombre, '')) LIKE $${idx}
    )`);
  }

  return {
    whereSql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    values,
  };
};

router.get('/', async (req, res) => {
  try {
    const pageRaw = Number.parseInt(req.query.page, 10);
    const limitRaw = Number.parseInt(req.query.limit, 10);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 30) : 8;
    const offset = (page - 1) * limit;

    const queryText = String(req.query.q || '').trim();
    const search = queryText ? `%${queryText.toLowerCase()}%` : null;
    const estado = ESTADOS_VALIDOS.includes(String(req.query.estado || '')) ? String(req.query.estado) : null;

    const { whereSql, values } = construirFiltros({ search, estado, admin: false });

    const totalR = await db.query(
      `SELECT COUNT(*)::int AS total
       FROM partidas_en_vivo p
       LEFT JOIN salas s ON s.id = p.id_sala
       ${whereSql}`,
      values
    );

    const total = totalR.rows[0]?.total || 0;
    const listValues = [...values, limit, offset];
    const limitPos = values.length + 1;
    const offsetPos = values.length + 2;

    const listR = await db.query(
      `SELECT
         p.*, s.nombre AS sala_nombre
       FROM partidas_en_vivo p
       LEFT JOIN salas s ON s.id = p.id_sala
       ${whereSql}
       ORDER BY
         CASE p.estado
           WHEN 'en_vivo' THEN 1
           WHEN 'pausada' THEN 2
           WHEN 'programada' THEN 3
           ELSE 4
         END,
         p.creada_en DESC,
         p.id DESC
       LIMIT $${limitPos} OFFSET $${offsetPos}`,
      listValues
    );

    const totalPages = Math.max(1, Math.ceil(total / limit));
    res.json({
      items: listR.rows.map(normalizarPartida),
      meta: {
        page,
        limit,
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
        query: queryText,
      },
    });
  } catch (error) {
    if (error.code === '42P01') {
      return res.json({
        items: [],
        meta: { page: 1, limit: 8, total: 0, totalPages: 1, hasNext: false, hasPrev: false, query: '' },
      });
    }

    console.error('Error GET /partidas-en-vivo', error);
    res.status(500).json({ error: 'Error al obtener partidas en vivo' });
  }
});

router.get('/admin', verificarToken, esSuperadmin, async (req, res) => {
  try {
    const pageRaw = Number.parseInt(req.query.page, 10);
    const limitRaw = Number.parseInt(req.query.limit, 10);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 20;
    const offset = (page - 1) * limit;

    const queryText = String(req.query.q || '').trim();
    const search = queryText ? `%${queryText.toLowerCase()}%` : null;
    const estado = ESTADOS_VALIDOS.includes(String(req.query.estado || '')) ? String(req.query.estado) : null;

    const { whereSql, values } = construirFiltros({ search, estado, admin: true });

    const totalR = await db.query(
      `SELECT COUNT(*)::int AS total
       FROM partidas_en_vivo p
       LEFT JOIN salas s ON s.id = p.id_sala
       ${whereSql}`,
      values
    );

    const total = totalR.rows[0]?.total || 0;
    const listValues = [...values, limit, offset];
    const limitPos = values.length + 1;
    const offsetPos = values.length + 2;

    const listR = await db.query(
      `SELECT
         p.*, s.nombre AS sala_nombre
       FROM partidas_en_vivo p
       LEFT JOIN salas s ON s.id = p.id_sala
       ${whereSql}
       ORDER BY p.creada_en DESC, p.id DESC
       LIMIT $${limitPos} OFFSET $${offsetPos}`,
      listValues
    );

    const totalPages = Math.max(1, Math.ceil(total / limit));
    res.json({
      items: listR.rows.map(normalizarPartida),
      meta: {
        page,
        limit,
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
        query: queryText,
      },
    });
  } catch (error) {
    if (error.code === '42P01') {
      return res.json({
        items: [],
        meta: { page: 1, limit: 20, total: 0, totalPages: 1, hasNext: false, hasPrev: false, query: '' },
      });
    }

    console.error('Error GET /partidas-en-vivo/admin', error);
    res.status(500).json({ error: 'Error al obtener partidas en vivo (admin)' });
  }
});

router.post('/admin', verificarToken, esSuperadmin, async (req, res) => {
  try {
    const payload = req.body || {};
    const titulo = String(payload.titulo || '').trim();

    if (!titulo) {
      return res.status(400).json({ error: 'El titulo es obligatorio' });
    }

    const estado = ESTADOS_VALIDOS.includes(payload.estado) ? payload.estado : 'programada';
    const modoVisualizacion = MODOS_VALIDOS.includes(payload.modoVisualizacion)
      ? payload.modoVisualizacion
      : 'oficial_valve';
    const delaySegundosRaw = Number.parseInt(payload.delaySegundos, 10);
    const delaySegundos = Number.isFinite(delaySegundosRaw)
      ? Math.min(Math.max(delaySegundosRaw, 0), 7200)
      : 120;

    const salaIdRaw = Number.parseInt(payload.salaId, 10);
    const salaId = Number.isFinite(salaIdRaw) && salaIdRaw > 0 ? salaIdRaw : null;

    const scoreRadiantRaw = Number.parseInt(payload.scoreRadiant, 10);
    const scoreDireRaw = Number.parseInt(payload.scoreDire, 10);
    const tiempoRaw = Number.parseInt(payload.tiempoPartidaSegundos, 10);

    const result = await db.query(
      `INSERT INTO partidas_en_vivo (
         id_sala,
         titulo,
         descripcion,
         match_id,
         lobby_id,
         estado,
         modo_visualizacion,
         delay_segundos,
         stream_url,
         radiant_nombre,
         dire_nombre,
         score_radiant,
         score_dire,
         estado_partida,
         tiempo_partida_segundos,
         items_resumen,
         fuente_datos,
         metadata,
         es_publica,
         activo,
         publicado_por,
         ultima_sincronizacion,
         actualizada_en
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18::jsonb,$19,TRUE,$20,NOW(),NOW()
       )
       RETURNING *`,
      [
        salaId,
        titulo,
        payload.descripcion ? String(payload.descripcion).trim() : null,
        payload.matchId ? String(payload.matchId).trim() : null,
        payload.lobbyId ? String(payload.lobbyId).trim() : null,
        estado,
        modoVisualizacion,
        delaySegundos,
        payload.streamUrl ? String(payload.streamUrl).trim() : null,
        payload.radiantNombre ? String(payload.radiantNombre).trim() : null,
        payload.direNombre ? String(payload.direNombre).trim() : null,
        Number.isFinite(scoreRadiantRaw) ? Math.max(scoreRadiantRaw, 0) : 0,
        Number.isFinite(scoreDireRaw) ? Math.max(scoreDireRaw, 0) : 0,
        payload.estadoPartida ? String(payload.estadoPartida).trim() : null,
        Number.isFinite(tiempoRaw) ? Math.max(tiempoRaw, 0) : null,
        JSON.stringify(parseItemsResumen(payload.itemsResumen)),
        payload.fuenteDatos ? String(payload.fuenteDatos).trim() : 'manual',
        JSON.stringify(payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}),
        payload.esPublica !== false,
        req.usuario?.id || null,
      ]
    );

    const row = result.rows[0];
    const withSala = await db.query(
      `SELECT p.*, s.nombre AS sala_nombre
       FROM partidas_en_vivo p
       LEFT JOIN salas s ON s.id = p.id_sala
       WHERE p.id = $1
       LIMIT 1`,
      [row.id]
    );

    res.status(201).json({ ok: true, item: normalizarPartida(withSala.rows[0]) });
  } catch (error) {
    console.error('Error POST /partidas-en-vivo/admin', error);
    res.status(500).json({ error: 'Error al crear partida en vivo' });
  }
});

router.put('/admin/:id', verificarToken, esSuperadmin, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Id invalido' });
    }

    const payload = req.body || {};
    const titulo = String(payload.titulo || '').trim();

    if (!titulo) {
      return res.status(400).json({ error: 'El titulo es obligatorio' });
    }

    const estado = ESTADOS_VALIDOS.includes(payload.estado) ? payload.estado : 'programada';
    const modoVisualizacion = MODOS_VALIDOS.includes(payload.modoVisualizacion)
      ? payload.modoVisualizacion
      : 'oficial_valve';
    const delaySegundosRaw = Number.parseInt(payload.delaySegundos, 10);
    const delaySegundos = Number.isFinite(delaySegundosRaw)
      ? Math.min(Math.max(delaySegundosRaw, 0), 7200)
      : 120;

    const salaIdRaw = Number.parseInt(payload.salaId, 10);
    const salaId = Number.isFinite(salaIdRaw) && salaIdRaw > 0 ? salaIdRaw : null;

    const scoreRadiantRaw = Number.parseInt(payload.scoreRadiant, 10);
    const scoreDireRaw = Number.parseInt(payload.scoreDire, 10);
    const tiempoRaw = Number.parseInt(payload.tiempoPartidaSegundos, 10);

    const updateR = await db.query(
      `UPDATE partidas_en_vivo
       SET
         id_sala = $1,
         titulo = $2,
         descripcion = $3,
         match_id = $4,
         lobby_id = $5,
         estado = $6,
         modo_visualizacion = $7,
         delay_segundos = $8,
         stream_url = $9,
         radiant_nombre = $10,
         dire_nombre = $11,
         score_radiant = $12,
         score_dire = $13,
         estado_partida = $14,
         tiempo_partida_segundos = $15,
         items_resumen = $16::jsonb,
         fuente_datos = $17,
         metadata = $18::jsonb,
         es_publica = $19,
         ultima_sincronizacion = NOW(),
         actualizada_en = NOW()
       WHERE id = $20
       RETURNING *`,
      [
        salaId,
        titulo,
        payload.descripcion ? String(payload.descripcion).trim() : null,
        payload.matchId ? String(payload.matchId).trim() : null,
        payload.lobbyId ? String(payload.lobbyId).trim() : null,
        estado,
        modoVisualizacion,
        delaySegundos,
        payload.streamUrl ? String(payload.streamUrl).trim() : null,
        payload.radiantNombre ? String(payload.radiantNombre).trim() : null,
        payload.direNombre ? String(payload.direNombre).trim() : null,
        Number.isFinite(scoreRadiantRaw) ? Math.max(scoreRadiantRaw, 0) : 0,
        Number.isFinite(scoreDireRaw) ? Math.max(scoreDireRaw, 0) : 0,
        payload.estadoPartida ? String(payload.estadoPartida).trim() : null,
        Number.isFinite(tiempoRaw) ? Math.max(tiempoRaw, 0) : null,
        JSON.stringify(parseItemsResumen(payload.itemsResumen)),
        payload.fuenteDatos ? String(payload.fuenteDatos).trim() : 'manual',
        JSON.stringify(payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}),
        payload.esPublica !== false,
        id,
      ]
    );

    if (!updateR.rows.length) {
      return res.status(404).json({ error: 'Partida en vivo no encontrada' });
    }

    const withSala = await db.query(
      `SELECT p.*, s.nombre AS sala_nombre
       FROM partidas_en_vivo p
       LEFT JOIN salas s ON s.id = p.id_sala
       WHERE p.id = $1
       LIMIT 1`,
      [id]
    );

    res.json({ ok: true, item: normalizarPartida(withSala.rows[0]) });
  } catch (error) {
    console.error('Error PUT /partidas-en-vivo/admin/:id', error);
    res.status(500).json({ error: 'Error al actualizar partida en vivo' });
  }
});

router.patch('/admin/:id/stats', verificarToken, esSuperadmin, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Id invalido' });
    }

    const payload = req.body || {};
    const scoreRadiantRaw = Number.parseInt(payload.scoreRadiant, 10);
    const scoreDireRaw = Number.parseInt(payload.scoreDire, 10);
    const tiempoRaw = Number.parseInt(payload.tiempoPartidaSegundos, 10);

    const updateR = await db.query(
      `UPDATE partidas_en_vivo
       SET
         score_radiant = COALESCE($1, score_radiant),
         score_dire = COALESCE($2, score_dire),
         estado_partida = COALESCE(NULLIF($3, ''), estado_partida),
         tiempo_partida_segundos = COALESCE($4, tiempo_partida_segundos),
         items_resumen = COALESCE($5::jsonb, items_resumen),
         fuente_datos = COALESCE(NULLIF($6, ''), fuente_datos),
         ultima_sincronizacion = NOW(),
         actualizada_en = NOW()
       WHERE id = $7
       RETURNING *`,
      [
        Number.isFinite(scoreRadiantRaw) ? Math.max(scoreRadiantRaw, 0) : null,
        Number.isFinite(scoreDireRaw) ? Math.max(scoreDireRaw, 0) : null,
        payload.estadoPartida ? String(payload.estadoPartida).trim() : '',
        Number.isFinite(tiempoRaw) ? Math.max(tiempoRaw, 0) : null,
        payload.itemsResumen ? JSON.stringify(parseItemsResumen(payload.itemsResumen)) : null,
        payload.fuenteDatos ? String(payload.fuenteDatos).trim() : '',
        id,
      ]
    );

    if (!updateR.rows.length) {
      return res.status(404).json({ error: 'Partida en vivo no encontrada' });
    }

    const withSala = await db.query(
      `SELECT p.*, s.nombre AS sala_nombre
       FROM partidas_en_vivo p
       LEFT JOIN salas s ON s.id = p.id_sala
       WHERE p.id = $1
       LIMIT 1`,
      [id]
    );

    res.json({ ok: true, item: normalizarPartida(withSala.rows[0]) });
  } catch (error) {
    console.error('Error PATCH /partidas-en-vivo/admin/:id/stats', error);
    res.status(500).json({ error: 'Error al actualizar estadisticas en vivo' });
  }
});

router.patch('/admin/:id/estado', verificarToken, esSuperadmin, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Id invalido' });
    }

    const estado = String(req.body?.estado || '');
    if (!ESTADOS_VALIDOS.includes(estado)) {
      return res.status(400).json({ error: 'Estado invalido' });
    }

    const updateR = await db.query(
      `UPDATE partidas_en_vivo
       SET estado = $1, actualizada_en = NOW()
       WHERE id = $2
       RETURNING *`,
      [estado, id]
    );

    if (!updateR.rows.length) {
      return res.status(404).json({ error: 'Partida en vivo no encontrada' });
    }

    const withSala = await db.query(
      `SELECT p.*, s.nombre AS sala_nombre
       FROM partidas_en_vivo p
       LEFT JOIN salas s ON s.id = p.id_sala
       WHERE p.id = $1
       LIMIT 1`,
      [id]
    );

    res.json({ ok: true, item: normalizarPartida(withSala.rows[0]) });
  } catch (error) {
    console.error('Error PATCH /partidas-en-vivo/admin/:id/estado', error);
    res.status(500).json({ error: 'Error al actualizar estado' });
  }
});

module.exports = router;
