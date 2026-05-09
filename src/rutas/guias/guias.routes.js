const express = require('express');
const router = express.Router();
const db = require('../../config/database');
const { verificarToken, esSuperadmin } = require('../../middleware/auth');

const normalizarPagina = (row) => ({
  id: row.id,
  slug: row.slug,
  tituloMenu: row.titulo_menu,
  topbarTitulo: row.topbar_titulo,
  topbarIcono: row.topbar_icono,
  navTitulo: row.nav_titulo,
  heroBadge: row.hero_badge,
  heroTitulo: row.hero_titulo,
  heroSubtitulo: row.hero_subtitulo,
  heroPrimarioLabel: row.hero_primario_label,
  heroPrimarioHref: row.hero_primario_href,
  heroSecundarioLabel: row.hero_secundario_label,
  heroSecundarioHref: row.hero_secundario_href,
  heroPanel: Array.isArray(row.hero_panel) ? row.hero_panel : [],
  ctaTitulo: row.cta_titulo,
  ctaSubtitulo: row.cta_subtitulo,
  ctaLabel: row.cta_label,
  ctaHref: row.cta_href,
  configuracion: row.configuracion || {},
  activo: row.activo,
});

const mapearPayload = (payload = {}) => ({
  tituloMenu: payload.tituloMenu || 'GUIAS',
  topbarTitulo: payload.topbarTitulo || 'GUIAS DE JUEGO',
  topbarIcono: payload.topbarIcono || 'fa-book-open',
  navTitulo: payload.navTitulo || 'NAVEGACION',
  heroBadge: payload.heroBadge || 'CENTRO DE APRENDIZAJE',
  heroTitulo: payload.heroTitulo || 'GUIAS',
  heroSubtitulo: payload.heroSubtitulo || '',
  heroPrimarioLabel: payload.heroPrimarioLabel || null,
  heroPrimarioHref: payload.heroPrimarioHref || null,
  heroSecundarioLabel: payload.heroSecundarioLabel || null,
  heroSecundarioHref: payload.heroSecundarioHref || null,
  heroPanel: Array.isArray(payload.heroPanel) ? payload.heroPanel : [],
  ctaTitulo: payload.ctaTitulo || null,
  ctaSubtitulo: payload.ctaSubtitulo || null,
  ctaLabel: payload.ctaLabel || null,
  ctaHref: payload.ctaHref || null,
  configuracion: payload.configuracion && typeof payload.configuracion === 'object' ? payload.configuracion : {},
});

