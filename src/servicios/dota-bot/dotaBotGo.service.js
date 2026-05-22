const redis = require('../../config/redis');
const { v4: uuidv4 } = require('uuid');
const socketEmitter = require('../../utils/socketEmitter');

/**
 * Servicio para comunicarse con el bot Dota 2 (Go)
 * Usa Redis pub/sub para enviar comandos y recibir eventos
 */
class DotaBotGoService {
  constructor() {
    this.logger = console;
    this.cmdChannel = process.env.REDIS_CMD_CHANNEL || 'dota:commands';
    this.evtChannel = process.env.REDIS_EVT_CHANNEL || 'dota:events';
    this.pendingResponses = new Map();
    this.lobbyToSalaMap = new Map(); // lobbyId -> salaId
    
    // Suscribirse a eventos del bot
    this.subscribeToEvents();
  }

  /**
   * Suscribirse al canal de eventos del bot
   */
  async subscribeToEvents() {
    try {
      const subscriber = redis.duplicate();
      await subscriber.subscribe(this.evtChannel);
      
      subscriber.on('message', (channel, message) => {
        try {
          const event = JSON.parse(message);
          this.handleBotEvent(event);
        } catch (err) {
          this.logger.error('[DotaBotGo] Error parsing event:', err.message);
        }
      });
      
      this.logger.log('[DotaBotGo] Suscrito a eventos del bot');
    } catch (err) {
      this.logger.error('[DotaBotGo] Error suscribiendo a eventos:', err.message);
    }
  }

