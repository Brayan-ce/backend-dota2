const axios = require('axios');
const steamLog = process.env.STEAM_VERBOSE_LOGS === 'true' ? (...args) => console.log(...args) : () => {};

class SteamService {
  constructor() {
    this.apiKey = process.env.STEAM_API_KEY;
    this.baseUrl = 'https://api.steampowered.com';
  }

  // Obtener información de un jugador
  async obtenerJugador(steamId) {
    try {
      const url = `${this.baseUrl}/ISteamUser/GetPlayerSummaries/v0002/`;
      const params = {
        key: this.apiKey,
        steamids: steamId
      };
      
      steamLog('Haciendo petición a Steam API:');
      steamLog('URL:', url);
      steamLog('Params:', params);
      
      const response = await axios.get(url, { params });
      
      steamLog('Respuesta de Steam API:', JSON.stringify(response.data, null, 2));
      
      const players = response.data.response.players;
      const player = players.length > 0 ? players[0] : null;
      
      steamLog('Player encontrado:', player);
      
      return player;
    } catch (error) {
      console.error('Error al obtener información del jugador:', error.message);
      console.error('Error completo:', error);
      throw new Error('No se pudo obtener información del jugador');
    }
  }

  // Obtener estadísticas de Dota 2 de un jugador
  async obtenerEstadisticasDota(steamId) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/IEconDOTA2_570/GetHeroes/v0001/`,
        {
          params: {
            key: this.apiKey,
            language: 'spanish'
          }
        }
      );
      
      return response.data.result.heroes;
    } catch (error) {
      console.error('Error al obtener estadísticas de Dota 2:', error.message);
      throw new Error('No se pudo obtener estadísticas de Dota 2');
    }
  }

  // Obtener partidas recientes de un jugador
  async obtenerPartidasRecientes(steamId) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/IDOTA2Match_570/GetMatchHistory/v001/`,
        {
          params: {
            key: this.apiKey,
            account_id: steamId,
            matches_requested: 10
          }
        }
      );
      
      return response.data.result.matches;
    } catch (error) {
      console.error('Error al obtener partidas recientes:', error.message);
      throw new Error('No se pudo obtener partidas recientes');
    }
  }

  // Obtener detalles de una partida específica
  async obtenerDetallesPartida(matchId) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/IDOTA2Match_570/GetMatchDetails/v001/`,
        {
          params: {
            key: this.apiKey,
            match_id: matchId
          }
        }
      );
      
      return response.data.result;
    } catch (error) {
      console.error('Error al obtener detalles de la partida:', error.message);
      throw new Error('No se pudo obtener detalles de la partida');
    }
  }

  // Validar Steam ID
  validarSteamId(steamId) {
    // Steam IDs son números de 17 dígitos que empiezan con 7656119
    // Después de 7656119 pueden venir entre 9 y 11 dígitos dependiendo de la generación
    const steamIdRegex = /^7656119\d{8,11}$/;
    
    const steamIdStr = steamId.toString();
    const isValid = steamIdRegex.test(steamIdStr);
    
    steamLog(`Validando Steam ID: ${steamIdStr}, longitud: ${steamIdStr.length}, válido: ${isValid}`);
    steamLog(`Tu Steam ID después de 7656119: ${steamIdStr.substring(7)} (longitud: ${steamIdStr.substring(7).length})`);
    
    return isValid;
  }

  // Obtener estadísticas reales de Dota 2 usando OpenDota API
  async obtenerEstadisticasDota2(steamId) {
    try {
      steamLog('Obteniendo estadísticas reales de Dota 2 para:', steamId);
      
      // Convertir SteamID a accountID para Dota 2 API
      const accountId = BigInt(steamId) - BigInt(76561197960265728);
      steamLog('AccountID para Dota 2:', accountId.toString());

      // Esta ruta es experimental y NO debe disparar GameCoordinator.
      // Se limita a OpenDota/STRATZ para reservar GC al flujo exacto por cola.
      // FALLBACK: OpenDota/STRATZ/Steam API
      // Intentar con OpenDota API (más confiable y no requiere Steam API key)
      try {
        steamLog('Intentando con OpenDota API para MMR ranked...');
        
        // Primero intentar obtener el MMR ranked real
        try {
          const mmrResponse = await axios.get(
            `https://api.opendota.com/api/players/${accountId.toString()}/ratings`
          );
          
          const mmrData = mmrResponse.data;
          steamLog('Datos de MMR de OpenDota:', JSON.stringify(mmrData, null, 2));
          
          // Buscar MMR de ranked solo (no turbo)
          const rankedMMR = mmrData.find(r => r.attr === 'solo_competitive');
          
          if (rankedMMR && rankedMMR.score) {
            const mmr = Math.round(rankedMMR.score);
            steamLog('MMR ranked real obtenido de OpenDota:', mmr);
            
            return {
              mmr: mmr,
              partidasJugadas: 0,
              winRate: 0,
              rank_tier: null,
              leaderboard_rank: null,
              fuente: 'OpenDota Ranked'
            };
          }
        } catch (mmrError) {
          steamLog('Endpoint de MMR ranked falló, intentando con datos generales...');
        }
        
        // Si no hay MMR ranked, intentar con datos generales
        const openDotaResponse = await axios.get(
          `https://api.opendota.com/api/players/${accountId.toString()}`
        );
        
        const playerData = openDotaResponse.data;
        steamLog('Datos generales de OpenDota:', JSON.stringify(playerData, null, 2));
        
        // Sistema mejorado: múltiples métodos para obtener MMR real
        let mmr = null;
        let fuente = 'No disponible';
        
        // 2. SISTEMA AUTOMÁTICO - APIs públicas como fallback
        // Método 1: OpenDota mmr_estimate (más confiable)
        if (playerData.mmr_estimate && playerData.mmr_estimate.estimate) {
          mmr = Math.round(playerData.mmr_estimate.estimate);
          fuente = 'OpenDota MMR Estimate';
          steamLog('MMR estimate encontrado:', mmr);
          
          return {
            mmr: mmr,
            partidasJugadas: playerData.profile?.total_matches || 0,
            winRate: playerData.winrate || 0,
            rank_tier: playerData.rank_tier,
            leaderboard_rank: playerData.leaderboard_rank,
            fuente: fuente
          };
        }
        
        // Método 2: computed_mmr (segunda opción)
        if (playerData.computed_mmr) {
          mmr = Math.round(playerData.computed_mmr);
          fuente = 'OpenDota Computed MMR';
          steamLog('Computed MMR encontrado:', mmr);
          
          return {
            mmr: mmr,
            partidasJugadas: playerData.profile?.total_matches || 0,
            winRate: playerData.winrate || 0,
            rank_tier: playerData.rank_tier,
            leaderboard_rank: playerData.leaderboard_rank,
            fuente: fuente
          };
        }
        
        // Método 3: Mapeo por rank_tier (fallback)
        if (playerData.rank_tier) {
          const rankTierMMRMapping = {
            1: 0, 2: 100, 3: 200, 4: 300, 5: 400,        // Herald
            6: 500, 7: 600, 8: 700, 9: 800, 10: 900,     // Guardian
            11: 1100, 12: 1500, 13: 1700, 14: 1900, 15: 2100, // Crusader
            16: 2300, 17: 2500, 18: 2700, 19: 2900, 20: 3100, // Archon
            21: 3300, 22: 3500, 23: 3700, 24: 3900, 25: 4100, // Legend
            26: 4300, 27: 4500, 28: 4700, 29: 4900, 30: 5100, // Ancient
            31: 5300, 32: 5500, 33: 5700, 34: 5900, 35: 6100, // Divine
            36: 6300, 37: 6500, 38: 6700, 39: 7000          // Divine/Immortal
          };
          
          mmr = rankTierMMRMapping[playerData.rank_tier] || null;
          fuente = 'Rank Tier Mapping';
          steamLog('MMR por rank_tier:', mmr, '(rank_tier:', playerData.rank_tier, ')');
          
          if (mmr) {
            return {
              mmr: mmr,
              partidasJugadas: playerData.profile?.total_matches || 0,
              winRate: playerData.winrate || 0,
              rank_tier: playerData.rank_tier,
              leaderboard_rank: playerData.leaderboard_rank,
              fuente: fuente
            };
          }
        }
        
        // 2. Si GameCoordinator falla, intentar OpenDota
        try {
          const ratingsResponse = await axios.get(
            `https://api.opendota.com/api/players/${accountId.toString()}/ratings`
          );
          
          const ratingsData = ratingsResponse.data;
          steamLog('Datos de ratings de OpenDota:', JSON.stringify(ratingsData, null, 2));
          
          // Buscar MMR de ranked solo
          const rankedMMR = ratingsData.find(r => r.attr === 'solo_competitive');
          
          if (rankedMMR && rankedMMR.score) {
            mmr = Math.round(rankedMMR.score);
            fuente = 'OpenDota Ranked Real';
            steamLog('MMR ranked real encontrado:', mmr);
          }
        } catch (ratingsError) {
          steamLog('No se pudo obtener MMR ranked real:', ratingsError.message);
        }
        
        // 2. Priorizar STRATZ API - la mejor plataforma profesional
        try {
          steamLog('Intentando con STRATZ API (mejor plataforma)...');
          const stratzResponse = await axios.get(
            `https://api.stratz.com/api/v1/player/${accountId.toString()}`
          );
          
          const stratzData = stratzResponse.data;
          steamLog('Datos de STRATZ:', JSON.stringify(stratzData, null, 2));
          
          // STRATZ tiene múltiples formas de obtener MMR
          if (stratzData.rankTier) {
            // MMR basado en rank tier de STRATZ (más preciso)
            const stratzMMR = {
              1: 0,     // Herald 1
              2: 100,   // Herald 2
              3: 200,   // Herald 3
              4: 300,   // Herald 4
              5: 400,   // Herald 5
              6: 500,   // Guardian 1
              7: 600,   // Guardian 2
              8: 700,   // Guardian 3
              9: 800,   // Guardian 4
              10: 900,  // Guardian 5
              11: 1000, // Crusader 1
              12: 1200, // Crusader 2
              13: 1400, // Crusader 3
              14: 1600, // Crusader 4
              15: 1800, // Crusader 5
              16: 2000, // Archon 1
              17: 2200, // Archon 2
              18: 2400, // Archon 3
              19: 2600, // Archon 4
              20: 2800, // Archon 5
              21: 3000, // Legend 1
              22: 3200, // Legend 2
              23: 3400, // Legend 3
              24: 3600, // Legend 4
              25: 3800, // Legend 5
              26: 4000, // Ancient 1
              27: 4200, // Ancient 2
              28: 4400, // Ancient 3
              29: 4600, // Ancient 4
              30: 4800, // Ancient 5
              31: 5000, // Divine 1
              32: 5200, // Divine 2
              33: 5400, // Divine 3
              34: 5600, // Divine 4
              35: 5800, // Divine 5
              36: 6000, // Divine 6
              37: 6200, // Divine 7
              38: 6400, // Divine 8
              39: 7000, // Immortal
            };
            
            mmr = stratzMMR[stratzData.rankTier] || null;
            if (mmr) {
              fuente = 'STRATZ Profesional';
              steamLog('MMR encontrado en STRATZ:', mmr, '(rankTier:', stratzData.rankTier, ')');
            }
          }
          
          // Intentar obtener MMR real de ranking si está disponible
          if (!mmr && stratzData.leaderboardRank) {
            try {
              const rankingResponse = await axios.get(
                `https://api.stratz.com/api/v1/player/${accountId.toString()}/ranking`
              );
              
              const rankingData = rankingResponse.data;
              if (rankingData.rank) {
                mmr = Math.round(rankingData.rank);
                fuente = 'STRATZ Ranked Real';
                steamLog('MMR real encontrado en STRATZ ranking:', mmr);
              }
            } catch (rankingError) {
              steamLog('STRATZ ranking no disponible');
            }
          }
          
        } catch (stratzError) {
          steamLog('STRATZ API falló:', stratzError.message);
        }
        
        // 3. Si no hay MMR real, usar rank_tier como estimación (mejor que nada)
        if (!mmr && playerData.rank_tier) {
          const rankTierToMMR = {
            10: 0,    // Herald 1
            11: 100,  // Herald 2
            12: 200,  // Herald 3
            13: 300,  // Herald 4
            14: 400,  // Herald 5
            20: 500,  // Guardian 1
            21: 600,  // Guardian 2
            22: 700,  // Guardian 3
            23: 800,  // Guardian 4
            24: 900,  // Guardian 5
            30: 1000, // Crusader 1
            31: 1200, // Crusader 2
            32: 1400, // Crusader 3
            33: 1600, // Crusader 4
            34: 1800, // Crusader 5
            40: 2000, // Archon 1
            41: 2200, // Archon 2
            42: 2400, // Archon 3
            43: 2600, // Archon 4
            44: 2800, // Archon 5
            50: 3000, // Legend 1
            51: 3200, // Legend 2
            52: 3400, // Legend 3
            53: 3600, // Legend 4
            54: 3800, // Legend 5
            60: 4000, // Ancient 1
            61: 4200, // Ancient 2
            62: 4400, // Ancient 3
            63: 4600, // Ancient 4
            64: 4800, // Ancient 5
            70: 5000, // Divine 1
            71: 5200, // Divine 2
            72: 5400, // Divine 3
            73: 5600, // Divine 4
            74: 5800, // Divine 5
            75: 6000, // Divine 6
            76: 6200, // Divine 7
            77: 6400, // Divine 8
            80: 7000, // Immortal
          };
          
          mmr = rankTierToMMR[playerData.rank_tier] || null;
          if (mmr) {
            fuente = 'Rank Tier Estimado';
            steamLog('MMR estimado basado en rank_tier:', mmr, '(rank_tier:', playerData.rank_tier, ')');
          }
        }
        
        // 4. Si todavía no hay MMR, intentar forzar sincronización con OpenDota
        if (!mmr) {
          try {
            steamLog('Intentando forzar sincronización con OpenDota...');
            await axios.post(
              `https://api.opendota.com/api/players/${accountId.toString()}/refresh`
            );
            steamLog('Sincronización forzada iniciada - intentando obtener datos...');
            
            // Esperar un momento y reintentar
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            const retryResponse = await axios.get(
              `https://api.opendota.com/api/players/${accountId.toString()}/ratings`
            );
            
            const retryData = retryResponse.data;
            const retryMMR = retryData.find(r => r.attr === 'solo_competitive');
            
            if (retryMMR && retryMMR.score) {
              mmr = Math.round(retryMMR.score);
              fuente = 'OpenDota Sincronizado';
              steamLog('MMR encontrado después de sincronización:', mmr);
            }
          } catch (syncError) {
            steamLog('Sincronización forzada falló:', syncError.message);
          }
        }
        
        // 5. Último recurso: si no hay nada, dejar null
        if (!mmr) {
          steamLog('MMR no disponible después de todos los intentos');
          return null;
        }
        
        // 3. Si no hay nada, no poner MMR (null) para que se intente con otros métodos
        if (!mmr) {
          steamLog('No se pudo determinar MMR de OpenDota, intentando otros métodos...');
          return null; // Devolver null para que intente con Steam API
        }
        
        if (mmr) {
          return {
            mmr: mmr,
            partidasJugadas: playerData.profile?.total_matches || 0,
            winRate: playerData.winrate || 0,
            rank_tier: playerData.rank_tier,
            leaderboard_rank: playerData.leaderboard_rank,
            fuente: fuente
          };
        }
      } catch (openDotaError) {
        steamLog('OpenDota API falló, intentando con Steam API...');
        steamLog('Error OpenDota:', openDotaError.message);
      }
      
      // Si OpenDota falla, intentar con Steam API
      try {
        steamLog('Intentando con Steam API oficial...');
        
        // Obtener partidas recientes del jugador
        const partidasResponse = await axios.get(
          `${this.baseUrl}/IDOTA2Match_570/GetMatchHistory/v001/`,
          {
            params: {
              key: this.apiKey,
              account_id: accountId.toString(),
              matches_requested: 50
            }
          }
        );
        
        const result = partidasResponse.data.result;
        const partidas = result ? result.matches : [];
        steamLog('Partidas obtenidas de Steam API:', partidas.length);
        
        if (partidas && partidas.length > 0) {
          // Calcular MMR basado en partidas recientes
          let partidasAnalizadas = 0;
          let partidasGanadas = 0;
          
          // Analizar primeras 10 partidas para no hacer demasiadas peticiones
          for (let i = 0; i < Math.min(10, partidas.length); i++) {
            try {
              const partida = partidas[i];
              
              // Obtener detalles básicos de la partida
              const detallesResponse = await axios.get(
                `${this.baseUrl}/IDOTA2Match_570/GetMatchDetails/v001/`,
                {
                  params: {
                    key: this.apiKey,
                    match_id: partida.match_id
                  }
                }
              );
              
              const detalles = detallesResponse.data.result;
              const jugador = detalles.players.find(p => p.account_id === accountId.toString());
              
              if (jugador) {
                partidasAnalizadas++;
                
                // Determinar si ganó
                const ganoRadiante = detalles.radiant_win;
                const estabaRadiante = jugador.player_slot < 128;
                
                if ((ganoRadiante && estabaRadiante) || (!ganoRadiante && !estabaRadiante)) {
                  partidasGanadas++;
                }
              }
            } catch (error) {
              steamLog('Error analizando partida:', error.message);
            }
          }
          
          const winRate = partidasAnalizadas > 0 ? (partidasGanadas / partidasAnalizadas) * 100 : 50;
          
          // Calcular MMR basado en win rate
          let mmr = 1500; // Base
          if (winRate > 60) mmr = 3000 + (winRate - 60) * 50;
          else if (winRate > 55) mmr = 2500 + (winRate - 55) * 100;
          else if (winRate > 50) mmr = 2000 + (winRate - 50) * 100;
          else if (winRate > 45) mmr = 1500 + (winRate - 45) * 100;
          else if (winRate < 40) mmr = 1000;
          
          mmr = Math.max(0, Math.min(9000, mmr));
          
          steamLog('MMR calculado con Steam API:', mmr, 'Win rate:', winRate);
          
          return {
            mmr: mmr,
            partidasJugadas: partidas.length,
            winRate: Math.round(winRate * 100) / 100,
            partidasGanadas,
            fuente: 'Steam API'
          };
        }
      } catch (steamError) {
        steamLog('Steam API también falló:', steamError.message);
      }
      
      // Si todo falla, no inventar MMR - retornar null para manejarlo apropiadamente
      steamLog('No se pudo obtener MMR real de ninguna fuente');
      return {
        mmr: null, // No hay MMR disponible - no inventar valores
        partidasJugadas: 0,
        winRate: 0,
        fuente: 'No disponible',
        error: true
      };
      
    } catch (error) {
      console.error('Error general al obtener estadísticas de Dota 2:', error.message);
      return {
        mmr: null, // No inventar MMR en caso de error
        partidasJugadas: 0,
        winRate: 0,
        fuente: 'Error',
        error: true
      };
    }
  }
}

module.exports = new SteamService();
