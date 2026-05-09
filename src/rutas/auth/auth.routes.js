const express = require('express');
const router = express.Router();
const authService = require('../../servicios/auth/auth.service');
const steamService = require('../../servicios/steam/steam.service');
const gameCoordinatorService = require('../../servicios/steam/gamecoordinator.service');
const steamConnectionManager = require('../../servicios/steam/steam-connection-manager');
const emailService = require('../../servicios/email/email.service');
const Usuario = require('../../modelos/usuario/usuario.model');
const db = require('../../config/database');
const { verificarToken } = require('../../middleware/auth');
const { esUsuarioSuperadmin } = require('../../middleware/auth');

function generarCodigo() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ─── REGISTRO ───────────────────────────────────────────────
// REGISTRO PASO 1: Validar Steam ID, obtener datos Steam, enviar código
router.post('/registro/send-code', async (req, res) => {
  try {
    const { steamId, email } = req.body;

    if (!steamId) return res.status(400).json({ error: 'Steam ID inválido: se requiere el Steam ID' });
    if (!steamService.validarSteamId(steamId)) {
      return res.status(400).json({ error: 'Steam ID inválido: debe ser un número de 17 dígitos que empiece por 7656119' });
    }
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Ingresa un email válido' });
    }

    const existente = await Usuario.buscarPorSteamId(steamId);
    if (existente) {
      return res.status(409).json({ error: 'Esta cuenta de Steam ya está registrada. Inicia sesión.' });
    }

    const emailExistente = await db.query('SELECT id FROM usuarios WHERE email = $1', [email]);
    if (emailExistente.rows.length > 0) {
      return res.status(409).json({ error: 'Este email ya está registrado en otra cuenta.' });
    }

    const jugadorSteam = await steamService.obtenerJugador(steamId);
    if (!jugadorSteam) return res.status(404).json({ error: 'Steam ID no encontrado en Steam' });

    const codigo = generarCodigo();
    await Usuario.guardarCodigo(steamId, codigo);
    await emailService.enviarCodigoVerificacion(email, codigo, jugadorSteam.personaname);

    res.json({
      mensaje: 'Código enviado',
      emailMask: email.replace(/(.{2}).+(@.+)/, '$1***$2'),
      nombreUsuario: jugadorSteam.personaname,
      avatar: jugadorSteam.avatarfull
    });
  } catch (error) {
    console.error('Error en registro send-code:', error);
    res.status(500).json({ error: 'Error al enviar el código. Intenta de nuevo.' });
  }
});

