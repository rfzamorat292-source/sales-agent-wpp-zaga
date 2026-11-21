// Servidor HTTP: webhook de WhatsApp + panel de administración.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import * as db from './db.js';
import * as wa from './whatsapp.js';
import * as csv from './csv.js';
import { config, leerTexto, guardar } from './config.js';
import { responder } from './agent.js';

const env = process.env;
config(); // falla al iniciar si la configuración es inválida
if (!env.WHATSAPP_APP_SECRET) console.warn('AVISO: sin WHATSAPP_APP_SECRET no se verifica la firma del webhook.');
if (!env.ADMIN_TOKEN) console.warn('AVISO: sin ADMIN_TOKEN el panel /admin queda deshabilitado.');

// ---- Cola por cliente: agrupa mensajes seguidos y procesa un turno a la vez ----
const pendientes = new Map(); // telefono -> { textos, nombre, timer }
const colas = new Map();      // telefono -> promesa del turno en curso

function encolar({ de, nombre, texto, imagen }) {
  const p = pendientes.get(de) ?? { textos: [], imagenes: [] };
  if (texto) p.textos.push(texto);
  if (imagen) p.imagenes.push(imagen);
  p.nombre = nombre;
  clearTimeout(p.timer);
  p.timer = setTimeout(() => {
    pendientes.delete(de);
    const turno = (colas.get(de) ?? Promise.resolve())
      .then(() => procesar(de, p.textos.join('\n'), p.nombre, p.imagenes))
      .finally(() => { if (colas.get(de) === turno) colas.delete(de); });
    colas.set(de, turno);
  }, config().modelo.agrupar_ms);
  pendientes.set(de, p);
}

// Avisos al negocio: con plantilla (avisos.plantilla) llegan aunque ese número no haya escrito en 24 h.
const notificar = async (a, texto) => {
  if (!a) return;
  const tel = String(a).replace(/\D/g, ''), pl = config().avisos?.plantilla;
  await (pl ? wa.enviarPlantilla(tel, pl, config().avisos.idioma || 'es', texto) : wa.enviarTexto(tel, texto))
    .catch((e) => console.error('[notificar]', e.message));
};

async function procesar(telefono, texto, nombre, ids = []) {
  if (db.pausado(telefono)) return; // chat derivado a una persona
  try {
    const imagenes = (await Promise.all(ids.slice(-3).map((id) => wa.descargarImagen(id).catch(() => null)))).filter(Boolean);
    if (!texto && !imagenes.length) return void await wa.enviarTexto(telefono, config().mensajes.no_texto);
    await wa.enviarTexto(telefono, await responder(telefono, texto, nombre, notificar, imagenes));
  } catch (e) {
    console.error('[turno]', telefono, e.status ?? '', e.message);
    await wa.enviarTexto(telefono, config().mensajes.error).catch(() => {});
  }
}

function recibir(body) {
  for (const e of body?.entry ?? []) for (const ch of e.changes ?? []) for (const s of ch.value?.statuses ?? [])
    if (s.status === 'failed') console.error('[entrega fallida]', s.recipient_id, s.errors?.map((x) => `${x.code} ${x.title}: ${x.error_data?.details ?? x.message ?? ''}`).join(' | '));
  for (const m of wa.extraerMensajes(body)) {
    if (db.yaProcesado(m.id)) continue; // Meta reintenta entregas
    wa.marcarLeido(m.id).catch(() => {});
    if (m.texto === null) {
      if (!db.pausado(m.de)) wa.enviarTexto(m.de, config().mensajes.no_texto).catch((e) => console.error(e.message));
    } else encolar(m);
  }
}

// ---- HTTP ----
const leer = (req, max) => new Promise((ok, err) => {
  const partes = []; let n = 0;
  req.on('data', (c) => { n += c.length; if (n > max) { err(new Error('demasiado grande')); req.destroy(); } else partes.push(c); });
  req.on('end', () => ok(Buffer.concat(partes)));
  req.on('error', err);
});
const enviar = (res, codigo, cuerpo, tipo = 'text/plain') => {
  res.writeHead(codigo, { 'content-type': `${tipo}; charset=utf-8`, 'cache-control': 'no-store' });
  res.end(typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo));
};
const tokenOk = (t) => {
  const a = Buffer.from(String(t || '')), b = Buffer.from(env.ADMIN_TOKEN || '');
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
};

