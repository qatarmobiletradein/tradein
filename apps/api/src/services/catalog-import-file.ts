/**
 * Catalogue bulk import from an Excel file (owner request 2026-10-10).
 *
 * The file is the reference template (apps/web/templates/qm-catalogue-import-template.xlsx): one row
 * per MODEL on the "Products" sheet — storage sizes and colours comma-separated, and optionally one
 * base price (QAR, Excellent grade) per storage size, in the same order. The owner's own catalogue
 * file (sheet "Product_Models": Storage Options / Color Options) is read the same way.
 *
 * Each model row is expanded to the existing import rows (one per storage x colour) and checked by the
 * SAME previewImport / applyImport as the paste import, so validation and writing stay in one place.
 * Nothing is written by the preview.
 */
import ExcelJS from 'exceljs';
import { fail } from '../../../../packages/shared/src/errors.js';
import type { Ctx } from '../context.js';
import { previewImport } from './catalog.js';

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_MODEL_ROWS = 2000;

/** Header synonyms (lower-case, spaces collapsed, "*" and "(…)" removed). */
const COLUMNS: Record<string, string[]> = {
  brand: ['brand'],
  category: ['category'],
  model: ['model', 'model name'],
  year: ['year', 'release year'],
  storage: ['storage', 'storage options', 'storages', 'capacity'],
  colours: ['colour', 'color', 'colours', 'colors', 'colour options', 'color options'],
  prices: ['base price', 'base prices', 'price', 'prices'],
};
const norm = (h: string) => h.toLowerCase().replace(/\(.*?\)/g, '').replace(/\*/g, '').replace(/\s+/g, ' ').trim();
const split = (v: string) => v.split(/[,;|\n]+/).map((x) => x.trim()).filter(Boolean);

type Cell = string;
export interface ParsedFile { rows: Record<string, string | number | null>[]; problems: string[]; modelRows: number; sheet: string }

function cellText(c: ExcelJS.Cell): Cell {
  const v = c.value as unknown;
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object' && v && 'result' in (v as Record<string, unknown>)) return String((v as { result: unknown }).result ?? '').trim();
  return String(c.text ?? '').trim();
}

/** Read the workbook and expand each model row to storage x colour import rows. */
export async function parseImportWorkbook(buf: Buffer): Promise<ParsedFile> {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf as unknown as ArrayBuffer); } catch { throw fail('That file could not be read. Save it as an Excel workbook (.xlsx) and try again.'); }
  const pick = (n: string) => wb.worksheets.find((w) => w.name.trim().toLowerCase() === n);
  const ws = pick('products') ?? pick('product_models') ?? wb.worksheets[0];
  if (!ws) throw fail('The file has no sheet to read.');

  // The header row: the first of the top 10 rows that has a "Brand" and a "Model" column.
  let headerRow = 0; const col: Record<string, number> = {};
  for (let r = 1; r <= Math.min(10, ws.rowCount) && !headerRow; r++) {
    const found: Record<string, number> = {};
    ws.getRow(r).eachCell((c, n) => {
      const h = norm(cellText(c));
      for (const [key, names] of Object.entries(COLUMNS)) if (names.includes(h) && !found[key]) found[key] = n;
    });
    if (found.brand && found.model) { headerRow = r; Object.assign(col, found); }
  }
  if (!headerRow) throw fail('No header row with "Brand" and "Model" was found. Use the template from this page.');
  if (!col.storage) throw fail('The "Storage options" column is missing. Use the template from this page.');

  const rows: ParsedFile['rows'] = []; const problems: string[] = []; let modelRows = 0;
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const get = (k: string) => (col[k] ? cellText(row.getCell(col[k]!)) : '');
    const brand = get('brand'), model = get('model'), category = get('category');
    const storages = split(get('storage')).map((s) => s.toUpperCase().replace(/\s+/g, ''));
    const colours = split(get('colours'));
    const priceText = get('prices'); const prices = split(priceText);
    if (!brand && !model && !storages.length && !colours.length && !priceText) continue; // empty line
    modelRows++;
    if (modelRows > MAX_MODEL_ROWS) { problems.push(`Only the first ${MAX_MODEL_ROWS} models are read; split the file.`); break; }
    const at = `Row ${r}${model ? ` (${model})` : ''}`;
    if (!brand || !model) { problems.push(`${at}: brand and model are both required.`); continue; }
    if (!category) { problems.push(`${at}: category is required (for example Smartphones).`); continue; }
    if (!storages.length) { problems.push(`${at}: at least one storage size is required.`); continue; }
    if (new Set(storages).size !== storages.length) { problems.push(`${at}: a storage size is listed twice.`); continue; }
    if (prices.length && prices.length !== storages.length) {
      problems.push(`${at}: ${prices.length} price(s) for ${storages.length} storage size(s) — give one price per storage size, in the same order, or leave prices empty.`);
      continue;
    }
    const year = get('year');
    storages.forEach((storage, i) => {
      for (const colour of colours.length ? colours : ['']) {
        rows.push({ Brand: brand, Category: category, Model: model, Storage: storage, Colour: colour,
          BasePrice: prices.length ? prices[i]!.replace(/[^\d.]/g, '') || prices[i]! : '', Year: year || null });
      }
    });
  }
  return { rows, problems, modelRows, sheet: ws.name };
}