// REGISTRO PASO 2: Verificar código y crear cuenta
router.post('/registro/completar', async (req, res) => {
  try {
    const { steamId, codigo, email, telefono, nombreReal, pais, referidoSteamId } = req.body;

    if (!steamId || !codigo || !email) {
      return res.status(400).json({ error: 'Faltan datos requeridos' });
    }

    console.log('📋 Registro COMPLETAR - Datos recibidos:', { steamId, codigo, email });

    const valido = await Usuario.verificarCodigo(steamId, codigo);
    console.log('✓ Verificación de código:', valido ? 'EXITOSA' : 'FALLIDA');
    if (!valido) {
      console.log('❌ Código incorrecto para steamId:', steamId, 'código:', codigo);
      return res.status(401).json({ error: 'Código incorrecto o expirado' });
    }

    const jugadorSteam = await steamService.obtenerJugador(steamId);

    const usuario = await Usuario.registrar({
      steamId,
      nombreUsuario: jugadorSteam.personaname,
      avatar: jugadorSteam.avatarfull,
        mmr: null,
      email,
      telefono: telefono || null,
      nombreReal: nombreReal || null,
      pais: pais || null
    });

    // Registrar referido solo cuando el registro ya fue verificado y el usuario existe en BD.
    if (referidoSteamId && referidoSteamId !== steamId) {
      try {
        const referidorR = await db.query('SELECT id FROM usuarios WHERE steam_id = $1 LIMIT 1', [referidoSteamId]);
        const idReferidor = referidorR.rows[0]?.id || null;
        if (idReferidor && idReferidor !== usuario.id) {
          await db.query(
            `INSERT INTO referidos (id_usuario, id_referido, bono_otorgado)
             VALUES ($1, $2, FALSE)
             ON CONFLICT (id_referido) DO NOTHING`,
            [idReferidor, usuario.id]
          );
        }
      } catch (refErr) {
        console.error('No se pudo registrar referido en alta de usuario:', refErr.message);
      }
    }

    const token = authService.generarToken(usuario);

    res.json({
      mensaje: 'Registro exitoso',
      token,
      usuario: {
        id: usuario.id,
        steamId: usuario.steam_id,
        nombreUsuario: usuario.nombre_usuario,
        avatar: usuario.avatar,
        email: usuario.email,
          mmr: usuario.mmr ?? null,
        saldo: usuario.saldo || 0,
        bono: usuario.bono || 0,
        nivel: usuario.nivel || 1,
        pais: usuario.pais || null,
        creado_en: usuario.creado_en || null,
        alertaBonoRegistroPendiente: usuario.bono_bienvenida_alerta_mostrada === false,
      }
    });
  } catch (error) {
    console.error('Error en registro completar:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Esta cuenta ya está registrada' });
    }
    res.status(500).json({ error: 'Error al crear la cuenta. Intenta de nuevo.' });
  }
});

// ─── LOGIN ───────────────────────────────────────────────────
// PASO 1: Validar Steam ID y enviar código al email
router.post('/steam/send-code', async (req, res) => {
  try {
    const { steamId, email } = req.body;

    if (!steamId) return res.status(400).json({ error: 'Steam ID inválido: se requiere el Steam ID' });
    if (!steamService.validarSteamId(steamId)) {
      return res.status(400).json({ error: 'Steam ID inválido: debe ser un número de 17 dígitos que empiece por 7656119' });
    }
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Ingresa un email válido para recibir el código' });
    }

    const usuario = await Usuario.buscarPorSteamId(steamId);
    if (!usuario) {
      return res.status(404).json({ error: 'Esta cuenta de Steam no está registrada. Ve a Registro para crear tu cuenta.' });
    }
    if (!usuario.email) {
      return res.status(400).json({ error: 'Tu cuenta no tiene email registrado. Contacta al soporte.' });
    }
    if (usuario.email.toLowerCase() !== email.toLowerCase()) {
      return res.status(400).json({ error: 'El email no coincide con el registrado para esta cuenta de Steam.' });
    }

    const jugadorSteam = await steamService.obtenerJugador(steamId);
    if (!jugadorSteam) return res.status(404).json({ error: 'Steam ID no encontrado en Steam. Verifica que sea correcto.' });

    const codigo = generarCodigo();
    await Usuario.guardarCodigo(steamId, codigo);
    await emailService.enviarCodigoVerificacion(usuario.email, codigo, jugadorSteam.personaname);

    res.json({
      mensaje: 'Código enviado al email',
      emailMask: usuario.email.replace(/(.{2}).+(@.+)/, '$1***$2'),
      nombreUsuario: jugadorSteam.personaname,
      avatar: jugadorSteam.avatarfull
    });
  } catch (error) {
    console.error('Error enviando código:', error);
    res.status(500).json({ error: 'Error al enviar el código. Intenta de nuevo.' });
  }
});

// PASO 2: Verificar código y completar login
router.post('/steam/verify-code', async (req, res) => {
  try {
    const { steamId, codigo, email } = req.body;

    if (!steamId || !codigo) return res.status(400).json({ error: 'Steam ID y código son requeridos' });

    const usuario = await Usuario.buscarPorSteamId(steamId);
    if (!usuario) {
      return res.status(404).json({ error: 'Esta cuenta de Steam no está registrada.' });
    }

    const valido = await Usuario.verificarCodigo(steamId, codigo);
    if (!valido) return res.status(401).json({ error: 'Código incorrecto o expirado' });

    const resultado = await authService.autenticarSteam(steamId);

    res.json({ mensaje: 'Autenticación exitosa', ...resultado });
  } catch (error) {
    console.error('Error verificando código:', error);
    res.status(500).json({ error: 'Error en la verificación' });
  }
});