  /**
   * Manejar eventos recibidos del bot
   */
  async handleBotEvent(event) {
    // Log de eventos
    this.logger.log(`[DotaBotGo] Evento recibido: ${event.type}`, event.payload);
    
    // Guardar hostSteamId cuando el primer jugador entra al lobby
    if (event.type === 'player_joined_first' && event.payload?.steamId) {
      const salaId = this.lobbyToSalaMap.get(String(event.lobbyId));
      if (salaId) {
        this.logger.log(`[DotaBotGo] Primer jugador entró al lobby ${event.lobbyId}, sala ${salaId}, host: ${event.payload.steamId}`);
        
        // Guardar en memoria para consultas rápidas
        this.hostPlayerMap = this.hostPlayerMap || new Map();
        this.hostPlayerMap.set(String(salaId), {
          steamId: event.payload.steamId,
          joinedAt: new Date().toISOString()
        });
        
        // Guardar en la base de datos
        try {
          const db = require('../../config/database');
          await db.query(
            'UPDATE salas SET host_steam_id = $1 WHERE id = $2',
            [event.payload.steamId, salaId]
          );
          this.logger.log(`[DotaBotGo] host_steam_id guardado en DB para sala ${salaId}`);
        } catch (dbError) {
          this.logger.error(`[DotaBotGo] Error guardando host_steam_id:`, dbError);
        }
      }
    }
    
    // Guardar match_id cuando la partida inicia
    // El evento viene con datos en payload: { matchId, lobbyId, gameName, state }
    const matchId = event.matchId || event.payload?.matchId;
    const lobbyIdFromEvent = event.lobbyId || event.payload?.lobbyId;
    
    // DEBUG: Loggear cualquier evento match_started
    if (event.type === 'match_started') {
      this.logger.log(`[DotaBotGo] DEBUG match_started recibido - matchId: ${matchId}, lobbyId: ${lobbyIdFromEvent}, payload:`, event.payload);
    }
    
    if (event.type === 'match_started' && matchId && lobbyIdFromEvent) {
      // Buscar sala por lobby_id en DB (más robusto que el mapa en memoria)
      try {
        const db = require('../../config/database');
        const lobbyId = String(lobbyIdFromEvent);
        
        let salaId = null;
        
        // Primero intentar buscar por lobby_id exacto
        const salaQuery = await db.query(
          'SELECT id FROM salas WHERE lobby_id = $1',
          [lobbyId]
        );
        
        if (salaQuery.rows.length > 0) {
          salaId = salaQuery.rows[0].id;
          this.logger.log(`[DotaBotGo] Sala encontrada por lobby_id exacto: ${salaId}`);
        } else {
          // Fallback 1: buscar en el mapa en memoria
          salaId = this.lobbyToSalaMap.get(lobbyId);
          if (salaId) {
            this.logger.log(`[DotaBotGo] Sala encontrada en mapa memoria: ${salaId}`);
          }
        }
        
        // Fallback 2: buscar por roomId (salaId) si viene en el evento
        if (!salaId && event.roomId) {
          const roomSalaQuery = await db.query(
            'SELECT id, lobby_id FROM salas WHERE id = $1',
            [event.roomId]
          );
          if (roomSalaQuery.rows.length > 0) {
            salaId = roomSalaQuery.rows[0].id;
            const foundLobbyId = roomSalaQuery.rows[0].lobby_id;
            this.logger.log(`[DotaBotGo] Sala encontrada por roomId: ${salaId} (lobby guardado: ${foundLobbyId})`);
            
            // Actualizar lobby_id si es diferente
            if (foundLobbyId !== lobbyId) {
              await db.query('UPDATE salas SET lobby_id = $1 WHERE id = $2', [lobbyId, salaId]);
              this.logger.log(`[DotaBotGo] lobby_id actualizado: ${foundLobbyId} -> ${lobbyId}`);
            }
          }
        }
        
        // Fallback 3: buscar sala más reciente activa del bot (últimos 10 min)
        if (!salaId) {
          const recentSalaQuery = await db.query(
            `SELECT id, lobby_id FROM salas 
             WHERE lobby_id IS NOT NULL 
               AND estado IN ('creado', 'jugadores_unidos', 'iniciada')
               AND creada_en > NOW() - INTERVAL '10 minutes'
             ORDER BY creada_en DESC 
             LIMIT 1`
          );
          if (recentSalaQuery.rows.length > 0) {
            salaId = recentSalaQuery.rows[0].id;
            const foundLobbyId = recentSalaQuery.rows[0].lobby_id;
            this.logger.log(`[DotaBotGo] Sala encontrada por reciente: ${salaId} (lobby guardado: ${foundLobbyId}, evento: ${lobbyId})`);
            
            // Actualizar el lobby_id si es diferente
            if (foundLobbyId !== lobbyId) {
              await db.query('UPDATE salas SET lobby_id = $1 WHERE id = $2', [lobbyId, salaId]);
              this.logger.log(`[DotaBotGo] lobby_id actualizado: ${foundLobbyId} -> ${lobbyId}`);
            }
          }
        }
        
        if (!salaId) {
          this.logger.warn(`[DotaBotGo] No se encontró sala para lobby ${lobbyId} (match_id: ${matchId})`);
          return;
        }
        
        this.logger.log(`[DotaBotGo] Match iniciado! Lobby ${lobbyId}, sala ${salaId}, matchId: ${matchId}`);
        
        await db.query(
          `UPDATE salas 
           SET match_id = $1, 
               match_encontrado_en = NOW(),
               estado = 'en_progreso'
           WHERE id = $2`,
          [String(matchId), salaId]
        );
        this.logger.log(`[DotaBotGo] ✅ match_id ${matchId} guardado en DB para sala ${salaId}`);
        
        // Notificar a superadmins via WebSocket
        socketEmitter.emitirActualizacionSalaAdmin(salaId, {
          matchId: String(matchId),
          lobbyId: lobbyId,
          estado: 'en_progreso',
          timestamp: new Date().toISOString()
        });
      } catch (dbError) {
        this.logger.error(`[DotaBotGo] Error guardando match_id:`, dbError);
      }
    }

    // Manejar resultado de partida finalizada
    if (event.type === 'match_finished') {
      const { matchId, lobbyId, winner, duration } = event.payload || {};
      if (!matchId || !winner) {
        this.logger.warn('[DotaBotGo] match_finished sin datos suficientes', event.payload);
        return;
      }
      
      this.logger.log(`[DotaBotGo] 🏁 Partida finalizada! Match ${matchId}, ganador: ${winner}, duración: ${duration}s`);
      
      try {
        const db = require('../../config/database');
        
        // Buscar sala por match_id y actualizar
        const result = await db.query(
          `UPDATE salas 
           SET match_resultado = $1::jsonb,
               match_duracion = $2,
               match_finalizado_en = NOW(),
               estado = 'finalizada'
           WHERE match_id = $3
           RETURNING id, lobby_id`,
          [JSON.stringify({ winner }), duration, String(matchId)]
        );
        
        if (result.rows.length > 0) {
          const sala = result.rows[0];
          this.logger.log(`[DotaBotGo] ✅ Resultado guardado en DB para sala ${sala.id}`);
          
          // Notificar a superadmins
          socketEmitter.emitirActualizacionSalaAdmin(sala.id, {
            matchId: String(matchId),
            lobbyId: sala.lobby_id,
            winner: winner,
            duration: duration,
            estado: 'finalizada',
            timestamp: new Date().toISOString()
          });
        } else {
          this.logger.warn(`[DotaBotGo] No se encontró sala con match_id ${matchId}`);
        }
      } catch (dbError) {
        this.logger.error(`[DotaBotGo] Error guardando resultado:`, dbError);
      }
    }
    
    // También guardar cuando el bot sale (backup)
    if (event.type === 'bot_left_lobby' && event.payload?.hostSteamId) {
      const lobbyId = event.payload.lobbyId || event.lobbyId;
      const salaId = this.lobbyToSalaMap.get(String(lobbyId));
      if (salaId && event.payload.hostSteamId) {
        this.logger.log(`[DotaBotGo] Bot salió del lobby ${lobbyId}, host confirmado: ${event.payload.hostSteamId}`);
        this.hostPlayerMap = this.hostPlayerMap || new Map();
        this.hostPlayerMap.set(String(salaId), {
          steamId: event.payload.hostSteamId,
          leftAt: new Date().toISOString()
        });
      }
    }
    
    // Resolver promesas pendientes (solo para eventos finales, no intermedios)
    const finalEventTypes = ['lobby_created', 'lobby_error', 'players_invited', 'players_invite_error', 'lobby_left', 'lobby_leave_error'];
    
    if (event.id && this.pendingResponses.has(event.id) && finalEventTypes.includes(event.type)) {
      const { resolve, reject, timeout } = this.pendingResponses.get(event.id);
      clearTimeout(timeout);
      this.pendingResponses.delete(event.id);
      
      if (event.error) {
        reject(new Error(event.error));
      } else {
        resolve(event.payload);
      }
    }
  }

