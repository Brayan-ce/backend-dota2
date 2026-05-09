const steamConnectionManager = require('./steam-connection-manager.js');
const steamLog = process.env.STEAM_VERBOSE_LOGS === 'true' ? (...args) => console.log(...args) : () => {};

function gcSvcInfo(...args) {
  console.log('[GC-SVC]', ...args);
}

function gcSvcError(label, err) {
  const msg = err?.message || err;
  console.log('[GC-SVC][ERROR]', label, msg);
  if (err?.stack) console.log('[GC-SVC][STACK]', err.stack);
}

class GameCoordinatorService {
  constructor() {
    this.dota2 = null;
    this.steamUser = null;
    this.isConnected = false;
  }

  async obtenerMMRReal(steamId) {
    try {
      steamLog('🚀 Obteniendo MMR real via GameCoordinator API (persistente)...');
      gcSvcInfo('Inicio obtenerMMRReal', { steamId });

      // Si la conexión al arrancar falló, intentar conectar bajo demanda aquí.
      if (!steamConnectionManager.isConnected || !steamConnectionManager.gcReady) {
        steamLog('♻️ GC no está listo; intentando reconexión bajo demanda...');
        gcSvcInfo('GC no listo, estado actual', {
          isConnected: steamConnectionManager.isConnected,
          gcReady: steamConnectionManager.gcReady,
          isConnecting: steamConnectionManager.isConnecting,
          reconnectAttempts: steamConnectionManager.reconnectAttempts,
        });
        await steamConnectionManager.connect();
        gcSvcInfo('Reconexión bajo demanda completada', {
          isConnected: steamConnectionManager.isConnected,
          gcReady: steamConnectionManager.gcReady,
        });
      }
      
      // Usar el gestor de conexión persistente
      const result = await steamConnectionManager.obtenerMMR(steamId);
      gcSvcInfo('Respuesta cruda de GC', result || null);
      
      if (result && result.mmr !== null && result.mmr !== undefined) {
        steamLog('✅ MMR obtenido exitosamente:', result.mmr);
        gcSvcInfo('MMR obtenido por GC', {
          steamId,
          mmr: result.mmr,
          rank_tier: result.rank_tier,
          rank_tier_score: result.rank_tier_score,
          fuente: result.fuente,
        });
        return result;
      } else {
        steamLog('⚠️ No se pudo obtener MMR via GameCoordinator');
        gcSvcInfo('GC respondió sin MMR útil', { steamId });
        return null;
      }
    } catch (error) {
      steamLog('❌ Error en GameCoordinator API:', error.message);
      gcSvcError(`Fallo obtenerMMRReal steamId=${steamId}`, error);
      return null;
    }
  }

  // Método alternativo usando APIs públicas como fallback
  async obtenerMMRDesdePartidas(steamId) {
    return new Promise((resolve, reject) => {
      steamLog('Usando método alternativo con APIs públicas...');
      
      // Convertir Steam ID a account ID
      const accountId = BigInt(steamId) - BigInt(76561197960265728);
      
      // Usar OpenDota como fallback rápido
      const axios = require('axios');
      axios.get(`https://api.opendota.com/api/players/${accountId.toString()}`)
        .then(response => {
          const playerData = response.data;
          let mmr = null;
          
          // Intentar obtener MMR de diferentes formas
          if (playerData.mmr_estimate && playerData.mmr_estimate.estimate) {
            mmr = Math.round(playerData.mmr_estimate.estimate);
          } else if (playerData.computed_mmr) {
            mmr = Math.round(playerData.computed_mmr);
          } else if (playerData.rank_tier) {
            // Mapeo básico de rank tier a MMR
            const rankTierMMR = {
              1: 0, 2: 100, 3: 200, 4: 300, 5: 400,
              6: 500, 7: 600, 8: 700, 9: 800, 10: 900,
              11: 1100, 12: 1500, 13: 1700, 14: 1900, 15: 2100,
              16: 2300, 17: 2500, 18: 2700, 19: 2900, 20: 3100,
              21: 3300, 22: 3500, 23: 3700, 24: 3900, 25: 4100,
              26: 4300, 27: 4500, 28: 4700, 29: 4900, 30: 5100,
              31: 5300, 32: 5500, 33: 5700, 34: 5900, 35: 6100,
              36: 6300, 37: 6500, 38: 6700, 39: 7000
            };
            mmr = rankTierMMR[playerData.rank_tier] || null;
          }
          
          if (mmr) {
            resolve({
              mmr: mmr,
              fuente: 'GameCoordinator - OpenDota Fallback',
              rank_tier: playerData.rank_tier
            });
          } else {
            resolve(null);
          }
        })
        .catch(error => {
          steamLog('Error en fallback:', error.message);
          resolve(null);
        });
    });
  }
}

module.exports = new GameCoordinatorService();
