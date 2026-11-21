// CSV mínimo: comillas, saltos de línea y separador "," o ";" (Excel en español).
export function parse(texto) {
  texto = texto.replace(/^﻿/, '');
  const cab = texto.split(/\r?\n/, 1)[0] || '';
  const sep = (cab.match(/;/g) || []).length > (cab.match(/,/g) || []).length ? ';' : ',';
  const filas = [];
  let fila = [], campo = '', q = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (q) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') q = false;
      else campo += c;
    } else if (c === '"') q = true;
    else if (c === sep) { fila.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++;
      fila.push(campo); filas.push(fila); fila = []; campo = '';
    } else campo += c;
  }
  if (campo || fila.length) { fila.push(campo); filas.push(fila); }
  const cols = (filas.shift() || []).map((h) => h.trim().toLowerCase());
  return filas
    .filter((f) => f.some((v) => v.trim()))
    .map((f) => Object.fromEntries(cols.map((h, i) => [h, (f[i] ?? '').trim()])));
}

export function stringify(filas, cols) {
  const esc = (v) => (/[",;\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [cols.join(','), ...filas.map((f) => cols.map((c) => esc(String(f[c] ?? ''))).join(','))].join('\n') + '\n';
}
