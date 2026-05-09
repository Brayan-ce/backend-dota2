const db = require('../../config/database');

class Sala {
  static async listar() {
    const q = `
      SELECT s.*, u.nombre_usuario AS creador_nombre, u.avatar AS creador_avatar,
        COUNT(sj.id) AS jugadores_count,
        COALESCE(json_agg(
          json_build_object('id', uj.id, 'avatar', uj.avatar, 'nombre', uj.nombre_usuario, 'banda', sj.banda, 'mmr', COALESCE(uj.mmr, 0))
          ORDER BY sj.unido_en
        ) FILTER (WHERE uj.id IS NOT NULL), '[]') AS jugadores_info
      FROM salas s
      LEFT JOIN usuarios u ON u.id = s.id_creador
      LEFT JOIN sala_jugadores sj ON sj.id_sala = s.id
      LEFT JOIN usuarios uj ON uj.id = sj.id_usuario
      WHERE s.estado IN ('esperando','jugando')
      GROUP BY s.id, u.nombre_usuario, u.avatar
      ORDER BY s.creada_en DESC
    `;
    const r = await db.query(q);
    return r.rows;
  }

  static async crear({ nombre, idCreador, tipo, modo, limiteMmrMin, limiteMmrMax, entrada, premio, esAutomatico, maxJugadores, fechaInicio }) {
    const q = `
      INSERT INTO salas (nombre, id_creador, tipo, modo, limite_mmr_min, limite_mmr_max, entrada, premio, es_automatico, max_jugadores, jugadores_actuales, estado, fecha_inicio, creada_en, actualizada_en)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,'esperando',$11,NOW(),NOW())
      RETURNING *
    `;
    const r = await db.query(q, [nombre, idCreador, tipo||'normal', modo||'All Pick', limiteMmrMin||0, limiteMmrMax||99999, entrada||0, premio||0, esAutomatico||false, maxJugadores||10, fechaInicio||null]);
    return r.rows[0];
  }

  static async eliminar(idSala, idUsuario) {
    const sala = await this.buscarPorId(idSala);
    if (!sala) throw new Error('Sala no encontrada');
    if (sala.id_creador !== idUsuario) throw new Error('Solo el creador puede eliminar la sala');
    if (sala.estado === 'jugando') throw new Error('No se puede eliminar una sala en curso');
    const mitad = Math.ceil(parseInt(sala.max_jugadores) / 2);
    if (parseInt(sala.jugadores_actuales) >= mitad) throw new Error(`No puedes eliminar la sala: ya tiene ${sala.jugadores_actuales} jugadores (mínimo ${mitad} para bloquear)`);
    await db.query('DELETE FROM sala_jugadores WHERE id_sala=$1', [idSala]);
    await db.query('DELETE FROM salas WHERE id=$1', [idSala]);
    return sala;
  }

  static async avisarAdmin(idSala, idUsuario) {
    const sala = await this.buscarPorId(idSala);
    if (!sala) throw new Error('Sala no encontrada');
    const r = await db.query(
      'UPDATE salas SET aviso_admin=TRUE, actualizada_en=NOW() WHERE id=$1 RETURNING *',
      [idSala]
    );
    return r.rows[0];
  }

  static async entrar(idSala, idUsuario, banda) {
    await db.query(
      'INSERT INTO sala_jugadores (id_sala, id_usuario, banda) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [idSala, idUsuario, banda || 'radiant']
    );
    const r = await db.query(
      'UPDATE salas SET jugadores_actuales = (SELECT COUNT(*) FROM sala_jugadores WHERE id_sala=$1), actualizada_en=NOW() WHERE id=$1 RETURNING *',
      [idSala]
    );
    return r.rows[0];
  }

  static async salir(idSala, idUsuario) {
    await db.query('DELETE FROM sala_jugadores WHERE id_sala=$1 AND id_usuario=$2', [idSala, idUsuario]);
    const r = await db.query(
      'UPDATE salas SET jugadores_actuales=(SELECT COUNT(*) FROM sala_jugadores WHERE id_sala=$1), actualizada_en=NOW() WHERE id=$1 RETURNING *',
      [idSala]
    );
    return r.rows[0];
  }

  static async buscarPorId(id) {
    const r = await db.query('SELECT * FROM salas WHERE id=$1', [id]);
    return r.rows[0];
  }

  static async contarActivas() {
    const r = await db.query("SELECT COUNT(*) FROM salas WHERE estado IN ('esperando','jugando')");
    return parseInt(r.rows[0].count);
  }

  static async contarTerminadas() {
    const r = await db.query("SELECT COUNT(*) FROM salas WHERE estado='terminada'");
    return parseInt(r.rows[0].count);
  }
}

module.exports = Sala;
