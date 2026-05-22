const db = require('../../config/database');

class Amigo {
  static async listar(idUsuario) {
    const q = `
      SELECT a.id, a.estado, a.creado_en,
        u.id AS amigo_id, u.nombre_usuario, u.avatar, u.mmr, u.saldo
      FROM amigos a
      JOIN usuarios u ON u.id = CASE WHEN a.id_usuario = $1::INTEGER THEN a.id_amigo ELSE a.id_usuario END
      WHERE (a.id_usuario = $1::INTEGER OR a.id_amigo = $1::INTEGER) 
        AND a.estado='aceptado'
        AND a.id_usuario != a.id_amigo
      ORDER BY u.nombre_usuario
    `;
    const r = await db.query(q, [idUsuario]);
    return r.rows;
  }

  static async solicitar(idUsuario, idAmigo) {
    const r = await db.query(
      'INSERT INTO amigos (id_usuario, id_amigo, estado) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING *',
      [idUsuario, idAmigo, 'pendiente']
    );
    return r.rows[0];
  }

  static async aceptar(idSolicitud, idUsuario) {
    const r = await db.query(
      'UPDATE amigos SET estado=$1 WHERE id=$2 AND id_amigo=$3 RETURNING *',
      ['aceptado', idSolicitud, idUsuario]
    );
    return r.rows[0];
  }

  static async rechazar(idSolicitud, idUsuario) {
    await db.query('DELETE FROM amigos WHERE id=$1 AND id_amigo=$2', [idSolicitud, idUsuario]);
  }

  static async eliminarAmistad(idUsuario, idAmigo) {
    const r = await db.query(
      'DELETE FROM amigos WHERE (id_usuario=$1 AND id_amigo=$2) OR (id_usuario=$2 AND id_amigo=$1) RETURNING *',
      [idUsuario, idAmigo]
    );
    return r.rows[0];
  }

  static async solicitudesPendientes(idUsuario) {
    const q = `
      SELECT a.id, a.creado_en,
        u.id AS solicitante_id, u.nombre_usuario, u.avatar
      FROM amigos a
      JOIN usuarios u ON u.id = a.id_usuario
      WHERE a.id_amigo=$1 AND a.estado='pendiente'
    `;
    const r = await db.query(q, [idUsuario]);
    return r.rows;
  }

  static async buscarPorSteamNombre(query) {
    const r = await db.query(
      'SELECT id, nombre_usuario, avatar, mmr FROM usuarios WHERE nombre_usuario ILIKE $1 LIMIT 10',
      [`%${query}%`]
    );
    return r.rows;
  }
}

module.exports = Amigo;
