const Partida = require('../../modelos/partida/partida.model');
const steamService = require('../steam/steam.service');
const redis = require('../../config/redis');
const apuestaService = require('../apuesta/apuesta.service');

class PartidaService {
  // Iniciar seguimiento de una nueva partida
  async iniciarSeguimiento(matchId) {
    try {
      // Verificar si la partida ya existe
      let partida = await Partida.buscarPorMatchId(matchId);

      if (!partida) {
        // Obtener detalles de la partida desde Steam API
        const detalles = await steamService.obtenerDetallesPartida(matchId);
        
        if (!detalles || !detalles.players) {
          throw new Error('No se pudieron obtener los detalles de la partida');
        }

        // Crear nueva partida en la base de datos
        partida = await Partida.crear(
          matchId,
          `Partida ${matchId} - Radiant vs Dire`,
          'en_curso'
        );
      }

      // Empezar a monitorear en tiempo real
      await this.monitorearPartidaEnVivo(matchId);

      return partida;
    } catch (error) {
      console.error('Error al iniciar seguimiento de partida:', error);
      throw error;
    }
  }

  // Monitorear partida en tiempo real
  async monitorearPartidaEnVivo(matchId) {
    try {
      const intervalo = setInterval(async () => {
        try {
          const detalles = await steamService.obtenerDetallesPartida(matchId);
          
          if (!detalles) {
            clearInterval(intervalo);
            return;
          }

          // Actualizar datos en Redis para acceso rápido
          await redis.setex(`partida:${matchId}`, 60, JSON.stringify({
            matchId,
            duracion: detalles.duration,
            estado: detalles.game_state,
            killsRadiant: detalles.radiant_score,
            killsDire: detalles.dire_score,
            jugadores: detalles.players,
            torresRadiant: detalles.tower_status_radiant,
            torresDire: detalles.tower_status_dire,
            barracasRadiant: detalles.barracks_status_radiant,
            barracasDire: detalles.barracks_status_dire
          }));

          // Publicar actualización para WebSocket
          await redis.publish('partida:actualizacion', JSON.stringify({
            matchId,
            tipo: 'datos_en_vivo',
            datos: {
              duracion: detalles.duration,
              estado: detalles.game_state,
              killsRadiant: detalles.radiant_score,
              killsDire: detalles.dire_score,
              jugadores: detalles.players
            }
          }));

          // Si la partida terminó, liquidar apuestas
          if (detalles.game_state === 6) { // 6 = Game Over
            await this.finalizarPartida(matchId, detalles);
            clearInterval(intervalo);
          }
        } catch (error) {
          console.error('Error en monitoreo de partida:', error);
        }
      }, 5000); // Actualizar cada 5 segundos

    } catch (error) {
      console.error('Error al monitorear partida en vivo:', error);
      throw error;
    }
  }

  // Finalizar partida y liquidar apuestas
  async finalizarPartida(matchId, detalles) {
    try {
      const partida = await Partida.buscarPorMatchId(matchId);
      
      if (!partida) {
        throw new Error('Partida no encontrada');
      }

      // Determinar ganador
      const ganador = detalles.radiant_win ? 'radiant' : 'dire';

      // Actualizar estado de la partida
      await Partida.actualizarEstado(partida.id, 'finalizada', ganador);

      // Liquidar todas las apuestas de esta partida
      await apuestaService.liquidarApuestasPartida(partida.id, ganador);

      // Publicar evento de finalización
      await redis.publish('partida:finalizada', JSON.stringify({
        matchId,
        ganador,
        duracion: detalles.duration,
        killsRadiant: detalles.radiant_score,
        killsDire: detalles.dire_score
      }));

      // Limpiar datos en tiempo real
      await redis.del(`partida:${matchId}`);

    } catch (error) {
      console.error('Error al finalizar partida:', error);
      throw error;
    }
  }

  // Obtener datos en tiempo real de una partida
  async obtenerDatosEnVivo(matchId) {
    try {
      const datos = await redis.get(`partida:${matchId}`);
      return datos ? JSON.parse(datos) : null;
    } catch (error) {
      console.error('Error al obtener datos en vivo:', error);
      throw error;
    }
  }

  // Obtener partidas activas
  async obtenerPartidasActivas() {
    try {
      const cacheKey = 'partidas:activas';
      const cached = await redis.get(cacheKey);
      
      if (cached) {
        return JSON.parse(cached);
      }

      const partidas = await Partida.obtenerActivas();
      await redis.setex(cacheKey, 30, JSON.stringify(partidas));

      return partidas;
    } catch (error) {
      console.error('Error al obtener partidas activas:', error);
      throw error;
    }
  }

  // Obtener historial de partidas
  async obtenerHistorial(limite = 20) {
    try {
      return await Partida.obtenerHistorial(limite);
    } catch (error) {
      console.error('Error al obtener historial de partidas:', error);
      throw error;
    }
  }
}

module.exports = new PartidaService();
