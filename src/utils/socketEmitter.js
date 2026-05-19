// Singleton para emitir eventos de socket desde cualquier parte del backend
let _io = null;

module.exports = {
  setIo(io) {
    _io = io;
  },

  // Emite el nuevo saldo al usuario específico en tiempo real
  emitirSaldoActualizado(idUsuario, nuevoSaldo) {
    if (!_io) return;
    _io.to(`usuario:${idUsuario}`).emit('saldo:actualizado', { saldo: parseFloat(nuevoSaldo) });
  },

  // Notifica al destinatario que recibió una solicitud de amistad
  emitirSolicitudAmigo(idDestinatario, solicitud) {
    if (!_io) return;
    _io.to(`usuario:${idDestinatario}`).emit('amigo:solicitud', solicitud);
  },

  // Notifica al solicitante que su solicitud fue aceptada
  emitirSolicitudAceptada(idSolicitante, amigo) {
    if (!_io) return;
    _io.to(`usuario:${idSolicitante}`).emit('amigo:aceptado', amigo);
  },

  // Emite actualización de sala desde superadmin a todos los clientes
  emitirActualizacionSalaAdmin(sala) {
    if (!_io) return;
    _io.to(`sala:${sala.id}`).emit('sala:actualizada', sala);
    _io.emit('salas:actualizar', sala);
    _io.emit('admin:sala:actualizada', sala);
  },

  // Envía propuesta de intercambio de rol al receptor
  emitirPropuestaIntercambio(idReceptor, payload) {
    if (!_io) return;
    _io.to(`usuario:${idReceptor}`).emit('sala:intercambio-propuesto', payload);
  },

  // Notifica a todos en la sala que los roles cambiaron (intercambio aceptado)
  emitirActualizacionSalaSimple(idSala) {
    if (!_io) return;
    _io.to(`sala:${idSala}`).emit('sala:actualizada', { id: idSala });
    _io.emit('salas:actualizar', { id: idSala });
  },

  // Notifica al superadmin (y a la sala) que todos los jugadores están listos
  emitirTodosListos(idSala, payload) {
    if (!_io) return;
    _io.emit('admin:sala:todos-listos', payload);
    _io.to(`sala:${idSala}`).emit('sala:todos-listos', payload);
  },

  // ── Eventos de lobby automático de Dota 2 ────────────────────────────

  // El bot Steam creó el lobby — envía lobby_id y password a los jugadores de la sala
  emitirLobbyCreado(idSala, payload) {
    if (!_io) return;
    _io.to(`sala:${idSala}`).emit('lobby:creado', payload);
    _io.emit('admin:lobby:creado', payload);
  },

  // Se envió invitación dentro de Dota 2 a un jugador
  emitirJugadorInvitado(idSala, payload) {
    if (!_io) return;
    _io.to(`sala:${idSala}`).emit('lobby:jugador-invitado', payload);
    if (payload.idUsuario) {
      _io.to(`usuario:${payload.idUsuario}`).emit('lobby:invitacion-recibida', payload);
    }
  },

  // Actualización en tiempo real del estado del lobby (jugadores que se unen)
  emitirLobbyActualizado(idSala, payload) {
    if (!_io) return;
    _io.to(`sala:${idSala}`).emit('lobby:actualizado', payload);
  },

  // Cambio de estado del lobby: 'creando' | 'creado' | 'jugadores_unidos' | 'iniciado' | 'error'
  emitirLobbyEstado(idSala, payload) {
    if (!_io) return;
    _io.to(`sala:${idSala}`).emit('lobby:estado', payload);
    _io.emit('admin:lobby:estado', payload);
  },

  // Error al crear o gestionar el lobby
  emitirLobbyError(idSala, payload) {
    if (!_io) return;
    _io.to(`sala:${idSala}`).emit('lobby:error', payload);
    _io.emit('admin:lobby:error', payload);
  },
};
