const SteamUser = require('steam-user');
const steamLog = process.env.STEAM_VERBOSE_LOGS === 'true' ? (...args) => console.log(...args) : () => {};
const SteamTotp = require('steam-totp');

function gcInfo(...args) {
  console.log('[GC]', ...args);
}

function gcError(label, err) {
  const msg = err?.message || err;
  console.log('[GC][ERROR]', label, msg);
  if (err?.stack) console.log('[GC][STACK]', err.stack);
}

const DOTA2_APPID = 570;

// GC message types
const k_EMsgGCClientHello              = 4006;
const k_EMsgGCClientWelcome            = 4004;
const k_EMsgGCGetProfileCard           = 7533;
const k_EMsgGCGetProfileCardResponse   = 7534;
const k_EMsgClientToGCGetPlayerCardInfo = 9208;
const k_EMsgGCToClientGetPlayerCardInfoResponse = 9209;
const EMSG_PROTO_MASK = 0x7fffffff;

function normalizeGCMsgType(msgType) {
  return (msgType & EMSG_PROTO_MASK) >>> 0;
}

// rank_tier format: tens=medal (1=Herald..8=Immortal), units=star (1-5)
// Dota 2 actual MMR breakpoints (Season 2024)
const RANK_TIER_MMR = {
  11: 0,   12: 155,  13: 310,  14: 465,  15: 620,
  21: 770, 22: 925,  23: 1080, 24: 1235, 25: 1390,
  31: 1540,32: 1695, 33: 1850, 34: 2005, 35: 2160,
  41: 2310,42: 2465, 43: 2620, 44: 2775, 45: 2930,
  51: 3080,52: 3235, 53: 3390, 54: 3545, 55: 3700,
  61: 3850,62: 4005, 63: 4160, 64: 4315, 65: 4470,
  71: 4620,72: 4775, 73: 4930, 74: 5085, 75: 5245,
  80: 6000
};

const RANK_NAMES = {
  11:'Herald I',  12:'Herald II',  13:'Herald III',  14:'Herald IV',  15:'Herald V',
  21:'Guardian I',22:'Guardian II',23:'Guardian III',24:'Guardian IV',25:'Guardian V',
  31:'Crusader I',32:'Crusader II',33:'Crusader III',34:'Crusader IV',35:'Crusader V',
  41:'Archon I',  42:'Archon II',  43:'Archon III',  44:'Archon IV',  45:'Archon V',
  51:'Legend I',  52:'Legend II',  53:'Legend III',  54:'Legend IV',  55:'Legend V',
  61:'Ancient I', 62:'Ancient II', 63:'Ancient III', 64:'Ancient IV', 65:'Ancient V',
  71:'Divine I',  72:'Divine II',  73:'Divine III',  74:'Divine IV',  75:'Divine V',
  80:'Immortal'
};

