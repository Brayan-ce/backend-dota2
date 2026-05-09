const db = require('../../config/database');

class Partida {
  // Crear nueva partida
  static async crear(matchId, descripcion, estado = 'pendiente') {
    const query = `
      INSERT INTO partidas (match_id, descripcion, estado, creado_en)
      VALUES ($1, $2, $3, NOW())
      RETURNING *
    `;
    
    try {
      const result = await db.query(query, [matchId, descripcion, estado]);
      return result.rows[0];
    } catch (error) {
      console.error('Error al crear partida:', error);
      throw error;
    }
  }

  // Obtener partida por Match ID de Steam
  static async buscarPorMatchId(matchId) {
    const query = 'SELECT * FROM partidas WHERE match_id = $1';
    
    try {
      const result = await db.query(query, [matchId]);
      return result.rows[0];
    } catch (error) {
      console.error('Error al buscar partida por Match ID:', error);
      throw error;
    }
  }

  // Obtener partidas activas
  static async obtenerActivas() {
    const query = `
      SELECT * FROM partidas 
      WHERE estado IN ('pendiente', 'en_curso')
      ORDER BY creado_en DESC
    `;
    
    try {
      const result = await db.query(query);
      return result.rows;
    } catch (error) {
      console.error('Error al obtener partidas activas:', error);
      throw error;
    }
  }

  // Actualizar estado de partida
  static async actualizarEstado(id, estado, resultado = null) {
    const query = `
      UPDATE partidas 
      SET estado = $1, resultado = $2, actualizado_en = NOW() 
      WHERE id = $3
      RETURNING *
    `;
    
    try {
      const result = await db.query(query, [estado, resultado, id]);
      return result.rows[0];
    } catch (error) {
      console.error('Error al actualizar estado de partida:', error);
      throw error;
    }
  }

  // Actualizar datos de la partida en tiempo real
  static async actualizarDatosEnVivo(id, datos) {
    const query = `
      UPDATE partidas 
      SET datos_en_vivo = $1, actualizado_en = NOW() 
      WHERE id = $2
      RETURNING *
    `;
    
    try {
      const result = await db.query(query, [JSON.stringify(datos), id]);
      return result.rows[0];
    } catch (error) {
      console.error('Error al actualizar datos en vivo:', error);
      throw error;
    }
  }

  // Obtener historial de partidas
  static async obtenerHistorial(limite = 20) {
    const query = `
      SELECT * FROM partidas 
      WHERE estado = 'finalizada'
      ORDER BY actualizado_en DESC
      LIMIT $1
    `;
    
    try {
      const result = await db.query(query, [limite]);
      return result.rows;
    } catch (error) {
      console.error('Error al obtener historial de partidas:', error);
      throw error;
    }
  }
}

module.exports = Partida;
