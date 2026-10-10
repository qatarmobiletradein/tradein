/*
 * qm-workflow.js — owner approval and partner payment (owner decision 2026-10-10).
 * Adds pages to the unchanged 3.1 portals (the hash-checked sources stay byte-for-byte) and a
 * Finance portal for the ACCOUNTANT role. Every rule is enforced by the API; this file only shows it.
 *
 *   Admin       Pending owner approval (approve / send back / reject), Vendor payments (oversight)
 *   Accountant  Pending payment, Paid / awaiting vendor, Completed  (record payment + receipt)
 *   Vendor      Payments: Awaiting payment, Confirm payment received, Completed  (VENDOR_ADMIN)
 *   Technician  With the owner, Completed (no actions)
 */
(function () {
  'use strict';
  if (!window.QM || typeof QM.route !== 'function' || typeof window.buildFrame !== 'function') return;

  var MAX_RECEIPT = 5 * 1024 * 1024;

  function key() {
    var b = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(b);
    var h = '';
    for (var i = 0; i < b.length; i++) h += ('0' + b[i].toString(16)).slice(-2);
    return 'qmw-' + h;
  }
  function ccy(n, c) { return QM.moneyCcy(n, c); }
  function notice(text, kind) {
    var n = QM.el('div', 'notice' + (kind ? ' ' + kind : ''));
    n.appendChild(document.createTextNode(text));
    return n;
  }
  function badge(page, n) { if (typeof window.setBadge === 'function') window.setBadge(page, n); }
  function pill(text, kind) { return QM.el('span', 'pill ' + (kind || 'info'), text); }
  function actions(buttons) {
    var d = QM.el('div');
    d.style.display = 'flex'; d.style.gap = '.4rem'; d.style.flexWrap = 'wrap';
    buttons.forEach(function (b) { if (b) d.appendChild(b); });
    return d;
  }
  function small(label, fn, cls) { return QM.button(label, fn, 'small ' + (cls || 'secondary')); }

  /* ------------------------------------------------------------ navigation */

  var baseFrame = window.buildFrame;
  window.buildFrame = function (config) {
    var me = QM.state.me || {};
    var nav = (config && config.nav ? config.nav : []).slice();
    var at = function (page) { for (var i = 0; i < nav.length; i++) if (nav[i].page === page) return i; return -1; };
    if (at('a-home') > -1 && at('a-approvals') < 0) {
      nav.splice(at('a-home') + 1, 0, { page: 'a-approvals', label: 'Pending owner approval', icon: '✓', badge: '0' });
      if (at('a-settlements') > -1) nav.splice(at('a-settlements') + 1, 0, { page: 'a-finance', label: 'Vendor payments', icon: '◱' });
    }
    if (at('t-queue') > -1 && at('t-done') < 0) {
      nav.push({ page: 't-owner', label: 'With the owner', icon: '◷' });
      nav.push({ page: 't-done', label: 'Completed', icon: '✓' });
    }
    if (at('v-home') > -1 && me.role === 'VENDOR_ADMIN' && at('v-finance') < 0) {
      var after = at('v-vouchers') > -1 ? at('v-vouchers') + 1 : nav.length;
      nav.splice(after, 0, { page: 'v-finance', label: 'Payments', icon: '◱', badge: '0' });
    }
    var cfg = {};
    for (var k in config) if (Object.prototype.hasOwnProperty.call(config, k)) cfg[k] = config[k];
    cfg.nav = nav;
    var out = baseFrame.call(this, cfg);
    if (at('a-approvals') > -1) refreshApprovalBadge();
    return out;
  };

  QM.portal('finance', function (me) {
    window.buildFrame({
      mark: 'QM', title: me.platform, search: false,
      nav: [
        { page: 'f-pending', label: 'Pending payment', icon: '◷', badge: '0' },
        { page: 'f-paid', label: 'Paid / awaiting vendor', icon: '➤' },
        { page: 'f-completed', label: 'Completed', icon: '✓' }
      ]
    });
  });

  function refreshApprovalBadge() {
    QM.call('admin.approvalQueue', {}).then(function (res) { if (res && res.ok) badge('a-approvals', res.count); });
  }

  /* ------------------------------------------------------- owner approval */

  function decide(t, decision) {
    var titles = { APPROVE: 'Approve ' + t.tradeInId + '?', SEND_BACK: 'Send ' + t.tradeInId + ' back to the technician?', REJECT: 'Reject ' + t.tradeInId + '?' };
    var body = QM.el('div');
    body.appendChild(QM.el('p', null, decision === 'APPROVE'
      ? 'The customer will see the offer of ' + ccy(t.finalValue, t.currency) + ' and can accept it.'
      : decision === 'REJECT' ? 'The trade-in is cancelled. The customer keeps the device.'
        : 'The technician re-checks the device and prices it again; it then comes back here.'));
    var reason = QM.el('textarea');
    reason.rows = 3;
    body.appendChild(QM.field(decision === 'APPROVE' ? 'Note (optional)' : 'Reason (required, recorded)', reason));
    var idem = key();
    QM.modal({
      title: titles[decision], body: body,
      confirmLabel: decision === 'APPROVE' ? 'Approve' : decision === 'REJECT' ? 'Reject' : 'Send back',
      collect: function () {
        if (decision !== 'APPROVE' && !reason.value.trim()) { QM.toast('Give a reason.', 'danger'); return false; }
        return { reason: reason.value.trim() };
      }
    }).then(function (data) {
      if (!data) return;
      QM.call('admin.approveTradeIn', { tradeInId: t.tradeInId, decision: decision, reason: data.reason, idempotencyKey: idem })
        .then(function (res) { if (QM.report(res)) QM.go('a-approvals'); });
    });
  }

  QM.route('a-approvals', function () {
    return QM.call('admin.approvalQueue', {}).then(function (res) {
      if (!res.ok) return QM.errorBlock(res.message);
      badge('a-approvals', res.count);
      var wrap = QM.el('div');
      wrap.setAttribute('data-qm', 'approval-queue');
      wrap.appendChild(notice('Evaluated and priced by the technician. The customer sees the offer only after you approve it, ' +
        'and the partner can issue a voucher only after that.'));
      if (!res.pending.length) wrap.appendChild(QM.emptyBlock('Nothing to approve', 'Every evaluated trade-in has been decided.'));
      else {
        wrap.appendChild(QM.card('Pending owner approval (' + res.pending.length + ')', QM.table([
          { key: 'tradeInId', label: 'Trade-in' },
          { key: 'vendorName', label: 'Vendor', render: function (r) { return r.vendorName + (r.branchName ? ' · ' + r.branchName : ''); } },
          { key: 'device', label: 'Device' },
          { key: 'grade', label: 'Grade', render: function (r) { return QM.gradeChip(r.grade); } },
          { key: 'estimatedValue', label: 'Estimate', numeric: true, render: function (r) { return QM.money(r.estimatedValue); } },
          { key: 'finalValue', label: 'Final offer', numeric: true, render: function (r) { return QM.money(r.finalValue); } },
          { key: 'payable', label: 'Payable to vendor', numeric: true, render: function (r) { return QM.money(r.payable); } },
          { key: 'technician', label: 'Technician' },
          { key: 'submittedDate', label: 'Submitted' },
          { key: 'x', label: '', render: function (r) {
            return actions([
              small('Approve', function () { decide(r, 'APPROVE'); }, 'gold'),
              small('Send back', function () { decide(r, 'SEND_BACK'); }),
              small('Reject', function () { decide(r, 'REJECT'); }, 'danger')
            ]);
          } }
        ], res.pending)));
      }
      if (res.legacyUnapproved && res.legacyUnapproved.length) {
        var c = QM.el('div');
        c.appendChild(notice('These vouchers were issued before the approval step existed. Approve them so the accountant can pay the partner.', 'warn'));
        c.appendChild(QM.table([
          { key: 'tradeInId', label: 'Trade-in' }, { key: 'vendorName', label: 'Vendor' }, { key: 'device', label: 'Device' },
          { key: 'finalValue', label: 'Customer value', numeric: true, render: function (r) { return QM.money(r.finalValue); } },
          { key: 'payable', label: 'Payable to vendor', numeric: true, render: function (r) { return QM.money(r.payable); } },
          { key: 'x', label: '', render: function (r) { return small('Approve', function () { decide(r, 'APPROVE'); }, 'gold'); } }
        ], res.legacyUnapproved));
        wrap.appendChild(QM.card('Issued before approval existed', c));
      }
      return wrap;
    });
  });

  /* ------------------------------------------------------------- finance */

  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result)); };
      r.onerror = function () { reject(new Error('read')); };
      r.readAsDataURL(file);
    });
  }
  function receiptInput() {
    var f = QM.input('file');
    f.accept = 'application/pdf,image/png,image/jpeg,image/webp,image/heic,image/heif';
    f.setAttribute('data-qm', 'receipt-file');
    return f;
  }
  function qatarNowLocal() {
    var d = new Date(Date.now() + 3 * 3600 * 1000);
    return d.toISOString().slice(0, 16);
  }
  function openReceipt(action, p, r) {
    QM.call(action, { paymentId: p.paymentId, receiptId: r.receiptId }).then(function (res) {
      if (!QM.report(res, 'Opening the receipt…')) return;
      var w = window.open(res.url, '_blank', 'noopener');
      if (!w) QM.toast('Allow pop-ups to open the receipt.', 'danger');
    });
  }
  function receiptButtons(action, p) {
    return actions((p.receipts || []).map(function (r, i) {
      return small('Receipt ' + (i + 1), function () { openReceipt(action, p, r); });
    }));
  }

  function recordPayment(lines, done) {
    var vendorId = lines[0].vendorId;
    var total = 0;
    lines.forEach(function (l) { total += Math.round(l.payable * 100); });
    var body = QM.el('div');
    body.appendChild(notice(lines.length + ' trade-in(s) for ' + lines[0].vendorName + ' — total ' + ccy(total / 100) + '.'));
    var ref = QM.input('text', '', 'Bank / transfer reference');
    ref.setAttribute('data-qm', 'payment-reference');
    body.appendChild(QM.field('Payment reference', ref));
    var when = QM.input('datetime-local', qatarNowLocal());
    when.setAttribute('data-qm', 'payment-date');
    body.appendChild(QM.field('Payment date and time (Qatar)', when));
    var file = receiptInput();
    body.appendChild(QM.field('Receipt / proof of payment', file, 'PDF or image, up to 5 MB. Stored privately.'));
    var notes = QM.el('textarea'); notes.rows = 2;
    body.appendChild(QM.field('Notes (optional)', notes));
    var idem = key();
    QM.modal({
      title: 'Record payment to ' + lines[0].vendorName, body: body, confirmLabel: 'Mark as paid',
      collect: function () {
        if (!ref.value.trim()) { QM.toast('Enter the payment reference.', 'danger'); return false; }
        if (!file.files || !file.files[0]) { QM.toast('Attach the receipt.', 'danger'); return false; }
        if (file.files[0].size > MAX_RECEIPT) { QM.toast('The receipt is larger than 5 MB.', 'danger'); return false; }
        return { file: file.files[0], ref: ref.value.trim(), when: when.value, notes: notes.value.trim() };
      }
    }).then(function (d) {
      if (!d) return;
      readFile(d.file).then(function (data) {
        return QM.call('finance.recordPayment', {
          vendorId: vendorId, tradeInIds: lines.map(function (l) { return l.tradeInId; }), paymentReference: d.ref,
          paidAt: d.when, receipt: data, receiptFileName: d.file.name, notes: d.notes, idempotencyKey: idem
        });
      }).then(function (res) { if (QM.report(res)) done(); })
        .catch(function () { QM.toast('The file could not be read.', 'danger'); });
    });
  }

  function addReceipt(p, done) {
    var body = QM.el('div');
    var file = receiptInput();
    body.appendChild(QM.field('Another receipt for ' + p.paymentId, file, 'PDF or image, up to 5 MB.'));
    var idem = key();
    QM.modal({
      title: 'Upload receipt', body: body, confirmLabel: 'Upload',
      collect: function () {
        if (!file.files || !file.files[0]) { QM.toast('Choose a file.', 'danger'); return false; }
        if (file.files[0].size > MAX_RECEIPT) { QM.toast('The receipt is larger than 5 MB.', 'danger'); return false; }
        return { file: file.files[0] };
      }
    }).then(function (d) {
      if (!d) return;
      readFile(d.file).then(function (data) {
        return QM.call('finance.uploadReceipt', { paymentId: p.paymentId, receipt: data, receiptFileName: d.file.name, idempotencyKey: idem });
      }).then(function (res) { if (QM.report(res)) done(); });
    });
  }

  function paymentsTable(list, opts) {
    return QM.table([
      { key: 'paymentId', label: 'Payment' },
      { key: 'vendorName', label: 'Vendor' },
      { key: 'tradeInCount', label: 'Trade-ins', numeric: true },
      { key: 'total', label: 'Amount paid', numeric: true, render: function (r) { return QM.money(r.total); } },
      { key: 'paymentReference', label: 'Reference' },
      { key: 'paymentDate', label: 'Payment date' },
      { key: 'receiptStatus', label: 'Receipt', render: function (r) { return (r.receipts || []).length ? receiptButtons(opts.receiptAction, r) : r.receiptStatus; } },
      { key: 'statusLabel', label: 'Status', render: function (r) { return pill(r.statusLabel, r.status === 'CLOSED' ? 'ok' : 'warn'); } },
      opts.confirmed ? { key: 'vendorConfirmedDate', label: 'Confirmed', render: function (r) { return r.vendorConfirmedDate + (r.vendorConfirmedBy ? ' · ' + r.vendorConfirmedBy : ''); } } : null,
      opts.extra ? { key: 'x', label: '', render: opts.extra } : null
    ].filter(Boolean), list);
  }

  function linesTable(rows, opts) {
    var cols = [];
    if (opts && opts.pick) cols.push({ key: 'pick', label: '', render: opts.pick });
    cols.push(
      { key: 'tradeInId', label: 'Trade-in' },
      { key: 'vendorName', label: 'Vendor' },
      { key: 'branchName', label: 'Branch' },
      { key: 'voucherNumber', label: 'Voucher' },
      { key: 'device', label: 'Device' },
      { key: 'agreedAmount', label: 'Agreed amount', numeric: true, render: function (r) { return QM.money(r.agreedAmount); } },
      { key: 'payable', label: 'Payable to vendor', numeric: true, render: function (r) { return QM.money(r.payable); } },
      { key: 'paymentStatus', label: 'Payment status', render: function (r) { return pill(r.paymentStatus, 'warn'); } },
      { key: 'paymentDate', label: 'Payment date' }
    );
    return QM.table(cols, rows);
  }

  function financePending(page) {
    return QM.call('finance.queue', {}).then(function (res) {
      if (!res.ok) return QM.errorBlock(res.message);
      badge('f-pending', res.awaitingPayment.length);
      var wrap = QM.el('div');
      wrap.setAttribute('data-qm', 'finance-pending');
      if (!res.awaitingPayment.length) wrap.appendChild(QM.emptyBlock('Nothing to pay', 'No voucher is waiting for a partner payment.'));
      var byVendor = {};
      res.awaitingPayment.forEach(function (l) { (byVendor[l.vendorId] = byVendor[l.vendorId] || []).push(l); });
      Object.keys(byVendor).forEach(function (vid) {
        var rows = byVendor[vid];
        var chosen = {};
        rows.forEach(function (r) { chosen[r.tradeInId] = true; });
        var total = 0; rows.forEach(function (r) { total += Math.round(r.payable * 100); });
        var body = QM.el('div');
        body.appendChild(linesTable(rows, {
          pick: function (r) {
            var c = QM.input('checkbox'); c.checked = true;
            c.setAttribute('aria-label', 'Include ' + r.tradeInId);
            c.onchange = function () { chosen[r.tradeInId] = c.checked; };
            return c;
          }
        }));
        if (res.canPay) {
          var b = QM.button('Record payment for the ticked trade-ins', function () {
            var pickedRows = rows.filter(function (r) { return chosen[r.tradeInId]; });
            if (!pickedRows.length) { QM.toast('Tick at least one trade-in.', 'danger'); return; }
            recordPayment(pickedRows, function () { QM.go(page); });
          }, 'gold mt');
          b.setAttribute('data-qm', 'record-payment');
          body.appendChild(b);
        }
        wrap.appendChild(QM.card(rows[0].vendorName + ' — ' + rows.length + ' awaiting payment · ' + ccy(total / 100), body));
      });
      if (res.needsApproval && res.needsApproval.length) {
        var n = QM.el('div');
        n.appendChild(notice('Voucher issued before owner approval existed. The owner approves these under "Pending owner approval" before they can be paid.', 'warn'));
        n.appendChild(linesTable(res.needsApproval));
        wrap.appendChild(QM.card('Waiting for the owner first', n));
      }
      return wrap;
    });
  }

  function financePaid(page) {
    return QM.call('finance.queue', {}).then(function (res) {
      if (!res.ok) return QM.errorBlock(res.message);
      var wrap = QM.el('div');
      wrap.setAttribute('data-qm', 'finance-paid');
      if (!res.awaitingVendor.length) return QM.emptyBlock('Nothing waiting', 'Every payment sent has been confirmed by the partner.');
      wrap.appendChild(notice('Paid by Qatar Mobile. Each closes when the partner confirms the money arrived.'));
      wrap.appendChild(QM.card('Paid — awaiting vendor confirmation', paymentsTable(res.awaitingVendor, {
        receiptAction: 'finance.viewReceipt',
        extra: res.canPay ? function (r) { return small('Add receipt', function () { addReceipt(r, function () { QM.go(page); }); }); } : null
      })));
      return wrap;
    });
  }

  function financeCompleted() {
    return QM.call('finance.queue', {}).then(function (res) {
      if (!res.ok) return QM.errorBlock(res.message);
      if (!res.completed.length) return QM.emptyBlock('No history yet', 'Confirmed payments appear here.');
      var wrap = QM.el('div');
      wrap.setAttribute('data-qm', 'finance-completed');
      wrap.appendChild(QM.card('Completed', paymentsTable(res.completed, { receiptAction: 'finance.viewReceipt', confirmed: true })));
      return wrap;
    });
  }

  QM.route('f-pending', function () { return financePending('f-pending'); });
  QM.route('f-paid', function () { return financePaid('f-paid'); });
  QM.route('f-completed', function () { return financeCompleted(); });

  // Admin oversight: the same three lists on one page.
  QM.route('a-finance', function () {
    return Promise.all([financePending('a-finance'), financePaid('a-finance'), financeCompleted()]).then(function (parts) {
      var wrap = QM.el('div');
      var heads = ['Pending payment', 'Paid / awaiting vendor', 'Completed'];
      parts.forEach(function (p, i) { wrap.appendChild(QM.el('h3', 'mt', heads[i])); wrap.appendChild(p); });
      return wrap;
    });
  });

  /* -------------------------------------------------------------- vendor */

  function confirmFunds(p) {
    var idem = key();
    QM.modal({
      title: 'Confirm funds received?',
      body: 'Confirm that ' + ccy(p.total, p.currency) + ' (reference ' + p.paymentReference + ') has arrived in your account. ' +
        'The ' + p.tradeInCount + ' trade-in(s) in this payment are then closed.',
      confirmLabel: 'Confirm funds received'
    }).then(function (yes) {
      if (!yes) return;
      QM.call('vendor.confirmFunds', { paymentId: p.paymentId, idempotencyKey: idem })
        .then(function (res) { if (QM.report(res)) QM.go('v-finance'); });
    });
  }

  QM.route('v-finance', function () {
    return QM.call('vendor.finance', {}).then(function (res) {
      if (!res.ok) return QM.errorBlock(res.message);
      badge('v-finance', res.toConfirm.length);
      var wrap = QM.el('div');
      wrap.setAttribute('data-qm', 'vendor-finance');
      var conf = res.toConfirm.length ? paymentsTable(res.toConfirm, {
        receiptAction: 'vendor.viewReceipt',
        extra: function (r) {
          var b = small('Confirm funds received', function () { confirmFunds(r); }, 'gold');
          b.setAttribute('data-qm', 'confirm-funds');
          return b;
        }
      }) : QM.emptyBlock('Nothing to confirm', 'Payments from Qatar Mobile appear here.');
      wrap.appendChild(QM.card('Confirm payment received', conf));
      wrap.appendChild(QM.card('Awaiting payment', res.awaitingPayment.length
        ? linesTable(res.awaitingPayment) : QM.emptyBlock('Nothing outstanding', 'Every voucher has been paid.')));
      wrap.appendChild(QM.card('Completed', res.completed.length
        ? paymentsTable(res.completed, { receiptAction: 'vendor.viewReceipt', confirmed: true }) : QM.emptyBlock('No history yet', '')));
      return wrap;
    });
  });

  /* ---------------------------------------------------------- technician */

  if (typeof window.techQueue === 'function') {
    QM.route('t-owner', function () {
      return window.techQueue('awaitingOwner', 'Priced and sent to the owner. The customer sees the offer once it is approved.');
    });
    QM.route('t-done', function () {
      return window.techQueue('completed', 'The voucher has been issued. Nothing more to do on these.');
    });
  }
})();
