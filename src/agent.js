// Bucle del agente: Claude + herramientas. Un turno = un mensaje (o ráfaga) del cliente.
import Anthropic from '@anthropic-ai/sdk';
import * as db from './db.js';
import { config } from './config.js';
import { ejecutar, textoCarrito } from './tools.js';

let cliente;
const api = () => (cliente ??= new Anthropic());

export async function responder(telefono, texto, nombrePerfil = '', notificar = async () => {}, imagenes = []) {
  const cfg = config();
  const m = cfg.modelo;
  const cli = db.cliente(telefono, nombrePerfil);
  const ctx = { cfg, telefono, cliente: cli, lista: cli.lista || cfg.precios.lista_por_defecto, listaDef: cfg.precios.lista_por_defecto, notificar };

  const limpio = texto.replace(/<\/?estado[^>]*>/gi, '').slice(0, 2000);
  const fecha = new Intl.DateTimeFormat('es', { timeZone: cfg.negocio.zona_horaria, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date());
  const estado = `<estado>${fecha} | cliente: ${cli.nombre || 'sin nombre'} | carrito: ${textoCarrito(ctx)}</estado>`;
  const messages = [
    ...db.historial(telefono, m.historial_mensajes, Date.now() - m.sesion_horas * 3600e3),
    { role: 'user', content: [...imagenes.map((source) => ({ type: 'image', source: { type: 'base64', ...source } })),
      { type: 'text', text: `${estado}\n${limpio || '(el cliente envió una imagen)'}` }] },
  ];

  const uso = { llamadas: 0, entrada: 0, salida: 0, cache_lectura: 0, cache_escritura: 0 };
  let respuesta = '';
  try {
    for (let paso = 0; paso < m.max_pasos; paso++) {
      const r = await api().messages.create({
        model: m.id,
        max_tokens: m.max_tokens,
        // Herramientas + sistema son el prefijo estable: se cachea y lo comparten todos los chats.
        system: [{ type: 'text', text: cfg.sistema, cache_control: { type: 'ephemeral' } }],
        tools: cfg.herramientas,
        messages,
        ...(m.esfuerzo ? { output_config: { effort: m.esfuerzo } } : {}),
      });
      uso.llamadas++;
      uso.entrada += r.usage.input_tokens;
      uso.salida += r.usage.output_tokens;
      uso.cache_lectura += r.usage.cache_read_input_tokens ?? 0;
      uso.cache_escritura += r.usage.cache_creation_input_tokens ?? 0;

      if (r.stop_reason === 'refusal') break;
      if (r.stop_reason !== 'tool_use') {
        respuesta = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        break;
      }
      messages.push({ role: 'assistant', content: r.content });
      const resultados = [];
      for (const b of r.content) {
        if (b.type !== 'tool_use') continue;
        try {
          resultados.push({ type: 'tool_result', tool_use_id: b.id, content: await ejecutar(b.name, b.input, ctx) });
        } catch (e) {
          resultados.push({ type: 'tool_result', tool_use_id: b.id, content: e.message, is_error: true });
        }
      }
      messages.push({ role: 'user', content: resultados });
    }
  } finally {
    if (uso.llamadas) db.registrarUso(uso);
    console.log(`[uso] +${telefono} llamadas=${uso.llamadas} in=${uso.entrada} out=${uso.salida} cache=${uso.cache_lectura}`);
  }
  if (!respuesta) return cfg.mensajes.error;
  db.guardarTurno(telefono, (imagenes.length ? '[imagen] ' : '') + limpio, respuesta); // solo texto: el historial se mantiene pequeño
  return respuesta;
}
