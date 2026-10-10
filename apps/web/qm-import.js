/*
 * qm-import.js — Admin -> Bulk import from an Excel file, with the reference template on the same page
 * (owner request 2026-10-10). Replaces the 3.1 "paste comma-separated rows" screen (route a-import);
 * the hash-checked 3.1 sources stay unchanged.
 *
 *   1. Download the template (served by qm-web at /templates/qm-catalogue-import-template.xlsx).
 *   2. Upload the filled .xlsx -> admin.previewImportFile parses it and previews (writes nothing).
 *   3. Import -> the existing admin.applyImport with the previewed rows (re-validated on the server).
 */
(function () {
  'use strict';
  if (!window.QM || typeof QM.route !== 'function') return;

  var TEMPLATE = '/templates/qm-catalogue-import-template.xlsx';
  var COLUMNS = [
    { col: 'Brand', req: 'Yes', what: 'Brand name. A new brand is created if needed.', ex: 'Apple' },
    { col: 'Category', req: 'Yes', what: 'Category name. A new category is created if needed.', ex: 'Smartphones' },
    { col: 'Model', req: 'Yes', what: 'Exact model name. An existing model is matched, never duplicated.', ex: 'iPhone 16' },
    { col: 'Release year', req: 'No', what: 'Four-digit year.', ex: '2024' },
    { col: 'Storage options', req: 'Yes', what: 'Storage sizes, comma-separated.', ex: '128GB, 256GB, 512GB' },
    { col: 'Colour options', req: 'No', what: 'Colours, comma-separated.', ex: 'Black, White, Pink' },
    { col: 'Base prices (QAR)', req: 'No', what: 'One Excellent-grade price per storage size, same order, no thousands separators. Replaces the current price.', ex: '1410, 1580, 1930' }
  ];

  function step(n, title, body) {
    var box = QM.el('div', 'card mb');
    var head = QM.el('div', 'card-head');
    head.appendChild(QM.el('h3', null, n + ' · ' + title));
    box.appendChild(head);
    var b = QM.el('div', 'card-body');
    b.appendChild(body);
    box.appendChild(b);
    return box;
  }

  function list(items) {
    var ul = QM.el('ul');
    ul.style.margin = '.4rem 0 0'; ul.style.paddingLeft = '1.2rem';
    items.forEach(function (p) { ul.appendChild(QM.el('li', null, p)); });
    return ul;
  }

  QM.route('a-import', function () {
    var wrap = QM.el('div', 'qm-import');

    var note = QM.el('div', 'notice');
    note.appendChild(QM.el('strong', null, 'Preview first, always'));
    note.appendChild(document.createTextNode(
      'Upload the filled template, read what the preview says it will create or change, and only then ' +
      'import. Nothing is written until you press Import. Importing the same file again is safe.'));
    wrap.appendChild(note);

    /* ---- 1. the reference template --------------------------------------- */
    var t = QM.el('div');
    t.appendChild(QM.el('div', 'hint mb',
      'One row per model on the "Products" sheet. The "Example" sheet shows filled rows and is never imported; ' +
      '"Instructions" explains every column in English and Arabic.'));
    var dl = QM.el('a', 'btn gold', 'Download the template (.xlsx)');
    dl.href = TEMPLATE; dl.setAttribute('download', 'qm-catalogue-import-template.xlsx');
    dl.setAttribute('data-qm', 'template-link');
    t.appendChild(dl);
    var ref = QM.el('div'); ref.style.marginTop = '1rem';
    ref.appendChild(QM.table([
      { key: 'col', label: 'Column' },
      { key: 'req', label: 'Required' },
      { key: 'what', label: 'What to enter' },
      { key: 'ex', label: 'Example' }
    ], COLUMNS));
    t.appendChild(ref);
    wrap.appendChild(step(1, 'Download the reference template', t));

    /* ---- 2. upload + preview -------------------------------------------- */
    var u = QM.el('div');
    var file = document.createElement('input');
    file.type = 'file';
    file.accept = '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    file.setAttribute('data-qm', 'import-file');
    u.appendChild(QM.field('Filled template (.xlsx, up to 2 MB)', file));
    var results = QM.el('div');

    var previewBtn = QM.button('Preview', function () {
      var f = file.files && file.files[0];
      if (!f) { QM.toast('Choose the Excel file first.', 'danger'); return; }
      if (f.size > 2 * 1024 * 1024) { QM.toast('That file is larger than 2 MB. Split it into smaller files.', 'danger'); return; }
      QM.clear(results);
      results.appendChild(QM.loadingBlock());
      var reader = new FileReader();
      reader.onerror = function () { QM.clear(results); results.appendChild(QM.errorBlock('That file could not be read.')); };
      reader.onload = function () {
        var b64 = String(reader.result || '').replace(/^data:[^,]*,/, '');
        QM.call('admin.previewImportFile', { file: b64, fileName: f.name }).then(function (res) {
          QM.clear(results);
          if (!res.ok) { results.appendChild(QM.errorBlock(res.message)); return; }
          render(res);
        });
      };
      reader.readAsDataURL(f);
    }, '');
    previewBtn.setAttribute('data-qm', 'import-preview');
    var row = QM.el('div', 'btn-row mb');
    row.appendChild(previewBtn);
    u.appendChild(row);
    u.appendChild(results);
    wrap.appendChild(step(2, 'Upload the filled file and preview', u));

    function render(res) {
      var s = res.summary;
      var ok = QM.el('div', 'notice ' + (res.problems.length ? 'warn' : 'ok'));
      ok.setAttribute('data-qm', 'import-summary');
      ok.appendChild(QM.el('strong', null, res.file.models + ' model row(s) read from "' + res.file.sheet + '"'));
      ok.appendChild(list([
        s.newBrands + ' new brand(s)',
        s.newModels + ' new model(s)',
        s.newStorage + ' new storage size(s)',
        s.newColours + ' new colour(s)',
        s.pricesToSet + ' price(s) to set or change'
      ]));
      results.appendChild(ok);
      if (res.newProducts && res.newProducts.length) {
        var nm = QM.el('div', 'hint mb', 'New models: ' + res.newProducts.slice(0, 30).join(', ') +
          (res.newProducts.length > 30 ? ' …' : ''));
        results.appendChild(nm);
      }
      if (res.problems.length) {
        var bad = QM.el('div', 'notice danger');
        bad.setAttribute('data-qm', 'import-problems');
        bad.appendChild(QM.el('strong', null, res.problems.length + ' problem(s) — fix them in the file and preview again'));
        bad.appendChild(list(res.problems.slice(0, 30)));
        results.appendChild(bad);
        return; // the server refuses an import with problems; do not offer it
      }
      var nothing = !s.newBrands && !s.newModels && !s.newStorage && !s.newColours && !s.pricesToSet;
      if (nothing) { results.appendChild(QM.el('div', 'notice ok', 'Everything in this file is already in the catalogue. Nothing to import.')); return; }
      var go = QM.button('Import', function () {
        go.disabled = true;
        QM.call('admin.applyImport', { rows: res.rows }).then(function (r2) {
          go.disabled = false;
          if (QM.report(r2)) QM.go('a-products');
        });
      }, 'gold block');
      go.setAttribute('data-qm', 'import-apply');
      results.appendChild(go);
    }

    return wrap;
  });
})();
