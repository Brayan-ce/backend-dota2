const { Server } = require('socket.io');
const redis = require('../config/redis');
const db = require('../config/database');
const socketEmitter = require('../utils/socketEmitter');

function getAllowedOrigins() {
  const raw = process.env.FRONTEND_URLS || process.env.FRONTEND_URL || 'http://localhost:3000';
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

class SocketHandler {
  constructor(server) {
    const allowedOrigins = getAllowedOrigins();
    this.io = new Server(server, {
      cors: {
        origin: (origin, callback) => {
          if (!origin) return callback(null, true);
          if (allowedOrigins.includes(origin)) return callback(null, true);
          return callback(new Error(`Origen no permitido por Socket CORS: ${origin}`));
        },
        methods: ["GET", "POST"],
        credentials: true
      }
    });

    this.usuariosConectados = new Map(); // socketId -> { id, nombre, avatar, nivel }
    socketEmitter.setIo(this.io); // registrar io en el singleton global
    this.setupEventHandlers();
    this.setupRedisSubscriptions();
  }

  setupEventHandlers() {
    this.io.on('connection', (socket) => {

      // ── Autenticación del socket ──────────────────────────────
      socket.on('autenticar', (userData) => {
        if (userData?.id) {
          this.usuariosConectados.set(socket.id, userData);
          socket.join(`usuario:${userData.id}`);
          this.io.emit('amigos-estado', this._getEstadosConectados());
        }
      });

      // ── Chat general ──────────────────────────────────────────
      socket.on('chat-general:enviar', async ({ mensaje }) => {
        const user = this.usuariosConectados.get(socket.id);
        if (!user || !mensaje?.trim()) return;
        try {
          const r = await db.query(
            'INSERT INTO mensajes_chat_general (id_usuario, mensaje, tipo) VALUES ($1,$2,$3) RETURNING *',
            [user.id, mensaje.trim().slice(0, 300), 'texto']
          );
          const msg = {
            id: r.rows[0].id,
            mensaje: r.rows[0].mensaje,
            tipo: 'texto',
            creado_en: r.rows[0].creado_en,
            nombre_usuario: user.nombre,
            avatar: user.avatar,
            nivel: user.nivel
          };
          this.io.emit('chat-general:mensaje', msg);
        } catch (e) { console.error('chat-general error:', e.message); }
      });

      // ── Sticker en chat general (1-5 públicos, 6-90 premium: saldo >= 1000) ──
      socket.on('chat-general:sticker', async ({ stickerId }) => {
        const user = this.usuariosConectados.get(socket.id);
        console.log('[sticker] user:', user?.id, '| stickerId:', stickerId);
        if (!user) { console.log('[sticker] usuario no autenticado en socket'); return; }
        const id = parseInt(stickerId, 10);
        if (!Number.isFinite(id) || id < 1 || id > 90) { console.log('[sticker] id inválido:', id); return; }
        const esPublico = id <= 5;
        try {
          if (!esPublico) {
            const saldoR = await db.query('SELECT saldo FROM usuarios WHERE id=$1', [user.id]);
            if (!saldoR.rows.length) return;
            const saldo = parseFloat(saldoR.rows[0].saldo);
            if (saldo < 1000) {
              socket.emit('chat-general:sticker-error', { error: 'Necesitas S/ 1,000.00 o más en tu cuenta para usar stickers.' });
              return;
            }
          }
          const r = await db.query(
            'INSERT INTO mensajes_chat_general (id_usuario, mensaje, tipo, sticker_id) VALUES ($1,$2,$3,$4) RETURNING *',
            [user.id, `sticker:${id}`, 'sticker', id]
          );
          const msg = {
            id: r.rows[0].id,
            mensaje: r.rows[0].mensaje,
            tipo: 'sticker',
            sticker_id: id,
            creado_en: r.rows[0].creado_en,
            nombre_usuario: user.nombre,
            avatar: user.avatar,
            nivel: user.nivel
          };
          this.io.emit('chat-general:mensaje', msg);
        } catch (e) { console.error('chat-general:sticker error:', e.message); }
      });

      // ── Chat privado ──────────────────────────────────────────
      socket.on('chat-privado:enviar', async ({ idReceptor, mensaje }) => {
        const user = this.usuariosConectados.get(socket.id);
        if (!user || !mensaje?.trim()) return;
        try {
          const r = await db.query(
            'INSERT INTO mensajes_chat_privado (id_emisor, id_receptor, mensaje) VALUES ($1,$2,$3) RETURNING *',
            [user.id, idReceptor, mensaje.trim().slice(0, 500)]
          );
          const msg = {
            id: r.rows[0].id,
            mensaje: r.rows[0].mensaje,
            creado_en: r.rows[0].creado_en,
            id_emisor: user.id,
            emisor_nombre: user.nombre,
            emisor_avatar: user.avatar
          };
          socket.emit('chat-privado:mensaje', { ...msg, idConversacion: idReceptor });
          this.io.to(`usuario:${idReceptor}`).emit('chat-privado:mensaje', { ...msg, idConversacion: user.id });
        } catch (e) { console.error('chat-privado error:', e.message); }
      });

      // ── Soporte ───────────────────────────────────────────────
      socket.on('soporte:enviar', async ({ mensaje }) => {
        const user = this.usuariosConectados.get(socket.id);
        if (!user || !mensaje?.trim()) return;
        try {
          const r = await db.query(
            'INSERT INTO mensajes_soporte (id_usuario, mensaje) VALUES ($1,$2) RETURNING *',
            [user.id, mensaje.trim().slice(0, 500)]
          );
          socket.emit('soporte:mensaje', r.rows[0]);
          this.io.emit('soporte:nuevo-ticket', { userId: user.id, nombre: user.nombre });
        } catch (e) { console.error('soporte error:', e.message); }
      });

      // ── Salas en tiempo real ──────────────────────────────────
      socket.on('salas:unirse', (idSala) => {
        socket.join(`sala:${idSala}`);
      });

      socket.on('salas:salir', (idSala) => {
        socket.leave(`sala:${idSala}`);
      });

      // ── Chat de sala ──────────────────────────────────────────
      socket.on('chat-sala:enviar', async ({ idSala, mensaje }) => {
        const user = this.usuariosConectados.get(socket.id);
        if (!user || !mensaje?.trim() || !idSala) return;

        try {
          // Verificar que el usuario está en sala_jugadores para esa sala
          const estaEnSala = await db.query(
            'SELECT 1 FROM sala_jugadores WHERE id_sala=$1 AND id_usuario=$2',
            [idSala, user.id]
          );
          if (!estaEnSala.rows.length) return;

          const r = await db.query(
            'INSERT INTO mensajes_chat_sala (id_sala, id_usuario, mensaje) VALUES ($1,$2,$3) RETURNING *',
            [idSala, user.id, mensaje.trim().slice(0, 500)]
          );

          const msg = {
            id: r.rows[0].id,
            mensaje: r.rows[0].mensaje,
            creado_en: r.rows[0].creado_en,
            id_usuario: user.id,
            nombre_usuario: user.nombre,
            avatar: user.avatar,
          };

          this.io.to(`sala:${idSala}`).emit('chat-sala:mensaje', msg);
        } catch (e) { console.error('chat-sala error:', e.message); }
      });

      // ── Sorteo 1v1 ────────────────────────────────────────────
      socket.on('sala:sorteo1v1:iniciar', ({ idSala }) => {
        // Notificar a todos en la sala que inicie el sorteo
        this.io.to(`sala:${idSala}`).emit('sala:sorteo1v1:iniciar');
      });

      socket.on('sala:sorteo1v1:completado', ({ idSala, banda }) => {
        // Notificar a todos en la sala el resultado del sorteo
        this.io.to(`sala:${idSala}`).emit('sala:sorteo1v1:completado', { idSala, banda });
      });

      // ── Partidas legacy ───────────────────────────────────────
      socket.on('unirse-partida', (matchId) => { socket.join(`partida:${matchId}`); });
      socket.on('salir-partida', (matchId) => { socket.leave(`partida:${matchId}`); });
      socket.on('unirse-apuestas', () => { socket.join('apuestas-activas'); });
      socket.on('solicitar-datos-partida', async (matchId) => {
        try {
          const datos = await redis.get(`partida:${matchId}`);
          if (datos) socket.emit('datos-partida', { matchId, datos: JSON.parse(datos) });
        } catch (error) { console.error('Error datos partida:', error); }
      });

      // ── Desconexión ───────────────────────────────────────────
      socket.on('disconnect', () => {
        this.usuariosConectados.delete(socket.id);
        this.io.emit('amigos-estado', this._getEstadosConectados());
      });
    });
  }

  _getEstadosConectados() {
    const ids = new Set();
    for (const u of this.usuariosConectados.values()) ids.add(u.id);
    return Array.from(ids);
  }

  emitirActualizacionSala(sala) {
    this.io.to(`sala:${sala.id}`).emit('sala:actualizada', sala);
    this.io.emit('salas:actualizar', sala);
  }

  setupRedisSubscriptions() {
    if (redis.status === 'mock') {
      return;
    }

    // Suscribirse a actualizaciones de partidas
    const subscriber = redis.duplicate();

    subscriber.on('error', (err) => {
      console.log('⚠️ Redis subscriber no disponible, realtime por Redis desactivado:', err.code || err.message);
    });

    subscriber.connect()
      .then(async () => {
        await subscriber.subscribe('partida:actualizacion');
        await subscriber.subscribe('partida:finalizada');
        await subscriber.subscribe('apuestas:actualizadas');
      })
      .catch((err) => {
        console.log('⚠️ No se pudo conectar subscriber Redis:', err.code || err.message);
      });

    // Manejar mensajes de Redis
    subscriber.on('message', (channel, message) => {
      try {
        const data = JSON.parse(message);

        switch (channel) {
          case 'partida:actualizacion':
            this.io.to(`partida:${data.matchId}`).emit('partida-actualizada', data);
            break;

          case 'partida:finalizada':
            this.io.emit('partida-finalizada', data);
            this.io.to('apuestas-activas').emit('apuestas-actualizadas', data);
            break;

          case 'apuestas:actualizadas':
            this.io.to('apuestas-activas').emit('apuestas-actualizadas', data);
            break;
        }
      } catch (error) {
        console.error('Error al procesar mensaje de Redis:', error);
      }
    });
  }

  // Método para emitir eventos manualmente
  emitirEvento(evento, data, sala = null) {
    if (sala) {
      this.io.to(sala).emit(evento, data);
    } else {
      this.io.emit(evento, data);
    }
  }

  // Obtener número de clientes conectados
  obtenerClientesConectados() {
    return this.io.engine.clientsCount;
  }

  // Obtener clientes en una sala específica
  obtenerClientesEnSala(sala) {
    return this.io.sockets.adapter.rooms.get(sala)?.size || 0;
  }
}

module.exports = SocketHandler;
