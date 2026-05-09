const express = require('express');
const router = express.Router();
const db = require('../../config/database');
const { verificarToken } = require('../../middleware/auth');

const BONO_POR_INVITADO = 5;

const formatearPromocion = (row) => ({
  id: row.id,
  codigo: row.codigo,
  titulo: row.titulo,
  descripcion: row.descripcion,
  tipo: row.tipo,
  monto: Number(row.monto || 0),
  maximoBono: Number(row.maximo_bono || 0),
  minimoApuesta: Number(row.minimo_apuesta || 0),
  etiqueta: row.etiqueta,
  icono: row.icono,
  colorPrincipal: row.color_principal,
  colorSecundario: row.color_secundario,
  visibleHasta: row.visible_hasta,
});

router.get('/resumen', verificarToken, async (req, res) => {
  try {
    const { id, steamId } = req.usuario;

    const [statsR, elegiblesR, ganadosR] = await Promise.all([
      db.query(
        `SELECT COUNT(*)::int AS invitados
         FROM referidos
         WHERE id_usuario = $1`,
        [id]
      ),
      db.query(
        `SELECT COUNT(*)::int AS elegibles
         FROM referidos r
         WHERE r.id_usuario = $1
           AND r.bono_otorgado = FALSE
           AND EXISTS (
             SELECT 1 FROM apuestas a WHERE a.id_usuario = r.id_referido
           )`,
        [id]
      ),
      db.query(
        `SELECT COUNT(*)::int AS bonos_otorgados
         FROM referidos
         WHERE id_usuario = $1 AND bono_otorgado = TRUE`,
        [id]
      ),
    ]);

    let promociones = [];
    let bonificacion = {
      activos: 0,
      pendientes: 0,
      acreditado: '0.00',
    };

    try {
      const [promocionesR, bonosR] = await Promise.all([
        db.query(
          `SELECT
             id,
             codigo,
             titulo,
             descripcion,
             tipo,
             monto,
             maximo_bono,
             minimo_apuesta,
             etiqueta,
             icono,
             color_principal,
             color_secundario,
             visible_hasta
           FROM bonos_promociones
           WHERE estado = 'activo'
             AND (visible_desde IS NULL OR visible_desde <= NOW())
             AND (visible_hasta IS NULL OR visible_hasta >= NOW())
           ORDER BY prioridad DESC, creado_en DESC
           LIMIT 4`
        ),
        db.query(
          `SELECT
             COUNT(*) FILTER (WHERE estado IN ('activo', 'en_progreso'))::int AS activos,
             COUNT(*) FILTER (WHERE estado = 'pendiente')::int AS pendientes,
             COALESCE(
               SUM(
                 CASE
                   WHEN estado IN ('acreditado', 'liberado') THEN monto_otorgado
                   ELSE 0
                 END
               ),
               0
             )::numeric(12,2) AS acreditado
           FROM bonos_usuario
           WHERE id_usuario = $1`,
          [id]
        ),
      ]);

      promociones = promocionesR.rows.map(formatearPromocion);
      bonificacion = {
        activos: bonosR.rows[0]?.activos || 0,
        pendientes: bonosR.rows[0]?.pendientes || 0,
        acreditado: Number(bonosR.rows[0]?.acreditado || 0).toFixed(2),
      };
    } catch (bonosError) {
      if (bonosError.code !== '42P01') {
        throw bonosError;
      }
    }

    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const invitados = statsR.rows[0]?.invitados || 0;
    const elegibles = elegiblesR.rows[0]?.elegibles || 0;
    const bonosOtorgados = ganadosR.rows[0]?.bonos_otorgados || 0;
    const ganadoReferidos = (bonosOtorgados * BONO_POR_INVITADO).toFixed(2);

    res.json({
      linkReferido: `${baseUrl}/registro?ref=${encodeURIComponent(steamId)}`,
      referidos: {
        invitados,
        elegibles,
        bonoPagado: BONO_POR_INVITADO.toFixed(2),
        ganado: ganadoReferidos,
      },
      bonificacion,
      promociones,
    });
  } catch (err) {
    console.error('Error /bonos/resumen:', err);
    res.status(500).json({ error: 'Error al obtener resumen de bonos' });
  }
});

router.get('/historial', verificarToken, async (req, res) => {
  try {
    const { id } = req.usuario;
    const limitRaw = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 30;

    let historialBonos = [];

    try {
      const bonosR = await db.query(
        `SELECT
           bu.id,
           bu.estado,
           bu.monto_otorgado,
           bu.progreso_actual,
           bu.progreso_meta,
           bu.vence_en,
           bu.creado_en,
           bp.codigo,
           bp.titulo,
           bp.tipo,
           bp.etiqueta
         FROM bonos_usuario bu
         INNER JOIN bonos_promociones bp ON bp.id = bu.id_bono_promocion
         WHERE bu.id_usuario = $1
         ORDER BY bu.creado_en DESC
         LIMIT $2`,
        [id, limit]
      );

      historialBonos = bonosR.rows.map((row) => ({
        id: `promo-${row.id}`,
        fecha: row.creado_en,
        categoria: 'PROMOCION',
        titulo: row.titulo,
        codigo: row.codigo,
        estado: row.estado,
        monto: Number(row.monto_otorgado || 0).toFixed(2),
        progresoActual: Number(row.progreso_actual || 0),
        progresoMeta: Number(row.progreso_meta || 0),
        venceEn: row.vence_en,
        etiqueta: row.etiqueta,
        tipo: row.tipo,
      }));
    } catch (bonosError) {
      if (bonosError.code !== '42P01') {
        throw bonosError;
      }
    }

    const referidosR = await db.query(
      `SELECT
         r.id,
         r.creado_en,
         r.bono_otorgado,
         u.nombre_usuario,
         COALESCE(ap.apuestas_count, 0)::int AS apuestas_count
       FROM referidos r
       INNER JOIN usuarios u ON u.id = r.id_referido
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS apuestas_count
         FROM apuestas a
         WHERE a.id_usuario = r.id_referido
       ) ap ON TRUE
       WHERE r.id_usuario = $1
       ORDER BY r.creado_en DESC
       LIMIT $2`,
      [id, limit]
    );

    const historialReferidos = referidosR.rows.map((row) => {
      const jugo = Number(row.apuestas_count || 0) > 0;
      let estado = 'pendiente';

      if (row.bono_otorgado) {
        estado = 'acreditado';
      } else if (jugo) {
        estado = 'elegible';
      }

      return {
        id: `ref-${row.id}`,
        fecha: row.creado_en,
        categoria: 'REFERIDO',
        titulo: `INVITA A ${String(row.nombre_usuario || 'USUARIO').toUpperCase()}`,
        codigo: 'REFERIDO',
        estado,
        monto: row.bono_otorgado ? BONO_POR_INVITADO.toFixed(2) : '0.00',
        progresoActual: Number(row.apuestas_count || 0),
        progresoMeta: 1,
        venceEn: null,
        etiqueta: jugo ? 'LISTO' : 'EN ESPERA',
        tipo: 'referido',
      };
    });

    const historial = [...historialBonos, ...historialReferidos]
      .sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime())
      .slice(0, limit);

    res.json({
      historial,
      meta: {
        limite: limit,
        total: historial.length,
      },
    });
  } catch (err) {
    console.error('Error /bonos/historial:', err);
    res.status(500).json({ error: 'Error al obtener historial de bonos' });
  }
});

module.exports = router;