const jwt = require('jsonwebtoken');
const Usuario = require('../../modelos/usuario/usuario.model');
const steamService = require('../steam/steam.service');
const db = require('../../config/database');

class AuthService {
  // Generar token JWT
  generarToken(usuario) {
    return jwt.sign(
      { 
        id: usuario.id, 
        steamId: usuario.steam_id,
        nombreUsuario: usuario.nombre_usuario 
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES }
    );
  }

  // Autenticar usuario con Steam
  async autenticarSteam(steamId) {
    try {
      console.log(`Intentando autenticar con Steam ID: ${steamId}`);
      
      // Validar formato del Steam ID
      if (!steamService.validarSteamId(steamId)) {
        console.log(`Steam ID inválido: ${steamId}`);
        throw new Error('Steam ID inválido. Debe ser un número de 17 dígitos que empiece con 7656119');
      }

      console.log(`Steam ID válido, obteniendo datos de Steam API...`);
      // Obtener datos del jugador desde Steam API
      const jugadorSteam = await steamService.obtenerJugador(steamId);
      
      console.log('=== DATOS OBTENIDOS DE STEAM API ===');
      console.log('jugadorSteam:', JSON.stringify(jugadorSteam, null, 2));
      console.log('====================================');
      
      if (!jugadorSteam) {
        throw new Error('No se pudo obtener información del jugador de Steam');
      }

      // Buscar usuario en nuestra base de datos
      let usuario = await Usuario.buscarPorSteamId(steamId);
      const estadisticasDota = null;
      
      console.log('Usuario encontrado en BD:', usuario);

      // Si no existe, crear nuevo usuario
      if (!usuario) {
        console.log('Creando nuevo usuario...');
        
        const nombreUsuario = jugadorSteam.personaname || jugadorSteam.realname || 'Usuario';
        console.log('Nombre a usar:', nombreUsuario);
        
        // Nuevo flujo: el MMR se actualiza manualmente desde perfil.
        const mmrCalculado = null;

        usuario = await Usuario.crear(
          steamId,
          nombreUsuario,
          jugadorSteam.avatarfull || '/font/logo.png',
          mmrCalculado
        );
      } else {
        // SIEMPRE actualizar usuario existente con datos frescos de Steam al loguearse
        console.log('Actualizando usuario existente con datos frescos de Steam...');
        
        const nombreUsuario = jugadorSteam.personaname || jugadorSteam.realname || usuario.nombre_usuario;
        console.log('Nombre anterior:', usuario.nombre_usuario);
        console.log('Nuevo nombre:', nombreUsuario);
        console.log('Avatar anterior:', usuario.avatar);
        console.log('Nuevo avatar:', jugadorSteam.avatarfull);
        
        // Verificar si hay cambios
        const hayCambios = 
          usuario.nombre_usuario !== nombreUsuario || 
          usuario.avatar !== jugadorSteam.avatarfull;
        
        console.log('¿Hay cambios en perfil?', hayCambios);
        
        // Nuevo flujo: no actualizar MMR al loguear. Solo nombre/avatar.
        usuario = await Usuario.actualizarDatosSteam(
          usuario.id,
          nombreUsuario,
          jugadorSteam.avatarfull || usuario.avatar,
          undefined
        );
        
        console.log('Usuario actualizado exitosamente:', usuario);
      }

      // Generar token JWT
      const token = this.generarToken(usuario);

      return {
        token,
        usuario: {
          id: usuario.id,
          steamId: usuario.steam_id,
          nombreUsuario: usuario.nombre_usuario,
          avatar: usuario.avatar,
          mmr: usuario.mmr ?? null,
          saldo: usuario.saldo || 0,
          bono: usuario.bono || 0,
          nivel: usuario.nivel || 1,
          email: usuario.email || null,
          pais: usuario.pais || null,
          creado_en: usuario.creado_en || null,
          alertaBonoRegistroPendiente: usuario.bono_bienvenida_alerta_mostrada === false,
          steamData: {
            personaname: jugadorSteam.personaname,
            realname: jugadorSteam.realname,
            avatarmedium: jugadorSteam.avatarmedium,
            avatarfull: jugadorSteam.avatarfull,
            profileurl: jugadorSteam.profileurl,
            personastate: jugadorSteam.personastate,
            communityvisibilitystate: jugadorSteam.communityvisibilitystate
          }
        },
        gcDisponible: false,
        mmrFuente: null,
        mmrPendienteActualizacion: true
      };
    } catch (error) {
      console.error('Error en autenticación Steam:', error);
      throw error;
    }
  }

  // Verificar token JWT
  verificarToken(token) {
    try {
      return jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
      throw new Error('Token inválido o expirado');
    }
  }

  // Refrescar información del usuario desde Steam
  async refrescarDatosUsuario(steamId) {
    try {
      const jugadorSteam = await steamService.obtenerJugador(steamId);
      const usuario = await Usuario.buscarPorSteamId(steamId);

      if (!usuario) {
        throw new Error('Usuario no encontrado');
      }

      // Actualizar datos del usuario
      const query = `
        UPDATE usuarios 
        SET nombre_usuario = $1, avatar = $2, actualizado_en = NOW()
        WHERE steam_id = $3
        RETURNING *
      `;

      const result = await db.query(query, [
        jugadorSteam.personaname,
        jugadorSteam.avatarfull,
        steamId
      ]);

      return result.rows[0];
    } catch (error) {
      console.error('Error al refrescar datos del usuario:', error);
      throw error;
    }
  }
}

module.exports = new AuthService();
