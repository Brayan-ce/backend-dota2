const express = require('express');
const router = express.Router();
const db = require('../../config/database');

router.get('/', async (req, res) => {
  try {
    const pageRaw = Number.parseInt(req.query.page, 10);
    const limitRaw = Number.parseInt(req.query.limit, 10);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 8;
    const offset = (page - 1) * limit;
    const queryText = String(req.query.q || '').trim();
    const search = queryText ? `%${queryText.toLowerCase()}%` : null;

    let total = 0;
    let rows = [];

    try {
      const filters = search
        ? `
          WHERE h.activo = TRUE
            AND u.esta_baneado = TRUE
            AND (
              LOWER(COALESCE(u.nombre_usuario, '')) LIKE $1
              OR LOWER(COALESCE(u.email, '')) LIKE $1
              OR LOWER(COALESCE(h.motivo, '')) LIKE $1
            )`
        : `
          WHERE h.activo = TRUE
            AND u.esta_baneado = TRUE`;

      const paramsBase = search ? [search] : [];
      const totalR = await db.query(
        `SELECT COUNT(*)::int AS total
         FROM usuarios_baneados_historial h
         INNER JOIN usuarios u ON u.id = h.id_usuario
         ${filters}`,
        paramsBase
      );

      total = totalR.rows[0]?.total || 0;
      const paramsRows = search ? [search, limit, offset] : [limit, offset];

      const listR = await db.query(
        `SELECT
           h.id,
           h.motivo,
           h.detalle,
           h.baneado_en,
           h.vence_en,
           u.id AS usuario_id,
           u.nombre_usuario,
           u.email
         FROM usuarios_baneados_historial h
         INNER JOIN usuarios u ON u.id = h.id_usuario
         ${filters}
         ORDER BY h.baneado_en DESC, h.id DESC
         LIMIT $${search ? 2 : 1} OFFSET $${search ? 3 : 2}`,
        paramsRows
      );

      rows = listR.rows;
    } catch (error) {
      if (error.code !== '42P01') {
        throw error;
      }

      const filters = search
        ? `WHERE u.esta_baneado = TRUE AND (LOWER(COALESCE(u.nombre_usuario, '')) LIKE $1 OR LOWER(COALESCE(u.email, '')) LIKE $1)`
        : `WHERE u.esta_baneado = TRUE`;
      const paramsBase = search ? [search] : [];
      const totalR = await db.query(
        `SELECT COUNT(*)::int AS total
         FROM usuarios u
         ${filters}`,
        paramsBase
      );
      total = totalR.rows[0]?.total || 0;

      const paramsRows = search ? [search, limit, offset] : [limit, offset];
      const listR = await db.query(
        `SELECT
           u.id AS usuario_id,
           u.nombre_usuario,
           u.email,
           u.creado_en AS baneado_en,
           NULL::timestamp AS vence_en,
           'Motivo no registrado aun' AS motivo,
           NULL::text AS detalle,
           u.id AS id
         FROM usuarios u
         ${filters}
         ORDER BY u.id DESC
         LIMIT $${search ? 2 : 1} OFFSET $${search ? 3 : 2}`,
        paramsRows
      );
      rows = listR.rows;
    }

    const totalPages = Math.max(1, Math.ceil(total / limit));
    res.json({
      items: rows.map((row, index) => ({
        id: row.id,
        numero: offset + index + 1,
        usuarioId: row.usuario_id,
        nombreUsuario: row.nombre_usuario,
        email: row.email,
        motivo: row.motivo,
        detalle: row.detalle,
        baneadoEn: row.baneado_en,
        venceEn: row.vence_en,
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
    console.error('Error GET /baneados', error);
    res.status(500).json({ error: 'Error al obtener jugadores baneados' });
  }
});

module.exports = router;