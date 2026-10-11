/*
 * qm-ui.js — small visual layer over the hash-checked 3.1 screens (they stay byte-for-byte).
 *
 * The 3.1 screens write a few colour emoji as text (🔍 Search, 🔔 notifications, 📱 device
 * placeholder, 🔒 "calculated by the system"). They are swapped for line icons that take the
 * text colour, so every portal uses one quiet icon style. Only the text node changes; buttons,
 * handlers, badges and aria labels stay as they are.
 */
(function () {
  'use strict';
  var P = {
    '🔍': 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5',                                   // 🔍
    '🔔': 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0',            // 🔔
    '📱': 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM11 18h2',    // 📱
    '🔒': 'M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1zM8 11V7a4 4 0 0 1 8 0v4', // 🔒
  };
  var RE = /(🔍|🔔|📱|🔒)️?\s?/;

  var css = '.qm-ico{display:inline-block;width:1.15em;height:1.15em;vertical-align:-.2em;background:currentColor;' +
    '-webkit-mask:var(--qm-ico) center/contain no-repeat;mask:var(--qm-ico) center/contain no-repeat}' +
    '.qm-ico+.qm-ico-gap{margin-left:.35em}';
  Object.keys(P).forEach(function (k, i) {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="' + P[k] + '"/></svg>';
    css += '.qm-ico-' + i + '{--qm-ico:url("data:image/svg+xml,' + encodeURIComponent(svg) + '")}';
  });
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  var KEYS = Object.keys(P);

  function swap(textNode) {
    var m = RE.exec(textNode.nodeValue);
    if (!m) return;
    var parent = textNode.parentNode;
    if (!parent || parent.closest && parent.closest('input, textarea, [contenteditable]')) return;
    var before = textNode.nodeValue.slice(0, m.index);
    var after = textNode.nodeValue.slice(m.index + m[0].length);
    var ico = document.createElement('span');
    ico.className = 'qm-ico qm-ico-' + KEYS.indexOf(m[1]);
    ico.setAttribute('aria-hidden', 'true');
    if (before) parent.insertBefore(document.createTextNode(before), textNode);
    parent.insertBefore(ico, textNode);
    if (after) {
      var rest = document.createElement('span');
      rest.className = 'qm-ico-gap';
      rest.textContent = after;
      parent.insertBefore(rest, textNode);
    }
    parent.removeChild(textNode);
  }
  function scan(root) {
    if (!root) return;
    if (root.nodeType === 3) { swap(root); return; }
    if (root.nodeType !== 1) return;
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var found = [];
    while (w.nextNode()) if (RE.test(w.currentNode.nodeValue)) found.push(w.currentNode);
    found.forEach(swap);
  }
  new MutationObserver(function (list) {
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (r.type === 'characterData') scan(r.target);
      else for (var j = 0; j < r.addedNodes.length; j++) scan(r.addedNodes[j]);
    }
  }).observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });
  scan(document.body);
})();

/*
 * Every page and every step starts at the top (owner report 2026-10-11): the 3.1 screens re-draw into
 * the same document, so the browser kept the previous scroll position — after sign-in, after a menu
 * choice, and between the steps of the customer's trade-in flow.
 */
(function () {
  'use strict';
  if (!window.QM) return;
  try { if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; } catch (e) { /* older browsers */ }
  function toTop() {
    try { window.scrollTo(0, 0); } catch (e) { /* ignore */ }
    var se = document.scrollingElement || document.documentElement;
    if (se) se.scrollTop = 0;
    if (document.body) document.body.scrollTop = 0;
    ['#content', '.content', '.main', '.cx-main', '#flow'].forEach(function (sel) {
      document.querySelectorAll(sel).forEach(function (n) { if (n.scrollTop) n.scrollTop = 0; });
    });
  }
  window.QMScrollTop = toTop;
  function wrap(owner, name) {
    var fn = owner[name];
    if (typeof fn !== 'function' || fn.__qmTop) return;
    var w = function () { var out = fn.apply(this, arguments); toTop(); return out; };
    w.__qmTop = true;
    owner[name] = w;
  }
  wrap(QM, 'go');
  wrap(QM, 'renderPortal');
  // The customer flow is drawn by global functions (3.1 PortalCustomerFlow); they exist when this runs.
  function wrapFlow() { wrap(window, 'renderFlow'); }
  wrapFlow();
  document.addEventListener('DOMContentLoaded', wrapFlow);
  window.addEventListener('load', function () { wrapFlow(); toTop(); });
})();

/*
 * A deploy reaches everyone (owner report 2026-10-11, "cache"): the page remembers the build it was
 * loaded from (/version.json, never cached) and, when the server has a newer one, shows a bar with
 * "Update now". It never reloads on its own, so a half-filled form is not lost. A page brought back
 * from the browser's back/forward cache is reloaded at once.
 */
(function () {
  'use strict';
  var mine = null; var shown = false; var last = 0;
  function check() {
    if (shown || Date.now() - last < 30000) return;
    last = Date.now();
    try {
      fetch('/version.json', { cache: 'no-store', credentials: 'omit' }).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (v) {
          if (!v || !v.build) return;
          if (mine === null) { mine = v.build; return; }
          if (v.build !== mine) offer();
        }).catch(function () { /* offline: try later */ });
    } catch (e) { /* very old browser */ }
  }
  function offer() {
    shown = true;
    var bar = document.createElement('div');
    bar.setAttribute('role', 'status'); bar.setAttribute('data-qm', 'update-bar');
    bar.style.cssText = 'position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:3000;' +
      'background:#1F2329;color:#fff;border-radius:12px;padding:.7rem .8rem .7rem 1rem;display:flex;gap:.8rem;align-items:center;' +
      'box-shadow:0 8px 24px rgba(0,0,0,.25);font:inherit;max-width:calc(100vw - 32px)';
    bar.appendChild(document.createTextNode('A new version of the app is available. / يتوفر إصدار جديد.'));
    var b = document.createElement('button');
    b.type = 'button'; b.textContent = 'Update now / تحديث';
    b.style.cssText = 'font:inherit;font-weight:600;border:0;border-radius:10px;padding:.5rem .9rem;background:var(--qm-cyan,#16BCDC);color:#fff;cursor:pointer;white-space:nowrap';
    b.onclick = function () { location.reload(); };
    bar.appendChild(b);
    document.body.appendChild(bar);
  }
  window.addEventListener('pageshow', function (e) { if (e.persisted) location.reload(); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') check(); });
  window.addEventListener('focus', check);
  setInterval(check, 5 * 60 * 1000);
  check();
})();
