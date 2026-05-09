const express = require('express');
const router = express.Router();
const db = require('../../config/database');

router.get('/', async (req, res) => {
  try {
    const pageRaw = Number.parseInt(req.query.page, 10);
    const limitRaw = Number.parseInt(req.query.limit, 10);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 30) : 8;
    const offset = (page - 1) * limit;
    const queryText = String(req.query.q || '').trim();
    const search = queryText ? `%${queryText.toLowerCase()}%` : null;

    let rows = [];
    let total = 0;

    try {
      const filters = search
        ? `
          WHERE sr.activo = TRUE
            AND (
              LOWER(COALESCE(s.nombre, '')) LIKE $1
              OR LOWER(COALESCE(sr.resumen_resultado, '')) LIKE $1
              OR LOWER(COALESCE(sr.equipo_ganador, '')) LIKE $1
            )`
        : 'WHERE sr.activo = TRUE';

      const totalParams = search ? [search] : [];
      const totalR = await db.query(
        `SELECT COUNT(*)::int AS total
         FROM salas_resultados sr
         INNER JOIN salas s ON s.id = sr.id_sala
         ${filters}`,
        totalParams
      );

      total = totalR.rows[0]?.total || 0;
      const params = search ? [search, limit, offset] : [limit, offset];

      const listR = await db.query(
        `SELECT
           sr.id,
           sr.id_sala,
           sr.match_id,
           sr.equipo_ganador,
           sr.marcador_radiant,
           sr.marcador_dire,
           sr.resumen_resultado,
           sr.finalizada_en,
           s.nombre AS sala_nombre,
           mvp.nombre_usuario AS mvp_nombre,
           (
             SELECT COALESCE(
               json_agg(
                 json_build_object('id', u.id, 'nombre', u.nombre_usuario)
                 ORDER BY u.nombre_usuario
               ),
               '[]'::json
             )
             FROM sala_jugadores sj
             INNER JOIN usuarios u ON u.id = sj.id_usuario
             WHERE sj.id_sala = sr.id_sala AND sj.banda = 'radiant'
           ) AS radiant_players,
           (
             SELECT COALESCE(
               json_agg(
                 json_build_object('id', u.id, 'nombre', u.nombre_usuario)
                 ORDER BY u.nombre_usuario
               ),
               '[]'::json
             )
             FROM sala_jugadores sj
             INNER JOIN usuarios u ON u.id = sj.id_usuario
             WHERE sj.id_sala = sr.id_sala AND sj.banda = 'dire'
           ) AS dire_players
         FROM salas_resultados sr
         INNER JOIN salas s ON s.id = sr.id_sala
         LEFT JOIN usuarios mvp ON mvp.id = sr.id_mvp_usuario
         ${filters}
         ORDER BY sr.finalizada_en DESC, sr.id DESC
         LIMIT $${search ? 2 : 1} OFFSET $${search ? 3 : 2}`,
        params
      );

      rows = listR.rows;
    } catch (error) {
      if (error.code !== '42P01') {
        throw error;
      }
      rows = [];
      total = 0;
    }

    const totalPages = Math.max(1, Math.ceil(total / limit));
    res.json({
      items: rows.map((row, index) => ({
        id: row.id,
        numero: offset + index + 1,
        salaId: row.id_sala,
        salaNombre: row.sala_nombre,
        matchId: row.match_id,
        equipoGanador: row.equipo_ganador,
        marcadorRadiant: Number(row.marcador_radiant || 0),
        marcadorDire: Number(row.marcador_dire || 0),
        resumenResultado: row.resumen_resultado,
        mvp: row.mvp_nombre,
        finalizadaEn: row.finalizada_en,
        radiantPlayers: Array.isArray(row.radiant_players) ? row.radiant_players : [],
        direPlayers: Array.isArray(row.dire_players) ? row.dire_players : [],
      })),
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
    console.error('Error GET /ganadores', error);
    res.status(500).json({ error: 'Error al obtener la tabla de ganadores' });
  }
});

module.exports = router;