const express = require('express');
const router = express.Router();
const db = require('../../config/database');
const { verificarToken } = require('../../middleware/auth');

const BONO_POR_INVITADO = 5;

router.get('/resumen', verificarToken, async (req, res) => {
  try {
    const { id, steamId } = req.usuario;

    const [statsR, elegiblesR, ganadosR] = await Promise.all([
      db.query(
        `SELECT COUNT(*)::int AS invitados
         FROM referidos
         WHERE id_usuario = $1`,
        [id]
      ),
      db.query(
        `SELECT COUNT(*)::int AS elegibles
         FROM referidos r
         WHERE r.id_usuario = $1
           AND r.bono_otorgado = FALSE
           AND EXISTS (
             SELECT 1 FROM apuestas a WHERE a.id_usuario = r.id_referido
           )`,
        [id]
      ),
      db.query(
        `SELECT COUNT(*)::int AS bonos_otorgados
         FROM referidos
         WHERE id_usuario = $1 AND bono_otorgado = TRUE`,
        [id]
      ),
    ]);

    const invitados = statsR.rows[0]?.invitados || 0;
    const elegibles = elegiblesR.rows[0]?.elegibles || 0;
    const bonosOtorgados = ganadosR.rows[0]?.bonos_otorgados || 0;
    const ganado = (bonosOtorgados * BONO_POR_INVITADO).toFixed(2);
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const link = `${baseUrl}/registro?ref=${encodeURIComponent(steamId)}`;

    res.json({
      link,
      stats: {
        invitados,
        elegibles,
        ganado,
      },
      recompensa: {
        bonoPorInvitado: BONO_POR_INVITADO,
      },
    });
  } catch (err) {
    console.error('Error /referidos/resumen:', err);
    res.status(500).json({ error: 'Error al obtener resumen de referidos' });
  }
});

router.get('/historial', verificarToken, async (req, res) => {
  try {
    const { id } = req.usuario;
    const limitRaw = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20;

    const historialR = await db.query(
      `SELECT
         r.id,
         r.creado_en,
         r.bono_otorgado,
         u.id AS id_referido,
         u.nombre_usuario,
         u.avatar,
         u.steam_id,
         COALESCE(ap.apuestas_count, 0)::int AS apuestas_count
       FROM referidos r
       INNER JOIN usuarios u ON u.id = r.id_referido
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS apuestas_count
         FROM apuestas a
         WHERE a.id_usuario = r.id_referido
       ) ap ON TRUE
       WHERE r.id_usuario = $1
       ORDER BY r.creado_en DESC
       LIMIT $2`,
      [id, limit]
    );

    const historial = historialR.rows.map((row) => {
      const yaJugo = Number(row.apuestas_count) > 0;
      let estado = 'pendiente';

      if (row.bono_otorgado) {
        estado = 'bono_pagado';
      } else if (yaJugo) {
        estado = 'elegible';
      }

      return {
        id: row.id,
        creadoEn: row.creado_en,
        estado,
        bonoOtorgado: row.bono_otorgado,
        apuestasCount: Number(row.apuestas_count) || 0,
        referido: {
          id: row.id_referido,
          nombreUsuario: row.nombre_usuario,
          avatar: row.avatar,
          steamId: row.steam_id,
        },
      };
    });

    res.json({
      historial,
      meta: {
        limite: limit,
        total: historial.length,
      },
    });
  } catch (err) {
    console.error('Error /referidos/historial:', err);
    res.status(500).json({ error: 'Error al obtener historial de referidos' });
  }
});

module.exports = router;
