const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Verificar conexión a la base de datos
pool.on('connect', (client) => {
  console.log('🐘 Conectado a PostgreSQL');
  // Evitar que las queries o locks cuelguen indefinidamente
  client.query('SET statement_timeout = 8000').catch(() => {});
  client.query('SET lock_timeout = 5000').catch(() => {});
});

pool.on('error', (err) => {
  console.error('❌ Error en la conexión a PostgreSQL:', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};
