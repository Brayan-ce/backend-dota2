const Redis = require('ioredis');

const mockRedis = {
  get: async () => null,
  set: async () => 'OK',
  setex: async () => 'OK',
  del: async () => 1,
  publish: async () => 1,
  duplicate: () => mockRedis,
  subscribe: async () => {},
  on: () => mockRedis,
  status: 'mock',
};

let redis;

try {
  const client = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: 0,
    lazyConnect: true,
    connectTimeout: 2000,
    retryStrategy: () => null, // No reintentar — usar mock si falla
  });

  client.on('connect', () => {
    console.log('🔴 Conectado a Redis');
  });

  client.on('error', (err) => {
    // Solo loguear una vez, no spamear
    if (client.status !== 'end') {
      console.log('⚠️ Redis no disponible, usando mock en memoria:', err.code || err.message);
    }
  });

  redis = client;
} catch (error) {
  console.log('⚠️ Redis no disponible, funcionando sin caché');
  redis = mockRedis;
}

module.exports = redis;
