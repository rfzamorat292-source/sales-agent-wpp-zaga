// Carga los datos de ejemplo (data/ejemplo/*.csv) en la base.
import { readFileSync } from 'node:fs';
import * as db from '../src/db.js';
import { parse } from '../src/csv.js';

for (const t of ['productos', 'precios', 'clientes'])
  console.log(t, db.importar(t, parse(readFileSync(new URL(`../data/ejemplo/${t}.csv`, import.meta.url), 'utf8'))));
