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
