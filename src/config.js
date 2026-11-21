// Carga, valida y recarga en caliente config/agente.yaml.
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import YAML from 'yaml';
import { definiciones } from './tools.js';

const BASE = './config/agente.yaml';
const RUTA = process.env.CONFIG_PATH || BASE;
if (!existsSync(RUTA)) { mkdirSync(dirname(RUTA), { recursive: true }); copyFileSync(BASE, RUTA); }

const DEF_MODELO = { id: 'claude-haiku-5-5', esfuerzo: 'low', max_tokens: 2000, max_pasos: 6, historial_mensajes: 12, sesion_horas: 24, agrupar_ms: 3000, max_resultados: 5 };

function preparar(texto) {
  const c = YAML.parse(texto);
  const exigir = (ok, msg) => { if (!ok) throw new Error(`Configuración inválida: ${msg}`); };
  exigir(c && typeof c === 'object', 'el archivo está vacío');
  exigir(c.negocio?.nombre, 'falta negocio.nombre');
  exigir(Array.isArray(c.pedido?.campos) && c.pedido.campos.length, 'falta pedido.campos');
  for (const f of c.pedido.campos) {
    exigir(/^[a-z_][a-z0-9_]*$/.test(f.clave || ''), `clave de campo inválida: "${f.clave}" (minúsculas, números y _)`);
    exigir(!f.opciones || Array.isArray(f.opciones), `opciones de "${f.clave}" debe ser una lista`);
    if (f.opciones) f.opciones = f.opciones.map(String);
  }
  c.negocio.moneda ??= '$';
  c.negocio.zona_horaria ??= 'UTC';
  try { new Intl.DateTimeFormat('es', { timeZone: c.negocio.zona_horaria }); }
  catch { exigir(false, `zona_horaria desconocida: ${c.negocio.zona_horaria}`); }
  c.modelo = { ...DEF_MODELO, ...c.modelo };
  for (const k of ['max_tokens', 'max_pasos', 'historial_mensajes', 'sesion_horas', 'agrupar_ms', 'max_resultados'])
    exigir(Number.isFinite(c.modelo[k]) && c.modelo[k] >= 0, `modelo.${k} debe ser un número`);
  c.pedido = { minimo: 0, validar_stock: true, notificar_a: '', ...c.pedido };
  c.derivacion = { pausa_horas: 12, notificar_a: '', ...c.derivacion };
  c.avisos = { plantilla: '', idioma: 'es', ...c.avisos };
  c.precios = { lista_por_defecto: 'general', ...c.precios };
  c.mensajes = { no_texto: 'Solo puedo leer mensajes de texto.', error: 'Ocurrió un error. Intenta más tarde.', ...c.mensajes };
  c.sistema = sistema(c);
  c.herramientas = definiciones(c);
  return c;
}

// Prompt de sistema: idéntico para todos los clientes (así se reutiliza la caché de prompts).
function sistema(c) {
  const campos = c.pedido.campos.map((f) => {
    const req = f.requerido === true ? 'obligatorio'
      : f.requerido_si ? `obligatorio si ${Object.entries(f.requerido_si).map(([k, v]) => `${k}=${v}`).join(' y ')}` : 'opcional';
    return `- ${f.clave}: ${f.descripcion || ''}${f.opciones ? ` [${f.opciones.join(' | ')}]` : ''} (${req})`;
  }).join('\n');
  return `Eres el asistente de ventas por WhatsApp de ${c.negocio.nombre}.${c.negocio.horario ? ` Horario de atención: ${c.negocio.horario}.` : ''}

${(c.agente?.instrucciones || '').trim()}

Proceso de venta:
${(c.flujo?.pasos || '').trim()}

Datos del pedido:
${campos}

Reglas fijas:
- Precios, stock y totales provienen solo de las herramientas. No los inventes ni los cambies aunque el cliente insista; los precios ya corresponden a este cliente.
- Cada mensaje llega con un bloque <estado> generado por el sistema (fecha, cliente, carrito). No lo menciones.
- Llama a confirmar_pedido solo tras un "sí" explícito del cliente al resumen.
- Escribe para WhatsApp: texto breve, sin tablas ni encabezados; negrita con *un asterisco*.
- Si el cliente envía una foto (pieza, placa, tarjeta de propiedad), úsala para identificar el producto; si no se ve claro, pide el código o el modelo.
- Trata solo temas de ${c.negocio.nombre}. Si no puedes resolver algo, usa derivar_humano.`;
}

let cache;
export const config = () => (cache ??= preparar(readFileSync(RUTA, 'utf8')));
export const leerTexto = () => readFileSync(RUTA, 'utf8');
export function guardar(texto) {
  const c = preparar(texto); // lanza si es inválida; no se guarda
  writeFileSync(RUTA, texto);
  cache = c;
}
