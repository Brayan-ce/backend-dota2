const express = require('express');
const router = express.Router();
const apuestaService = require('../../servicios/apuesta/apuesta.service');
const { verificarToken, authOpcional } = require('../../middleware/auth');

// Crear apuesta sobre una sala (Radiant/Dire/Jugador)
router.post('/salas/:idSala', verificarToken, async (req, res) => {
  try {
    const idSala = parseInt(req.params.idSala);
    const { lado, monto, idJugador } = req.body;

    if (!idSala || idSala <= 0) {
      return res.status(400).json({ error: 'Sala inválida' });
    }
    if (!lado || !monto) {
      return res.status(400).json({ error: 'Faltan datos para crear la apuesta' });
    }

    const data = await apuestaService.crearApuestaSala(
      req.usuario.id,
      idSala,
      String(lado).toLowerCase(),
      parseFloat(monto),
      idJugador ? parseInt(idJugador) : null
    );

    res.status(201).json({
      mensaje: 'Apuesta registrada correctamente',
      apuesta: data.apuesta,
      nuevoSaldo: data.nuevoSaldo,
    });
  } catch (error) {
    console.error('Error al crear apuesta por sala:', error);
    res.status(400).json({ error: error.message || 'No se pudo registrar la apuesta' });
  }
});

// Obtener votos Radiant/Dire por un conjunto de salas
router.get('/salas/votos', authOpcional, async (req, res) => {
  try {
    const idsRaw = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean);
    const ids = idsRaw.map((s) => parseInt(s)).filter((n) => Number.isInteger(n) && n > 0);

    const votos = await apuestaService.obtenerVotosPorSalas(ids);
    res.json({ votos });
  } catch (error) {
    console.error('Error al obtener votos por sala:', error);
    res.status(500).json({ error: 'No se pudieron obtener los votos' });
  }
});

// Obtener apuestas activas del usuario (pendientes)
router.get('/mis-activas', verificarToken, async (req, res) => {
  try {
    const apuestas = await apuestaService.obtenerApuestasActivasUsuario(req.usuario.id);
    res.json({ apuestas });
  } catch (error) {
    console.error('Error al obtener apuestas activas del usuario:', error);
    res.status(500).json({ error: 'No se pudieron obtener tus apuestas activas' });
  }
});

// Cancelar apuesta pendiente (solo si la sala no inició)
router.post('/:idApuesta/cancelar', verificarToken, async (req, res) => {
  try {
    const idApuesta = parseInt(req.params.idApuesta);
    if (!idApuesta || idApuesta <= 0) {
      return res.status(400).json({ error: 'Apuesta inválida' });
    }

    const data = await apuestaService.cancelarApuestaSala(req.usuario.id, idApuesta);
    res.json({
      mensaje: 'Apuesta cancelada correctamente',
      apuesta: data.apuesta,
      nuevoSaldo: data.nuevoSaldo,
    });
  } catch (error) {
    console.error('Error al cancelar apuesta:', error);
    res.status(400).json({ error: error.message || 'No se pudo cancelar la apuesta' });
  }
});

// Crear nueva apuesta
router.post('/', verificarToken, async (req, res) => {
  try {
    const { idPartida, tipoApuesta, monto, prediccion } = req.body;
    
    if (!idPartida || !tipoApuesta || !monto || !prediccion) {
      return res.status(400).json({ 
        error: 'Faltan datos requeridos para la apuesta' 
      });
    }

    if (monto <= 0) {
      return res.status(400).json({ 
        error: 'El monto debe ser mayor a 0' 
      });
    }

    const apuesta = await apuestaService.crearApuesta(
      req.usuario.id,
      idPartida,
      tipoApuesta,
      monto,
      prediccion
    );

    res.status(201).json({
      mensaje: 'Apuesta creada exitosamente',
      apuesta
    });
  } catch (error) {
    console.error('Error al crear apuesta:', error);
    res.status(500).json({ 
      error: error.message || 'Error al crear apuesta' 
    });
  }
});

// Obtener apuestas activas
router.get('/activas', authOpcional, async (req, res) => {
  try {
    const apuestas = await apuestaService.obtenerApuestasActivas();
    
    res.json({
      apuestas
    });
  } catch (error) {
    console.error('Error al obtener apuestas activas:', error);
    res.status(500).json({ 
      error: 'Error al obtener apuestas activas' 
    });
  }
});

// Obtener historial de apuestas del usuario
router.get('/historial', verificarToken, async (req, res) => {
  try {
    const { limite = 10 } = req.query;
    const historial = await apuestaService.obtenerHistorialUsuario(
      req.usuario.id,
      parseInt(limite)
    );
    
    res.json({
      historial
    });
  } catch (error) {
    console.error('Error al obtener historial:', error);
    res.status(500).json({ 
      error: 'Error al obtener historial de apuestas' 
    });
  }
});

// Obtener estadísticas del usuario
router.get('/estadisticas', verificarToken, async (req, res) => {
  try {
    const estadisticas = await apuestaService.obtenerEstadisticasUsuario(
      req.usuario.id
    );
    
    res.json({
      estadisticas
    });
  } catch (error) {
    console.error('Error al obtener estadísticas:', error);
    res.status(500).json({ 
      error: 'Error al obtener estadísticas' 
    });
  }
});

// Liquidar apuestas de una partida (solo admin)
router.post('/liquidar/:idPartida', async (req, res) => {
  try {
    const { idPartida } = req.params;
    const { resultado } = req.body;
    
    if (!resultado) {
      return res.status(400).json({ 
        error: 'Se requiere el resultado de la partida' 
      });
    }

    const apuestas = await apuestaService.liquidarApuestasPartida(
      idPartida, 
      resultado
    );

    res.json({
      mensaje: 'Apuestas liquidadas exitosamente',
      apuestas
    });
  } catch (error) {
    console.error('Error al liquidar apuestas:', error);
    res.status(500).json({ 
      error: 'Error al liquidar apuestas' 
    });
  }
});

module.exports = router;
