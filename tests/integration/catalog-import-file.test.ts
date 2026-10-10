/**
 * Admin -> Bulk import from Excel (owner request 2026-10-10): the reference template is read back
 * correctly; a filled file previews exact counts and problems, writes nothing, and the import then
 * creates models / storage / colours / prices once (a second import changes nothing).
 */
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HAS_DB } from '../helpers/db.js';
import { createTestApp, idemKey, type TestApp } from '../helpers/app.js';
import { parseImportWorkbook } from '../../apps/api/src/services/catalog-import-file.js';

const TEMPLATE = 'apps/web/templates/qm-catalogue-import-template.xlsx';

async function workbook(rows: (string | number | null)[][], sheet = 'Products'): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  ws.addRow(['Brand*', 'Category*', 'Model*', 'Release year', 'Storage options*', 'Colour options', 'Base prices (QAR)']);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}

describe('the reference template', () => {
  it('has the Products / Example / Instructions sheets; Products is empty, Example parses cleanly', async () => {
    const buf = readFileSync(TEMPLATE);
    const blank = await parseImportWorkbook(buf);
    expect(blank).toMatchObject({ sheet: 'Products', modelRows: 0, problems: [] });
    // the Example sheet, read as if it were filled in: 3 models, no problems
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Products', 'Example', 'Instructions']);
    wb.removeWorksheet(wb.getWorksheet('Products')!.id);
    const ex = await parseImportWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(ex.modelRows).toBe(3);
    expect(ex.problems).toEqual([]);
    expect(ex.rows.length).toBe(3 * 5 + 2 * 4 + 2 * 4); // storage x colour lines
  });
});

describe.skipIf(!HAS_DB)('admin.previewImportFile + applyImport', () => {
  let t: TestApp; let admin = '';
  beforeAll(async () => { t = await createTestApp(); admin = await t.tokenFor('USR-00002'); });
  afterAll(async () => { await t?.close(); });

  it('previews exact counts, lists problems, and writes nothing', async () => {
    const before = (await t.deps.pool.query('select count(*)::int n from public.products')).rows[0].n;
    const file = await workbook([
      ['Nova', 'Smartphones', 'Nova One', 2025, '128GB, 256GB', 'Black, White', '900, 1100'],
      ['Nova', 'Smartphones', 'Nova Two', '', '256GB', '', ''],
      ['Nova', '', 'Nova Bad', 2025, '128GB', 'Black', ''],
      ['Nova', 'Smartphones', 'Nova Mismatch', 2025, '128GB, 256GB', 'Black', '900'],
    ]);
    const r = await t.call('admin.previewImportFile', admin, { file, fileName: 'nova.xlsx' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.file).toMatchObject({ sheet: 'Products', models: 4 });
    expect((r.body.problems as string[]).join(' ')).toMatch(/category is required/);
    expect((r.body.problems as string[]).join(' ')).toMatch(/1 price\(s\) for 2 storage size\(s\)/);
    expect((await t.deps.pool.query('select count(*)::int n from public.products')).rows[0].n).toBe(before);
  });

  it('a clean file imports once: models, year, storage, colours and prices; a re-import changes nothing', async () => {
    const file = await workbook([
      ['Nova', 'Smartphones', 'Nova One', 2025, '128GB, 256GB', 'Black, White', '900, 1100'],
      ['Nova', 'Smartphones', 'Nova Two', '', '256GB', '', ''],
    ]);
    const p = await t.call('admin.previewImportFile', admin, { file, fileName: 'nova.xlsx' });
    expect(p.body.problems).toEqual([]);
    expect(p.body.summary).toEqual({ newBrands: 1, newModels: 2, newStorage: 3, newColours: 2, pricesToSet: 2 });
    const a = await t.call('admin.applyImport', admin, { rows: p.body.rows }, idemKey());
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const one = (await t.deps.pool.query(`select p.id, p.release_year, c.name category,
        (select string_agg(storage, ',' order by storage) from public.product_variants v where v.product_id = p.id) storage,
        (select string_agg(color, ',' order by color) from public.product_colors k where k.product_id = p.id) colours,
        (select string_agg(m.base_price::int::text, ',' order by m.base_price) from public.master_prices m where m.product_id = p.id and m.active) prices
      from public.products p join public.categories c on c.id = p.category_id where p.model = 'Nova One'`)).rows[0];
    expect(one).toMatchObject({ release_year: 2025, category: 'Smartphones', storage: '128GB,256GB', colours: 'Black,White', prices: '900,1100' });
    const again = await t.call('admin.previewImportFile', admin, { file, fileName: 'nova.xlsx' });
    expect(again.body.summary).toEqual({ newBrands: 0, newModels: 0, newStorage: 0, newColours: 0, pricesToSet: 0 });
  });

  it('refuses something that is not an .xlsx, and a customer cannot use it', async () => {
    const r = await t.call('admin.previewImportFile', admin, { file: Buffer.from('Brand,Model\nA,B').toString('base64') });
    expect(r.status).toBe(422);
    expect(String(r.body.message)).toMatch(/not an Excel workbook/);
    const c = await t.call('admin.previewImportFile', await t.tokenFor('CUS-00001'), { file: await workbook([]) });
    expect(c.status).toBe(403);
  });
});
