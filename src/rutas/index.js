// Índice central de rutas
const authRoutes     = require('./auth/auth.routes');
const apuestaRoutes  = require('./apuesta/apuesta.routes');
const partidaRoutes  = require('./partida/partida.routes');
const salaRoutes     = require('./sala/sala.routes');
const amigoRoutes    = require('./amigo/amigo.routes');
const billeteraRoutes      = require('./billetera/billetera.routes');
const configuracionRoutes  = require('./configuracion/configuracion.routes');
const recargaRoutes        = require('./recarga/recarga.routes');
const referidosRoutes      = require('./referidos/referidos.routes');
const retiroRoutes         = require('./retiro/retiro.routes');
const apuestasRoutes       = require('./apuestas/apuestas.routes');
const bonosRoutes          = require('./bonos/bonos.routes');
const guiasRoutes          = require('./guias/guias.routes');
const baneadosRoutes       = require('./baneados/baneados.routes');
const ganadoresRoutes      = require('./ganadores/ganadores.routes');
const partidasVivoRoutes   = require('./partidas-vivo/partidas-vivo.routes');
const superadminRoutes     = require('./superadmin/superadmin.routes');

module.exports = {
  authRoutes,
  apuestaRoutes,
  partidaRoutes,
  salaRoutes,
  amigoRoutes,
  billeteraRoutes,
  configuracionRoutes,
  recargaRoutes,
  referidosRoutes,
  retiroRoutes,
  apuestasRoutes,
  bonosRoutes,
  guiasRoutes,
  baneadosRoutes,
  ganadoresRoutes,
  partidasVivoRoutes,
  superadminRoutes,
};
