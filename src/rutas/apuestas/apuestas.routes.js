const express = require('express');
const router = express.Router();
const { verificarToken } = require('../../middleware/auth');
const db = require('../../config/database');
const socketEmitter = require('../../utils/socketEmitter');

const CASA_COMISION = 0.05;

// ─── Query helper: lista apuestas de sala con info de jugadores ──────────────
async function listarApuestasSala() {
  const q = `
    SELECT s.*,
      u.nombre_usuario AS creador_nombre,
      u.avatar         AS creador_avatar,
      u.mmr            AS creador_mmr,
      COALESCE(json_agg(
        json_build_object(
          'id',     uj.id,
          'nombre', uj.nombre_usuario,
          'avatar', uj.avatar,
          'mmr',    uj.mmr,
          'banda',  sj.banda
        ) ORDER BY sj.unido_en
      ) FILTER (WHERE uj.id IS NOT NULL), '[]') AS jugadores_info
    FROM salas s
    LEFT JOIN usuarios u  ON u.id  = s.id_creador
    LEFT JOIN sala_jugadores sj ON sj.id_sala = s.id
    LEFT JOIN usuarios uj ON uj.id = sj.id_usuario
    WHERE s.tipo = 'apuesta'
      AND s.estado IN ('esperando', 'jugando')
    GROUP BY s.id, u.nombre_usuario, u.avatar, u.mmr
    ORDER BY s.creada_en DESC
  `;
  const r = await db.query(q);
  return r.rows;
}

