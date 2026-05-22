const express = require('express');
const router = express.Router();
const Sala = require('../../modelos/sala/sala.model');
const { verificarToken } = require('../../middleware/auth');
const db = require('../../config/database');
const socketEmitter = require('../../utils/socketEmitter');

router.get('/', async (req, res) => {
  try {
    const { filtro } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset = parseInt(req.query.offset) || 0;
    if (filtro === 'finalizadas') {
      const { salas, total } = await Sala.listarFinalizadas(limit, offset);
      const activas = await Sala.contarActivas();
      return res.json({ salas, activas, finalizadas: total, hasMore: offset + salas.length < total });
    }
    if (filtro === 'canceladas') {
      const { salas, total } = await Sala.listarCanceladas(limit, offset);
      const activas = await Sala.contarActivas();
      return res.json({ salas, activas, canceladas: total, hasMore: offset + salas.length < total });
    }
    const salas = await Sala.listar();
    const activas = await Sala.contarActivas();
    const finalizadas = await Sala.contarFinalizadas();
    const canceladas = await Sala.contarCanceladas();
    res.json({ salas, activas, terminadas: finalizadas, finalizadas, canceladas });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', verificarToken, async (req, res) => {
  let client;
  try {
    client = await db.pool.connect();
  } catch (e) {
    return res.status(503).json({ error: 'No se pudo conectar a la base de datos. Intenta de nuevo.' });
  }
  try {
    await client.query('BEGIN');
    const { entrada, maxJugadores, fechaInicio } = req.body;
    const entradaNum = parseFloat(entrada) || 0;
    const jugadoresNum = parseInt(maxJugadores) || 10;
    const CASA_COMISION = 0.05;
    const pozoTotal = entradaNum * jugadoresNum;
    const premioCalculado = parseFloat((pozoTotal * (1 - CASA_COMISION)).toFixed(2));

    if (entradaNum > 0) {
      // UPDATE atómico: verifica saldo y descuenta en una sola sentencia, sin SELECT FOR UPDATE
      const updateSaldo = await client.query(`
        UPDATE usuarios
        SET bono  = CASE WHEN bono  >= $2 THEN bono  - $2 ELSE 0 END,
            saldo = CASE WHEN bono  >= $2 THEN saldo     ELSE saldo - ($2 - bono) END
        WHERE id = $1 AND (saldo + bono) >= $2
        RETURNING saldo, bono
      `, [req.usuario.id, entradaNum]);
      if (updateSaldo.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Saldo insuficiente para crear la sala. Necesitas S/ ${entradaNum.toFixed(2)}` });
      }
      await client.query(
        `INSERT INTO transacciones (id_usuario, tipo, monto, descripcion, creado_en) VALUES ($1,'apuesta',$2,$3,NOW())`,
        [req.usuario.id, entradaNum, `Entrada sala creada por usuario`]
      );
    }

    const sala = await Sala.crear({
      ...req.body,
      idCreador: req.usuario.id,
      premio: premioCalculado,
      fechaInicio: fechaInicio || null,
    });
    await client.query(
      'INSERT INTO sala_jugadores (id_sala, id_usuario, banda) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [sala.id, req.usuario.id, 'radiant']
    );
    await client.query('UPDATE salas SET jugadores_actuales=1, actualizada_en=NOW() WHERE id=$1', [sala.id]);
    await client.query('COMMIT');

    const nuevoSaldo = entradaNum > 0
      ? (await db.query('SELECT saldo, bono FROM usuarios WHERE id=$1', [req.usuario.id])).rows[0]
      : null;
    const saldoFinal = nuevoSaldo ? parseFloat(nuevoSaldo.saldo) : null;
    if (saldoFinal !== null) socketEmitter.emitirSaldoActualizado(req.usuario.id, saldoFinal);
    res.json({
      sala: { ...sala, jugadores_actuales: 1 },
      premioCalculado,
      comision: parseFloat((pozoTotal * CASA_COMISION).toFixed(2)),
      nuevoSaldo: saldoFinal,
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    res.status(500).json({ error: e.message });
  } finally {
    if (client) client.release();
  }
});

router.delete('/:id', verificarToken, async (req, res) => {
  let client;
  try {
    client = await db.pool.connect();
  } catch (e) {
    return res.status(503).json({ error: 'No se pudo conectar a la base de datos. Intenta de nuevo.' });
  }
  try {
    await client.query('BEGIN');

    // Verificar sala y permisos ANTES de borrar nada
    const salaR = await client.query('SELECT * FROM salas WHERE id=$1', [req.params.id]);
    if (salaR.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Sala no encontrada' }); }
    const sala = salaR.rows[0];

    if (sala.id_creador !== req.usuario.id) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Solo el creador puede eliminar la sala' }); }
    if (sala.estado === 'jugando') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'No se puede eliminar una sala en curso' }); }

    const mitad = Math.ceil(parseInt(sala.max_jugadores) / 2);
    if (parseInt(sala.jugadores_actuales) >= mitad) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `No puedes eliminar la sala: ya tiene ${sala.jugadores_actuales} jugadores (mínimo ${mitad} para bloquear)` });
    }

    const entrada = parseFloat(sala.entrada) || 0;

    // Obtener jugadores ANTES de borrar sala_jugadores
    const jugadoresR = await client.query('SELECT id_usuario FROM sala_jugadores WHERE id_sala=$1', [sala.id]);

    // Devolver saldo a cada jugador y registrar transacción
    if (entrada > 0 && jugadoresR.rows.length > 0) {
      for (const j of jugadoresR.rows) {
        const saldoR = await client.query(
          'UPDATE usuarios SET saldo = saldo + $1 WHERE id=$2 RETURNING saldo',
          [entrada, j.id_usuario]
        );
        await client.query(
          `INSERT INTO transacciones (id_usuario, tipo, monto, descripcion, creado_en)
           VALUES ($1, 'devolucion', $2, $3, NOW())`,
          [j.id_usuario, entrada, `Devolución por cancelación de sala "${sala.nombre}" (ID #${sala.id})`]
        );
        // Notificar en tiempo real a cada jugador
        socketEmitter.emitirSaldoActualizado(j.id_usuario, saldoR.rows[0].saldo);
      }
    }

    // Ahora sí borrar
    await client.query('DELETE FROM sala_jugadores WHERE id_sala=$1', [sala.id]);
    await client.query('DELETE FROM salas WHERE id=$1', [sala.id]);

    await client.query('COMMIT');
    res.json({ ok: true, mensaje: `Sala eliminada. Se devolvió S/ ${entrada.toFixed(2)} a ${jugadoresR.rows.length} jugador(es).` });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    res.status(400).json({ error: e.message });
  } finally {
    if (client) client.release();
  }
});

router.post('/:id/avisar-admin', verificarToken, async (req, res) => {
  try {
    const sala = await Sala.buscarPorId(req.params.id);
    if (!sala) return res.status(404).json({ error: 'Sala no encontrada' });
    const salaActualizada = await Sala.avisarAdmin(req.params.id, req.usuario.id);
    await db.query(
      `INSERT INTO mensajes_soporte (id_usuario, mensaje, es_admin, creado_en) VALUES ($1, $2, FALSE, NOW())`,
      [req.usuario.id, `⚠️ SALA LISTA: "${sala.nombre}" (ID #${sala.id}) está llena y la hora de inicio llegó. Crear sala en Dota 2 y enviar link a los ${sala.jugadores_actuales} jugadores.`]
    );
    // Emitir actualización a superadmin para mostrar alerta en tiempo real
    socketEmitter.emitirActualizacionSalaAdmin(salaActualizada);
    res.json({ ok: true, mensaje: 'Aviso enviado al administrador' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/cambiar-banda', verificarToken, async (req, res) => {
  try {
    const { banda } = req.body;
    if (!['radiant','dire'].includes(banda)) return res.status(400).json({ error: 'Banda inválida' });
    const r = await db.query(
      'UPDATE sala_jugadores SET banda=$1, sorteado=TRUE WHERE id_sala=$2 AND id_usuario=$3 RETURNING *',
      [banda, req.params.id, req.usuario.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'No estás en esta sala' });
    res.json({ ok: true, banda });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Sorteo 1v1: asigna bandas opuestas a ambos jugadores atómicamente ────────
router.post('/:id/sorteo-1v1', verificarToken, async (req, res) => {
  try {
    const idSala = req.params.id;
    // Verificar que el solicitante está en la sala
    const estaR = await db.query(
      'SELECT id FROM sala_jugadores WHERE id_sala=$1 AND id_usuario=$2',
      [idSala, req.usuario.id]
    );
    if (!estaR.rows.length) return res.status(403).json({ error: 'No estás en esta sala' });

    // Obtener los dos jugadores de la sala 1v1
    const jugadoresR = await db.query(
      'SELECT id_usuario FROM sala_jugadores WHERE id_sala=$1 ORDER BY unido_en ASC LIMIT 2',
      [idSala]
    );
    if (jugadoresR.rows.length < 2) return res.status(400).json({ error: 'La sala no tiene 2 jugadores aún' });

    // Sorteo: decidir quién es radiant y quién dire
    const esRadiantPrimero = Math.random() < 0.5;
    const idPrimero = jugadoresR.rows[0].id_usuario;
    const idSegundo = jugadoresR.rows[1].id_usuario;
    const bandaPrimero = esRadiantPrimero ? 'radiant' : 'dire';
    const bandaSegundo = esRadiantPrimero ? 'dire' : 'radiant';

    // Asignar bandas a ambos jugadores en una sola transacción
    await db.query(
      'UPDATE sala_jugadores SET banda=$1, sorteado=TRUE WHERE id_sala=$2 AND id_usuario=$3',
      [bandaPrimero, idSala, idPrimero]
    );
    await db.query(
      'UPDATE sala_jugadores SET banda=$1, sorteado=TRUE WHERE id_sala=$2 AND id_usuario=$3',
      [bandaSegundo, idSala, idSegundo]
    );

    socketEmitter.emitirActualizacionSalaSimple(Number(idSala));

    res.json({
      ok: true,
      [idPrimero]: bandaPrimero,
      [idSegundo]: bandaSegundo,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/entrar', verificarToken, async (req, res) => {
  let client;
  try {
    client = await db.pool.connect();
  } catch (e) {
    return res.status(503).json({ error: 'No se pudo conectar a la base de datos. Intenta de nuevo.' });
  }
  try {
    await client.query('BEGIN');
    const ROLES_VALIDOS = ['Carry', 'Mid', 'Off', 'Pos 4', 'Pos 5'];
    const rolPreferido = typeof req.body?.equipo === 'string' ? req.body.equipo.trim() : null;
    if (rolPreferido && !ROLES_VALIDOS.includes(rolPreferido)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Rol inválido' });
    }

    const sala = await Sala.buscarPorId(req.params.id);
    if (!sala) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Sala no encontrada' }); }
    if (sala.estado !== 'esperando') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'La sala ya no acepta jugadores' }); }
    if (parseInt(sala.jugadores_actuales) >= parseInt(sala.max_jugadores)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Sala llena' }); }

    const yaEsta = await client.query('SELECT id FROM sala_jugadores WHERE id_sala=$1 AND id_usuario=$2', [sala.id, req.usuario.id]);
    if (yaEsta.rows.length > 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Ya estás en esta sala' }); }

    const entrada = parseFloat(sala.entrada) || 0;
    if (entrada > 0) {
      // UPDATE atómico: sin SELECT FOR UPDATE
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
        [req.usuario.id, entrada, `Entrada sala #${sala.id} - ${sala.nombre}`]
      );
    }

    // Verificar si hay banda vacante (alguien se salió después del sorteo en 1v1)
    let banda;
    let sorteado = false;
    if (sala.banda_vacante) {
      // El siguiente jugador entra en la banda del que se salió (sin sorteo)
      banda = sala.banda_vacante;
      sorteado = true; // Se considera sorteado porque ya se hizo el sorteo antes
      // Limpiar la banda vacante para que no se use de nuevo
      await client.query('UPDATE salas SET banda_vacante=NULL WHERE id=$1', [sala.id]);
    } else {
      // Asignación normal por balance
      const bandaRadiant = await client.query("SELECT COUNT(*) FROM sala_jugadores WHERE id_sala=$1 AND banda='radiant'", [sala.id]);
      const bandaDire = await client.query("SELECT COUNT(*) FROM sala_jugadores WHERE id_sala=$1 AND banda='dire'", [sala.id]);
      const mitad = Math.ceil(parseInt(sala.max_jugadores) / 2);
      banda = parseInt(bandaRadiant.rows[0].count) < mitad ? 'radiant' : 'dire';
    }

    await client.query(
      'INSERT INTO sala_jugadores (id_sala, id_usuario, banda, equipo, sorteado) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      [sala.id, req.usuario.id, banda, rolPreferido, sorteado]
    );
    const updated = await client.query(
      'UPDATE salas SET jugadores_actuales=(SELECT COUNT(*) FROM sala_jugadores WHERE id_sala=$1), actualizada_en=NOW() WHERE id=$1 RETURNING *',
      [sala.id]
    );

    if (sala.es_automatico && parseInt(updated.rows[0].jugadores_actuales) >= parseInt(sala.max_jugadores)) {
      await client.query("UPDATE salas SET estado='jugando', actualizada_en=NOW() WHERE id=$1", [sala.id]);
      updated.rows[0].estado = 'jugando';
    }

    await client.query('COMMIT');
    const nuevoSaldo = entrada > 0
      ? (await db.query('SELECT saldo FROM usuarios WHERE id=$1', [req.usuario.id])).rows[0].saldo
      : null;
    if (nuevoSaldo !== null) socketEmitter.emitirSaldoActualizado(req.usuario.id, nuevoSaldo);
    socketEmitter.emitirActualizacionSalaSimple(Number(sala.id));
    res.json({ sala: updated.rows[0], nuevoSaldo, banda });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    res.status(500).json({ error: e.message });
  } finally {
    if (client) client.release();
  }
});

router.post('/:id/salir', verificarToken, async (req, res) => {
  let client;
  try {
    client = await db.pool.connect();
  } catch (e) {
    return res.status(503).json({ error: 'No se pudo conectar a la base de datos. Intenta de nuevo.' });
  }
  try {
    await client.query('BEGIN');
    const sala = await Sala.buscarPorId(req.params.id);
    if (!sala) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Sala no encontrada' }); }

    if (sala.estado === 'jugando') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'No puedes salir de una partida en curso' }); }

    const estaR = await client.query('SELECT id FROM sala_jugadores WHERE id_sala=$1 AND id_usuario=$2', [sala.id, req.usuario.id]);
    if (estaR.rows.length === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'No estás en esta sala' }); }

    await client.query('DELETE FROM sala_jugadores WHERE id_sala=$1 AND id_usuario=$2', [sala.id, req.usuario.id]);

    const sancionAplicada = false;

    const updated = await client.query(
      'UPDATE salas SET jugadores_actuales=(SELECT COUNT(*) FROM sala_jugadores WHERE id_sala=$1), actualizada_en=NOW() WHERE id=$1 RETURNING *',
      [sala.id]
    );

    const entrada = parseFloat(sala.entrada) || 0;
    if (entrada > 0) {
      await client.query('UPDATE usuarios SET saldo = saldo + $1 WHERE id = $2', [entrada, req.usuario.id]);
      await client.query(
        `INSERT INTO transacciones (id_usuario, tipo, monto, descripcion, creado_en)
         VALUES ($1, 'devolucion', $2, $3, NOW())`,
        [req.usuario.id, entrada, `Devolución por salir sala #${sala.id} - ${sala.nombre}`]
      );
    }

    await client.query('COMMIT');
    const nuevoSaldo = (entrada > 0 || sancionAplicada)
      ? (await db.query('SELECT saldo FROM usuarios WHERE id=$1', [req.usuario.id])).rows[0].saldo
      : null;
    if (nuevoSaldo !== null) socketEmitter.emitirSaldoActualizado(req.usuario.id, nuevoSaldo);
    socketEmitter.emitirActualizacionSalaSimple(Number(sala.id));
    res.json({ sala: updated.rows[0], nuevoSaldo, sancion: sancionAplicada ? -100 : 0 });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    res.status(500).json({ error: e.message });
  } finally {
    if (client) client.release();
  }
});

router.get('/actividad-reciente', async (req, res) => {
  try {
    const ganadores = await db.query(`
      SELECT
        'ganador' AS tipo,
        u.nombre_usuario,
        u.avatar,
        s.nombre AS sala_nombre,
        sr.equipo_ganador,
        sr.finalizada_en AS fecha
      FROM salas_resultados sr
      JOIN salas s ON s.id = sr.id_sala
      JOIN sala_jugadores sj ON sj.id_sala = sr.id_sala AND sj.banda = sr.equipo_ganador
      JOIN usuarios u ON u.id = sj.id_usuario
      WHERE sr.finalizada_en >= NOW() - INTERVAL '7 days'
      ORDER BY sr.finalizada_en DESC
      LIMIT 10
    `);

    const sanciones = await db.query(`
      SELECT
        b.tipo AS tipo,
        u.nombre_usuario,
        u.avatar,
        b.mensaje AS descripcion,
        b.monto,
        b.creado_en AS fecha
      FROM bonos b
      JOIN usuarios u ON u.id = b.usuario_id
      WHERE b.tipo IN ('sancion', 'abono')
        AND b.creado_en >= NOW() - INTERVAL '7 days'
      ORDER BY b.creado_en DESC
      LIMIT 15
    `);

    const actividad = [
      ...ganadores.rows,
      ...sanciones.rows
    ].sort((a, b) => new Date(b.fecha) - new Date(a.fecha)).slice(0, 15);

    res.json({ actividad });
  } catch (e) {
    console.error('[actividad-reciente]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Obtener salas terminadas donde el usuario participó
router.get('/mis-terminadas', verificarToken, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const offset = parseInt(req.query.offset) || 0;
    const { salas, total } = await Sala.listarTerminadasPorUsuario(req.usuario.id, limit, offset);
    res.json({ salas, total, hasMore: offset + salas.length < total });
  } catch (e) {
    console.error('[mis-terminadas]', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/chat-general', async (req, res) => {
  try {
    const before = req.query.before ? parseInt(req.query.before, 10) : null;
    const limitRaw = req.query.limit ? parseInt(req.query.limit, 10) : 40;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 10), 100) : 40;

    const r = await db.query(
      `SELECT m.id, m.mensaje, m.creado_en, m.id_usuario,
              COALESCE(m.tipo, 'texto') AS tipo, m.sticker_id,
              u.nombre_usuario, u.avatar, u.nivel, u.saldo
       FROM mensajes_chat_general m
       LEFT JOIN usuarios u ON u.id = m.id_usuario
       WHERE ($1::int IS NULL OR m.id < $1)
       ORDER BY m.id DESC
       LIMIT $2`,
      [before, limit]
    );

    const mensajes = r.rows.reverse();
    const cursor = mensajes.length ? mensajes[0].id : null;
    const hasMore = r.rows.length === limit;
    res.json({ mensajes, cursor, hasMore });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Verificar si usuario es premium (saldo >= 1000) y obtener lista de stickers
router.get('/stickers/estado', verificarToken, async (req, res) => {
  try {
    const r = await db.query('SELECT saldo FROM usuarios WHERE id=$1', [req.usuario.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    const saldo = parseFloat(r.rows[0].saldo);
    const esPremium = saldo >= 1000;
    const totalStickers = 90;
    const stickers = esPremium ? Array.from({ length: totalStickers }, (_, i) => i + 1) : [];
    res.json({ esPremium, saldo, totalStickers, stickers });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Verificar estado premium para cambio de nombre (una vez al mes)
router.get('/premium/nombre-estado', verificarToken, async (req, res) => {
  try {
    const r = await db.query(
      'SELECT saldo, nombre_usuario, nombre_cambiado_en FROM usuarios WHERE id=$1',
      [req.usuario.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    
    const saldo = parseFloat(r.rows[0].saldo);
    const esPremium = saldo >= 1000;
    const nombre = r.rows[0].nombre_usuario;
    const ultimoCambio = r.rows[0].nombre_cambiado_en;
    
    // Calcular días restantes para próximo cambio
    let diasRestantes = 0;
    let puedeCambiar = esPremium;
    
    if (ultimoCambio) {
      const ultimaFecha = new Date(ultimoCambio);
      const ahora = new Date();
      const diffMs = ahora - ultimaFecha;
      const diffDias = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      
      if (diffDias < 30) {
        diasRestantes = 30 - diffDias;
        puedeCambiar = false;
      }
    }
    
    res.json({ 
      esPremium, 
      saldo, 
      nombre,
      puedeCambiar,
      diasRestantes,
      ultimoCambio 
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Cambiar nombre de usuario (solo premium, máximo 1 vez al mes)
router.post('/premium/cambiar-nombre', verificarToken, async (req, res) => {
  try {
    const { nuevoNombre } = req.body;
    
    // Validaciones
    if (!nuevoNombre || typeof nuevoNombre !== 'string') {
      return res.status(400).json({ error: 'Nombre requerido' });
    }
    
    const nombreLimpio = nuevoNombre.trim();
    if (nombreLimpio.length < 3 || nombreLimpio.length > 20) {
      return res.status(400).json({ error: 'El nombre debe tener entre 3 y 20 caracteres' });
    }
    
    // Validar caracteres alfanuméricos
    if (!/^[a-zA-Z0-9_-]+$/.test(nombreLimpio)) {
      return res.status(400).json({ error: 'El nombre solo puede contener letras, números, guiones y guiones bajos' });
    }
    
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      
      // Verificar premium y último cambio
      const r = await client.query(
        'SELECT saldo, nombre_cambiado_en FROM usuarios WHERE id=$1 FOR UPDATE',
        [req.usuario.id]
      );
      
      if (!r.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }
      
      const saldo = parseFloat(r.rows[0].saldo);
      const esPremium = saldo >= 1000;
      const ultimoCambio = r.rows[0].nombre_cambiado_en;
      
      if (!esPremium) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Necesitas S/ 1,000.00 o más para cambiar tu nombre' });
      }
      
      // Verificar cooldown de 30 días
      if (ultimoCambio) {
        const ultimaFecha = new Date(ultimoCambio);
        const ahora = new Date();
        const diffMs = ahora - ultimaFecha;
        const diffDias = Math.floor(diffMs / (1000 * 60 * 60 * 24));
        
        if (diffDias < 30) {
          const diasRestantes = 30 - diffDias;
          await client.query('ROLLBACK');
          return res.status(429).json({ 
            error: `Debes esperar ${diasRestantes} día${diasRestantes > 1 ? 's' : ''} más para cambiar tu nombre` 
          });
        }
      }
      
      // Verificar que el nombre no esté en uso
      const existe = await client.query(
        'SELECT id FROM usuarios WHERE nombre_usuario = $1 AND id != $2',
        [nombreLimpio, req.usuario.id]
      );
      
      if (existe.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Este nombre ya está en uso' });
      }
      
      // Actualizar nombre y fecha de cambio
      await client.query(
        'UPDATE usuarios SET nombre_usuario = $1, nombre_cambiado_en = NOW() WHERE id = $2',
        [nombreLimpio, req.usuario.id]
      );
      
      await client.query('COMMIT');
      
      res.json({ 
        success: true, 
        mensaje: 'Nombre cambiado exitosamente',
        nuevoNombre: nombreLimpio 
      });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Historial del chat de sala (público para leer, solo participantes pueden escribir vía socket)
router.get('/:id/chat', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT m.id, m.mensaje, m.creado_en, m.id_usuario,
              u.nombre_usuario, u.avatar, u.saldo
       FROM mensajes_chat_sala m
       JOIN usuarios u ON u.id = m.id_usuario
       WHERE m.id_sala = $1
       ORDER BY m.creado_en ASC
       LIMIT 100`,
      [req.params.id]
    );
    res.json({ mensajes: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/chat-privado/:idAmigo', verificarToken, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 40, 100);
    const before = req.query.before ? parseInt(req.query.before) : null;
    const params = [req.usuario.id, req.params.idAmigo];
    let whereBefore = '';
    if (before) {
      whereBefore = ` AND m.id < $3`;
      params.push(before);
    }
    const r = await db.query(
      `SELECT m.*, u.nombre_usuario AS emisor_nombre, u.avatar AS emisor_avatar
       FROM mensajes_chat_privado m
       JOIN usuarios u ON u.id=m.id_emisor
       WHERE ((m.id_emisor=$1 AND m.id_receptor=$2) OR (m.id_emisor=$2 AND m.id_receptor=$1))${whereBefore}
       ORDER BY m.id DESC LIMIT ${limit + 1}`,
      params
    );
    const rows = r.rows;
    const hasMore = rows.length > limit;
    const mensajes = rows.slice(0, limit).reverse();
    const cursor = mensajes.length > 0 ? mensajes[0].id : null;
    await db.query('UPDATE mensajes_chat_privado SET leido=TRUE WHERE id_receptor=$1 AND id_emisor=$2', [req.usuario.id, req.params.idAmigo]);
    res.json({ mensajes, cursor, hasMore });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/soporte', verificarToken, async (req, res) => {
  try {
    const r = await db.query(
      'SELECT * FROM mensajes_soporte WHERE id_usuario=$1 ORDER BY creado_en ASC',
      [req.usuario.id]
    );
    res.json({ mensajes: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const r = await db.query(
      `SELECT s.*,
        u.nombre_usuario AS creador_nombre,
        u.avatar         AS creador_avatar,
        COUNT(sj.id)     AS jugadores_count,
        COALESCE(json_agg(
          json_build_object(
            'id', uj.id,
            'nombre', uj.nombre_usuario,
            'avatar', uj.avatar,
            'mmr', COALESCE(uj.mmr, 0),
            'saldo', uj.saldo,
            'banda', sj.banda,
            'equipo', sj.equipo,
            'listo', sj.listo,
            'unido_en', sj.unido_en,
            'salas_jugadas', (
              SELECT COUNT(*) FROM sala_jugadores sj2
              JOIN salas s2 ON s2.id = sj2.id_sala
              WHERE sj2.id_usuario = uj.id
                AND s2.estado IN ('finalizada','terminada')
                AND s2.match_resultado IS NOT NULL
            ),
            'salas_ganadas', (
              SELECT COUNT(*) FROM sala_jugadores sj3
              JOIN salas s3 ON s3.id = sj3.id_sala
              WHERE sj3.id_usuario = uj.id
                AND s3.estado IN ('finalizada','terminada')
                AND s3.match_resultado IS NOT NULL
                AND s3.match_resultado->>'winner' = sj3.banda
            )
          ) ORDER BY sj.unido_en
        ) FILTER (WHERE uj.id IS NOT NULL), '[]') AS jugadores_info
      FROM salas s
      LEFT JOIN usuarios u ON u.id = s.id_creador
      LEFT JOIN sala_jugadores sj ON sj.id_sala = s.id
      LEFT JOIN usuarios uj ON uj.id = sj.id_usuario
      WHERE s.id = $1
      GROUP BY s.id, u.nombre_usuario, u.avatar
      LIMIT 1`,
      [id]
    );

    if (!r.rows.length) return res.status(404).json({ error: 'Sala no encontrada' });
    return res.json({ sala: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Marcar / desmarcar listo ─────────────────────────────────────────────
router.post('/:id/listo', verificarToken, async (req, res) => {
  try {
    const idSala = req.params.id;
    const estaR = await db.query(
      'SELECT listo FROM sala_jugadores WHERE id_sala=$1 AND id_usuario=$2',
      [idSala, req.usuario.id]
    );
    if (!estaR.rows.length) return res.status(400).json({ error: 'No estás en esta sala' });
    const nuevoListo = !estaR.rows[0].listo;
    await db.query(
      'UPDATE sala_jugadores SET listo=$1 WHERE id_sala=$2 AND id_usuario=$3',
      [nuevoListo, idSala, req.usuario.id]
    );
    const salaR = await db.query('SELECT * FROM salas WHERE id=$1', [idSala]);
    const sala = salaR.rows[0];
    if (sala) {
      const totalR = await db.query(
        'SELECT COUNT(*) AS total, SUM(CASE WHEN listo THEN 1 ELSE 0 END) AS listos FROM sala_jugadores WHERE id_sala=$1',
        [idSala]
      );
      const total = parseInt(totalR.rows[0].total);
      const listos = parseInt(totalR.rows[0].listos);
      const llena = total >= parseInt(sala.max_jugadores);
      if (llena && total === listos && total > 0) {
        socketEmitter.emitirTodosListos(Number(idSala), {
          idSala: Number(idSala),
          nombreSala: sala.nombre,
          totalJugadores: total,
        });

        if (sala.es_automatico) {
          // Nota: El superadmin debe ingresar el lobby_id manualmente
          // El sistema ya no crea lobbies automáticamente en Steam
          console.log(`[SALA] Sala #${idSala} lista. Superadmin debe ingresar lobby_id manualmente.`);
        }
      }
    }
    socketEmitter.emitirActualizacionSalaSimple(Number(idSala));
    res.json({ ok: true, listo: nuevoListo });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Proponer intercambio de roles ─────────────────────────────
router.post('/:id/proponer-intercambio', verificarToken, async (req, res) => {
  try {
    const idSala = req.params.id;
    const { idReceptor } = req.body;
    if (!idReceptor) return res.status(400).json({ error: 'idReceptor requerido' });

    const proponenteR = await db.query(
      'SELECT equipo FROM sala_jugadores WHERE id_sala=$1 AND id_usuario=$2',
      [idSala, req.usuario.id]
    );
    if (!proponenteR.rows.length) return res.status(400).json({ error: 'No estás en esta sala' });
    if (!proponenteR.rows[0].equipo) return res.status(400).json({ error: 'No tienes un rol asignado' });

    const receptorR = await db.query(
      'SELECT equipo FROM sala_jugadores WHERE id_sala=$1 AND id_usuario=$2',
      [idSala, idReceptor]
    );
    if (!receptorR.rows.length) return res.status(400).json({ error: 'El otro jugador no está en esta sala' });
    if (!receptorR.rows[0].equipo) return res.status(400).json({ error: 'El otro jugador no tiene rol asignado' });

    const userR = await db.query('SELECT nombre_usuario, avatar FROM usuarios WHERE id=$1', [req.usuario.id]);

    socketEmitter.emitirPropuestaIntercambio(Number(idReceptor), {
      tipo: 'rol',
      idSala: Number(idSala),
      idProponente: req.usuario.id,
      nombreProponente: userR.rows[0]?.nombre_usuario || 'Jugador',
      avatarProponente: userR.rows[0]?.avatar || null,
      rolProponente: proponenteR.rows[0].equipo,
      rolReceptor: receptorR.rows[0].equipo,
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Proponer intercambio de bando (solo sala llena) ───────────────────────
router.post('/:id/proponer-intercambio-bando', verificarToken, async (req, res) => {
  try {
    const idSala = req.params.id;
    const { idReceptor } = req.body;
    if (!idReceptor) return res.status(400).json({ error: 'idReceptor requerido' });

    const salaR = await db.query('SELECT id, nombre, estado, max_jugadores FROM salas WHERE id=$1', [idSala]);
    if (!salaR.rows.length) return res.status(404).json({ error: 'Sala no encontrada' });
    const sala = salaR.rows[0];

    const totalR = await db.query('SELECT COUNT(*) AS total FROM sala_jugadores WHERE id_sala=$1', [idSala]);
    const total = parseInt(totalR.rows[0].total, 10);
    const llena = total >= parseInt(sala.max_jugadores, 10);
    if (!llena) return res.status(400).json({ error: 'El intercambio de bando solo se permite con sala llena' });
    if (sala.estado !== 'esperando') return res.status(400).json({ error: 'Solo se puede intercambiar bando en estado esperando' });

    const proponenteR = await db.query(
      'SELECT banda FROM sala_jugadores WHERE id_sala=$1 AND id_usuario=$2',
      [idSala, req.usuario.id]
    );
    if (!proponenteR.rows.length) return res.status(400).json({ error: 'No estás en esta sala' });

    const receptorR = await db.query(
      'SELECT banda FROM sala_jugadores WHERE id_sala=$1 AND id_usuario=$2',
      [idSala, idReceptor]
    );
    if (!receptorR.rows.length) return res.status(400).json({ error: 'El otro jugador no está en esta sala' });
    if (receptorR.rows[0].banda === proponenteR.rows[0].banda) {
      return res.status(400).json({ error: 'El jugador debe estar en el bando opuesto' });
    }

    const userR = await db.query('SELECT nombre_usuario, avatar FROM usuarios WHERE id=$1', [req.usuario.id]);

    socketEmitter.emitirPropuestaIntercambio(Number(idReceptor), {
      tipo: 'bando',
      idSala: Number(idSala),
      idProponente: req.usuario.id,
      nombreProponente: userR.rows[0]?.nombre_usuario || 'Jugador',
      avatarProponente: userR.rows[0]?.avatar || null,
      bandoProponente: proponenteR.rows[0].banda,
      bandoReceptor: receptorR.rows[0].banda,
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Aceptar intercambio de bando ───────────────────────────────────────────
router.post('/:id/aceptar-intercambio-bando', verificarToken, async (req, res) => {
  try {
    const idSala = req.params.id;
    const { idProponente } = req.body;
    if (!idProponente) return res.status(400).json({ error: 'idProponente requerido' });

    const proponenteR = await db.query(
      'SELECT banda FROM sala_jugadores WHERE id_sala=$1 AND id_usuario=$2',
      [idSala, idProponente]
    );
    const receptorR = await db.query(
      'SELECT banda FROM sala_jugadores WHERE id_sala=$1 AND id_usuario=$2',
      [idSala, req.usuario.id]
    );
    if (!proponenteR.rows.length || !receptorR.rows.length) {
      return res.status(400).json({ error: 'Uno de los jugadores ya no está en la sala' });
    }

    const bandaProp = proponenteR.rows[0].banda;
    const bandaRec = receptorR.rows[0].banda;
    if (!bandaProp || !bandaRec) {
      return res.status(400).json({ error: 'Bandos inválidos para intercambio' });
    }
    if (bandaProp === bandaRec) {
      return res.status(400).json({ error: 'Ambos jugadores están en el mismo bando' });
    }

    await db.query('UPDATE sala_jugadores SET banda=$1 WHERE id_sala=$2 AND id_usuario=$3', [bandaRec, idSala, idProponente]);
    await db.query('UPDATE sala_jugadores SET banda=$1 WHERE id_sala=$2 AND id_usuario=$3', [bandaProp, idSala, req.usuario.id]);

    socketEmitter.emitirActualizacionSalaSimple(Number(idSala));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Aceptar intercambio de roles ──────────────────────────────
router.post('/:id/aceptar-intercambio', verificarToken, async (req, res) => {
  try {
    const idSala = req.params.id;
    const { idProponente } = req.body;
    if (!idProponente) return res.status(400).json({ error: 'idProponente requerido' });

    const proponenteR = await db.query(
      'SELECT equipo FROM sala_jugadores WHERE id_sala=$1 AND id_usuario=$2',
      [idSala, idProponente]
    );
    const receptorR = await db.query(
      'SELECT equipo FROM sala_jugadores WHERE id_sala=$1 AND id_usuario=$2',
      [idSala, req.usuario.id]
    );

    if (!proponenteR.rows.length || !receptorR.rows.length) {
      return res.status(400).json({ error: 'Uno de los jugadores ya no está en la sala' });
    }
    const rolProp = proponenteR.rows[0].equipo;
    const rolRec = receptorR.rows[0].equipo;
    if (!rolProp || !rolRec) {
      return res.status(400).json({ error: 'Uno de los jugadores no tiene rol asignado' });
    }

    // Intercambiar
    await db.query('UPDATE sala_jugadores SET equipo=$1 WHERE id_sala=$2 AND id_usuario=$3', [rolRec, idSala, idProponente]);
    await db.query('UPDATE sala_jugadores SET equipo=$1 WHERE id_sala=$2 AND id_usuario=$3', [rolProp, idSala, req.usuario.id]);

    // Notificar a todos en la sala
    socketEmitter.emitirActualizacionSalaSimple(Number(idSala));

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
