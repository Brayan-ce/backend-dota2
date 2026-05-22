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
   * @param {number} data.maxJugadores - Máximo de jugadores (2 para 1v1)
   * @param {Array} data.jugadores - Lista de jugadores [{steamId, name, team}]
   */
  async createLobby(data) {
    try {
      this.logger.log(`[DotaBot] Creando lobby para sala ${data.salaId}...`);
      
      // Body que espera el bot C# en POST /api/lobby/create
      // maxJugadores determina el modo: 2 = 1v1 Solo Mid, >2 = All Pick
      const requestBody = {
        salaId:       data.salaId,
        nombre:       data.nombre   || `Sala #${data.salaId}`,
        password:     data.password || '',
        gameMode:     data.gameMode || 1,  // 1 = All Pick
        region:       data.region   || 7,  // 7 = South America
        maxJugadores: data.maxJugadores || 10,
        jugadores:    data.jugadores || []
      };

      const response = await axios.post(
        `${this.baseURL}/api/lobby/create`,
        requestBody,
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 150000 // 150s — el bot necesita hasta 120s para que el GC responda
        }
      );

      this.logger.log(`[DotaBot] Lobby creado:`, response.data);
      // El bot C# responde con { success, lobbyId, password, salaId, message }
      return {
        success:  response.data.success  ?? true,
        lobbyId:  response.data.lobbyId  || response.data.LobbyId,
        password: response.data.password || response.data.Password || data.password
      };
    } catch (error) {
      this.logger.error('[DotaBot] Error creando lobby:', error.message);
      if (error.response) {
        return { 
          success: false, 
          message: error.response.data?.message || error.response.data?.Message || error.message 
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
      
      // El bot C# expone POST /api/lobby/invite con { steamId }
      const response = await axios.post(
        `${this.baseURL}/api/lobby/invite`,
        { steamId: String(steamId) },
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
      
      // El bot C# expone POST /api/lobby/leave (sin ID, usa el lobby actual)
      const response = await axios.post(
        `${this.baseURL}/api/lobby/leave`,
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

  /**
   * Iniciar partida (alias para consistencia)
   */
  async iniciarPartida(lobbyId) {
    return this.startMatch(lobbyId);
  }

  /**
   * Bot sale del lobby (deja la sala pero los jugadores pueden seguir)
   */
  async salirSlotEspectador(lobbyId) {
    try {
      this.logger.log(`[DotaBot] Bot saliendo del lobby ${lobbyId}...`);
      
      // Usamos leaveLobby para salir limpiamente del lobby
      const response = await axios.post(
        `${this.baseURL}/api/lobby/leave`,
        { lobbyId: lobbyId },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000
        }
      );

      this.logger.log(`[DotaBot] Bot salió del lobby exitosamente`);
      return response.data;
    } catch (error) {
      this.logger.error('[DotaBot] Error saliendo del lobby:', error.message);
      return { success: false, message: error.message };
    }
  }
}

module.exports = new DotaBotService();
