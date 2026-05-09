const express = require('express');
const router = express.Router();
const db = require('../../config/database');
const { verificarToken } = require('../../middleware/auth');

// ── GET /api/billetera/resumen ──────────────────────────────────────────────
// Saldo, bono y totales calculados desde transacciones
router.get('/resumen', verificarToken, async (req, res) => {
  try {
    const { id } = req.usuario;

    const [resUsuario, resStats] = await Promise.all([
      db.query('SELECT saldo, bono FROM usuarios WHERE id = $1', [id]),
      db.query(`
        SELECT
          COALESCE(SUM(monto) FILTER (WHERE tipo = 'recarga'),    0) AS total_recargado,
          COALESCE(SUM(monto) FILTER (WHERE tipo = 'retiro'),     0) AS total_retirado,
          COALESCE(SUM(monto) FILTER (WHERE tipo = 'apuesta'),    0) AS total_apostado,
          COALESCE(SUM(monto) FILTER (WHERE tipo = 'devolucion'), 0) AS total_devuelto,
          COUNT(*)                                                    AS total_movimientos
        FROM transacciones
        WHERE id_usuario = $1
      `, [id]),
    ]);

    if (!resUsuario.rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });

    res.json({
      saldo: resUsuario.rows[0].saldo,
      bono:  resUsuario.rows[0].bono,
      stats: resStats.rows[0],
    });
  } catch (err) {
    console.error('Error /billetera/resumen:', err);
    res.status(500).json({ error: 'Error al obtener resumen' });
  }
});

// ── GET /api/billetera/transacciones ───────────────────────────────────────
// Historial paginado de transacciones
router.get('/transacciones', verificarToken, async (req, res) => {
  try {
    const { id } = req.usuario;
    const pagina  = Math.max(1, parseInt(req.query.pagina)  || 1);
    const limite  = Math.min(50, parseInt(req.query.limite) || 20);
    const tipo    = req.query.tipo || null; // filtro opcional
    const offset  = (pagina - 1) * limite;

    const condTipo  = tipo ? 'AND tipo = $3' : '';
    const condTipoCount = tipo ? 'AND tipo = $2' : '';
    const params    = tipo ? [id, limite, tipo, offset] : [id, limite, offset];
    const paramOffset = tipo ? 4 : 3;

    const querySQL = `
      SELECT id, tipo, monto, descripcion, referencia_id, creado_en
      FROM transacciones
      WHERE id_usuario = $1
      ${condTipo}
      ORDER BY creado_en DESC
      LIMIT $2 OFFSET $${paramOffset}
    `;

    const countSQL = `
      SELECT COUNT(*) AS total FROM transacciones
      WHERE id_usuario = $1 ${condTipoCount}
    `;

    const [resTx, resCount] = await Promise.all([
      db.query(querySQL, params),
      db.query(countSQL, tipo ? [id, tipo] : [id]),
    ]);

    res.json({
      transacciones: resTx.rows,
      total:  parseInt(resCount.rows[0].total),
      pagina,
      limite,
      paginas: Math.ceil(parseInt(resCount.rows[0].total) / limite),
    });
  } catch (err) {
    console.error('Error /billetera/transacciones:', err);
    res.status(500).json({ error: 'Error al obtener transacciones' });
  }
});

module.exports = router;
