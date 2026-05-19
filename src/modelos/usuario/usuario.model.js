const db = require('../../config/database');

class Usuario {
  // Guardar código de verificación
  static async guardarCodigo(steamId, codigo) {
    console.log(`💾 Guardando código para steamId: ${steamId}, código: ${codigo}`);
    await db.query('DELETE FROM codigos_verificacion WHERE steam_id = $1', [steamId]);
    const expira = new Date(Date.now() + 10 * 60 * 1000);
    await db.query(
      'INSERT INTO codigos_verificacion (steam_id, codigo, expira_en) VALUES ($1, $2, $3)',
      [steamId, codigo, expira]
    );
    console.log(`✅ Código guardado exitosamente, expira a las: ${expira.toISOString()}`);
  }

  // Verificar código
  static async verificarCodigo(steamId, codigo) {
    console.log(`🔍 Buscando código para steamId: ${steamId}, código: ${codigo}`);
    const result = await db.query(
      'SELECT * FROM codigos_verificacion WHERE steam_id = $1 AND codigo = $2 AND usado = FALSE AND expira_en > NOW()',
      [steamId, codigo]
    );
    console.log(`📊 Resultado de búsqueda: ${result.rows.length} fila(s) encontrada(s)`);
    if (result.rows.length === 0) {
      console.log(`❌ Código no válido: steam_id=${steamId}, código=${codigo}`);
      return false;
    }
    console.log(`✅ Código válido encontrado, marcando como usado...`);
    await db.query('UPDATE codigos_verificacion SET usado = TRUE WHERE id = $1', [result.rows[0].id]);
    return true;
  }

  // Actualizar email del usuario
  static async actualizarEmail(steamId, email) {
    const result = await db.query(
      'UPDATE usuarios SET email = $1 WHERE steam_id = $2 RETURNING *',
      [email, steamId]
    );
    return result.rows[0];
  }

  // Registrar usuario completo con datos del formulario
  static async registrar({ steamId, nombreUsuario, avatar, mmr, email, telefono, nombreReal, pais }) {
    const query = `
      INSERT INTO usuarios (steam_id, nombre_usuario, avatar, mmr, saldo, bono, email, telefono, nombre_real, pais, creado_en)
      VALUES ($1, $2, $3, $4, 0.00, 10.00, $5, $6, $7, $8, NOW())
      RETURNING *
    `;
    const result = await db.query(query, [steamId, nombreUsuario, avatar, mmr ?? null, email, telefono || null, nombreReal || null, pais || null]);
    return result.rows[0];
  }

  // Crear nuevo usuario
  static async crear(steamId, nombreUsuario, avatar, mmr = null) {
    const query = `
      INSERT INTO usuarios (steam_id, nombre_usuario, avatar, mmr, saldo, bono, creado_en)
      VALUES ($1, $2, $3, $4, 0.00, 10.00, NOW())
      RETURNING *
    `;
    
    try {
      const result = await db.query(query, [steamId, nombreUsuario, avatar, mmr ?? null]);
      return result.rows[0];
    } catch (error) {
      console.error('Error al crear usuario:', error);
      throw error;
    }
  }

  // Buscar usuario por Steam ID
  static async buscarPorSteamId(steamId) {
    const query = 'SELECT * FROM usuarios WHERE steam_id = $1';
    
    try {
      const result = await db.query(query, [steamId]);
      return result.rows[0];
    } catch (error) {
      console.error('Error al buscar usuario por Steam ID:', error);
      throw error;
    }
  }

  // Actualizar datos de Steam del usuario
  static async actualizarDatosSteam(id, nombreUsuario, avatar, mmr) {
    const query = `
        UPDATE usuarios 
        SET nombre_usuario = $1, avatar = $2, mmr = COALESCE($3, mmr), actualizado_en = NOW(), 
          steam_actualizado_en = NOW() 
      WHERE id = $4
      RETURNING *
    `;
    
    try {
      const result = await db.query(query, [nombreUsuario, avatar, mmr, id]);
      console.log('Usuario actualizado en BD:', result.rows[0]);
      return result.rows[0];
    } catch (error) {
      console.error('Error al actualizar datos de Steam:', error);
      throw error;
    }
  }

  // Verificar si necesita actualizar datos de Steam (cada 1 hora o si hay cambios)
  static async necesitaActualizarSteam(steamId) {
    const query = `
      SELECT steam_actualizado_en 
      FROM usuarios 
      WHERE steam_id = $1
    `;
    
    try {
      const result = await db.query(query, [steamId]);
      if (result.rows.length === 0) return true;
      
      const ultimaActualizacion = result.rows[0].steam_actualizado_en;
      if (!ultimaActualizacion) return true;
      
      // Actualizar si ha pasado más de 1 hora
      const unaHoraAtras = new Date(Date.now() - 60 * 60 * 1000);
      return new Date(ultimaActualizacion) < unaHoraAtras;
    } catch (error) {
      console.error('Error al verificar si necesita actualizar:', error);
      return true; // Si hay error, actualizar por seguridad
    }
  }

  // Actualizar saldo del usuario
  static async actualizarSaldo(id, nuevoSaldo) {
    const query = `
      UPDATE usuarios 
      SET saldo = $1, actualizado_en = NOW() 
      WHERE id = $2
      RETURNING *
    `;
    
    try {
      const result = await db.query(query, [nuevoSaldo, id]);
      return result.rows[0];
    } catch (error) {
      console.error('Error al actualizar saldo:', error);
      throw error;
    }
  }

  // Obtener todos los usuarios
  static async obtenerTodos() {
    const query = 'SELECT * FROM usuarios ORDER BY creado_en DESC';
    
    try {
      const result = await db.query(query);
      return result.rows;
    } catch (error) {
      console.error('Error al obtener usuarios:', error);
      throw error;
    }
  }

  // Buscar usuario por ID
  static async buscarPorId(id) {
    const result = await db.query('SELECT * FROM usuarios WHERE id = $1', [id]);
    return result.rows[0];
  }

  // Registrar usuario simple (email + password, sin Steam)
  static async registrarSimple({ email, passwordHash, nickname, mmr }) {
    const query = `
      INSERT INTO usuarios (nombre_usuario, email, password_hash, mmr, saldo, bono, creado_en)
      VALUES ($1, $2, $3, $4, 0.00, 10.00, NOW())
      RETURNING *
    `;
    const result = await db.query(query, [
      nickname.trim(),
      email.toLowerCase().trim(),
      passwordHash,
      mmr ?? null
    ]);
    return result.rows[0];
  }

  // Actualizar MMR del usuario
  static async actualizarMMR(id, nuevoMMR) {
    const query = `
      UPDATE usuarios 
      SET mmr = $1, actualizado_en = NOW() 
      WHERE id = $2
      RETURNING *
    `;
    
    try {
      const result = await db.query(query, [nuevoMMR, id]);
      return result.rows[0];
    } catch (error) {
      console.error('Error al actualizar MMR:', error);
      throw error;
    }
  }
}

module.exports = Usuario;
