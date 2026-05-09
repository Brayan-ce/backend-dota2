const jwt = require('jsonwebtoken');

const SUPERADMIN_JWT_SECRET = process.env.SUPERADMIN_JWT_SECRET || process.env.JWT_SECRET;

function verificarSuperadminToken(req, res, next) {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ error: 'Token de superadmin requerido' });
    }

    const decoded = jwt.verify(token, SUPERADMIN_JWT_SECRET);

    if (decoded?.tipo !== 'superadmin' || decoded?.rol !== 'superadmin') {
      return res.status(403).json({ error: 'Token de superadmin invalido' });
    }

    req.superadmin = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token de superadmin invalido o expirado' });
  }
}

module.exports = {
  verificarSuperadminToken,
};
