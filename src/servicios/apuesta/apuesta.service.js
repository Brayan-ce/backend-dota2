const Apuesta = require('../../modelos/apuesta/apuesta.model');
const Usuario = require('../../modelos/usuario/usuario.model');
const Partida = require('../../modelos/partida/partida.model');
const redis = require('../../config/redis');
const db = require('../../config/database');

class ApuestaService {
  async obtenerApuestasActivasUsuario(idUsuario) {
    const q = `
      SELECT
        a.id,
        a.tipo_apuesta,
        a.monto,
        a.prediccion,
        a.estado,
        a.creado_en,
        CASE
          WHEN split_part(a.prediccion, ':', 1) = 'sala'
            AND split_part(a.prediccion, ':', 2) ~ '^[0-9]+$'
          THEN split_part(a.prediccion, ':', 2)::int
          ELSE NULL
        END AS id_sala,
        s.nombre AS sala_nombre,
        s.estado AS sala_estado,
        s.entrada AS sala_entrada,
        s.premio AS sala_premio,
        CASE
          WHEN split_part(a.prediccion, ':', 3) = 'radiant' THEN 'Radiant'
          WHEN split_part(a.prediccion, ':', 3) = 'dire' THEN 'Dire'
          WHEN split_part(a.prediccion, ':', 3) = 'jugador' THEN COALESCE(u.nombre_usuario, 'Jugador')
          ELSE 'Sin selección'
        END AS seleccion
      FROM apuestas a
      LEFT JOIN salas s
        ON s.id = CASE
          WHEN split_part(a.prediccion, ':', 1) = 'sala'
            AND split_part(a.prediccion, ':', 2) ~ '^[0-9]+$'
          THEN split_part(a.prediccion, ':', 2)::int
          ELSE NULL
        END
      LEFT JOIN usuarios u
        ON u.id = CASE
          WHEN split_part(a.prediccion, ':', 3) = 'jugador'
            AND split_part(a.prediccion, ':', 4) ~ '^[0-9]+$'
          THEN split_part(a.prediccion, ':', 4)::int
          ELSE NULL
        END
      WHERE a.id_usuario = $1
        AND a.estado = 'pendiente'
      ORDER BY a.creado_en DESC
    `;

    const r = await db.query(q, [idUsuario]);
    return r.rows;
  }

  async cancelarApuestaSala(idUsuario, idApuesta) {
    let client;
    try {
      client = await db.pool.connect();
      await client.query('BEGIN');

      const apuestaR = await client.query(
        `SELECT
           id,
           monto,
           estado,
           prediccion
         FROM apuestas
         WHERE id = $1
           AND id_usuario = $2
         FOR UPDATE`,
        [idApuesta, idUsuario]
      );

      if (apuestaR.rows.length === 0) {
        throw new Error('No se encontró la apuesta');
      }

      const apuesta = apuestaR.rows[0];
      if (apuesta.estado !== 'pendiente') {
        throw new Error('Solo puedes cancelar apuestas pendientes');
      }

      const pred = String(apuesta.prediccion || '');
      const m = pred.match(/^sala:(\d+):/);
      const idSala = m ? parseInt(m[1]) : null;
      if (!idSala) {
        throw new Error('Esta apuesta no está asociada a una sala cancelable');
      }

      const salaR = await client.query(
        `SELECT id, nombre, estado
         FROM salas
         WHERE id = $1
         FOR UPDATE`,
        [idSala]
      );

      if (salaR.rows.length === 0) {
        throw new Error('La sala ya no existe');
      }

      const sala = salaR.rows[0];
      if (sala.estado !== 'esperando') {
        throw new Error('La partida ya inició, no se puede cancelar esta apuesta');
      }

      await client.query(
        `UPDATE apuestas
         SET estado = 'cancelada', actualizado_en = NOW()
         WHERE id = $1`,
        [idApuesta]
      );

      const saldoR = await client.query(
        `UPDATE usuarios
         SET saldo = saldo + $2
         WHERE id = $1
         RETURNING saldo`,
        [idUsuario, apuesta.monto]
      );

      await client.query(
        `INSERT INTO transacciones (id_usuario, tipo, monto, descripcion, creado_en)
         VALUES ($1, 'devolucion', $2, $3, NOW())`,
        [idUsuario, apuesta.monto, `Cancelación de apuesta en sala #${idSala} (${sala.nombre || 'SALA'})`]
      );

      await client.query('COMMIT');

      return {
        apuesta: { ...apuesta, id_sala: idSala, sala_nombre: sala.nombre, sala_estado: sala.estado, estado: 'cancelada' },
        nuevoSaldo: parseFloat(saldoR.rows[0]?.saldo || 0),
      };
    } catch (error) {
      if (client) {
        try { await client.query('ROLLBACK'); } catch (_) {}
      }
      throw error;
    } finally {
      if (client) client.release();
    }
  }

