require('dotenv').config();
const db = require('./src/config/database');
const { bootstrapSuperadmin } = require('./src/servicios/superadmin/bootstrap-superadmin');

bootstrapSuperadmin()
  .then((resultado) => {
    console.log('Superadmin actualizado correctamente');
    console.log(`usuario: ${resultado.usuario}`);
  })
  .catch((error) => {
    console.error('Error actualizando superadmin:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await db.pool.end();
    } catch (_) {}
  });
