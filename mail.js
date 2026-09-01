const { Resend } = require('resend');

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const DE = process.env.MAIL_FROM || 'CajaViva <hola@cajaviva.app>';
const APP = process.env.APP_URL || 'https://cajaviva.app';

function envolver(titulo, cuerpo) {
  return '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#2C3E37;">' +
    '<h1 style="font-size:21px;margin:0 0 16px;color:#1E7A5A;">' + titulo + '</h1>' +
    cuerpo +
    '<p style="font-size:12px;color:#8A9691;margin-top:28px;border-top:1px solid #E4EAE7;padding-top:14px;">' +
    'CajaViva - la app para manejar tu negocio</p></div>';
}

async function mandar(para, asunto, html) {
  if (!resend || !para) return { ok: false, motivo: 'sin configurar' };
  try {
    const r = await resend.emails.send({ from: DE, to: para, subject: asunto, html: html });
    if (r.error) { console.error('Mail error:', r.error); return { ok: false, motivo: r.error.message }; }
    return { ok: true, id: r.data && r.data.id };
  } catch (e) {
    console.error('Mail error:', e.message);
    return { ok: false, motivo: e.message };
  }
}

function mailBienvenida(para, usuario) {
  return mandar(para, 'Bienvenido a CajaViva', envolver('Ya tenes tu cuenta lista',
    '<p style="font-size:15px;line-height:1.55;">Hola! Tu cuenta <b>' + usuario + '</b> quedo creada.</p>' +
    '<p style="font-size:15px;line-height:1.55;">Desde CajaViva podes vender, controlar el stock, llevar la caja, ' +
    'anotar el fiado y mucho mas. Todo desde el celular, aunque te quedes sin internet.</p>' +
    '<p style="margin:24px 0;"><a href="' + APP + '" style="background:#1E7A5A;color:#fff;text-decoration:none;' +
    'padding:12px 22px;border-radius:10px;font-size:15px;display:inline-block;">Entrar a CajaViva</a></p>' +
    '<p style="font-size:13.5px;color:#6B7975;">Guarda este mail: si alguna vez te olvidas la contrasena, ' +
    'la vas a poder recuperar desde esta direccion.</p>'));
}

function mailRecuperar(para, usuario, link) {
  return mandar(para, 'Recuperar tu contrasena de CajaViva', envolver('Recuperar tu contrasena',
    '<p style="font-size:15px;line-height:1.55;">Pediste cambiar la contrasena de tu cuenta <b>' + usuario + '</b>.</p>' +
    '<p style="margin:24px 0;"><a href="' + link + '" style="background:#1E7A5A;color:#fff;text-decoration:none;' +
    'padding:12px 22px;border-radius:10px;font-size:15px;display:inline-block;">Poner una contrasena nueva</a></p>' +
    '<p style="font-size:13.5px;color:#6B7975;">El link vence en 1 hora y se puede usar una sola vez. ' +
    'Si no fuiste vos, ignora este mail: tu contrasena sigue igual.</p>'));
}

module.exports = { mandar, mailBienvenida, mailRecuperar };
