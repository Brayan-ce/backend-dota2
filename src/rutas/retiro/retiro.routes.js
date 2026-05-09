const express = require('express');
const db = require('../../config/database');
const { verificarToken } = require('../../middleware/auth');

const router = express.Router();
let schemaReady = false;

const MONTO_MINIMO = 10;
const MONTO_MAXIMO = 5000;
const BILLETERAS_VALIDAS = ['yape', 'plin', 'binance'];

async function ensureSchema() {
  if (schemaReady) return;
  const check = await db.query("SELECT to_regclass('public.retiros_solicitudes') AS reg");
  if (!check.rows?.[0]?.reg) {
    const err = new Error('Falta tabla requerida: public.retiros_solicitudes');
    err.code = 'RETIRO_SCHEMA_MISSING';
    throw err;
  }
  schemaReady = true;
}

// ── POST /api/retiros/solicitar ──────────────────────────────────────────────
router.post('/solicitar', verificarToken, async (req, res) => {
  try {
    await ensureSchema();
    const { id } = req.usuario;
    const { monto, billetera, titular, numero_cuenta, observaciones } = req.body;

    // Validaciones
    const montoNum = parseFloat(monto);
    if (!monto || isNaN(montoNum) || montoNum < MONTO_MINIMO) {
      return res.status(400).json({ error: `El monto mínimo de retiro es S/${MONTO_MINIMO}.00` });
    }
    if (montoNum > MONTO_MAXIMO) {
      return res.status(400).json({ error: `El monto máximo de retiro es S/${MONTO_MAXIMO}.00` });
    }
    if (!billetera || !BILLETERAS_VALIDAS.includes(billetera)) {
      return res.status(400).json({ error: 'Selecciona una billetera válida' });
    }
    if (!titular || String(titular).trim().length < 3) {
      return res.status(400).json({ error: 'Ingresa el nombre completo del titular' });
    }
    if (!numero_cuenta || String(numero_cuenta).trim().length < 5) {
      return res.status(400).json({ error: 'Ingresa el número de cuenta o ID válido' });
    }

    // Verificar saldo suficiente
    const usuarioR = await db.query('SELECT saldo FROM usuarios WHERE id = $1', [id]);
    if (!usuarioR.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    const saldoActual = parseFloat(usuarioR.rows[0].saldo) || 0;

    if (saldoActual < montoNum) {
      return res.status(400).json({ error: `Saldo insuficiente. Tu saldo disponible es S/${saldoActual.toFixed(2)}` });
    }

    // Verificar que no tenga una solicitud pendiente activa
    const pendienteR = await db.query(
      `SELECT id FROM retiros_solicitudes WHERE id_usuario = $1 AND estado = 'pendiente' LIMIT 1`,
      [id]
    );
    if (pendienteR.rows.length) {
      return res.status(400).json({ error: 'Ya tienes una solicitud de retiro pendiente. Espera a que sea procesada antes de crear otra.' });
    }

    // Crear solicitud (NO descuenta saldo todavía, lo hace el admin al aprobar)
    const insertR = await db.query(
      `INSERT INTO retiros_solicitudes
         (id_usuario, monto, billetera, titular, numero_cuenta, observaciones)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, monto, billetera, estado, creado_en`,
      [id, montoNum, billetera, String(titular).trim(), String(numero_cuenta).trim(), observaciones || null]
    );

    const solicitud = insertR.rows[0];

    res.status(201).json({
      mensaje: 'Solicitud de retiro enviada. Revisaremos tus datos y apuestas; en un plazo de 24 horas realizaremos el depósito. Cualquier inconveniente te comunicaremos.',
      solicitud: {
        id: solicitud.id,
        monto: solicitud.monto,
        billetera: solicitud.billetera,
        estado: solicitud.estado,
        creadoEn: solicitud.creado_en,
      },
    });
  } catch (err) {
    if (err.code === 'RETIRO_SCHEMA_MISSING') {
      return res.status(503).json({
        error: 'Falta aplicar migraciones de retiros en la base de datos.',
        codigo: 'RETIRO_SCHEMA_MISSING',
        faltantes: ['public.retiros_solicitudes'],
      });
    }
    console.error('Error POST /retiros/solicitar:', err);
    res.status(500).json({ error: 'Error interno al procesar la solicitud' });
  }
});

// ── GET /api/retiros/mis-solicitudes ────────────────────────────────────────
router.get('/mis-solicitudes', verificarToken, async (req, res) => {
  try {
    await ensureSchema();
    const { id } = req.usuario;
    const limitRaw = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 10;

    const r = await db.query(
      `SELECT id, monto, billetera, titular, numero_cuenta, estado,
              comentario_revision, creado_en, revisado_en
       FROM retiros_solicitudes
       WHERE id_usuario = $1
       ORDER BY creado_en DESC
       LIMIT $2`,
      [id, limit]
    );

    res.json({ solicitudes: r.rows });
  } catch (err) {
    if (err.code === 'RETIRO_SCHEMA_MISSING') {
      return res.status(503).json({
        error: 'Falta aplicar migraciones de retiros en la base de datos.',
        codigo: 'RETIRO_SCHEMA_MISSING',
        faltantes: ['public.retiros_solicitudes'],
      });
    }
    console.error('Error GET /retiros/mis-solicitudes:', err);
    res.status(500).json({ error: 'Error al obtener solicitudes' });
  }
});

module.exports = router;
