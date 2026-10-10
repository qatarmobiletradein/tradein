/*
 * qm-flow.js — customer trade-in flow: choose the PARTNER first, then a BRANCH of that partner.
 * (Owner decision 2026-10-10.) The hash-checked 3.1 screens stay byte-for-byte; this file replaces
 * a few of their global functions after they load:
 *
 *   flowSteps()  shop (partner) → branch → brand → model → storage → colour → questions →
 *                estimate → device → review          (3.1: the shop came after the estimate)
 *   CX_PHASES / phaseOf()   a "Shop" phase first in the progress rail
 *   stepShop()   the partner list only (no branches)
 *   stepBranch() the branches of the chosen partner, loaded from public.vendorBranches —
 *                filtered on the SERVER; creating the trade-in checks the pair again.
 *
 * The estimate is unchanged (master price; no partner-specific pricing is introduced here).
 */
(function () {
  'use strict';
  if (typeof window.flowSteps !== 'function' || typeof window.stepShop !== 'function') return;

  var legacyReview = window.stepReview;

  window.CX_PHASES = [
    { key: 'shop',      label: 'Shop' },
    { key: 'device',    label: 'Device' },
    { key: 'condition', label: 'Condition' },
    { key: 'estimate',  label: 'Estimate' },
    { key: 'details',   label: 'Details' },
    { key: 'review',    label: 'Review' }
  ];

  window.phaseOf = function (step) {
    if (step.key === 'shop' || step.key === 'branch') return 'shop';
    if (step.key.indexOf('q:') === 0) return 'condition';
    if (step.key === 'estimate') return 'estimate';
    if (step.key === 'review') return 'review';
    if (step.key === 'device') return 'details';
    return 'device';
  };

  window.flowSteps = function () {
    var steps = [
      { key: 'shop',    label: 'Shop',    render: window.stepShop },
      { key: 'branch',  label: 'Branch',  render: stepBranch },
      { key: 'brand',   label: 'Brand',   render: window.stepBrand },
      { key: 'model',   label: 'Model',   render: window.stepModel },
      { key: 'storage', label: 'Storage', render: window.stepStorage },
      { key: 'colour',  label: 'Colour',  render: stepColour,
        skip: function () { return !window.currentProduct() || !window.currentProduct().colors.length; } }
    ];
    (F.questions || []).forEach(function (q) {
      steps.push({ key: 'q:' + q.key, label: q.group, question: q,
        render: function (body) { return window.stepQuestion(body, q); } });
    });
    steps.push({ key: 'estimate', label: 'Your value', render: window.stepEstimate });
    steps.push({ key: 'device',   label: 'Device',     render: window.stepDevice });
    steps.push({ key: 'review',   label: 'Review',     render: function (b, h) { F.qmSeenReview = true; return legacyReview(b, h); } });
    return steps;
  };

  /* Colour: the 3.1 screen, with each colour's own photo shown large (3:2, the catalogue image frame). */
  var legacyColour = window.stepColour;
  function stepColour(body, host) {
    var r = legacyColour(body, host);
    var imgs = body.querySelectorAll('.cx-choice img');
    for (var i = 0; i < imgs.length; i++) imgs[i].className = 'qm-colour-img';
    return r;
  }

  /* After a choice: straight back to the review screen when the person came from there. */
  function next(host) {
    if (F.qmSeenReview && F.branchId) window.flowGoToStep(host, 'review');
    else window.flowAdvance(host);
  }

  function choice(label, sub, logoUrl, selected, onPick) {
    var b = QM.el('button', 'cx-choice' + (selected ? ' on' : ''));
    b.type = 'button';
    if (QM.safeImageUrl(logoUrl)) {
      var img = document.createElement('img');
      img.src = QM.safeImageUrl(logoUrl); img.alt = '';
      b.appendChild(img);
    }
    var inner = QM.el('div', 'body');
    inner.appendChild(QM.el('div', 'label', label));
    if (sub) inner.appendChild(QM.el('div', 'sub', sub));
    b.appendChild(inner);
    b.appendChild(QM.el('div', 'tick', '✓'));
    b.onclick = onPick;
    return b;
  }

  /* ---- 1. the partner ---------------------------------------------------- */
  window.stepShop = function (body, host) {
    window.heading(body, 'Where will you bring your device?',
      'Choose the shop first, then the branch you can get to. We inspect the device there and hand you the voucher.');
    var vendors = F.vendors || [];
    if (!vendors.length) {
      body.appendChild(QM.el('div', 'cx-note warn', 'No shops are accepting trade-ins right now.'));
      body.appendChild(window.flowFoot(host, {}));
      return;
    }
    vendors.forEach(function (v) {
      var n = (v.branches || []).length;
      body.appendChild(choice(v.name, n === 1 ? '1 branch' : n + ' branches', v.logoUrl, F.vendorId === v.vendorId, function () {
        if (F.vendorId !== v.vendorId) { F.branchId = null; F.branchName = ''; F.branchAddress = ''; }
        F.vendorId = v.vendorId; F.vendorName = v.name;
        window.flowAdvance(host); // always on to the branch step
      }));
    });
    body.appendChild(window.flowFoot(host, {}));
  };

  /* ---- 2. a branch of that partner (server-filtered) ---------------------- */
  function stepBranch(body, host) {
    if (!F.vendorId) { window.flowGoToStep(host, 'shop'); return; }
    window.heading(body, 'Which ' + F.vendorName + ' branch?', 'Only ' + F.vendorName + ' branches are listed.');
    var list = QM.el('div');
    list.appendChild(QM.el('div', 'cx-note', 'Loading branches…'));
    body.appendChild(list);
    body.appendChild(window.flowFoot(host, {}));
    var forVendor = F.vendorId;
    QM.call('public.vendorBranches', { vendorId: forVendor }).then(function (res) {
      if (F.vendorId !== forVendor || !list.isConnected) return; // the person moved on
      QM.clear(list);
      if (!res.ok) { list.appendChild(QM.el('div', 'cx-note warn', res.message || 'The branches could not be loaded.')); return; }
      if (!res.branches.length) { list.appendChild(QM.el('div', 'cx-note warn', 'This shop has no branch accepting trade-ins right now.')); return; }
      res.branches.forEach(function (b) {
        list.appendChild(choice(b.name, b.address || '', null, F.branchId === b.branchId, function () {
          F.branchId = b.branchId; F.branchName = b.name; F.branchAddress = b.address || '';
          next(host);
        }));
      });
    });
  }
})();
