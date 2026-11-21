// Prueba rápida sin red: catálogo, precio por cliente, carrito y pedido.
import assert from 'node:assert/strict';
import './seed.js';
import * as db from '../src/db.js';
import { config } from '../src/config.js';
import { ejecutar } from '../src/tools.js';

const cfg = config();
const ctx = (telefono) => {
  const cliente = db.cliente(telefono);
  return { cfg, telefono, cliente, lista: cliente.lista || 'general', listaDef: 'general', notificar: async () => {} };
};
const normal = ctx('111'), mayorista = ctx('5215500000001');

assert.match(await ejecutar('buscar_productos', { consulta: 'cafés organico' }, normal), /CAF-250.*8\.50/);
assert.match(await ejecutar('buscar_productos', { consulta: 'cafe organico' }, mayorista), /CAF-250.*6\.90/);
assert.match(await ejecutar('buscar_productos', { consulta: 'te verde' }, mayorista), /5\.00/); // sin precio mayorista -> general
await assert.rejects(ejecutar('actualizar_carrito', { sku: 'FIL-V60', cantidad: 1 }, normal), /Stock/);
assert.match(await ejecutar('actualizar_carrito', { sku: 'caf-250', cantidad: 2 }, mayorista), /Total \$13\.80/);
await assert.rejects(ejecutar('confirmar_pedido', { nombre: 'Ana', entrega: 'envio', pago: 'efectivo' }, mayorista), /direccion/);
assert.match(await ejecutar('confirmar_pedido', { nombre: 'Ana', entrega: 'recojo', pago: 'efectivo' }, mayorista), /Pedido #1.*13\.80/);
assert.equal(db.producto('CAF-250', 'general', 'general').stock, 38);
db.importar('productos', [{ sku: 'P-281-01A', nombre: 'Muelle parabólico 100x32', compatibilidad: 'Volvo FH 440 delantero', stock: '2' }]);
assert.equal(db.buscar('volvo fh delantero', 'general', 'general', 5).length, 0); // sin precio no se muestra
db.importar('precios', [{ sku: 'P-281-01A', lista: 'general', precio: '900' }]);
assert.match(await ejecutar('buscar_productos', { consulta: 'muelle volvo fh 440' }, normal), /P-281-01A.*compatible: Volvo/);
console.log('OK');