  // Crear nueva apuesta
  async crearApuesta(idUsuario, idPartida, tipoApuesta, monto, prediccion) {
    try {
      // Validar que el usuario tenga saldo suficiente
      const usuarioResult = await db.query('SELECT * FROM usuarios WHERE id = $1', [idUsuario]);
      const usuario = usuarioResult.rows[0];
      if (!usuario) {
        throw new Error('Usuario no encontrado');
      }

      if (usuario.saldo < monto) {
        throw new Error('Saldo insuficiente');
      }

      // Crear la apuesta
      const apuesta = await Apuesta.crear(idUsuario, idPartida, tipoApuesta, monto, prediccion);

      // Descontar el saldo del usuario
      const nuevoSaldo = usuario.saldo - monto;
      await Usuario.actualizarSaldo(usuario.id, nuevoSaldo);

      // Guardar en Redis para actualizaciones en tiempo real
      await redis.setex(`apuesta:${apuesta.id}`, 3600, JSON.stringify(apuesta));

      return apuesta;
    } catch (error) {
      console.error('Error al crear apuesta:', error);
      throw error;
    }
  }

  // Obtener apuestas activas para mostrar en tiempo real
  async obtenerApuestasActivas() {
    try {
      // Primero intentar obtener de Redis
      const cacheKey = 'apuestas:activas';
      const cached = await redis.get(cacheKey);
      
      if (cached) {
        return JSON.parse(cached);
      }

      // Si no está en caché, obtener de la base de datos
      const apuestas = await Apuesta.obtenerActivas();
      
      // Guardar en caché por 30 segundos
      await redis.setex(cacheKey, 30, JSON.stringify(apuestas));

      return apuestas;
    } catch (error) {
      console.error('Error al obtener apuestas activas:', error);
      throw error;
    }
  }

  // Liquidar apuestas cuando una partida termina
  async liquidarApuestasPartida(idPartida, resultado) {
    try {
      const apuestas = await Apuesta.liquidarApuestasPartida(idPartida, resultado);
      
      // Actualizar saldos de los ganadores
      for (const apuesta of apuestas) {
        if (apuesta.estado === 'ganada') {
          const usuarioResult = await db.query('SELECT * FROM usuarios WHERE id = $1', [apuesta.id_usuario]);
          const usuario = usuarioResult.rows[0];
          if (!usuario) continue;
          const nuevoSaldo = usuario.saldo + apuesta.ganancia;
          await Usuario.actualizarSaldo(usuario.id, nuevoSaldo);
        }
      }

      // Limpiar caché
      await redis.del('apuestas:activas');

      // Emitir evento para WebSocket
      await redis.publish('apuestas:actualizadas', JSON.stringify({
        tipo: 'liquidacion',
        idPartida,
        resultado,
        apuestas
      }));

      return apuestas;
    } catch (error) {
      console.error('Error al liquidar apuestas:', error);
      throw error;
    }
  }

  // Obtener historial de apuestas de un usuario
  async obtenerHistorialUsuario(idUsuario, limite = 10) {
    try {
      return await Apuesta.obtenerPorUsuario(idUsuario, limite);
    } catch (error) {
      console.error('Error al obtener historial de apuestas:', error);
      throw error;
    }
  }

  // Obtener estadísticas de apuestas
  async obtenerEstadisticasUsuario(idUsuario) {
    try {
      const query = `
        SELECT 
          COUNT(*) as total_apuestas,
          COUNT(CASE WHEN estado = 'ganada' THEN 1 END) as apuestas_ganadas,
          COUNT(CASE WHEN estado = 'perdida' THEN 1 END) as apuestas_perdidas,
          SUM(CASE WHEN estado = 'ganada' THEN ganancia ELSE 0 END) as total_ganado,
          SUM(monto) as total_apostado
        FROM apuestas 
        WHERE id_usuario = $1
      `;

      const result = await db.query(query, [idUsuario]);
      return result.rows[0];
    } catch (error) {
      console.error('Error al obtener estadísticas:', error);
      throw error;
    }
  }

