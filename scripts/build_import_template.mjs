#!/usr/bin/env node
/**
 * Builds apps/web/templates/qm-catalogue-import-template.xlsx — the reference template for
 * Admin -> Bulk import. Run: node scripts/build_import_template.mjs
 *
 * Sheets: "Products" (headers only — fill one row per model), "Example" (filled rows to copy from,
 * never read by the import), "Instructions" (column rules, English and Arabic).
 */
import ExcelJS from 'exceljs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'templates', 'qm-catalogue-import-template.xlsx');
mkdirSync(dirname(out), { recursive: true });

export const HEADERS = [
  { key: 'brand', header: 'Brand*', width: 14 },
  { key: 'category', header: 'Category*', width: 16 },
  { key: 'model', header: 'Model*', width: 24 },
  { key: 'year', header: 'Release year', width: 13 },
  { key: 'storage', header: 'Storage options*', width: 28 },
  { key: 'colours', header: 'Colour options', width: 46 },
  { key: 'prices', header: 'Base prices (QAR)', width: 26 },
];
const EXAMPLES = [
  ['Apple', 'Smartphones', 'iPhone 16', 2024, '128GB, 256GB, 512GB', 'Black, White, Pink, Teal, Ultramarine', '1410, 1580, 1930'],
  ['Samsung', 'Smartphones', 'Galaxy S24', 2024, '128GB, 256GB', 'Onyx Black, Marble Gray, Cobalt Violet, Amber Yellow', '870, 930'],
  ['Samsung', 'Smartphones', 'Galaxy Z Flip6', 2024, '256GB, 512GB', 'Silver Shadow, Yellow, Blue, Mint', ''],
];

const wb = new ExcelJS.Workbook();
wb.creator = 'Qatar Mobile Trade-In';
const navy = 'FF0B2A4A', pale = 'FFE8F4FB';

function sheet(name, rows) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = HEADERS.map((h) => ({ header: h.header, key: h.key, width: h.width }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: navy } };
  head.alignment = { vertical: 'middle' };
  head.height = 22;
  for (const r of rows) ws.addRow(r);
  for (let r = 2; r <= Math.max(rows.length + 1, 200); r++) {
    ws.getCell(`D${r}`).dataValidation = { type: 'whole', operator: 'between', formulae: [2000, 2100], allowBlank: true,
      showErrorMessage: true, errorTitle: 'Release year', error: 'Enter a year such as 2024, or leave it empty.' };
    for (const c of ['E', 'F', 'G']) ws.getCell(`${c}${r}`).numFmt = '@'; // text: "1410, 1580" must not become a number
  }
  return ws;
}

sheet('Products', []);
const ex = sheet('Example', EXAMPLES);
ex.eachRow((row, n) => { if (n > 1) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: pale } }; });

const info = wb.addWorksheet('Instructions');
info.columns = [{ width: 22 }, { width: 70 }, { width: 60 }];
const lines = [
  ['Column', 'Rule', 'القاعدة'],
  ['Products sheet', 'Fill ONE row per model on the "Products" sheet. Only that sheet is imported; "Example" is never read.', 'املأ صفاً واحداً لكل موديل في ورقة Products فقط. ورقة Example للمثال ولا تُستورد.'],
  ['Brand*', 'Brand name, e.g. Apple or Samsung. A new brand is created if it does not exist.', 'اسم العلامة مثل Apple أو Samsung. تُنشأ العلامة إن لم تكن موجودة.'],
  ['Category*', 'e.g. Smartphones. A new category is created if it does not exist.', 'التصنيف مثل Smartphones. يُنشأ إن لم يكن موجوداً.'],
  ['Model*', 'Exact model name, e.g. iPhone 16 Pro Max. An existing model is matched by brand + name (not duplicated).', 'اسم الموديل بدقة. الموديل الموجود يُطابق بالعلامة والاسم ولا يتكرر.'],
  ['Release year', 'Optional, e.g. 2024.', 'اختياري، مثل 2024.'],
  ['Storage options*', 'Comma-separated, e.g. 128GB, 256GB, 1TB.', 'السعات مفصولة بفواصل، مثل 128GB, 256GB, 1TB.'],
  ['Colour options', 'Comma-separated, e.g. Black, White, Pink. Optional.', 'الألوان مفصولة بفواصل. اختياري.'],
  ['Base prices (QAR)', 'Optional. ONE price per storage size, in the SAME order, no thousands separators: 1410, 1580, 1930. This is the Excellent-grade value; the other grades follow the grade ladder. A price given here replaces the current price of that storage size.', 'اختياري. سعر واحد لكل سعة وبنفس الترتيب وبدون فواصل آلاف. هذا سعر درجة ممتاز، والدرجات الأخرى حسب سلم الدرجات. السعر هنا يستبدل السعر الحالي لتلك السعة.'],
  ['Re-importing', 'Safe: existing models, storage sizes and colours are not duplicated. Always press Preview first and read what will change.', 'إعادة الاستيراد آمنة ولا تكرر البيانات. اضغط Preview أولاً دائماً.'],
];
lines.forEach((l, i) => {
  const row = info.addRow(l);
  row.alignment = { wrapText: true, vertical: 'top' };
  if (i === 0) { row.font = { bold: true, color: { argb: 'FFFFFFFF' } }; row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: navy } }; }
});
info.getColumn(3).alignment = { wrapText: true, vertical: 'top', horizontal: 'right', readingOrder: 'rtl' };

await wb.xlsx.writeFile(out);
console.log('wrote', out);