// Ruta para refrescar datos del usuario
router.get('/refrescar', verificarToken, async (req, res) => {
  try {
    const usuario = await authService.refrescarDatosUsuario(req.usuario.steamId);
    
    res.json({
      mensaje: 'Datos actualizados',
      usuario
    });
  } catch (error) {
    console.error('Error al refrescar datos:', error);
    res.status(500).json({ 
      error: 'Error al actualizar datos' 
    });
  }
});

// Ruta para verificar token
router.get('/verificar', verificarToken, async (req, res) => {
  try {
    const usuarioDB = await Usuario.buscarPorSteamId(req.usuario.steamId);
    if (!usuarioDB) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({
      mensaje: 'Token válido',
      usuario: {
        id: usuarioDB.id,
        steamId: usuarioDB.steam_id,
        nombreUsuario: usuarioDB.nombre_usuario,
        avatar: usuarioDB.avatar,
          mmr: usuarioDB.mmr ?? null,
        saldo: usuarioDB.saldo ?? 0,
        bono: usuarioDB.bono ?? 0,
        nivel: usuarioDB.nivel ?? 1,
        email: usuarioDB.email,
        pais: usuarioDB.pais || null,
        creado_en: usuarioDB.creado_en || null,
        alertaBonoRegistroPendiente: usuarioDB.bono_bienvenida_alerta_mostrada === false,
        esSuperadmin: esUsuarioSuperadmin({ steamId: usuarioDB.steam_id }),
      }
    });
  } catch (error) {
    console.error('Error al verificar token:', error);
    res.status(500).json({ error: 'Error al verificar token' });
  }
});

router.post('/bono-bienvenida/marcar-visto', verificarToken, async (req, res) => {
  try {
    await db.query(
      `UPDATE usuarios
       SET bono_bienvenida_alerta_mostrada = TRUE,
           actualizado_en = NOW()
       WHERE id = $1`,
      [req.usuario.id]
    );

    return res.json({ ok: true, mensaje: 'Alerta de bono de bienvenida marcada como vista' });
  } catch (error) {
    console.error('Error al marcar alerta de bono bienvenida:', error);
    return res.status(500).json({ error: 'No se pudo confirmar la alerta de bono de bienvenida' });
  }
});

// Ruta para obtener MMR en tiempo real via GameCoordinator
router.get('/mmr/:steamId', async (req, res) => {
  try {
    const { steamId } = req.params;
    const modo = String(req.query.modo || '').toLowerCase();
    const usarGC = modo === 'gc' || modo === 'exacto';

    if (!steamService.validarSteamId(steamId)) {
      return res.status(400).json({ error: 'Steam ID inválido' });
    }

    console.log(`🎯 Solicitando MMR para: ${steamId}`);

    // Solo usar GC cuando se solicite explícitamente modo exacto/gc.
    let resultado = null;
    if (usarGC) {
      try {
        resultado = await gameCoordinatorService.obtenerMMRReal(steamId);
      } catch (gcErr) {
        console.log('GC falló, usando fallback:', gcErr.message);
      }
    }

    // Fallback a OpenDota/STRATZ si GC no está disponible
    if (!resultado || resultado.mmr === null || resultado.mmr === undefined) {
      const stats = await steamService.obtenerEstadisticasDota2(steamId);
      if (stats && stats.mmr) {
        resultado = stats;
      }
    }

    if (!resultado || resultado.mmr === null) {
      return res.json({
        mmr: null,
        fuente: 'No disponible',
        mensaje: 'MMR no público o perfil privado'
      });
    }

    res.json({
      mmr: resultado.mmr,
      fuente: usarGC ? (resultado.fuente || 'GameCoordinator') : (resultado.fuente || 'OpenDota/STRATZ (experimental)'),
      experimental: !usarGC,
      rank_tier: resultado.rank_tier || null,
      leaderboard_rank: resultado.leaderboard_rank || null
    });
  } catch (error) {
    console.error('Error obteniendo MMR:', error);
    res.status(500).json({ error: 'Error al obtener MMR' });
  }
});