  // Crear apuesta sobre una sala (Radiant, Dire o Jugador)
  async crearApuestaSala(idUsuario, idSala, lado, monto, idJugador = null) {
    let client;
    try {
      client = await db.pool.connect();
      await client.query('BEGIN');

      const salaR = await client.query(
        `SELECT id, nombre, estado FROM salas WHERE id = $1 AND estado IN ('esperando', 'jugando')`,
        [idSala]
      );
      if (salaR.rows.length === 0) {
        throw new Error('La sala no existe o ya no está activa');
      }
      const sala = salaR.rows[0];

      if (!['radiant', 'dire', 'jugador'].includes(lado)) {
        throw new Error('Lado inválido para apostar');
      }

      if (lado === 'jugador') {
        if (!idJugador) throw new Error('Debes indicar el jugador para esta apuesta');
        const jugadorR = await client.query(
          'SELECT id_usuario FROM sala_jugadores WHERE id_sala = $1 AND id_usuario = $2',
          [idSala, idJugador]
        );
        if (jugadorR.rows.length === 0) {
          throw new Error('El jugador elegido no pertenece a la sala');
        }
      }

      const montoNum = parseFloat(monto);
      if (!montoNum || montoNum <= 0) {
        throw new Error('El monto debe ser mayor a 0');
      }

      const saldoR = await client.query(
        `UPDATE usuarios
         SET bono  = CASE WHEN bono  >= $2 THEN bono  - $2 ELSE 0 END,
             saldo = CASE WHEN bono  >= $2 THEN saldo ELSE saldo - ($2 - bono) END
         WHERE id = $1 AND (saldo + bono) >= $2
         RETURNING saldo, bono`,
        [idUsuario, montoNum]
      );
      if (saldoR.rows.length === 0) {
        throw new Error(`Saldo insuficiente. Necesitas S/ ${montoNum.toFixed(2)}`);
      }

      const tipoApuesta = lado === 'jugador' ? 'sala_jugador' : 'sala_bando';
      const prediccion = lado === 'jugador'
        ? `sala:${idSala}:jugador:${idJugador}`
        : `sala:${idSala}:${lado}`;

      const apuesta = await Apuesta.crear(idUsuario, null, tipoApuesta, montoNum, prediccion);

      await client.query(
        `INSERT INTO transacciones (id_usuario, tipo, monto, descripcion, creado_en)
         VALUES ($1, 'apuesta', $2, $3, NOW())`,
        [idUsuario, montoNum, `Apuesta ${lado} en sala #${idSala} (${sala.nombre})`]
      );

      await client.query('COMMIT');

      return {
        apuesta,
        nuevoSaldo: parseFloat(saldoR.rows[0].saldo),
      };
    } catch (error) {
      if (client) {
        try { await client.query('ROLLBACK'); } catch (_) {}
      }
      throw error;
    } finally {
      if (client) client.release();
    }
  }

  // Resumen de votos por sala para mostrar Radiant/Dire en frontend
  async obtenerVotosPorSalas(idsSala = []) {
    const ids = Array.isArray(idsSala)
      ? idsSala.map((id) => parseInt(id)).filter((id) => Number.isInteger(id) && id > 0)
      : [];

    if (ids.length === 0) return {};

    const q = `
      WITH base AS (
        SELECT
          split_part(prediccion, ':', 2)::int AS id_sala,
          CASE
            WHEN split_part(prediccion, ':', 3) = 'radiant' THEN 'radiant'
            WHEN split_part(prediccion, ':', 3) = 'dire' THEN 'dire'
            WHEN split_part(prediccion, ':', 3) = 'jugador' THEN 'jugador'
            ELSE 'otro'
          END AS lado,
          id_usuario,
          monto
        FROM apuestas
        WHERE estado = 'pendiente'
          AND prediccion LIKE 'sala:%'
          AND split_part(prediccion, ':', 2) ~ '^[0-9]+$'
          AND split_part(prediccion, ':', 2)::int = ANY($1::int[])
      )
      SELECT
        id_sala,
        COUNT(*) FILTER (WHERE lado = 'radiant') AS radiant_votos,
        COUNT(*) FILTER (WHERE lado = 'dire') AS dire_votos,
        COALESCE(SUM(monto) FILTER (WHERE lado = 'radiant'), 0) AS radiant_monto,
        COALESCE(SUM(monto) FILTER (WHERE lado = 'dire'), 0) AS dire_monto,
        COUNT(*) FILTER (WHERE lado = 'jugador') AS jugador_votos
      FROM base
      GROUP BY id_sala
    `;

    const r = await db.query(q, [ids]);
    const votos = {};

    for (const row of r.rows) {
      votos[row.id_sala] = {
        radiantVotos: parseInt(row.radiant_votos || 0),
        direVotos: parseInt(row.dire_votos || 0),
        jugadorVotos: parseInt(row.jugador_votos || 0),
        radiantMonto: parseFloat(row.radiant_monto || 0),
        direMonto: parseFloat(row.dire_monto || 0),
      };
    }

    return votos;
  }
}

module.exports = new ApuestaService();
