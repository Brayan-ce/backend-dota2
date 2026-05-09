const { Server } = require('socket.io');
const redis = require('../config/redis');
const db = require('../config/database');
const socketEmitter = require('../utils/socketEmitter');

class SocketHandler {
  constructor(server) {
    this.io = new Server(server, {
      cors: {
        origin: process.env.FRONTEND_URL || "http://localhost:3000",
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
            'INSERT INTO mensajes_chat_general (id_usuario, mensaje) VALUES ($1,$2) RETURNING *',
            [user.id, mensaje.trim().slice(0, 300)]
          );
          const msg = {
            id: r.rows[0].id,
            mensaje: r.rows[0].mensaje,
            creado_en: r.rows[0].creado_en,
            nombre_usuario: user.nombre,
            avatar: user.avatar,
            nivel: user.nivel
          };
          this.io.emit('chat-general:mensaje', msg);
        } catch (e) { console.error('chat-general error:', e.message); }
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
    // Suscribirse a actualizaciones de partidas
    const subscriber = redis.duplicate();
    
    subscriber.subscribe('partida:actualizacion', (err) => {
      if (err) {
        console.error('Error al suscribirse a partida:actualizacion:', err);
        return;
      }
    });

    subscriber.subscribe('partida:finalizada', (err) => {
      if (err) {
        console.error('Error al suscribirse a partida:finalizada:', err);
        return;
      }
    });

    subscriber.subscribe('apuestas:actualizadas', (err) => {
      if (err) {
        console.error('Error al suscribirse a apuestas:actualizadas:', err);
        return;
      }
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
