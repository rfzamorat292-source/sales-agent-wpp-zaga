// Herramientas del agente. Precios, stock y totales se resuelven aquí (nunca en el modelo).
import * as db from './db.js';

export function definiciones(cfg) {
  const props = {}, required = [];
  for (const c of cfg.pedido.campos) {
    props[c.clave] = { type: 'string', description: c.descripcion || c.clave };
    if (c.opciones) props[c.clave].enum = c.opciones;
    if (c.requerido === true) required.push(c.clave);
  }
  return [
    {
      name: 'buscar_productos',
      description: 'Busca en el catálogo. Busca por código, nombre, marca o modelo de vehículo. Devuelve SKU, nombre, precio para este cliente, stock y compatibilidad. Consulta vacía = lista de categorías.',
      input_schema: { type: 'object', properties: { consulta: { type: 'string', description: 'Palabras clave del producto' } }, required: ['consulta'] },
    },
    {
      name: 'actualizar_carrito',
      description: 'Fija la cantidad de un producto en el carrito (0 lo quita). Devuelve el carrito.',
      input_schema: { type: 'object', properties: { sku: { type: 'string' }, cantidad: { type: 'integer' } }, required: ['sku', 'cantidad'] },
    },
    {
      name: 'confirmar_pedido',
      description: 'Registra el pedido con el carrito actual. Úsala solo después de que el cliente confirme el resumen.',
      input_schema: { type: 'object', properties: props, required },
    },
    {
      name: 'derivar_humano',
      description: 'Pasa el chat a una persona del negocio (reclamos, casos fuera de tu alcance o si el cliente lo pide).',
      input_schema: { type: 'object', properties: { motivo: { type: 'string' } }, required: ['motivo'] },
    },
  ];
}

const dinero = (cfg, n) => `${cfg.negocio.moneda}${n.toFixed(2)}`;

export function textoCarrito(ctx) {
  const { items, total } = db.carrito(ctx.telefono, ctx.lista, ctx.listaDef);
  if (!items.length) return 'vacío';
  return items.map((i) => `${i.cantidad} x ${i.nombre} [${i.sku}] ${dinero(ctx.cfg, i.precio)}`).join('; ') + ` | Total ${dinero(ctx.cfg, total)}`;
}

export async function ejecutar(nombre, input, ctx) {
  const { cfg, telefono, lista, listaDef } = ctx;
  switch (nombre) {
    case 'buscar_productos': {
      const r = db.buscar(String(input.consulta || ''), lista, listaDef, cfg.modelo.max_resultados, cfg.pedido.validar_stock);
      if (!r.length) return `Sin resultados. Categorías: ${db.categorias(cfg.pedido.validar_stock).join(', ') || 'ninguna'}.`;
      return r.map((p) => `${p.sku} | ${p.nombre} | ${dinero(cfg, p.precio)} | stock ${p.stock}` +
        (p.compatibilidad ? ` | compatible: ${p.compatibilidad.slice(0, 150)}` : '') +
        (p.descripcion ? ` | ${p.descripcion.slice(0, 100)}` : '')).join('\n');
    }
    case 'actualizar_carrito': {
      const p = db.producto(String(input.sku || ''), lista, listaDef);
      if (!p) throw new Error('SKU inexistente. Usa buscar_productos.');
      const cant = Math.trunc(Number(input.cantidad));
      if (!Number.isFinite(cant) || cant < 0) throw new Error('Cantidad inválida.');
      if (cfg.pedido.validar_stock && cant > p.stock) throw new Error(`Stock insuficiente: quedan ${p.stock} de ${p.nombre}.`);
      db.ponerEnCarrito(telefono, p.sku, cant);
      return `Carrito: ${textoCarrito(ctx)}`;
    }
    case 'confirmar_pedido': {
      const datos = {}, faltan = [];
      for (const c of cfg.pedido.campos) {
        const v = String(input[c.clave] ?? '').trim();
        if (v && c.opciones && !c.opciones.includes(v)) throw new Error(`${c.clave} debe ser: ${c.opciones.join(', ')}.`);
        if (v) datos[c.clave] = v.slice(0, 300);
      }
      for (const c of cfg.pedido.campos) {
        const req = c.requerido === true ||
          (c.requerido_si && Object.entries(c.requerido_si).every(([k, v]) => datos[k] === String(v)));
        if (req && !datos[c.clave]) faltan.push(c.clave);
      }
      if (faltan.length) throw new Error(`Faltan datos: ${faltan.join(', ')}. Pídelos al cliente.`);
      const ped = db.crearPedido(telefono, datos, lista, listaDef,
        { validarStock: cfg.pedido.validar_stock, minimo: cfg.pedido.minimo });
      const detalle = ped.items.map((i) => `${i.cantidad} x ${i.nombre} [${i.sku}]`).join('; ');
      await ctx.notificar(cfg.pedido.notificar_a,
        `Nuevo pedido #${ped.id} de +${telefono}\n${detalle}\nTotal ${dinero(cfg, ped.total)}\n` +
        Object.entries(datos).map(([k, v]) => `${k}: ${v}`).join('\n'));
      const pago = cfg.pedido.instrucciones_pago?.[datos.pago];
      return `Pedido #${ped.id} registrado. Total ${dinero(cfg, ped.total)}.` + (pago ? ` Indicaciones de pago: ${pago}` : '');
    }
    case 'derivar_humano': {
      db.pausar(telefono, Date.now() + cfg.derivacion.pausa_horas * 3600e3);
      await ctx.notificar(cfg.derivacion.notificar_a,
        `Atención requerida: +${telefono} (${ctx.cliente.nombre || 'sin nombre'}). Motivo: ${String(input.motivo || '').slice(0, 300)}`);
      return 'Derivado. Avisa al cliente que una persona del equipo continuará la atención por este chat.';
    }
    default:
      throw new Error('Herramienta desconocida.');
  }
}