function construirGuiaFallback(slug = 'principal') {
  return {
    pagina: {
      id: null,
      slug,
      tituloMenu: 'GUIAS',
      topbarTitulo: 'GUIAS DE JUEGO',
      topbarIcono: 'fa-book-open',
      navTitulo: 'NAVEGACION',
      heroBadge: 'CENTRO DE APRENDIZAJE',
      heroTitulo: 'GUIAS',
      heroSubtitulo: 'Aprende lo esencial para entrar a salas, gestionar tu saldo y evitar errores comunes al apostar.',
      heroPrimarioLabel: 'VER PASOS',
      heroPrimarioHref: '#primeros-pasos',
      heroSecundarioLabel: 'IR A SALAS',
      heroSecundarioHref: '/salas',
      heroPanel: [
        { label: 'NIVEL', value: 'BASICO' },
        { label: 'TIEMPO', value: '5 MIN' },
        { label: 'OBJETIVO', value: 'EMPEZAR BIEN' },
      ],
      ctaTitulo: 'Listo para tu primera partida',
      ctaSubtitulo: 'Entra a salas activas y aplica esta guia paso a paso para jugar con seguridad.',
      ctaLabel: 'EMPEZAR AHORA',
      ctaHref: '/salas',
      configuracion: {},
      activo: true,
      fallback: true,
    },
    secciones: [
      {
        id: null,
        clave: 'primeros-pasos',
        etiquetaNav: 'PRIMEROS PASOS',
        titulo: 'Primeros pasos',
        descripcion: 'Configura tu perfil, revisa tu MMR y valida tu saldo antes de entrar a una sala.',
        icono: 'fa-list-check',
        tipoVisual: 'steps',
        metadata: {},
        orden: 1,
        activo: true,
        items: [
          {
            id: null,
            titulo: 'Verifica tu perfil y MMR',
            descripcion: 'Asegurate de que tu nombre, pais y MMR esten correctos para evitar restricciones en salas.',
            etiqueta: null,
            icono: 'fa-id-card',
            tono: 'neutro',
            accionLabel: null,
            accionHref: null,
            metadata: {},
            orden: 1,
            activo: true,
          },
          {
            id: null,
            titulo: 'Revisa saldo y bono disponible',
            descripcion: 'Confirma tu saldo total y define un limite para no apostar de mas.',
            etiqueta: null,
            icono: 'fa-wallet',
            tono: 'neutro',
            accionLabel: null,
            accionHref: null,
            metadata: {},
            orden: 2,
            activo: true,
          },
          {
            id: null,
            titulo: 'Entra a una sala acorde a tu nivel',
            descripcion: 'Prioriza salas con reglas claras y ticket que se ajuste a tu banca.',
            etiqueta: null,
            icono: 'fa-door-open',
            tono: 'neutro',
            accionLabel: null,
            accionHref: null,
            metadata: {},
            orden: 3,
            activo: true,
          },
        ],
      },
      {
        id: null,
        clave: 'reglas-basicas',
        etiquetaNav: 'REGLAS BASICAS',
        titulo: 'Reglas basicas',
        descripcion: 'Cumplir estas reglas reduce errores y disputas dentro de las salas.',
        icono: 'fa-shield-halved',
        tipoVisual: 'rules',
        metadata: {},
        orden: 2,
        activo: true,
        items: [
          {
            id: null,
            titulo: 'No compartas tu cuenta ni codigos de verificacion.',
            descripcion: null,
            etiqueta: null,
            icono: 'fa-user-lock',
            tono: 'neutro',
            accionLabel: null,
            accionHref: null,
            metadata: {},
            orden: 1,
            activo: true,
          },
          {
            id: null,
            titulo: 'Revisa el estado final antes de confirmar cualquier apuesta.',
            descripcion: null,
            etiqueta: null,
            icono: 'fa-circle-check',
            tono: 'neutro',
            accionLabel: null,
            accionHref: null,
            metadata: {},
            orden: 2,
            activo: true,
          },
          {
            id: null,
            titulo: 'Si algo no cuadra, reportalo por soporte antes de repetir la accion.',
            descripcion: null,
            etiqueta: null,
            icono: 'fa-life-ring',
            tono: 'neutro',
            accionLabel: null,
            accionHref: null,
            metadata: {},
            orden: 3,
            activo: true,
          },
        ],
      },
      {
        id: null,
        clave: 'consejos-rapidos',
        etiquetaNav: 'CONSEJOS',
        titulo: 'Consejos rapidos',
        descripcion: 'Buenas practicas para mantener consistencia y controlar riesgo.',
        icono: 'fa-bolt',
        tipoVisual: 'tips',
        metadata: {},
        orden: 3,
        activo: true,
        items: [
          {
            id: null,
            titulo: 'Empieza con montos pequeños hasta conocer bien el ritmo de la sala.',
            descripcion: null,
            etiqueta: null,
            icono: 'fa-coins',
            tono: 'neutro',
            accionLabel: null,
            accionHref: null,
            metadata: {},
            orden: 1,
            activo: true,
          },
          {
            id: null,
            titulo: 'No persigas perdidas: define un tope diario y respetalo.',
            descripcion: null,
            etiqueta: null,
            icono: 'fa-chart-line',
            tono: 'neutro',
            accionLabel: null,
            accionHref: null,
            metadata: {},
            orden: 2,
            activo: true,
          },
          {
            id: null,
            titulo: 'Usa historial de apuestas para ajustar estrategia, no para improvisar.',
            descripcion: null,
            etiqueta: null,
            icono: 'fa-clock-rotate-left',
            tono: 'neutro',
            accionLabel: null,
            accionHref: null,
            metadata: {},
            orden: 3,
            activo: true,
          },
        ],
      },
    ],
  };
}

