// Capa de datos (SQLite integrado en Node). Para usar otra base, reimplementa estas funciones.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const ruta = process.env.DB_PATH || './data/negocio.db';
if (ruta !== ':memory:') mkdirSync(dirname(ruta), { recursive: true });
const db = new DatabaseSync(ruta);

db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS productos (sku TEXT PRIMARY KEY, nombre TEXT NOT NULL, descripcion TEXT, categoria TEXT, stock INTEGER DEFAULT 0, activo INTEGER DEFAULT 1, compatibilidad TEXT);
CREATE TABLE IF NOT EXISTS precios (sku TEXT, lista TEXT, precio REAL NOT NULL, PRIMARY KEY (sku, lista));
CREATE TABLE IF NOT EXISTS clientes (telefono TEXT PRIMARY KEY, nombre TEXT, lista TEXT, pausado_hasta INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS mensajes (id INTEGER PRIMARY KEY AUTOINCREMENT, telefono TEXT, rol TEXT, texto TEXT, ts INTEGER);
CREATE INDEX IF NOT EXISTS mensajes_tel ON mensajes (telefono, id);
CREATE TABLE IF NOT EXISTS carrito (telefono TEXT, sku TEXT, cantidad INTEGER, PRIMARY KEY (telefono, sku));
CREATE TABLE IF NOT EXISTS pedidos (id INTEGER PRIMARY KEY AUTOINCREMENT, telefono TEXT, datos TEXT, items TEXT, total REAL, estado TEXT DEFAULT 'nuevo', ts INTEGER);
CREATE TABLE IF NOT EXISTS procesados (wamid TEXT PRIMARY KEY, ts INTEGER);
CREATE TABLE IF NOT EXISTS uso (dia TEXT PRIMARY KEY, turnos INTEGER, llamadas INTEGER, entrada INTEGER, salida INTEGER, cache_lectura INTEGER, cache_escritura INTEGER);
CREATE VIRTUAL TABLE IF NOT EXISTS productos_fts USING fts5(sku UNINDEXED, texto, tokenize = 'unicode61 remove_diacritics 2');
`);

// Migración: bases creadas antes de la columna compatibilidad.
if (!db.prepare('PRAGMA table_info(productos)').all().some((c) => c.name === 'compatibilidad'))
  db.exec('ALTER TABLE productos ADD COLUMN compatibilidad TEXT');

const q = (sql) => db.prepare(sql);
const redondear = (n) => Math.round(n * 100) / 100;

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---- Clientes ----
export function cliente(telefono, nombre = '') {
  q('INSERT OR IGNORE INTO clientes (telefono, nombre) VALUES (?, ?)').run(telefono, nombre);
  if (nombre) q("UPDATE clientes SET nombre = ? WHERE telefono = ? AND COALESCE(nombre, '') = ''").run(nombre, telefono);
  return q('SELECT * FROM clientes WHERE telefono = ?').get(telefono);
}
export const pausado = (telefono) =>
  (q('SELECT pausado_hasta p FROM clientes WHERE telefono = ?').get(telefono)?.p ?? 0) > Date.now();
export const pausar = (telefono, hasta) =>
  q('UPDATE clientes SET pausado_hasta = ? WHERE telefono = ?').run(hasta, telefono);

// ---- Conversación ----
export function historial(telefono, n, desde) {
  const filas = q('SELECT rol, texto FROM mensajes WHERE telefono = ? AND ts > ? ORDER BY id DESC LIMIT ?')
    .all(telefono, desde, n).reverse();
  while (filas.length && filas[0].rol !== 'user') filas.shift();
  return filas.map((f) => ({ role: f.rol, content: f.texto }));
}
export function guardarTurno(telefono, usuario, asistente) {
  const ins = q('INSERT INTO mensajes (telefono, rol, texto, ts) VALUES (?, ?, ?, ?)');
  const ts = Date.now();
  tx(() => { ins.run(telefono, 'user', usuario, ts); ins.run(telefono, 'assistant', asistente, ts); });
}

// ---- Catálogo y precios por lista ----
const SEL = `SELECT p.sku, p.nombre, p.descripcion, p.categoria, p.compatibilidad, p.stock, COALESCE(a.precio, g.precio) AS precio`;
const JOIN = `LEFT JOIN precios a ON a.sku = p.sku AND a.lista = ? LEFT JOIN precios g ON g.sku = p.sku AND g.lista = ?`;
const VIS = `p.activo = 1 AND COALESCE(a.precio, g.precio) IS NOT NULL`;

export function buscar(consulta, lista, listaDef, limite, soloStock = false) {
  const tokens = (consulta.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]+/g) || [])
    .filter((t) => t.length > 1)
    .map((t) => (t.length > 4 ? t.replace(/(es|s)$/, '') : t)); // plural -> raíz
  if (!tokens.length) return [];
  const sql = q(`${SEL} FROM productos_fts JOIN productos p ON p.sku = productos_fts.sku ${JOIN}
    WHERE productos_fts MATCH ? AND ${VIS}${soloStock ? ' AND p.stock > 0' : ''} ORDER BY rank LIMIT ?`);
  const terminos = tokens.map((t) => `"${t}"*`);
  const r = sql.all(lista, listaDef, terminos.join(' '), limite);
  return r.length || tokens.length === 1 ? r : sql.all(lista, listaDef, terminos.join(' OR '), limite);
}
export const producto = (sku, lista, listaDef) =>
  q(`${SEL} FROM productos p ${JOIN} WHERE ${VIS} AND p.sku = ? COLLATE NOCASE`).get(lista, listaDef, sku);
export const categorias = (soloStock = false) =>
  q(`SELECT DISTINCT categoria c FROM productos WHERE activo = 1${soloStock ? ' AND stock > 0' : ''} AND COALESCE(categoria, '') <> '' ORDER BY 1`).all().map((f) => f.c);

// ---- Carrito y pedidos ----
export function carrito(telefono, lista, listaDef) {
  const items = q(`SELECT c.cantidad, p.sku, p.nombre, p.stock, COALESCE(a.precio, g.precio) AS precio
    FROM carrito c JOIN productos p ON p.sku = c.sku ${JOIN} WHERE c.telefono = ? AND ${VIS}`).all(lista, listaDef, telefono);
  return { items, total: redondear(items.reduce((s, i) => s + i.precio * i.cantidad, 0)) };
}
export function ponerEnCarrito(telefono, sku, cantidad) {
  if (cantidad <= 0) q('DELETE FROM carrito WHERE telefono = ? AND sku = ?').run(telefono, sku);
  else q(`INSERT INTO carrito (telefono, sku, cantidad) VALUES (?, ?, ?)
    ON CONFLICT (telefono, sku) DO UPDATE SET cantidad = excluded.cantidad`).run(telefono, sku, cantidad);
}
export function crearPedido(telefono, datos, lista, listaDef, { validarStock, minimo }) {
  return tx(() => {
    const { items, total } = carrito(telefono, lista, listaDef);
    if (!items.length) throw new Error('El carrito está vacío.');
    if (total < minimo) throw new Error(`El pedido mínimo es ${minimo}.`);
    if (validarStock) for (const i of items)
      if (i.cantidad > i.stock) throw new Error(`Stock insuficiente de ${i.nombre} (${i.sku}): quedan ${i.stock}.`);
    const r = q('INSERT INTO pedidos (telefono, datos, items, total, ts) VALUES (?, ?, ?, ?, ?)')
      .run(telefono, JSON.stringify(datos), JSON.stringify(items.map(({ stock, ...i }) => i)), total, Date.now());
    if (validarStock) for (const i of items)
      q('UPDATE productos SET stock = MAX(stock - ?, 0) WHERE sku = ?').run(i.cantidad, i.sku);
    q('DELETE FROM carrito WHERE telefono = ?').run(telefono);
    return { id: Number(r.lastInsertRowid), items, total };
  });
}
export const estadoPedido = (id, estado) =>
  q('UPDATE pedidos SET estado = ? WHERE id = ?').run(String(estado).slice(0, 30), id).changes;
export function guardarMensaje(telefono, rol, texto) {
  q('INSERT INTO mensajes (telefono, rol, texto, ts) VALUES (?, ?, ?, ?)').run(telefono, rol, texto, Date.now());
}
export const pedidos = (n = 100) =>
  q('SELECT * FROM pedidos ORDER BY id DESC LIMIT ?').all(n)
    .map((p) => ({ ...p, datos: JSON.parse(p.datos), items: JSON.parse(p.items) }));

// ---- WhatsApp: evitar procesar dos veces el mismo mensaje ----
export function yaProcesado(wamid) {
  q('DELETE FROM procesados WHERE ts < ?').run(Date.now() - 7 * 864e5);
  return q('INSERT OR IGNORE INTO procesados (wamid, ts) VALUES (?, ?)').run(wamid, Date.now()).changes === 0;
}

// ---- Consumo de tokens por día ----
export function registrarUso(u) {
  q(`INSERT INTO uso VALUES (date('now'), 1, ?, ?, ?, ?, ?) ON CONFLICT (dia) DO UPDATE SET turnos = turnos + 1,
    llamadas = llamadas + excluded.llamadas, entrada = entrada + excluded.entrada, salida = salida + excluded.salida,
    cache_lectura = cache_lectura + excluded.cache_lectura, cache_escritura = cache_escritura + excluded.cache_escritura`)
    .run(u.llamadas, u.entrada, u.salida, u.cache_lectura, u.cache_escritura);
}
export const uso = (n = 30) => q('SELECT * FROM uso ORDER BY dia DESC LIMIT ?').all(n);

// ---- Importar / exportar tablas (panel de administración) ----
export const COLUMNAS = {
  productos: ['sku', 'nombre', 'descripcion', 'categoria', 'compatibilidad', 'stock', 'activo'],
  precios: ['sku', 'lista', 'precio'],
  clientes: ['telefono', 'nombre', 'lista', 'bot_pausado'],
};
const num = (v) => parseFloat(String(v).replace(',', '.'));

export function exportar(tabla) {
  if (tabla === 'productos') return q('SELECT * FROM productos ORDER BY sku').all();
  if (tabla === 'precios') return q('SELECT * FROM precios ORDER BY sku, lista').all();
  return q('SELECT telefono, nombre, lista, pausado_hasta > ? AS bot_pausado FROM clientes ORDER BY telefono').all(Date.now());
}

// Inserta o actualiza por clave; no borra filas ausentes (para ocultar un producto: activo = 0).
export function importar(tabla, filas, pausaMs = 0) {
  return tx(() => {
    let n = 0;
    for (const f of filas) {
      if (tabla === 'productos') {
        if (!f.sku || !f.nombre) continue;
        q(`INSERT INTO productos (sku, nombre, descripcion, categoria, stock, activo, compatibilidad) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (sku) DO UPDATE SET nombre = excluded.nombre, descripcion = excluded.descripcion,
          categoria = excluded.categoria, compatibilidad = excluded.compatibilidad, stock = excluded.stock, activo = excluded.activo`)
          .run(f.sku, f.nombre, f.descripcion || '', f.categoria || '', parseInt(f.stock) || 0, f.activo === '0' ? 0 : 1, f.compatibilidad || '');
      } else if (tabla === 'precios') {
        if (!f.sku || !f.lista) continue;
        const p = num(f.precio);
        if (Number.isNaN(p)) q('DELETE FROM precios WHERE sku = ? AND lista = ?').run(f.sku, f.lista); // precio vacío = quitar
        else q(`INSERT INTO precios VALUES (?, ?, ?) ON CONFLICT (sku, lista) DO UPDATE SET precio = excluded.precio`).run(f.sku, f.lista, p);
      } else {
        const tel = (f.telefono || '').replace(/\D/g, '');
        if (!tel) continue;
        const hasta = f.bot_pausado === '1' ? (pausado(tel) ? null : Date.now() + pausaMs) : 0;
        q(`INSERT INTO clientes (telefono, nombre, lista, pausado_hasta) VALUES (?, ?, ?, COALESCE(?, 0)) ON CONFLICT (telefono) DO UPDATE SET
          nombre = excluded.nombre, lista = excluded.lista, pausado_hasta = COALESCE(?, pausado_hasta)`)
          .run(tel, f.nombre || '', f.lista || null, hasta, hasta);
      }
      n++;
    }
    if (tabla === 'productos') {
      db.exec(`DELETE FROM productos_fts; INSERT INTO productos_fts (sku, texto)
        SELECT sku, sku || ' ' || nombre || ' ' || COALESCE(descripcion, '') || ' ' || COALESCE(categoria, '') || ' ' || COALESCE(compatibilidad, '') FROM productos WHERE activo = 1`);
    }
    return n;
  });
}
