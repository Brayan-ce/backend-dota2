const authService = require('../servicios/auth/auth.service');

const obtenerSteamIdsSuperadmin = () => String(process.env.SUPERADMIN_STEAM_IDS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const esUsuarioSuperadmin = (usuario) => {
  if (!usuario?.steamId) return false;
  return obtenerSteamIdsSuperadmin().includes(String(usuario.steamId));
};

// Middleware para verificar token JWT
const verificarToken = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ 
        error: 'Se requiere token de autenticación' 
      });
    }

    const decoded = authService.verificarToken(token);
    req.usuario = decoded;
    next();
  } catch (error) {
    res.status(401).json({ 
      error: 'Token inválido o expirado' 
    });
  }
};

// Middleware opcional de autenticación
const authOpcional = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (token) {
      const decoded = authService.verificarToken(token);
      req.usuario = decoded;
    }
    
    next();
  } catch (error) {
    // Si el token es inválido, continuamos sin usuario
    next();
  }
};

// Middleware para verificar si es administrador
const esAdmin = async (req, res, next) => {
  try {
    if (!req.usuario) {
      return res.status(401).json({ 
        error: 'Se requiere autenticación' 
      });
    }
    
    next();
  } catch (error) {
    res.status(500).json({ 
      error: 'Error de autenticación' 
    });
  }
};

const esSuperadmin = async (req, res, next) => {
  try {
    if (!req.usuario) {
      return res.status(401).json({
        error: 'Se requiere autenticación'
      });
    }

    if (!esUsuarioSuperadmin(req.usuario)) {
      return res.status(403).json({
        error: 'Solo un superadmin puede realizar esta acción'
      });
    }

    next();
  } catch (error) {
    res.status(500).json({
      error: 'Error validando superadmin'
    });
  }
};

module.exports = {
  verificarToken,
  authOpcional,
  esAdmin,
  esSuperadmin,
  esUsuarioSuperadmin,
};
