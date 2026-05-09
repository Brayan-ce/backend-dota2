const db = require('../../config/database');

class Apuesta {
  // Crear nueva apuesta
  static async crear(idUsuario, idPartida, tipoApuesta, monto, prediccion) {
    const query = `
      INSERT INTO apuestas (id_usuario, id_partida, tipo_apuesta, monto, prediccion, estado, creado_en)
      VALUES ($1, $2, $3, $4, $5, 'pendiente', NOW())
      RETURNING *
    `;
    
    try {
      const result = await db.query(query, [idUsuario, idPartida, tipoApuesta, monto, prediccion]);
      return result.rows[0];
    } catch (error) {
      console.error('Error al crear apuesta:', error);
      throw error;
    }
  }

  // Obtener apuestas de un usuario
  static async obtenerPorUsuario(idUsuario, limite = 10) {
    const query = `
      SELECT a.*, p.descripcion as descripcion_partida 
      FROM apuestas a
      LEFT JOIN partidas p ON a.id_partida = p.id
      WHERE a.id_usuario = $1
      ORDER BY a.creado_en DESC
      LIMIT $2
    `;
    
    try {
      const result = await db.query(query, [idUsuario, limite]);
      return result.rows;
    } catch (error) {
      console.error('Error al obtener apuestas del usuario:', error);
      throw error;
    }
  }

  // Obtener apuestas activas
  static async obtenerActivas() {
    const query = `
      SELECT a.*, u.nombre_usuario, p.descripcion as descripcion_partida
      FROM apuestas a
      JOIN usuarios u ON a.id_usuario = u.id
      LEFT JOIN partidas p ON a.id_partida = p.id
      WHERE a.estado = 'pendiente'
      ORDER BY a.creado_en DESC
    `;
    
    try {
      const result = await db.query(query);
      return result.rows;
    } catch (error) {
      console.error('Error al obtener apuestas activas:', error);
      throw error;
    }
  }

  // Actualizar estado de apuesta
  static async actualizarEstado(id, estado, ganancia = 0) {
    const query = `
      UPDATE apuestas 
      SET estado = $1, ganancia = $2, actualizado_en = NOW() 
      WHERE id = $3
      RETURNING *
    `;
    
    try {
      const result = await db.query(query, [estado, ganancia, id]);
      return result.rows[0];
    } catch (error) {
      console.error('Error al actualizar estado de apuesta:', error);
      throw error;
    }
  }

  // Liquidar apuestas de una partida
  static async liquidarApuestasPartida(idPartida, resultado) {
    const query = `
      UPDATE apuestas 
      SET estado = CASE 
        WHEN prediccion = $2 THEN 'ganada'
        ELSE 'perdida'
      END,
      ganancia = CASE 
        WHEN prediccion = $2 THEN monto * 2
        ELSE 0
      END,
      actualizado_en = NOW()
      WHERE id_partida = $1 AND estado = 'pendiente'
      RETURNING *
    `;
    
    try {
      const result = await db.query(query, [idPartida, resultado]);
      return result.rows;
    } catch (error) {
      console.error('Error al liquidar apuestas:', error);
      throw error;
    }
  }
}

module.exports = Apuesta;
