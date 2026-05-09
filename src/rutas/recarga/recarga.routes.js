const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../../config/database');
const { verificarToken } = require('../../middleware/auth');

const router = express.Router();
let schemaReady = false;

async function ensureSchema() {
  if (schemaReady) return;
  const check = await db.query("SELECT to_regclass('public.recargas_solicitudes') AS reg");
  if (!check.rows?.[0]?.reg) {
    const err = new Error('Falta tabla requerida: public.recargas_solicitudes');
    err.code = 'RECARGA_SCHEMA_MISSING';
    throw err;
  }
  schemaReady = true;
}

function safeSegment(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '') || 'usuario';
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      const id = req.usuario?.id;
      const steamId = req.usuario?.steamId || 'sin_steam';
      const nombre = req.usuario?.nombreUsuario || 'usuario';
      const userFolder = `${id}_${safeSegment(nombre)}_${safeSegment(steamId)}`;
      const uploadDir = path.join(__dirname, '../../../uploads/recargas', userFolder);
      fs.mkdirSync(uploadDir, { recursive: true });
      cb(null, uploadDir);
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
    const base = `comprobante_${Date.now()}_${Math.round(Math.random() * 1e9)}`;
    cb(null, `${base}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Solo se permiten imagenes JPG, PNG o WEBP'));
    }
    cb(null, true);
  },
});

// ── POST /api/recargas/solicitar ───────────────────────────────────────────
router.post('/solicitar', verificarToken, upload.single('comprobante'), async (req, res) => {
  try {
    await ensureSchema();
    const { id } = req.usuario;
    const { monto, titular_yape, celular_yape, operacion_codigo, observaciones } = req.body;

    const montoNum = parseFloat(String(monto || '').replace(',', '.'));
    if (!montoNum || montoNum <= 0) {
      return res.status(400).json({ error: 'Monto invalido' });
    }
    if (!titular_yape || titular_yape.trim().length < 3) {
      return res.status(400).json({ error: 'Titular de Yape invalido' });
    }
    if (!celular_yape || !/^\d{9,15}$/.test(celular_yape)) {
      return res.status(400).json({ error: 'Celular Yape invalido' });
    }
    if (!operacion_codigo || operacion_codigo.trim().length < 4) {
      return res.status(400).json({ error: 'Codigo de operacion invalido' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Debes subir una imagen de comprobante' });
    }

    const relativePath = path
      .relative(path.join(__dirname, '../../../'), req.file.path)
      .replace(/\\/g, '/');

    const r = await db.query(
      `INSERT INTO recargas_solicitudes
         (id_usuario, monto, titular_yape, celular_yape, operacion_codigo, observaciones, comprobante_path, estado)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pendiente')
       RETURNING id, monto, estado, creado_en`,
      [
        id,
        montoNum,
        titular_yape.trim(),
        celular_yape.trim(),
        operacion_codigo.trim(),
        observaciones?.trim() || null,
        relativePath,
      ]
    );

    return res.status(201).json({
      mensaje: 'Solicitud de recarga enviada para revision',
      solicitud: r.rows[0],
    });
  } catch (err) {
    if (err.code === 'RECARGA_SCHEMA_MISSING') {
      return res.status(503).json({
        error: 'Falta aplicar migraciones de recargas en la base de datos.',
        codigo: 'RECARGA_SCHEMA_MISSING',
        faltantes: ['public.recargas_solicitudes'],
      });
    }
    if (req.file?.path) {
      fs.unlink(req.file.path, () => {});
    }
    console.error('Error /recargas/solicitar:', err);
    return res.status(500).json({ error: 'Error al registrar recarga' });
  }
});

// ── GET /api/recargas/mis-solicitudes ──────────────────────────────────────
router.get('/mis-solicitudes', verificarToken, async (req, res) => {
  try {
    await ensureSchema();
    const { id } = req.usuario;
    const r = await db.query(
      `SELECT id, monto, titular_yape, celular_yape, operacion_codigo, observaciones,
              comprobante_path, estado, comentario_revision, creado_en, revisado_en
       FROM recargas_solicitudes
       WHERE id_usuario = $1
       ORDER BY creado_en DESC
       LIMIT 50`,
      [id]
    );
    return res.json({ solicitudes: r.rows });
  } catch (err) {
    if (err.code === 'RECARGA_SCHEMA_MISSING') {
      return res.status(503).json({
        error: 'Falta aplicar migraciones de recargas en la base de datos.',
        codigo: 'RECARGA_SCHEMA_MISSING',
        faltantes: ['public.recargas_solicitudes'],
      });
    }
    console.error('Error /recargas/mis-solicitudes:', err);
    return res.status(500).json({ error: 'Error al listar solicitudes' });
  }
});

module.exports = router;
