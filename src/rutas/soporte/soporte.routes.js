const express = require('express');
const db = require('../../config/database');
const { verificarToken } = require('../../middleware/auth');

const router = express.Router();

// Obtener o crear chat de soporte del usuario
router.get('/mi-chat', verificarToken, async (req, res) => {
  try {
    const usuarioId = req.usuario.id;

    // Buscar chat activo del usuario
    let r = await db.query(
      `SELECT id, estado, creado_en, actualizado_en 
       FROM soporte_chats 
       WHERE usuario_id = $1 AND estado = 'activo'`,
      [usuarioId]
    );

    let chat = r.rows[0];

    // Si no hay chat activo, crear uno
    if (!chat) {
      r = await db.query(
        `INSERT INTO soporte_chats (tipo, usuario_id, estado) 
         VALUES ('usuario', $1, 'activo') RETURNING *`,
        [usuarioId]
      );
      chat = r.rows[0];

      // Mensaje de bienvenida
      await db.query(
        `INSERT INTO soporte_mensajes (chat_id, mensaje, es_admin, es_sistema, visto) 
         VALUES ($1, '¡Bienvenido al soporte! ¿En qué podemos ayudarte?', true, true, true)`,
        [chat.id]
      );
    }

    res.json({ chat });
  } catch (e) {
    console.error('Error obteniendo chat:', e);
    res.status(500).json({ error: e.message });
  }
});

// Obtener mensajes del chat del usuario (todos los chats combinados)
router.get('/mi-chat/mensajes', verificarToken, async (req, res) => {
  try {
    const usuarioId = req.usuario.id;
    const limit = parseInt(req.query.limit) || 30;
    const before = req.query.before;

    // Buscar todos los chats del usuario
    const chatsRes = await db.query(
      'SELECT id, estado FROM soporte_chats WHERE usuario_id = $1 ORDER BY creado_en ASC',
      [usuarioId]
    );

    if (chatsRes.rows.length === 0) {
      return res.json({ mensajes: [], resuelto: false });
    }

    const chatIds = chatsRes.rows.map(c => c.id);
    const ultimoChat = chatsRes.rows[chatsRes.rows.length - 1];
    const chatEstado = ultimoChat.estado;

    // Marcar mensajes como vistos en todos los chats
    await db.query(
      'UPDATE soporte_mensajes SET visto = true WHERE chat_id = ANY($1) AND es_admin = true',
      [chatIds]
    );

    let query;
    let params = [chatIds, limit];
    
    if (before) {
      query = `
        SELECT 
          m.id,
          m.mensaje,
          m.es_admin,
          m.es_sistema,
          m.creado_en as fecha,
          COALESCE(u.nombre_usuario, a.usuario, 'Sistema') as autor
        FROM soporte_mensajes m
        LEFT JOIN usuarios u ON m.usuario_id = u.id
        LEFT JOIN superadmin_usuarios a ON m.admin_id = a.id
        WHERE m.chat_id = ANY($1) AND m.id < $3
        ORDER BY m.creado_en DESC
        LIMIT $2
      `;
      params.push(parseInt(before));
    } else {
      query = `
        SELECT * FROM (
          SELECT 
            m.id,
            m.mensaje,
            m.es_admin,
            m.es_sistema,
            m.creado_en as fecha,
            COALESCE(u.nombre_usuario, a.usuario, 'Sistema') as autor
          FROM soporte_mensajes m
          LEFT JOIN usuarios u ON m.usuario_id = u.id
          LEFT JOIN superadmin_usuarios a ON m.admin_id = a.id
          WHERE m.chat_id = ANY($1)
          ORDER BY m.creado_en DESC
          LIMIT $2
        ) sub
        ORDER BY sub.fecha ASC
      `;
    }

    const mensajes = await db.query(query, params);
    
    const countRes = await db.query(
      'SELECT COUNT(*) as total FROM soporte_mensajes WHERE chat_id = ANY($1)',
      [chatIds]
    );

    res.json({ 
      mensajes: mensajes.rows,
      hasMore: mensajes.rows.length === limit,
      total: parseInt(countRes.rows[0].total),
      chatEstado: chatEstado,
      resuelto: chatEstado === 'resuelto'
    });
  } catch (e) {
    console.error('Error obteniendo mensajes:', e);
    res.status(500).json({ error: e.message });
  }
});

// Enviar mensaje
router.post('/mi-chat/mensajes', verificarToken, async (req, res) => {
  try {
    const usuarioId = req.usuario.id;
    const { mensaje } = req.body;

    if (!mensaje || !mensaje.trim()) {
      return res.status(400).json({ error: 'Mensaje requerido' });
    }

    // Buscar o crear chat
    let r = await db.query(
      'SELECT id FROM soporte_chats WHERE usuario_id = $1 AND estado = $2',
      [usuarioId, 'activo']
    );

    let chatId;
    if (r.rows.length === 0) {
      r = await db.query(
        `INSERT INTO soporte_chats (tipo, usuario_id, estado) 
         VALUES ('usuario', $1, 'activo') RETURNING id`,
        [usuarioId]
      );
      chatId = r.rows[0].id;
    } else {
      chatId = r.rows[0].id;
    }

    // Verificar si el chat estaba resuelto y reactivarlo
    const chatRes = await db.query('SELECT estado FROM soporte_chats WHERE id = $1', [chatId]);
    const estabaResuelto = chatRes.rows[0]?.estado === 'resuelto';
    
    if (estabaResuelto) {
      // Reactivar chat
      await db.query(
        "UPDATE soporte_chats SET estado = 'activo', actualizado_en = NOW() WHERE id = $1",
        [chatId]
      );
    }

    // Insertar mensaje
    await db.query(
      `INSERT INTO soporte_mensajes (chat_id, usuario_id, mensaje, es_admin, visto) 
       VALUES ($1, $2, $3, false, false)`,
      [chatId, usuarioId, mensaje.trim()]
    );

    // Si estaba resuelto, agregar mensaje de sistema de reactivación
    if (estabaResuelto) {
      await db.query(
        `INSERT INTO soporte_mensajes (chat_id, mensaje, es_admin, es_sistema, visto) 
         VALUES ($1, '🔄 Chat reactivado - nuevo mensaje del usuario', true, true, true)`,
        [chatId]
      );
    }

    // Actualizar chat
    await db.query(
      'UPDATE soporte_chats SET actualizado_en = NOW() WHERE id = $1',
      [chatId]
    );

    // Obtener mensajes actualizados
    const mensajes = await db.query(`
      SELECT 
        m.id,
        m.mensaje,
        m.es_admin,
        m.es_sistema,
        m.creado_en as fecha,
        COALESCE(u.nombre_usuario, a.usuario, 'Sistema') as autor
      FROM soporte_mensajes m
      LEFT JOIN usuarios u ON m.usuario_id = u.id
      LEFT JOIN superadmin_usuarios a ON m.admin_id = a.id
      WHERE m.chat_id = $1
      ORDER BY m.creado_en ASC
    `, [chatId]);

    res.json({ mensajes: mensajes.rows });
  } catch (e) {
    console.error('Error enviando mensaje:', e);
    res.status(500).json({ error: e.message });
  }
});

// Cerrar chat (resolver)
router.post('/mi-chat/cerrar', verificarToken, async (req, res) => {
  try {
    const usuarioId = req.usuario.id;

    await db.query(
      `UPDATE soporte_chats 
       SET estado = 'resuelto', actualizado_en = NOW() 
       WHERE usuario_id = $1 AND estado = 'activo'`,
      [usuarioId]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error('Error cerrando chat:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
