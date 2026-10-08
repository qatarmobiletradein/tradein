/** npm run make:fictional-export -- --out <dir> [--dirty]  — writes a FICTIONAL export for dry runs. */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeFictionalExport } from './fictional-export.js';

const i = process.argv.indexOf('--out');
const out = resolve(i > -1 ? process.argv[i + 1]! : 'fictional-export');
mkdirSync(out, { recursive: true });
writeFictionalExport(out, { dirty: process.argv.includes('--dirty') });
console.log(`Fictional export written to ${out}`);
