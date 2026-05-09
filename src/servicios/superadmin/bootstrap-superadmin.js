const bcrypt = require('bcryptjs');
const db = require('../../config/database');

const DEFAULT_USER = 'admin';
const DEFAULT_PASSWORD = '123456';
const SALT_ROUNDS = 10;

async function bootstrapSuperadmin() {
  const usuario = String(process.env.SUPERADMIN_USER || DEFAULT_USER).trim();
  const password = String(process.env.SUPERADMIN_PASSWORD || DEFAULT_PASSWORD);

  if (!usuario) {
    throw new Error('Usuario de superadmin invalido');
  }

  if (!password || password.length < 6) {
    throw new Error('La password debe tener al menos 6 caracteres');
  }

  const check = await db.query("SELECT to_regclass('public.superadmin_usuarios') AS reg");
  if (!check.rows?.[0]?.reg) {
    const err = new Error('Falta tabla requerida: public.superadmin_usuarios');
    err.code = 'SUPERADMIN_SCHEMA_MISSING';
    throw err;
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  await db.query(
    `
    INSERT INTO superadmin_usuarios (usuario, password_hash, rol, activo)
    VALUES ($1, $2, 'superadmin', TRUE)
    ON CONFLICT (usuario)
    DO UPDATE
      SET password_hash = EXCLUDED.password_hash,
          rol = 'superadmin',
          activo = TRUE,
          actualizado_en = CURRENT_TIMESTAMP
    `,
    [usuario, passwordHash]
  );

  return { usuario };
}

module.exports = {
  bootstrapSuperadmin,
};
