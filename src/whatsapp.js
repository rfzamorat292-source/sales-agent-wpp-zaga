// WhatsApp Cloud API (Meta): verificación de firma, lectura del webhook y envío.
import { createHmac, timingSafeEqual } from 'node:crypto';

const env = process.env;
const url = () => `https://graph.facebook.com/${env.GRAPH_VERSION || 'v23.0'}/${env.WHATSAPP_PHONE_ID}/messages`;

export function firmaValida(cuerpo, cabecera) {
  if (!env.WHATSAPP_APP_SECRET) return true; // sin secreto no se puede verificar (ver aviso al iniciar)
  const esperada = Buffer.from('sha256=' + createHmac('sha256', env.WHATSAPP_APP_SECRET).update(cuerpo).digest('hex'));
  const recibida = Buffer.from(String(cabecera || ''));
  return esperada.length === recibida.length && timingSafeEqual(esperada, recibida);
}

// Devuelve [{ id, de, nombre, texto, imagen }] ; texto = null si no es texto ni imagen.
export function extraerMensajes(body) {
  const out = [];
  for (const e of body?.entry ?? []) for (const ch of e.changes ?? []) {
    const v = ch.value ?? {};
    const nombres = Object.fromEntries((v.contacts ?? []).map((c) => [c.wa_id, c.profile?.name || '']));
    for (const m of v.messages ?? []) {
      const texto = m.type === 'text' ? m.text?.body
        : m.type === 'interactive' ? (m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title)
        : m.type === 'button' ? m.button?.text
        : m.type === 'image' ? (m.image?.caption || '') : null;
      out.push({ id: m.id, de: m.from, nombre: nombres[m.from] || '', texto: texto ?? null, imagen: m.type === 'image' ? m.image?.id : null });
    }
  }
  return out;
}

async function enviar(payload) {
  const r = await fetch(url(), {
    method: 'POST',
    headers: { authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
  });
  if (!r.ok) throw new Error(`WhatsApp ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

export async function enviarTexto(a, texto) {
  for (let i = 0; i < texto.length; i += 4000) // límite de WhatsApp: 4096 caracteres
    await enviar({ to: a, type: 'text', text: { body: texto.slice(i, i + 4000) } });
}
export const marcarLeido = (id) => enviar({ status: 'read', message_id: id });

// Descarga una imagen recibida. Devuelve { media_type, data (base64) } o null si no es apta para el modelo.
const TIPOS = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
export async function descargarImagen(id) {
  const auth = { authorization: `Bearer ${env.WHATSAPP_TOKEN}` };
  const meta = await (await fetch(`https://graph.facebook.com/${env.GRAPH_VERSION || 'v23.0'}/${id}`, { headers: auth })).json();
  if (!TIPOS.includes(meta.mime_type) || meta.file_size > 4.5e6) return null;
  const r = await fetch(meta.url, { headers: auth });
  if (!r.ok) throw new Error(`WhatsApp media ${r.status}`);
  return { media_type: meta.mime_type, data: Buffer.from(await r.arrayBuffer()).toString('base64') };
}

// Plantilla aprobada con un parámetro {{1}} en el cuerpo (Meta no admite saltos de línea en parámetros).
export const enviarPlantilla = (a, nombre, idioma, texto) => enviar({
  to: a, type: 'template',
  template: { name: nombre, language: { code: idioma }, components: [{ type: 'body',
    parameters: [{ type: 'text', text: texto.replace(/\s*\n\s*/g, ' · ').replace(/\s{4,}/g, '   ').slice(0, 1000) }] }] },
});