  /**
   * Enviar comando al bot y esperar respuesta
   */
  async sendCommand(action, payload, timeoutMs = 30000) {
    const id = uuidv4();
    const command = {
      id,
      action,
      roomId: payload.salaId,
      payload
    };

    return new Promise((resolve, reject) => {
      // Timeout
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(id);
        reject(new Error(`Timeout esperando respuesta del bot para ${action}`));
      }, timeoutMs);

      // Guardar promesa pendiente
      this.pendingResponses.set(id, { resolve, reject, timeout });

      // Enviar comando
      redis.publish(this.cmdChannel, JSON.stringify(command))
        .then(() => {
          this.logger.log(`[DotaBotGo] Comando enviado: ${action}`, { id, salaId: payload.salaId });
        })
        .catch(err => {
          clearTimeout(timeout);
          this.pendingResponses.delete(id);
          reject(err);
        });
    });
  }

  /**
   * Crear lobby en Dota 2
   */
  async createLobby(data) {
    try {
      this.logger.log(`[DotaBotGo] Creando lobby para sala ${data.salaId}...`);

      const response = await this.sendCommand('create_lobby', {
        salaId: data.salaId,
        gameName: data.nombre || `Sala #${data.salaId}`,
        passKey: data.password || '',
        gameMode: data.gameMode || 1,
        region: data.region || 7,
        maxPlayers: data.maxJugadores || 10
      }, 60000); // 60s timeout

      this.logger.log(`[DotaBotGo] Lobby creado:`, response);
      
      // Guardar mapping de lobbyId -> salaId para invitaciones futuras
      if (response.lobbyId) {
        this.lobbyToSalaMap.set(String(response.lobbyId), data.salaId);
        this.logger.log(`[DotaBotGo] Mapping guardado: lobby ${response.lobbyId} -> sala ${data.salaId}`);
        
        // También guardar en la base de datos para persistencia
        try {
          const db = require('../../config/database');
          await db.query(
            `UPDATE salas 
             SET lobby_id = $1, 
                 lobby_password = $2,
                 lobby_estado = 'creado'
             WHERE id = $3`,
            [String(response.lobbyId), data.password || '', data.salaId]
          );
          this.logger.log(`[DotaBotGo] lobby_id ${response.lobbyId} guardado en DB para sala ${data.salaId}`);
        } catch (dbError) {
          this.logger.error(`[DotaBotGo] Error guardando lobby_id en DB:`, dbError);
        }
      }
      
      return {
        success: true,
        lobbyId: response.lobbyId,
        password: data.password
      };
    } catch (error) {
      this.logger.error('[DotaBotGo] Error creando lobby:', error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * Invitar jugador al lobby
   */
  async invitePlayer(steamId, lobbyId, team = 'radiant') {
    try {
      this.logger.log(`[DotaBotGo] Invitando jugador ${steamId} al lobby ${lobbyId}...`);

      // Obtener salaId del mapping
      const salaId = this.lobbyToSalaMap.get(String(lobbyId));
      if (!salaId) {
        this.logger.warn(`[DotaBotGo] No se encontró salaId para lobby ${lobbyId}`);
      }

      await this.sendCommand('invite_players', {
        salaId: salaId || 0,  // ← AHORA SÍ enviamos salaId
        lobbyId: String(lobbyId),
        players: [{
          steamId: String(steamId),
          team: team
        }]
      }, 30000);

      this.logger.log(`[DotaBotGo] Jugador ${steamId} invitado`);
      return { success: true };
    } catch (error) {
      this.logger.error('[DotaBotGo] Error invitando jugador:', error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * Iniciar partida en el lobby
   */
  async iniciarPartida(salaId, lobbyId) {
    try {
      this.logger.log(`[DotaBotGo] Iniciando partida para sala ${salaId}, lobby ${lobbyId}...`);

      await this.sendCommand('start_game', {
        salaId: String(salaId),
        lobbyId: String(lobbyId)
      }, 30000);

      this.logger.log(`[DotaBotGo] Comando start_game enviado`);
      return { success: true };
    } catch (error) {
      this.logger.error('[DotaBotGo] Error iniciando partida:', error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * Bot sale del slot (se queda en espectador)
   */
  async salirSlot(salaId, lobbyId) {
    try {
      this.logger.log(`[DotaBotGo] Bot saliendo del slot para sala ${salaId}...`);

      await this.sendCommand('leave_lobby', {
        salaId: String(salaId),
        lobbyId: String(lobbyId)
      }, 30000);

      this.logger.log(`[DotaBotGo] Bot salió del slot`);
      return { success: true };
    } catch (error) {
      this.logger.error('[DotaBotGo] Error saliendo del slot:', error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * Salir del lobby (cerrar completamente)
   */
  async leaveLobby(lobbyId) {
    try {
      this.logger.log(`[DotaBotGo] Saliendo del lobby ${lobbyId}...`);

      await this.sendCommand('leave_lobby', {
        lobbyId: String(lobbyId)
      }, 30000);

      this.logger.log(`[DotaBotGo] Bot salió del lobby`);
      return { success: true };
    } catch (error) {
      this.logger.error('[DotaBotGo] Error saliendo del lobby:', error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * Crear lobby, invitar jugadores y salir (modo "sala fantasma")
   */
  async createLobbyAndLeave(data) {
    try {
      this.logger.log(`[DotaBotGo] Modo sala fantasma para sala ${data.salaId}...`);

      const response = await this.sendCommand('create_and_invite', {
        salaId: data.salaId,
        gameName: data.nombre || `Sala #${data.salaId}`,
        passKey: data.password || '',
        players: data.jugadores || [],
        leaveAfter: true
      }, 120000); // 120s timeout

      this.logger.log(`[DotaBotGo] Sala fantasma completada:`, response);
      
      return {
        success: true,
        lobbyId: response.lobbyId,
        password: data.password
      };
    } catch (error) {
      this.logger.error('[DotaBotGo] Error en sala fantasma:', error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * Verificar que el bot está activo
   */
  async healthCheck() {
    try {
      // Verificar Redis está conectado
      await redis.ping();
      
      // Intentar enviar un comando simple (no esperar respuesta)
      await redis.publish(this.cmdChannel, JSON.stringify({
        id: uuidv4(),
        action: 'health_check',
        payload: {}
      }));
      
      return { status: 'ok', message: 'Redis conectado, bot puede recibir comandos' };
    } catch (error) {
      return { status: 'error', message: error.message };
    }
  }

  /**
   * Obtener el jugador host guardado cuando el bot salió del lobby
   */
  getHostPlayer(salaId) {
    if (!this.hostPlayerMap) return null;
    return this.hostPlayerMap.get(String(salaId)) || null;
  }
}

// Singleton
module.exports = new DotaBotGoService();
