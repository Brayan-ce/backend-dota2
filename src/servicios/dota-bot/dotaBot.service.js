const axios = require('axios');

/**
 * Servicio para comunicarse con el bot Dota 2 (.NET C#)
 * El bot corre como microservicio en http://localhost:5001
 */
class DotaBotService {
  constructor() {
    this.baseURL = process.env.DOTA_BOT_URL || 'http://localhost:5001';
    this.logger = console;
  }

  /**
   * Verificar que el bot está activo
   */
  async healthCheck() {
    try {
      const response = await axios.get(`${this.baseURL}/health`, {
        timeout: 5000
      });
      return response.data;
    } catch (error) {
      this.logger.error('[DotaBot] Health check failed:', error.message);
      return { status: 'error', message: error.message };
    }
  }

  /**
   * Crear lobby en Dota 2
   * @param {Object} data - Datos de la sala
   * @param {number} data.salaId - ID de la sala
   * @param {string} data.nombre - Nombre del lobby
   * @param {string} data.password - Contraseña (opcional)
   * @param {number} data.gameMode - Modo de juego (1 = All Pick)
   * @param {Array} data.jugadores - Lista de jugadores [{steamId, name, team}]
   */
  async createLobby(data) {
    try {
      this.logger.log(`[DotaBot] Creando lobby para sala ${data.salaId}...`);
      
      const requestBody = {
        name: data.nombre || `Sala #${data.salaId}`,
        password: data.password || '',
        game_mode: data.gameMode || 1, // All Pick por defecto
        region: 0 // US East por defecto
      };

      const response = await axios.post(
        `${this.baseURL}/api/lobby/create`,
        requestBody,
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000 // 30 segundos para crear lobby
        }
      );

      this.logger.log(`[DotaBot] Lobby creado:`, response.data);
      // Mapear respuesta del Go service al formato esperado por el backend
      return {
        success: true,
        lobbyId: response.data.lobby_id,
        name: response.data.name
      };
    } catch (error) {
      this.logger.error('[DotaBot] Error creando lobby:', error.message);
      if (error.response) {
        return { 
          success: false, 
          message: error.response.data?.message || error.message 
        };
      }
      return { success: false, message: error.message };
    }
  }

  /**
   * Invitar jugador al lobby
   * @param {string} steamId - Steam ID del jugador
   */
  async invitePlayer(steamId, lobbyId) {
    try {
      this.logger.log(`[DotaBot] Invitando jugador ${steamId} al lobby ${lobbyId}...`);
      
      const response = await axios.post(
        `${this.baseURL}/api/lobby/${lobbyId}/invite`,
        { steam_id: steamId },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000
        }
      );

      return response.data;
    } catch (error) {
      this.logger.error('[DotaBot] Error invitando jugador:', error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * Obtener estado del lobby actual
   */
  async getLobbyStatus() {
    try {
      const response = await axios.get(`${this.baseURL}/api/lobby/status`, {
        timeout: 5000
      });
      return response.data;
    } catch (error) {
      this.logger.error('[DotaBot] Error obteniendo estado:', error.message);
      return { hasActiveLobby: false, error: error.message };
    }
  }

  /**
   * Abandonar/destruir lobby
   */
  async leaveLobby(lobbyId) {
    try {
      this.logger.log(`[DotaBot] Abandonando lobby ${lobbyId}...`);
      
      const response = await axios.post(
        `${this.baseURL}/api/lobby/${lobbyId}/leave`,
        {},
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000
        }
      );

      return response.data;
    } catch (error) {
      this.logger.error('[DotaBot] Error abandonando lobby:', error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * Iniciar partida
   */
  async startMatch(lobbyId) {
    try {
      this.logger.log(`[DotaBot] Iniciando partida en lobby ${lobbyId}...`);
      
      const response = await axios.post(
        `${this.baseURL}/api/lobby/${lobbyId}/start`,
        {},
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000
        }
      );

      return response.data;
    } catch (error) {
      this.logger.error('[DotaBot] Error iniciando partida:', error.message);
      return { success: false, message: error.message };
    }
  }
}

module.exports = new DotaBotService();