async function admin(req, res, ruta) {
  if (!tokenOk(req.headers['x-admin-token'])) return enviar(res, 401, 'No autorizado');
  const [recurso, nombre] = ruta.split('/');
  if (recurso === 'texto' && (nombre === 'config' || db.COLUMNAS[nombre])) {
    if (req.method === 'GET')
      return enviar(res, 200, nombre === 'config' ? leerTexto() : csv.stringify(db.exportar(nombre), db.COLUMNAS[nombre]));
    if (req.method === 'PUT') {
      const texto = (await leer(req, 5e6)).toString('utf8');
      try {
        if (nombre === 'config') { guardar(texto); return enviar(res, 200, 'Configuración guardada y aplicada.'); }
        const n = db.importar(nombre, csv.parse(texto), config().derivacion.pausa_horas * 3600e3);
        return enviar(res, 200, `${n} filas guardadas.`);
      } catch (e) { return enviar(res, 400, e.message); }
    }
  }
  if (req.method === 'GET' && recurso === 'pedidos') return enviar(res, 200, db.pedidos(), 'application/json');
  if (req.method === 'POST' && recurso === 'responder') { // el vendedor escribe al cliente desde el panel
    const { telefono, texto, pedido, estado } = JSON.parse((await leer(req, 1e5)).toString('utf8'));
    const tel = String(telefono || '').replace(/\D/g, ''), t = String(texto || '').trim();
    if (!tel || (!t && !estado)) return enviar(res, 400, 'Faltan teléfono y mensaje.');
    try {
      if (t) { await wa.enviarTexto(tel, t); db.guardarMensaje(tel, 'assistant', t); }
      if (pedido && estado) db.estadoPedido(Number(pedido), estado);
      return enviar(res, 200, t ? 'Mensaje enviado.' : 'Estado actualizado.');
    } catch (e) { return enviar(res, 502, `No se pudo enviar (fuera de las 24 h Meta exige plantilla): ${e.message}`); }
  }
  if (req.method === 'GET' && recurso === 'uso') return enviar(res, 200, db.uso(), 'application/json');
  if (req.method === 'POST' && recurso === 'probar') {
    const { telefono, texto } = JSON.parse((await leer(req, 1e5)).toString('utf8'));
    const tel = String(telefono || '').replace(/\D/g, '') || '0000';
    try { return enviar(res, 200, await responder(tel, String(texto || ''), '')); } // sin envíos por WhatsApp
    catch (e) { return enviar(res, 502, `Error del modelo: ${e.message}`); }
  }
  enviar(res, 404, 'No encontrado');
}

createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/webhook' && req.method === 'GET') { // verificación de Meta
      const ok = u.searchParams.get('hub.mode') === 'subscribe' && env.WHATSAPP_VERIFY_TOKEN &&
        u.searchParams.get('hub.verify_token') === env.WHATSAPP_VERIFY_TOKEN;
      return enviar(res, ok ? 200 : 403, ok ? u.searchParams.get('hub.challenge') || '' : 'Prohibido');
    }
    if (u.pathname === '/webhook' && req.method === 'POST') {
      const cuerpo = await leer(req, 1e6);
      if (!wa.firmaValida(cuerpo, req.headers['x-hub-signature-256'])) return enviar(res, 401, 'Firma inválida');
      enviar(res, 200, 'ok'); // responder de inmediato; el turno se procesa después
      return recibir(JSON.parse(cuerpo.toString('utf8')));
    }
    if (u.pathname === '/admin' && req.method === 'GET')
      return enviar(res, 200, readFileSync(new URL('./admin.html', import.meta.url), 'utf8'), 'text/html');
    if (u.pathname.startsWith('/admin/api/')) return await admin(req, res, u.pathname.slice(11));
    if (u.pathname === '/salud') return enviar(res, 200, 'ok');
    enviar(res, 404, 'No encontrado');
  } catch (e) {
    console.error('[http]', e.message);
    if (!res.headersSent) enviar(res, 400, 'Solicitud inválida');
  }
}).listen(env.PORT || 3000, () => console.log(`Agente escuchando en :${env.PORT || 3000}`));