/** admin.previewImportFile: parse + the standard preview, with exact counts of what would change. */
export async function previewImportFile(ctx: Ctx, p: { file?: string; fileName?: string }) {
  const b64 = String(p.file ?? '').replace(/^data:[^,]*,/, '');
  if (!b64) throw fail('Choose the Excel file first.');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw fail('That file is empty.');
  if (buf.length > MAX_FILE_BYTES) throw fail('That file is larger than 2 MB. Split it into smaller files.');
  if (buf.subarray(0, 2).toString('latin1') !== 'PK') throw fail('That is not an Excel workbook (.xlsx). Save it as .xlsx and try again.');

  const parsed = await parseImportWorkbook(buf);
  const preview = await previewImport(ctx, { rows: parsed.rows });

  // Exact counts (the per-row preview counts storage x colour lines).
  const newVariants = new Set<string>(), newColours = new Set<string>(), priceChanges = new Set<string>();
  const productId = new Map<string, string | null>();
  for (const r of preview.rows) {
    const key = `${r.brand}|${r.model}`.toLowerCase();
    if (!productId.has(key)) {
      const pr = (await ctx.db.query<{ id: string }>(`select p.id from public.products p join public.brands b on b.id = p.brand_id
        where lower(btrim(b.name)) = lower($1) and lower(btrim(p.model)) = lower($2)`, [r.brand, r.model])).rows[0];
      productId.set(key, pr?.id ?? null);
    }
    const pid = productId.get(key);
    const vKey = `${key}|${r.storage.toLowerCase()}`;
    let variantId: string | null = null;
    if (pid) variantId = (await ctx.db.query<{ id: string }>('select id from public.product_variants where product_id = $1 and lower(storage) = lower($2)', [pid, r.storage])).rows[0]?.id ?? null;
    if (!variantId) newVariants.add(vKey);
    if (r.color) {
      const cKey = `${key}|${r.color.toLowerCase()}`;
      const has = pid ? (await ctx.db.query('select 1 from public.product_colors where product_id = $1 and lower(btrim(color)) = lower($2)', [pid, r.color])).rowCount : 0;
      if (!has) newColours.add(cKey);
    }
    if (r.basePrice !== null && !priceChanges.has(vKey)) {
      const cur = variantId ? (await ctx.db.query<{ base_price: string }>(`select base_price from public.master_prices where variant_id = $1 and active
        and effective_from <= now() and (effective_to is null or effective_to > now()) order by effective_from desc limit 1`, [variantId])).rows[0] : undefined;
      if (!cur || Number(cur.base_price) !== r.basePrice) priceChanges.add(vKey);
    }
  }
  return {
    ...preview,
    problems: [...parsed.problems, ...preview.problems],
    file: { name: String(p.fileName ?? '').slice(0, 200), sheet: parsed.sheet, models: parsed.modelRows },
    summary: { newBrands: preview.newBrands.length, newModels: preview.newProducts.length, newStorage: newVariants.size,
      newColours: newColours.size, pricesToSet: priceChanges.size },
  };
}
