/*
 * qm-commission.js — Admin -> Commission: choose HOW the partner's commission is worked out
 * (owner decision 2026-10-10). Replaces the 3.1 editCommission() dialog, which always sent PERCENTAGE;
 * the hash-checked 3.1 sources stay unchanged.
 *
 *   INVOICE_PERCENTAGE  invoice = value / (1 - rate)   e.g. 1500 at 5% -> 1578.95 (Carrefour -> QM)
 *   PERCENTAGE          invoice = value + value x rate e.g. 1500 at 5% -> 1575.00
 */
(function () {
  'use strict';
  if (!window.QM || typeof window.editCommission !== 'function') return;

  function money(n) { return (Math.round(n * 100) / 100).toFixed(2); }
  function invoiceFor(value, rate, type) {
    if (type === 'INVOICE_PERCENTAGE') return rate < 1 ? Math.round(value * 100 / (1 - rate)) / 100 : NaN;
    return Math.round(value * (1 + rate) * 100) / 100;
  }

  window.editCommission = function () {
    var body = QM.el('div');

    var vendor = QM.select([{ value: '', label: 'Choose a vendor' }]);
    body.appendChild(QM.field('Vendor', vendor));
    QM.call('admin.vendors', {}).then(function (res) {
      if (!res.ok) return;
      res.vendors.forEach(function (v) {
        var opt = document.createElement('option');
        opt.value = v.vendorId; opt.textContent = v.name;
        vendor.appendChild(opt);
      });
    });

    var brand = QM.select([{ value: '', label: 'All brands' }]);
    body.appendChild(QM.field('Brand (optional)', brand,
      'Leave blank for a rule covering everything this vendor takes.'));
    QM.call('admin.brands', {}).then(function (res) {
      if (!res.ok) return;
      res.brands.forEach(function (b) {
        var opt = document.createElement('option');
        opt.value = b.brandId; opt.textContent = b.name;
        brand.appendChild(opt);
      });
    });

    var type = QM.select([
      { value: 'INVOICE_PERCENTAGE', label: 'Share of the invoice — invoice = value ÷ (1 − rate)' },
      { value: 'PERCENTAGE', label: 'Percentage of the trade-in value — invoice = value + value × rate' }
    ], 'INVOICE_PERCENTAGE');
    type.setAttribute('data-qm', 'commission-type');
    body.appendChild(QM.field('How the commission is worked out', type));

    var value = QM.input('number', 0.05);
    value.min = 0; value.max = 0.99; value.step = '0.005';
    body.appendChild(QM.field('Commission', value, 'A fraction. Five percent is 0.05.'));

    var example = QM.el('div', 'notice');
    example.setAttribute('data-qm', 'commission-example');
    body.appendChild(example);
    function refresh() {
      var r = Number(value.value) || 0;
      var inv = invoiceFor(1500, r, type.value);
      QM.clear(example);
      example.appendChild(QM.el('strong', null, 'Example: trade-in value 1500.00'));
      example.appendChild(document.createTextNode(isFinite(inv)
        ? ' The partner invoices ' + money(inv) + ' (commission ' + money(inv - 1500) + ').'
        : ' A share of the invoice must be below 1.'));
    }
    type.onchange = refresh; value.oninput = refresh; refresh();

    var from = QM.input('date');
    body.appendChild(QM.field('Effective from', from,
      'Leave blank for today. The rule in force is closed with this date rather than overwritten.'));

    QM.modal({
      title: 'Commission rule',
      body: body,
      confirmLabel: 'Save',
      collect: function () {
        if (!vendor.value) { QM.toast('Choose a vendor.', 'danger'); return false; }
        return {
          vendorId: vendor.value,
          brandId: brand.value,
          commissionType: type.value,
          commissionValue: Number(value.value),
          effectiveFrom: from.value
        };
      }
    }).then(function (data) {
      if (!data) return;
      QM.call('admin.saveCommissionRule', data).then(function (res) {
        if (QM.report(res)) QM.go('a-commission');
      });
    });
  };
})();