// GET /api/apuestas-salas — listar apuestas de sala activas
router.get('/', async (req, res) => {
  try {
    const apuestas = await listarApuestasSala();
    const activos = await db.query("SELECT COUNT(*) FROM salas WHERE tipo='apuesta' AND estado IN ('esperando','jugando')");
    const terminados = await db.query("SELECT COUNT(*) FROM salas WHERE tipo='apuesta' AND estado='terminada'");
    res.json({
      apuestas,
      activos: parseInt(activos.rows[0].count),
      terminados: parseInt(terminados.rows[0].count),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/apuestas-salas — crear sala de apuesta (1v1)
router.post('/', verificarToken, async (req, res) => {
  let client;
  try {
    client = await db.pool.connect();
  } catch (e) {
    return res.status(503).json({ error: 'No se pudo conectar a la base de datos. Intenta de nuevo.' });
  }
  try {
    await client.query('BEGIN');

    const { nombre, modo, limiteMmrMin, limiteMmrMax, entrada } = req.body;
    const entradaNum = parseFloat(entrada) || 0;
    const premioCalculado = parseFloat((entradaNum * 2 * (1 - CASA_COMISION)).toFixed(2));

    if (!nombre || !nombre.trim()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'El nombre de la apuesta es obligatorio' });
    }

    if (entradaNum > 0) {
      const updateSaldo = await client.query(`
        UPDATE usuarios
        SET bono  = CASE WHEN bono  >= $2 THEN bono  - $2 ELSE 0 END,
            saldo = CASE WHEN bono  >= $2 THEN saldo     ELSE saldo - ($2 - bono) END
        WHERE id = $1 AND (saldo + bono) >= $2
        RETURNING saldo, bono
      `, [req.usuario.id, entradaNum]);

      if (updateSaldo.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Saldo insuficiente. Necesitas S/ ${entradaNum.toFixed(2)}` });
      }

      await client.query(
        `INSERT INTO transacciones (id_usuario, tipo, monto, descripcion, creado_en)
         VALUES ($1, 'apuesta', $2, $3, NOW())`,
        [req.usuario.id, entradaNum, 'Entrada apuesta de sala creada por usuario']
      );
    }

    // Insertar sala con tipo='apuesta' y max_jugadores=2
    const nuevaApuestaSala = await client.query(`
      INSERT INTO salas (nombre, id_creador, tipo, modo, limite_mmr_min, limite_mmr_max,
                         entrada, premio, es_automatico, max_jugadores, jugadores_actuales,
                         estado, creada_en, actualizada_en)
      VALUES ($1, $2, 'apuesta', $3, $4, $5, $6, $7, TRUE, 2, 0, 'esperando', NOW(), NOW())
      RETURNING *
    `, [
      nombre.trim(),
      req.usuario.id,
      modo || 'All Pick',
      parseInt(limiteMmrMin) || 0,
      parseInt(limiteMmrMax) || 99999,
      entradaNum,
      premioCalculado,
    ]);

    const apuesta = nuevaApuestaSala.rows[0];

    // Registrar al creador como Jugador 1 (banda='radiant')
    await client.query(
      `INSERT INTO sala_jugadores (id_sala, id_usuario, banda) VALUES ($1, $2, 'radiant') ON CONFLICT DO NOTHING`,
      [apuesta.id, req.usuario.id]
    );
    await client.query(
      `UPDATE salas SET jugadores_actuales=1, actualizada_en=NOW() WHERE id=$1`,
      [apuesta.id]
    );

    await client.query('COMMIT');

    const nuevoSaldo = entradaNum > 0
      ? (await db.query('SELECT saldo, bono FROM usuarios WHERE id=$1', [req.usuario.id])).rows[0]
      : null;
    const saldoFinal = nuevoSaldo ? parseFloat(nuevoSaldo.saldo) : null;
    if (saldoFinal !== null) socketEmitter.emitirSaldoActualizado(req.usuario.id, saldoFinal);

    res.json({
      apuesta: { ...apuesta, jugadores_actuales: 1 },
      premioCalculado,
      nuevoSaldo: saldoFinal,
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    res.status(500).json({ error: e.message });
  } finally {
    if (client) client.release();
  }
});

// POST /api/apuestas-salas/:id/aceptar — unirse como oponente
router.post('/:id/aceptar', verificarToken, async (req, res) => {
  let client;
  try {
    client = await db.pool.connect();
  } catch (e) {
    return res.status(503).json({ error: 'No se pudo conectar a la base de datos. Intenta de nuevo.' });
  }
  try {
    await client.query('BEGIN');

    const apuestaR = await client.query(
      `SELECT s.*, u.nombre_usuario AS creador_nombre
       FROM salas s LEFT JOIN usuarios u ON u.id=s.id_creador
       WHERE s.id=$1 AND s.tipo='apuesta'`,
      [req.params.id]
    );
    if (apuestaR.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Apuesta de sala no encontrada' });
    }
    const apuesta = apuestaR.rows[0];

    if (apuesta.estado !== 'esperando') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'La apuesta ya no acepta oponentes' });
    }
    if (parseInt(apuesta.jugadores_actuales) >= 2) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'La apuesta ya está completa' });
    }
    if (apuesta.id_creador === req.usuario.id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No puedes aceptar tu propia apuesta' });
    }

    const yaEsta = await client.query(
      'SELECT id FROM sala_jugadores WHERE id_sala=$1 AND id_usuario=$2',
      [apuesta.id, req.usuario.id]
    );
    if (yaEsta.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Ya estás en esta apuesta' });
    }

    // Verificar MMR
    const usuarioR = await client.query('SELECT mmr FROM usuarios WHERE id=$1', [req.usuario.id]);
    const miMmr = parseInt(usuarioR.rows[0]?.mmr) || 0;
    const mmrMin = parseInt(apuesta.limite_mmr_min) || 0;
    const mmrMax = parseInt(apuesta.limite_mmr_max) || 99999;
    if (miMmr < mmrMin || miMmr > mmrMax) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Tu MMR (${miMmr}) no cumple el requisito de la apuesta (${mmrMin}–${mmrMax})` });
    }

    const entrada = parseFloat(apuesta.entrada) || 0;
    if (entrada > 0) {
      const updateSaldo = await client.query(`
        UPDATE usuarios SET saldo = saldo - $2
        WHERE id = $1 AND saldo >= $2
        RETURNING saldo
      `, [req.usuario.id, entrada]);

      if (updateSaldo.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Saldo insuficiente. Necesitas S/ ${entrada.toFixed(2)}` });
      }

      await client.query(
        `INSERT INTO transacciones (id_usuario, tipo, monto, descripcion, creado_en)
         VALUES ($1, 'apuesta', $2, $3, NOW())`,
        [req.usuario.id, entrada, `Entrada apuesta #${apuesta.id} - ${apuesta.nombre}`]
      );
    }

    // Registrar como Jugador 2 (banda='dire')
    await client.query(
      `INSERT INTO sala_jugadores (id_sala, id_usuario, banda) VALUES ($1, $2, 'dire') ON CONFLICT DO NOTHING`,
      [apuesta.id, req.usuario.id]
    );

    // Actualizar jugadores y cambiar estado a 'jugando'
    const updated = await client.query(
      `UPDATE salas SET jugadores_actuales=2, estado='jugando', actualizada_en=NOW() WHERE id=$1 RETURNING *`,
      [apuesta.id]
    );

    await client.query('COMMIT');

    const nuevoSaldo = entrada > 0
      ? (await db.query('SELECT saldo FROM usuarios WHERE id=$1', [req.usuario.id])).rows[0].saldo
      : null;
    if (nuevoSaldo !== null) socketEmitter.emitirSaldoActualizado(req.usuario.id, nuevoSaldo);

    res.json({ apuesta: updated.rows[0], nuevoSaldo });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    res.status(500).json({ error: e.message });
  } finally {
    if (client) client.release();
  }
});

// DELETE /api/apuestas-salas/:id — cancelar apuesta de sala
router.delete('/:id', verificarToken, async (req, res) => {
  let client;
  try {
    client = await db.pool.connect();
  } catch (e) {
    return res.status(503).json({ error: 'No se pudo conectar a la base de datos. Intenta de nuevo.' });
  }
  try {
    await client.query('BEGIN');

    const apuestaR = await client.query('SELECT * FROM salas WHERE id=$1 AND tipo=$2', [req.params.id, 'apuesta']);
    if (apuestaR.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Apuesta de sala no encontrada' });
    }
    const apuesta = apuestaR.rows[0];

    if (apuesta.id_creador !== req.usuario.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Solo el creador puede cancelar la apuesta' });
    }
    if (apuesta.estado === 'jugando') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No se puede cancelar una apuesta en curso' });
    }

    const entrada = parseFloat(apuesta.entrada) || 0;

    // Devolver saldo a todos los jugadores registrados
    if (entrada > 0) {
      const jugadoresR = await client.query('SELECT id_usuario FROM sala_jugadores WHERE id_sala=$1', [apuesta.id]);
      for (const j of jugadoresR.rows) {
        const saldoR = await client.query(
          'UPDATE usuarios SET saldo = saldo + $1 WHERE id=$2 RETURNING saldo',
          [entrada, j.id_usuario]
        );
        await client.query(
          `INSERT INTO transacciones (id_usuario, tipo, monto, descripcion, creado_en)
           VALUES ($1, 'devolucion', $2, $3, NOW())`,
          [j.id_usuario, entrada, `Devolución por cancelación de apuesta "${apuesta.nombre}" (ID #${apuesta.id})`]
        );
        if (saldoR.rows.length > 0) {
          socketEmitter.emitirSaldoActualizado(j.id_usuario, saldoR.rows[0].saldo);
        }
      }
    }

    await client.query('DELETE FROM sala_jugadores WHERE id_sala=$1', [apuesta.id]);
    await client.query('DELETE FROM salas WHERE id=$1', [apuesta.id]);
    await client.query('COMMIT');

    res.json({ ok: true, mensaje: `Apuesta cancelada. Se devolvió S/ ${entrada.toFixed(2)} a los jugadores registrados.` });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    res.status(500).json({ error: e.message });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