// Encode varint (protobuf)
function encodeVarint(value) {
  const bytes = [];
  while (value > 127) {
    bytes.push((value & 0x7F) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return Buffer.from(bytes);
}

// Build minimal protobuf with field1=uint32
function buildProto1(accountId) {
  const tag = Buffer.from([0x08]); // field 1, wire 0
  const val = encodeVarint(accountId);
  return Buffer.concat([tag, val]);
}

// Parse protobuf fields (varint + length-delimited only)
function parseProtoFields(buf) {
  const fields = {};
  let i = 0;
  while (i < buf.length) {
    if (i >= buf.length) break;
    const tagByte = buf[i++];
    const fieldNumber = tagByte >> 3;
    const wireType = tagByte & 0x7;
    if (wireType === 0) {
      let value = 0, shift = 0;
      while (i < buf.length) {
        const b = buf[i++];
        value |= (b & 0x7F) << shift;
        if (!(b & 0x80)) break;
        shift += 7;
      }
      fields[fieldNumber] = value;
    } else if (wireType === 2) {
      let len = 0, shift = 0;
      while (i < buf.length) {
        const b = buf[i++];
        len |= (b & 0x7F) << shift;
        if (!(b & 0x80)) break;
        shift += 7;
      }
      fields[fieldNumber] = buf.slice(i, i + len);
      i += len;
    } else if (wireType === 5) {
      fields[fieldNumber] = buf.readUInt32LE(i);
      i += 4;
    } else if (wireType === 1) {
      i += 8;
    } else {
      break;
    }
  }
  return fields;
}

class SteamConnectionManager {
  constructor() {
    this.steamUser = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.gcReady = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 3;
    this.disabled = false;
    this.rateLimitUntil = 0;
    this.connectTimeoutMs = parseInt(process.env.STEAM_GC_CONNECT_TIMEOUT_MS || '60000', 10);
  }

  _getReconnectDelay() {
    return Math.min(5000 * Math.pow(2, this.reconnectAttempts), 60000);
  }

  async connect() {
    if (this.disabled) {
      const now = Date.now();
      const remainingMs = Math.max(0, this.rateLimitUntil - now);
      const remainingSec = Math.ceil(remainingMs / 1000);
      throw new Error(`RateLimitExceeded: GC bloqueado temporalmente (${remainingSec}s restantes)`);
    }
    if (this.isConnected || this.isConnecting) return this.isConnected;

    this.isConnecting = true;
    steamLog('Iniciando conexion a Steam GameCoordinator...');
    gcInfo('Iniciando conexión', {
      isConnected: this.isConnected,
      isConnecting: this.isConnecting,
      gcReady: this.gcReady,
      reconnectAttempts: this.reconnectAttempts,
      timeoutMs: this.connectTimeoutMs,
    });

    return new Promise((resolve, reject) => {
      this.steamUser = new SteamUser();

      const timeout = setTimeout(() => {
        this.isConnecting = false;
        this.isConnected = false;
        this.gcReady = false;
        this._cleanup();
        gcError('Timeout de conexión a Steam/GC', new Error(`No hubo ClientWelcome en ${this.connectTimeoutMs}ms`));
        reject(new Error('Timeout de conexion a Steam'));
      }, this.connectTimeoutMs);

      this.steamUser.on('loggedOn', () => {
        steamLog('Login exitoso a Steam');
        gcInfo('Steam loggedOn recibido. Enviando gamesPlayed para Dota 2.');
        this.steamUser.setPersona(SteamUser.EPersonaState.Online);
        // Lanzar Dota 2 para activar el GC
        this.steamUser.gamesPlayed([{ game_id: DOTA2_APPID }]);
      });

      this.steamUser.on('appLaunched', (appId) => {
        if (appId === DOTA2_APPID) {
          steamLog('Dota 2 lanzado - enviando ClientHello al GC...');
          gcInfo('appLaunched Dota2 detectado; enviando ClientHello', { appId });
          // ClientHello: field1=client_version(uint32)=1, field2=engine(uint32)=1 (SOURCE2)
          // CMsgClientHello { uint32 client_version = 1; ESourceEngine engine = 2; }
          const hello = Buffer.concat([
            Buffer.from([0x08]), encodeVarint(1),   // field1 client_version=1
            Buffer.from([0x10]), encodeVarint(1)    // field2 engine=1 (SOURCE2)
          ]);
          this.steamUser.sendToGC(DOTA2_APPID, k_EMsgGCClientHello, {}, hello);
        }
      });

      this.steamUser.on('receivedFromGC', (appId, msgType, payload) => {
        if (appId !== DOTA2_APPID) return;
        const cleanType = normalizeGCMsgType(msgType);
        if (process.env.STEAM_VERBOSE_LOGS === 'true') {
          gcInfo('Mensaje recibido de GC', { appId, msgTypeRaw: msgType, msgTypeClean: cleanType, bytes: payload?.length || 0 });
        }
        if (cleanType === k_EMsgGCClientWelcome && !this.gcReady) {
          steamLog('GC ClientWelcome recibido - GameCoordinator listo');
          gcInfo('GC listo (ClientWelcome).');
          this.gcReady = true;
          this.isConnected = true;
          this.isConnecting = false;
          this.reconnectAttempts = 0;
          clearTimeout(timeout);
          resolve(true);
        }
      });

      this.steamUser.on('error', (err) => {
        clearTimeout(timeout);
        this.isConnecting = false;
        this.isConnected = false;
        this.gcReady = false;
        steamLog('Error Steam:', err.eresult, err.message);
        gcError(`Evento error Steam (eresult=${err?.eresult})`, err);

        const isRateLimit = err.eresult === SteamUser.EResult.RateLimitExceeded ||
                            err.eresult === 84;

        if (isRateLimit) {
          steamLog('Rate limit de Steam detectado; bloqueando nuevos intentos por 5 minutos.');
          gcInfo('Rate limit detectado; no se hará retry automático.');
          this.disabled = true;
          this.rateLimitUntil = Date.now() + 300000;
        }

        reject(err);
      });

      this.steamUser.on('steamGuard', (domain, callback) => {
        if (process.env.STEAM_SHARED_SECRET) {
          const code = SteamTotp.generateAuthCode(process.env.STEAM_SHARED_SECRET);
          steamLog('Steam Guard OK (TOTP)');
          gcInfo('SteamGuard solicitado; enviando TOTP', { domain: domain || 'unknown' });
          callback(code);
        } else {
          clearTimeout(timeout);
          this.isConnecting = false;
          gcError('SteamGuard sin shared secret', new Error('Falta STEAM_SHARED_SECRET'));
          reject(new Error('Se requiere STEAM_SHARED_SECRET en .env'));
        }
      });

      this.steamUser.on('disconnected', (eresult, msg) => {
        steamLog('Desconectado de Steam:', msg);
        gcInfo('Steam desconectado', { eresult, msg });
        this.isConnected = false;
        this.gcReady = false;
      });

      const logOnOptions = {
        accountName: process.env.STEAM_USERNAME,
        password: process.env.STEAM_PASSWORD
      };

      if (process.env.STEAM_SHARED_SECRET) {
        logOnOptions.twoFactorCode = SteamTotp.generateAuthCode(process.env.STEAM_SHARED_SECRET);
      }

      gcInfo('Ejecutando logOn a Steam', {
        accountName: !!logOnOptions.accountName,
        hasPassword: !!logOnOptions.password,
        hasTwoFactorCode: !!logOnOptions.twoFactorCode,
      });

      this.steamUser.logOn(logOnOptions);
    });
  }

  _cleanup() {
    try {
      if (this.steamUser) this.steamUser.logOff();
    } catch (e) {}
    this.steamUser = null;
    this.isConnected = false;
    this.gcReady = false;
  }

  // Obtener perfil completo de Dota 2 via GC
  async obtenerPerfilCompleto(steamId) {
    if (!this.isConnected || !this.gcReady) {
      gcInfo('obtenerPerfilCompleto abortado: GC no disponible', {
        isConnected: this.isConnected,
        gcReady: this.gcReady,
      });
      throw new Error('GameCoordinator no disponible');
    }

    const accountId = Number(BigInt(steamId) - BigInt(76561197960265728));
    const payload = buildProto1(accountId);
    gcInfo('Solicitando perfil GC', { steamId, accountId });

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        this.steamUser.removeListener('receivedFromGC', handler);
        gcError('Timeout esperando respuesta de perfil GC', new Error(`steamId=${steamId} accountId=${accountId}`));
        reject(new Error('Timeout GC ProfileCard'));
      }, 15000);

      const handler = (appId, msgType, buf) => {
        if (appId !== DOTA2_APPID || settled) return;
        const cleanType = normalizeGCMsgType(msgType);
        if (cleanType !== k_EMsgGCGetProfileCardResponse && cleanType !== k_EMsgGCToClientGetPlayerCardInfoResponse) return;
        clearTimeout(timer);
        settled = true;
        this.steamUser.removeListener('receivedFromGC', handler);
        gcInfo('Respuesta de perfil GC recibida', { steamId, msgTypeRaw: msgType, msgTypeClean: cleanType, bytes: buf?.length || 0 });

        try {
          const f = parseProtoFields(buf);
          steamLog('GC ProfileCard fields:', JSON.stringify(f));

          // CMsgDOTAProfileCard fields:
          // 1=account_id, 2=badge_points, 3=event_points, 4=event_id
          // 5=recent_battle_cup_victory, 6=rank_tier, 7=leaderboard_rank
          // 8=is_plus_subscriber, 9=plus_original_start_date
          // 10=rank_tier_score (calibrated MMR if available)
          const rankTier        = f[6]  || null;
          const leaderboardRank = f[7]  || null;
          const rankTierScore   = f[10] || null;
          const badgePoints     = f[2]  || null;
          const isPlusSubscriber= f[8]  || null;

          const mmr = rankTierScore && rankTierScore > 0
            ? rankTierScore
            : (rankTier ? RANK_TIER_MMR[rankTier] || null : null);

          gcInfo('Datos parseados de perfil GC', {
            steamId,
            rankTier,
            rankTierScore,
            leaderboardRank,
            mmr,
          });

          resolve({
            mmr,
            rank_tier: rankTier,
            rank_name: rankTier ? RANK_NAMES[rankTier] || null : null,
            leaderboard_rank: leaderboardRank,
            rank_tier_score: rankTierScore,
            badge_points: badgePoints,
            is_plus_subscriber: !!isPlusSubscriber,
            fuente: 'GameCoordinator API (Dota 2 GC)'
          });
        } catch (e) {
          gcError('Error parseando payload de perfil GC', e);
          reject(e);
        }
      };

      this.steamUser.on('receivedFromGC', handler);
      // Enviar ambos requests; dependiendo de versión/estado del GC puede responder uno u otro.
      gcInfo('Enviando requests de perfil al GC', {
        msgProfileCard: k_EMsgGCGetProfileCard,
        msgPlayerCardInfo: k_EMsgClientToGCGetPlayerCardInfo,
      });
      this.steamUser.sendToGC(DOTA2_APPID, k_EMsgGCGetProfileCard, {}, payload);
      this.steamUser.sendToGC(DOTA2_APPID, k_EMsgClientToGCGetPlayerCardInfo, {}, payload);
    });
  }

  // Alias para compatibilidad con código existente
  async obtenerMMR(steamId) {
    return this.obtenerPerfilCompleto(steamId);
  }

  async disconnect() {
    this.disabled = true;
    this._cleanup();
    steamLog('Desconectado de Steam');
  }
}

module.exports = new SteamConnectionManager();
