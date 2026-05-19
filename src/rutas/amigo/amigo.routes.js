const express = require('express');
const router = express.Router();
const Amigo = require('../../modelos/amigo/amigo.model');
const { verificarToken } = require('../../middleware/auth');
const db = require('../../config/database');
const socketEmitter = require('../../utils/socketEmitter');

router.get('/', verificarToken, async (req, res) => {
  try {
    const amigos = await Amigo.listar(req.usuario.id);
    const solicitudes = await Amigo.solicitudesPendientes(req.usuario.id);
    res.json({ amigos, solicitudes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/buscar', verificarToken, async (req, res) => {
  try {
    const usuarios = await Amigo.buscarPorSteamNombre(req.query.q || '');
    // Excluir al propio usuario de los resultados
    const filtrados = usuarios.filter(u => u.id !== req.usuario.id);
    res.json({ usuarios: filtrados });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Buscar usuario por ID interno, Steam ID, nombre o email
router.get('/buscar-id/:q', verificarToken, async (req, res) => {
  try {
    const q = req.params.q.trim();
    if (!q) return res.status(400).json({ error: 'Parámetro vacío' });

    let usuario = null;

    // Steam ID: número de 17 dígitos que empieza con 7656119
    if (/^\d{17}$/.test(q) && q.startsWith('7656119')) {
      const r = await db.query('SELECT id, nombre_usuario, avatar, mmr, steam_id FROM usuarios WHERE steam_id=$1', [q]);
      usuario = r.rows[0] || null;
    }
    // ID interno: número pequeño
    else if (/^\d+$/.test(q) && parseInt(q) <= 2147483647) {
      const r = await db.query('SELECT id, nombre_usuario, avatar, mmr, steam_id FROM usuarios WHERE id=$1', [parseInt(q)]);
      usuario = r.rows[0] || null;
    }

    // Si no se encontró por número, buscar por nombre o email
    if (!usuario) {
      const r = await db.query(
        'SELECT id, nombre_usuario, avatar, mmr, steam_id FROM usuarios WHERE nombre_usuario ILIKE $1 OR email ILIKE $1 LIMIT 1',
        [q]
      );
      usuario = r.rows[0] || null;
    }

    if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (usuario.id === req.usuario.id) return res.status(400).json({ error: 'No puedes agregarte a ti mismo' });

    res.json({ usuario });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/solicitar/:idAmigo', verificarToken, async (req, res) => {
  try {
    const idAmigo = parseInt(req.params.idAmigo);
    if (idAmigo === req.usuario.id) return res.status(400).json({ error: 'No puedes agregarte a ti mismo' });
    // Verificar si ya existe relación
    const existe = await db.query(
      'SELECT id FROM amigos WHERE (id_usuario=$1 AND id_amigo=$2) OR (id_usuario=$2 AND id_amigo=$1)',
      [req.usuario.id, idAmigo]
    );
    if (existe.rows.length > 0) return res.status(400).json({ error: 'Ya existe una solicitud o ya son amigos' });
    const r = await Amigo.solicitar(req.usuario.id, idAmigo);
    if (!r) return res.status(400).json({ error: 'No se pudo enviar la solicitud' });
    // Obtener datos del solicitante para notificar en tiempo real
    const solicitante = await db.query('SELECT id, nombre_usuario, avatar FROM usuarios WHERE id=$1', [req.usuario.id]);
    socketEmitter.emitirSolicitudAmigo(idAmigo, {
      id: r.id,
      solicitante_id: req.usuario.id,
      nombre_usuario: solicitante.rows[0].nombre_usuario,
      avatar: solicitante.rows[0].avatar,
      creado_en: r.creado_en,
    });
    res.json({ solicitud: r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/aceptar/:idSolicitud', verificarToken, async (req, res) => {
  try {
    const r = await Amigo.aceptar(parseInt(req.params.idSolicitud), req.usuario.id);
    if (!r) return res.status(404).json({ error: 'Solicitud no encontrada' });
    // Notificar al solicitante original que fue aceptado
    const yo = await db.query('SELECT id, nombre_usuario, avatar FROM usuarios WHERE id=$1', [req.usuario.id]);
    socketEmitter.emitirSolicitudAceptada(r.id_usuario, {
      amigo_id: req.usuario.id,
      nombre_usuario: yo.rows[0].nombre_usuario,
      avatar: yo.rows[0].avatar,
    });
    res.json({ amigo: r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/rechazar/:idSolicitud', verificarToken, async (req, res) => {
  try {
    await Amigo.rechazar(parseInt(req.params.idSolicitud), req.usuario.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Estado de relación con un usuario
router.get('/estado/:idUsuario', verificarToken, async (req, res) => {
  try {
    const idUsuario = parseInt(req.params.idUsuario);
    if (idUsuario === req.usuario.id) return res.json({ estado: 'mismo_usuario' });
    const r = await db.query(
      'SELECT id, estado, id_usuario FROM amigos WHERE (id_usuario=$1 AND id_amigo=$2) OR (id_usuario=$2 AND id_amigo=$1)',
      [req.usuario.id, idUsuario]
    );
    if (r.rows.length === 0) return res.json({ estado: 'ninguno' });
    const row = r.rows[0];
    if (row.estado === 'aceptado') return res.json({ estado: 'amigos', id: row.id });
    if (row.estado === 'pendiente' && row.id_usuario === req.usuario.id) return res.json({ estado: 'solicitud_enviada', id: row.id });
    if (row.estado === 'pendiente') return res.json({ estado: 'solicitud_recibida', id: row.id });
    res.json({ estado: 'ninguno' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Eliminar amistad (dejar de ser amigos)
router.delete('/eliminar/:idAmigo', verificarToken, async (req, res) => {
  try {
    const idAmigo = parseInt(req.params.idAmigo);
    const r = await Amigo.eliminarAmistad(req.usuario.id, idAmigo);
    if (!r) return res.status(404).json({ error: 'Amistad no encontrada' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
