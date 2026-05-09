const nodemailer = require('nodemailer');

class EmailService {
  constructor() {
    this.transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });
  }

  async enviarCodigoVerificacion(email, codigo, nombreUsuario) {
    const mailOptions = {
      from: `"Dota 2 Apuestas" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Código de verificación - Dota 2 Apuestas',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; background: #0f1923; color: #e2e8f0; padding: 32px; border-radius: 12px;">
          <h2 style="color: #f6ad55; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 8px;">Dota 2 Apuestas</h2>
          <p style="color: #94a3b8; margin-bottom: 24px;">Verificación de inicio de sesión</p>
          <p style="margin-bottom: 8px;">Hola <strong>${nombreUsuario || 'jugador'}</strong>,</p>
          <p style="margin-bottom: 24px; color: #94a3b8;">Tu código de verificación para iniciar sesión es:</p>
          <div style="background: #1e293b; border: 1px solid #f6ad55; border-radius: 8px; padding: 20px; text-align: center; margin-bottom: 24px;">
            <span style="font-size: 2.4rem; font-weight: 900; letter-spacing: 12px; color: #f6ad55;">${codigo}</span>
          </div>
          <p style="color: #64748b; font-size: 0.85rem;">Este código expira en <strong style="color: #94a3b8;">10 minutos</strong>.</p>
          <p style="color: #64748b; font-size: 0.85rem;">Si no fuiste tú, ignora este mensaje.</p>
        </div>
      `
    };

    await this.transporter.sendMail(mailOptions);
  }

  async enviarBono(email, nombreUsuario, monto, mensajeAdmin) {
    const montoFmt = Number(monto).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const mailOptions = {
      from: `"Dota 2 Apuestas" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: `¡Recibiste un bono de S/ ${montoFmt}! - Dota 2 Apuestas`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; background: #0f1923; color: #e2e8f0; padding: 32px; border-radius: 12px;">
          <h2 style="color: #f6ad55; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 8px;">Dota 2 Apuestas</h2>
          <p style="color: #94a3b8; margin-bottom: 24px;">Bono acreditado a tu cuenta</p>
          <p style="margin-bottom: 8px;">Hola <strong>${nombreUsuario || 'jugador'}</strong>,</p>
          <p style="margin-bottom: 24px; color: #94a3b8;">Se ha acreditado un bono en tu cuenta:</p>
          <div style="background: #1e293b; border: 1px solid #22c55e; border-radius: 8px; padding: 20px; text-align: center; margin-bottom: 24px;">
            <span style="font-size: 2rem; font-weight: 900; letter-spacing: 6px; color: #22c55e;">S/ ${montoFmt}</span>
          </div>
          ${mensajeAdmin ? `<div style="background: #162032; border-left: 3px solid #f6ad55; border-radius: 4px; padding: 14px 16px; margin-bottom: 20px; color: #cbd5e1; font-size: 0.9rem; line-height: 1.6;">${String(mensajeAdmin).replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>` : ''}
          <p style="color: #64748b; font-size: 0.85rem;">El saldo ya está disponible para usar en tus apuestas.</p>
          <p style="color: #64748b; font-size: 0.85rem;">¡Buena suerte!</p>
        </div>
      `
    };
    await this.transporter.sendMail(mailOptions);
  }
}

module.exports = new EmailService();
