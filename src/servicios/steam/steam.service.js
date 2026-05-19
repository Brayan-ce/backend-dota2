const axios = require('axios');

const STEAM_API_KEY = process.env.STEAM_API_KEY;
const OPEN_DOTA_API = 'https://api.opendota.com/api';
const STRATZ_API = 'https://api.stratz.com/api/v1';
const STRATZ_TOKEN = process.env.STRATZ_TOKEN;

class SteamService {
  // Validar formato de Steam ID
  validarSteamId(steamId) {
    if (!steamId) return false;
    const sid = String(steamId).trim();
    return /^7656119\d{10}$/.test(sid);
  }

  // Convertir Steam ID 64 a Steam ID 32 (para OpenDota)
  steamId64To32(steamId64) {
    const sid = BigInt(steamId64);
    const y = sid & BigInt(0xFFFFFFFF);
    return y.toString();
  }

  // Obtener datos del jugador desde Steam API
  async obtenerJugador(steamId) {
    try {
      if (!STEAM_API_KEY) {
        console.warn('STEAM_API_KEY no configurada');
        return null;
      }

      const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${STEAM_API_KEY}&steamids=${steamId}`;
      const response = await axios.get(url, { timeout: 10000 });
      
      const players = response.data?.response?.players;
      if (players && players.length > 0) {
        return players[0];
      }
      return null;
    } catch (error) {
      console.error('Error obteniendo datos de Steam:', error.message);
      return null;
    }
  }

  // Obtener estadísticas de Dota 2 desde OpenDota y STRATZ
  async obtenerEstadisticasDota2(steamId) {
    try {
      const steamId32 = this.steamId64To32(steamId);
      
      // Intentar con OpenDota primero
      try {
        const openDotaUrl = `${OPEN_DOTA_API}/players/${steamId32}`;
        const response = await axios.get(openDotaUrl, { timeout: 10000 });
        
        const data = response.data;
        if (data && data.mmr_estimate && data.mmr_estimate.estimate) {
          return {
            mmr: data.mmr_estimate.estimate,
            fuente: 'OpenDota',
            rank_tier: data.rank_tier || null,
            leaderboard_rank: data.leaderboard_rank || null,
            profile: data.profile || null
          };
        }
      } catch (openDotaError) {
        console.log('OpenDota no disponible, intentando STRATZ...');
      }

      // Fallback a STRATZ
      if (STRATZ_TOKEN) {
        try {
          const stratzUrl = `${STRATZ_API}/player/${steamId32}`;
          const response = await axios.get(stratzUrl, {
            headers: { Authorization: `Bearer ${STRATZ_TOKEN}` },
            timeout: 10000
          });
          
          const data = response.data;
          if (data && data.rating) {
            return {
              mmr: data.rating,
              fuente: 'STRATZ',
              rank_tier: data.rankTier || null,
              leaderboard_rank: data.leaderboardRank || null
            };
          }
        } catch (stratzError) {
          console.log('STRATZ no disponible');
        }
      }

      return { mmr: null, fuente: 'No disponible' };
    } catch (error) {
      console.error('Error obteniendo estadísticas Dota 2:', error.message);
      return { mmr: null, fuente: 'Error', error: error.message };
    }
  }

  // Obtener detalles de una partida desde OpenDota
  async obtenerDetallesPartida(matchId) {
    try {
      const url = `${OPEN_DOTA_API}/matches/${matchId}`;
      const response = await axios.get(url, { timeout: 15000 });
      return response.data;
    } catch (error) {
      console.error('Error obteniendo detalles de partida:', error.message);
      return null;
    }
  }
}

module.exports = new SteamService();
