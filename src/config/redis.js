const Redis = require('ioredis');

let redis;

try {
  const client = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: 3,
    lazyConnect: false,
    connectTimeout: 5000,
    retryStrategy: (times) => {
      const delay = Math.min(times * 50, 2000);
      return delay;
    },
  });

  client.on('connect', () => {
    console.log('🔴 Redis conectado');
  });

  client.on('ready', () => {
    console.log('🔴 Redis listo para comandos');
  });

  client.on('error', (err) => {
    console.error('⚠️ Redis error:', err.message);
  });

  redis = client;
} catch (error) {
  console.error('⚠️ Error inicializando Redis:', error.message);
  throw error;
}

module.exports = redis;
