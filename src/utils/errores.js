// Clase personalizada para errores de la aplicación
class AppError extends Error {
  constructor(mensaje, statusCode = 500) {
    super(mensaje);
    this.statusCode = statusCode;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}

// Manejador central de errores
const manejarError = (err, req, res, next) => {
  let error = { ...err };
  error.message = err.message;

  // Error de validación de Mongoose o Sequelize
  if (err.name === 'ValidationError') {
    const mensaje = Object.values(err.errors).map(val => val.message).join(', ');
    error = new AppError(mensaje, 400);
  }

  // Error de duplicado (clave única)
  if (err.code === '23505') {
    error = new AppError('El registro ya existe', 400);
  }

  // Error de base de datos
  if (err.code === '23503') {
    error = new AppError('Referencia no válida', 400);
  }

  // Error de JWT
  if (err.name === 'JsonWebTokenError') {
    error = new AppError('Token inválido', 401);
  }

  // Error de JWT expirado
  if (err.name === 'TokenExpiredError') {
    error = new AppError('Token expirado', 401);
  }

  // Error de conexión a Redis
  if (err.code === 'ECONNREFUSED' && err.address === '127.0.0.1' && err.port === 6379) {
    error = new AppError('Error de conexión con Redis', 503);
  }

  // Error de conexión a PostgreSQL
  if (err.code === 'ECONNREFUSED' && err.address === '127.0.0.1' && err.port === 5432) {
    error = new AppError('Error de conexión con la base de datos', 503);
  }

  res.status(error.statusCode || 500).json({
    success: false,
    error: error.message || 'Error interno del servidor',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
};

// Manejador para rutas no encontradas
const rutaNoEncontrada = (req, res, next) => {
  const error = new AppError(`Ruta no encontrada - ${req.originalUrl}`, 404);
  next(error);
};

// Manejador de errores asíncronos
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = {
  AppError,
  manejarError,
  rutaNoEncontrada,
  asyncHandler
};
