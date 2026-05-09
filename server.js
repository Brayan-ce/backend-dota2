require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const SocketHandler = require('./src/websocket/socketHandler');
const { manejarError, rutaNoEncontrada } = require('./src/utils/errores');

// Importar rutas
const { authRoutes, apuestaRoutes, partidaRoutes, salaRoutes, amigoRoutes, billeteraRoutes, configuracionRoutes, recargaRoutes, referidosRoutes, retiroRoutes, apuestasRoutes, bonosRoutes, guiasRoutes, baneadosRoutes, ganadoresRoutes, partidasVivoRoutes, superadminRoutes } = require('./src/rutas');

// Crear aplicación Express
const app = express();
const PORT = process.env.PORT || 3001;

function getAllowedOrigins() {
  const raw = process.env.FRONTEND_URLS || process.env.FRONTEND_URL || 'http://localhost:3000';
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

const allowedOrigins = getAllowedOrigins();

// Middleware de seguridad
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// Middleware de CORS
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`Origen no permitido por CORS: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Middleware de logging
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined'));
}

// Middleware para parsear JSON
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Rutas de la API
app.use('/api/auth', authRoutes);
app.use('/api/apuestas', apuestaRoutes);
app.use('/api/partidas', partidaRoutes);
app.use('/api/salas', salaRoutes);
app.use('/api/amigos', amigoRoutes);
app.use('/api/billetera', billeteraRoutes);
app.use('/api/configuracion', configuracionRoutes);
app.use('/api/recargas', recargaRoutes);
app.use('/api/referidos', referidosRoutes);
app.use('/api/retiros', retiroRoutes);
app.use('/api/apuestas-salas', apuestasRoutes);
app.use('/api/bonos', bonosRoutes);
app.use('/api/guias', guiasRoutes);
app.use('/api/baneados', baneadosRoutes);
app.use('/api/ganadores', ganadoresRoutes);
app.use('/api/partidas-en-vivo', partidasVivoRoutes);
app.use('/api/superadmin', superadminRoutes);

// Ruta de salud
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Ruta principal
app.get('/', (req, res) => {
  res.json({
    mensaje: '🎮 API de Apuestas Dota 2',
    version: '1.0.0',
    endpoints: {
      auth: '/api/auth',
      apuestas: '/api/apuestas',
      apuestasSalas: '/api/apuestas-salas',
      bonos: '/api/bonos',
      guias: '/api/guias',
      baneados: '/api/baneados',
      ganadores: '/api/ganadores',
      partidasEnVivo: '/api/partidas-en-vivo',
      superadmin: '/api/superadmin',
      partidas: '/api/partidas',
      health: '/api/health'
    }
  });
});

// Manejo de rutas no encontradas
app.use(rutaNoEncontrada);

// Manejo central de errores
app.use(manejarError);

// Crear servidor HTTP
const server = require('http').createServer(app);

// Configurar WebSocket
const socketHandler = new SocketHandler(server);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Puerto ${PORT} ocupado, liberando...`);
    const { execSync } = require('child_process');
    try {
      execSync(`for /f "tokens=5" %a in ('netstat -ano ^| findstr :${PORT}') do taskkill /F /PID %a`, { shell: 'cmd.exe', stdio: 'ignore' });
    } catch (e) {}
    setTimeout(() => server.listen({ port: PORT }, startCallback), 1500);
  } else {
    throw err;
  }
});

const startCallback = async () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
  console.log('🎮 API de Apuestas Dota 2 iniciada');
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
};

server.listen({ port: PORT }, startCallback);

// Manejo de cierre gracioso
process.on('SIGTERM', () => {
  console.log('📴 SIGTERM recibido, cerrando servidor...');
  server.close(() => {
    console.log('✅ Servidor cerrado exitosamente');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('📴 SIGINT recibido, cerrando servidor...');
  server.close(() => {
    console.log('✅ Servidor cerrado exitosamente');
    process.exit(0);
  });
});

// Exportar para testing
module.exports = { app, server };