function limpiarTextoPlano(valor = '') {
  return String(valor || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[#!>*_~\-]+/g, ' ')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

async function obtenerSeccionGuiasLegacy() {
  let r;
  try {
    r = await db.query(
      `SELECT id, titulo, resumen, contenido, categoria, orden
       FROM guias
       WHERE activo = TRUE
       ORDER BY orden ASC, creado_en DESC
       LIMIT 50`
    );
  } catch (error) {
    if (error?.code === '42P01') {
      return null;
    }
    throw error;
  }

  if (!r.rows.length) {
    return null;
  }

  return {
    id: 'legacy-guias',
    clave: 'guias-superadmin',
    etiquetaNav: 'GUIAS',
    titulo: 'Guias publicadas',
    descripcion: 'Contenido creado desde el panel de superadmin.',
    icono: 'fa-file-lines',
    tipoVisual: 'cards',
    metadata: { origen: 'legacy-guias' },
    orden: 999,
    activo: true,
    items: r.rows.map((row, index) => {
      const resumenPlano = limpiarTextoPlano(row.resumen || '');
      const contenidoPlano = limpiarTextoPlano(row.contenido || '');
      return {
        id: `legacy-guia-${row.id}`,
        titulo: row.titulo,
        descripcion: (resumenPlano || contenidoPlano || row.titulo).slice(0, 240),
        etiqueta: row.categoria ? String(row.categoria).toUpperCase() : null,
        icono: 'fa-bookmark',
        tono: 'neutro',
        accionLabel: null,
        accionHref: null,
        metadata: {
          legacyGuiaId: row.id,
          legacyResumen: row.resumen || '',
          legacyContenido: row.contenido || '',
        },
        orden: Number(row.orden ?? index + 1),
        activo: true,
      };
    }),
  };
}

function anexarSeccionLegacy(guia, seccionLegacy) {
  if (!seccionLegacy) return guia;

  const secciones = Array.isArray(guia?.secciones) ? guia.secciones : [];
  const yaExiste = secciones.some((sec) => sec?.clave === seccionLegacy.clave);
  if (yaExiste) return guia;

  return {
    ...guia,
    secciones: [...secciones, seccionLegacy],
  };
}

function priorizarSeccionLegacy(guia, seccionLegacy) {
  if (!seccionLegacy) return guia;

  const secciones = Array.isArray(guia?.secciones) ? guia.secciones : [];
  const legacyEnGuia = secciones.find((sec) => sec?.clave === seccionLegacy.clave);
  const legacyObjetivo = legacyEnGuia || seccionLegacy;

  if (!legacyObjetivo) return guia;

  return {
    ...guia,
    secciones: [legacyObjetivo],
  };
}

function tieneSeccionesPublicas(guia) {
  const secciones = Array.isArray(guia?.secciones) ? guia.secciones : [];
  return secciones.some((seccion) => {
    if (seccion?.activo === false) return false;
    const items = Array.isArray(seccion?.items) ? seccion.items : [];
    return items.some((item) => item?.activo !== false);
  });
}

async function obtenerGuiaCompleta(slug = 'principal', incluirInactivos = false) {
  const paginaR = await db.query(
    `SELECT *
     FROM guias_paginas
     WHERE slug = $1
       AND ($2::boolean = TRUE OR activo = TRUE)
     LIMIT 1`,
    [slug, incluirInactivos]
  );

  if (!paginaR.rows.length) {
    return null;
  }

  const pagina = normalizarPagina(paginaR.rows[0]);
  const seccionesR = await db.query(
    `SELECT
       s.*,
       COALESCE(
         json_agg(
           json_build_object(
             'id', i.id,
             'titulo', i.titulo,
             'descripcion', i.descripcion,
             'etiqueta', i.etiqueta,
             'icono', i.icono,
             'tono', i.tono,
             'accionLabel', i.accion_label,
             'accionHref', i.accion_href,
             'metadata', i.metadata,
             'orden', i.orden,
             'activo', i.activo
           ) ORDER BY i.orden, i.id
         ) FILTER (WHERE i.id IS NOT NULL),
         '[]'::json
       ) AS items
     FROM guias_secciones s
     LEFT JOIN guias_items i ON i.id_guia_seccion = s.id
       AND ($2::boolean = TRUE OR i.activo = TRUE)
     WHERE s.id_guia_pagina = $1
       AND ($2::boolean = TRUE OR s.activo = TRUE)
     GROUP BY s.id
     ORDER BY s.orden, s.id`,
    [pagina.id, incluirInactivos]
  );

  return {
    pagina,
    secciones: seccionesR.rows.map((row) => ({
      id: row.id,
      clave: row.clave,
      etiquetaNav: row.etiqueta_nav,
      titulo: row.titulo,
      descripcion: row.descripcion,
      icono: row.icono,
      tipoVisual: row.tipo_visual,
      metadata: row.metadata || {},
      orden: row.orden,
      activo: row.activo,
      items: Array.isArray(row.items) ? row.items : [],
    })),
  };
}

router.get('/admin/:slug', verificarToken, esSuperadmin, async (req, res) => {
  try {
    const guia = await obtenerGuiaCompleta(req.params.slug || 'principal', true);

    if (!guia) {
      return res.status(404).json({ error: 'Guia no encontrada' });
    }

    res.json(guia);
  } catch (error) {
    console.error('Error GET /guias/admin/:slug', error);
    res.status(500).json({ error: 'Error al obtener la guia editable' });
  }
});

router.put('/admin/:slug', verificarToken, esSuperadmin, async (req, res) => {
  const client = await db.pool.connect();

  try {
    const slug = req.params.slug || 'principal';
    const { pagina: paginaPayload, secciones = [] } = req.body || {};
    const pagina = mapearPayload(paginaPayload);

    await client.query('BEGIN');

    const upsertPaginaR = await client.query(
      `INSERT INTO guias_paginas (
         slug,
         titulo_menu,
         topbar_titulo,
         topbar_icono,
         nav_titulo,
         hero_badge,
         hero_titulo,
         hero_subtitulo,
         hero_primario_label,
         hero_primario_href,
         hero_secundario_label,
         hero_secundario_href,
         hero_panel,
         cta_titulo,
         cta_subtitulo,
         cta_label,
         cta_href,
         configuracion,
         activo,
         actualizado_en
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18::jsonb,TRUE,NOW()
       )
       ON CONFLICT (slug) DO UPDATE SET
         titulo_menu = EXCLUDED.titulo_menu,
         topbar_titulo = EXCLUDED.topbar_titulo,
         topbar_icono = EXCLUDED.topbar_icono,
         nav_titulo = EXCLUDED.nav_titulo,
         hero_badge = EXCLUDED.hero_badge,
         hero_titulo = EXCLUDED.hero_titulo,
         hero_subtitulo = EXCLUDED.hero_subtitulo,
         hero_primario_label = EXCLUDED.hero_primario_label,
         hero_primario_href = EXCLUDED.hero_primario_href,
         hero_secundario_label = EXCLUDED.hero_secundario_label,
         hero_secundario_href = EXCLUDED.hero_secundario_href,
         hero_panel = EXCLUDED.hero_panel,
         cta_titulo = EXCLUDED.cta_titulo,
         cta_subtitulo = EXCLUDED.cta_subtitulo,
         cta_label = EXCLUDED.cta_label,
         cta_href = EXCLUDED.cta_href,
         configuracion = EXCLUDED.configuracion,
         activo = TRUE,
         actualizado_en = NOW()
       RETURNING id`,
      [
        slug,
        pagina.tituloMenu,
        pagina.topbarTitulo,
        pagina.topbarIcono,
        pagina.navTitulo,
        pagina.heroBadge,
        pagina.heroTitulo,
        pagina.heroSubtitulo,
        pagina.heroPrimarioLabel,
        pagina.heroPrimarioHref,
        pagina.heroSecundarioLabel,
        pagina.heroSecundarioHref,
        JSON.stringify(pagina.heroPanel),
        pagina.ctaTitulo,
        pagina.ctaSubtitulo,
        pagina.ctaLabel,
        pagina.ctaHref,
        JSON.stringify(pagina.configuracion),
      ]
    );

    const paginaId = upsertPaginaR.rows[0].id;

    await client.query(
      `DELETE FROM guias_items
       WHERE id_guia_seccion IN (
         SELECT id FROM guias_secciones WHERE id_guia_pagina = $1
       )`,
      [paginaId]
    );
    await client.query('DELETE FROM guias_secciones WHERE id_guia_pagina = $1', [paginaId]);

    for (const [sectionIndex, section] of secciones.entries()) {
      const seccionR = await client.query(
        `INSERT INTO guias_secciones (
           id_guia_pagina,
           clave,
           etiqueta_nav,
           titulo,
           descripcion,
           icono,
           tipo_visual,
           metadata,
           orden,
           activo,
           actualizado_en
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,NOW())
         RETURNING id`,
        [
          paginaId,
          section.clave || `seccion-${sectionIndex + 1}`,
          section.etiquetaNav || section.titulo || `SECCION ${sectionIndex + 1}`,
          section.titulo || `Seccion ${sectionIndex + 1}`,
          section.descripcion || null,
          section.icono || 'fa-circle-info',
          section.tipoVisual || 'cards',
          JSON.stringify(section.metadata && typeof section.metadata === 'object' ? section.metadata : {}),
          Number(section.orden ?? sectionIndex + 1),
          section.activo !== false,
        ]
      );

      const seccionId = seccionR.rows[0].id;
      const items = Array.isArray(section.items) ? section.items : [];

      for (const [itemIndex, item] of items.entries()) {
        await client.query(
          `INSERT INTO guias_items (
             id_guia_seccion,
             titulo,
             descripcion,
             etiqueta,
             icono,
             tono,
             accion_label,
             accion_href,
             metadata,
             orden,
             activo,
             actualizado_en
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,NOW())`,
          [
            seccionId,
            item.titulo || `Item ${itemIndex + 1}`,
            item.descripcion || null,
            item.etiqueta || null,
            item.icono || 'fa-star',
            item.tono || 'neutro',
            item.accionLabel || null,
            item.accionHref || null,
            JSON.stringify(item.metadata && typeof item.metadata === 'object' ? item.metadata : {}),
            Number(item.orden ?? itemIndex + 1),
            item.activo !== false,
          ]
        );
      }
    }

    await client.query('COMMIT');

    const guiaActualizada = await obtenerGuiaCompleta(slug, true);
    res.json({ ok: true, guia: guiaActualizada });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error PUT /guias/admin/:slug', error);
    res.status(500).json({ error: 'Error al guardar la guia' });
  } finally {
    client.release();
  }
});

router.get('/:slug', async (req, res) => {
  const slug = req.params.slug || 'principal';
  try {
    const [guia, seccionLegacy] = await Promise.all([
      obtenerGuiaCompleta(slug, false),
      obtenerSeccionGuiasLegacy(),
    ]);

    const fallback = construirGuiaFallback(slug);

    if (!guia) {
      const base = anexarSeccionLegacy(fallback, seccionLegacy);
      return res.json(priorizarSeccionLegacy(base, seccionLegacy));
    }

    if (!seccionLegacy && !tieneSeccionesPublicas(guia)) {
      return res.json(fallback);
    }

    const conLegacy = anexarSeccionLegacy(guia, seccionLegacy);
    res.json(priorizarSeccionLegacy(conLegacy, seccionLegacy));
  } catch (error) {
    console.error('Error GET /guias/:slug', error);
    res.json(construirGuiaFallback(slug));
  }
});

module.exports = router;