const express = require('express');
const router = express.Router();
const partidaService = require('../../servicios/partida/partida.service');
const { verificarToken, authOpcional } = require('../../middleware/auth');

// Iniciar seguimiento de una partida
router.post('/seguir', async (req, res) => {
  try {
    const { matchId } = req.body;
    
    if (!matchId) {
      return res.status(400).json({ 
        error: 'Se requiere el Match ID de la partida' 
      });
    }

    const partida = await partidaService.iniciarSeguimiento(matchId);
    
    res.json({
      mensaje: 'Seguimiento de partida iniciado',
      partida
    });
  } catch (error) {
    console.error('Error al iniciar seguimiento:', error);
    res.status(500).json({ 
      error: error.message || 'Error al iniciar seguimiento de partida' 
    });
  }
});

// Obtener datos en tiempo real de una partida
router.get('/vivo/:matchId', authOpcional, async (req, res) => {
  try {
    const { matchId } = req.params;
    const datos = await partidaService.obtenerDatosEnVivo(matchId);
    
    if (!datos) {
      return res.status(404).json({ 
        error: 'No se encontraron datos en vivo para esta partida' 
      });
    }

    res.json({
      datos
    });
  } catch (error) {
    console.error('Error al obtener datos en vivo:', error);
    res.status(500).json({ 
      error: 'Error al obtener datos en vivo' 
    });
  }
});

// Obtener partidas activas
router.get('/activas', authOpcional, async (req, res) => {
  try {
    const partidas = await partidaService.obtenerPartidasActivas();
    
    res.json({
      partidas
    });
  } catch (error) {
    console.error('Error al obtener partidas activas:', error);
    res.status(500).json({ 
      error: 'Error al obtener partidas activas' 
    });
  }
});

// Obtener historial de partidas
router.get('/historial', authOpcional, async (req, res) => {
  try {
    const { limite = 20 } = req.query;
    const historial = await partidaService.obtenerHistorial(parseInt(limite));
    
    res.json({
      historial
    });
  } catch (error) {
    console.error('Error al obtener historial de partidas:', error);
    res.status(500).json({ 
      error: 'Error al obtener historial de partidas' 
    });
  }
});

// Obtener detalles de una partida específica
router.get('/:matchId', authOpcional, async (req, res) => {
  try {
    const { matchId } = req.params;
    
    // Primero intentar obtener de Redis (datos en vivo)
    const datosEnVivo = await partidaService.obtenerDatosEnVivo(matchId);
    
    if (datosEnVivo) {
      return res.json({
        tipo: 'en_vivo',
        datos: datosEnVivo
      });
    }

    // Si no está en vivo, obtener de la base de datos
    const Partida = require('../../modelos/partida/partida.model');
    const partida = await Partida.buscarPorMatchId(matchId);
    
    if (!partida) {
      return res.status(404).json({ 
        error: 'Partida no encontrada' 
      });
    }

    res.json({
      tipo: 'historica',
      datos: partida
    });
  } catch (error) {
    console.error('Error al obtener detalles de partida:', error);
    res.status(500).json({ 
      error: 'Error al obtener detalles de la partida' 
    });
  }
});

// Finalizar partida manualmente (solo admin)
router.post('/finalizar/:matchId', async (req, res) => {
  try {
    const { matchId } = req.params;
    const { resultado } = req.body;
    
    if (!resultado) {
      return res.status(400).json({ 
        error: 'Se requiere el resultado de la partida' 
      });
    }

    await partidaService.finalizarPartida(matchId, { radiant_win: resultado === 'radiant' });
    
    res.json({
      mensaje: 'Partida finalizada exitosamente'
    });
  } catch (error) {
    console.error('Error al finalizar partida:', error);
    res.status(500).json({ 
      error: 'Error al finalizar partida' 
    });
  }
});

module.exports = router;
