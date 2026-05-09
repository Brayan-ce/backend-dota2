// Índice central de servicios
const authService = require('./auth/auth.service');
const apuestaService = require('./apuesta/apuesta.service');
const partidaService = require('./partida/partida.service');
const steamService = require('./steam/steam.service');

module.exports = {
  authService,
  apuestaService,
  partidaService,
  steamService
};