// SSE: Stream de MMR en tiempo real al hacer login/registro
router.get('/mmr-stream/:steamId', async (req, res) => {
  const { steamId } = req.params;

  if (!steamService.validarSteamId(steamId)) {
    return res.status(400).json({ error: 'Steam ID inválido' });
  }

  // Configurar headers SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || 'http://localhost:3000');
  res.flushHeaders();

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send({ estado: 'iniciando', mensaje: 'Conectando con Steam GameCoordinator...' });

  try {
    // Paso 1: Info básica de Steam
    send({ estado: 'steam', mensaje: 'Obteniendo perfil de Steam...' });
    const jugador = await steamService.obtenerJugador(steamId);
    if (jugador) {
      send({
        estado: 'perfil_ok',
        mensaje: 'Perfil de Steam encontrado',
        datos: { nombre: jugador.personaname, avatar: jugador.avatarfull }
      });
    }

    // Paso 2: Intentar GameCoordinator (el real)
    send({ estado: 'gc', mensaje: 'Consultando GameCoordinator de Dota 2...' });
    let mmrFinal = null;
    let fuenteFinal = 'No disponible';
    let rankTier = null;

    try {
      const gcResult = await gameCoordinatorService.obtenerMMRReal(steamId);
      if (gcResult && gcResult.mmr) {
        mmrFinal = gcResult.mmr;
        fuenteFinal = gcResult.fuente;
        rankTier = gcResult.rank_tier;
        send({
          estado: 'mmr_ok',
          mensaje: 'MMR obtenido via GameCoordinator',
          mmr: mmrFinal,
          fuente: fuenteFinal,
          rank_tier: rankTier
        });
      }
    } catch (gcErr) {
      send({ estado: 'gc_fallback', mensaje: 'GameCoordinator no disponible, usando APIs públicas...' });
    }

    // Paso 3: Fallback a OpenDota/STRATZ
    if (!mmrFinal) {
      send({ estado: 'opendota', mensaje: 'Consultando OpenDota y STRATZ...' });
      const stats = await steamService.obtenerEstadisticasDota2(steamId);
      if (stats && stats.mmr) {
        mmrFinal = stats.mmr;
        fuenteFinal = stats.fuente;
        rankTier = stats.rank_tier;
        send({
          estado: 'mmr_ok',
          mensaje: 'MMR obtenido',
          mmr: mmrFinal,
          fuente: fuenteFinal,
          rank_tier: rankTier
        });
      } else {
        send({ estado: 'mmr_null', mensaje: 'MMR no disponible (perfil privado)', mmr: null });
      }
    }

    // Paso 4: Final
    send({
      estado: 'completado',
      mensaje: 'Proceso completado',
      mmr: mmrFinal,
      fuente: fuenteFinal,
      rank_tier: rankTier
    });
  } catch (error) {
    console.error('Error en SSE MMR stream:', error);
    send({ estado: 'error', mensaje: 'Error al obtener datos', error: error.message });
  } finally {
    res.end();
  }
});

// Ruta para logout (opcional, principalmente para limpiar tokens en el cliente)
router.post('/logout', verificarToken, async (req, res) => {
  try {
    res.json({
      mensaje: 'Sesión cerrada exitosamente'
    });
  } catch (error) {
    console.error('Error en logout:', error);
    res.status(500).json({ 
      error: 'Error al cerrar sesión' 
    });
  }
});

module.exports = router;
