/*
 * qm-imei.js — "Enter IMEI Manually" or "Scan IMEI", one reusable component wherever an IMEI is typed
 * (owner request 2026-10-10). The hash-checked 3.1 screens stay byte-for-byte: this file finds their
 * existing IMEI field and adds the two choices above it — it never creates a second IMEI field.
 *
 *   customer trade-in registration  stepDevice()  input.imei-input   Continue waits for Confirm
 *   technician inspection           imeiCard()    input.code-input   "Check IMEI" waits for Confirm
 *   (device receipt has no IMEI field: the device is verified in the inspection.)
 *
 * Scanning runs in the browser only: the native BarcodeDetector where the browser has one, otherwise
 * the pinned, self-hosted ZXing decoder (/vendor/zxing-library-0.21.3.min.js, loaded on demand). No
 * frame, image or IMEI leaves the device through this file; nothing is logged; nothing goes in a URL.
 * The API stays authoritative: it re-validates the IMEI (15 digits, Luhn) and checks duplicates.
 */
(function (root) {
  'use strict';

  /* ================================================================ core (pure, unit-tested) */

  var GROUPED = /(^|[^0-9])([0-9]{2}[ -][0-9]{6}[ -][0-9]{6}[ -][0-9])(?![0-9])/g;
  var RUN = /[0-9]+/g;

  function luhn(d) {
    if (!/^[0-9]{15}$/.test(d)) return false;
    var sum = 0;
    for (var i = 0; i < 15; i++) {
      var n = d.charCodeAt(i) - 48;
      if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
      sum += n;
    }
    return sum % 10 === 0;
  }

  /** Typed or scanned text -> digits, or null when it holds anything but digits, spaces and dashes. */
  function normalize(raw) {
    var s = String(raw === null || raw === undefined ? '' : raw).trim();
    if (!s) return '';
    if (!/^[0-9][0-9 -]*$/.test(s)) return null;
    return s.replace(/[ -]/g, '');
  }

  /** 'valid' | 'empty' | 'malformed' | 'short' | 'long' | 'checksum' */
  function check(raw) {
    var d = normalize(raw);
    if (d === '') return 'empty';
    if (d === null) return 'malformed';
    if (d.length < 15) return 'short';
    if (d.length > 15) return 'long';
    return luhn(d) ? 'valid' : 'checksum';
  }

  function format(d) { return d.length === 15 ? d.slice(0, 2) + ' ' + d.slice(2, 8) + ' ' + d.slice(8, 14) + ' ' + d.slice(14) : d; }

  function labelBefore(text, at) {
    var m = /IMEI\s*([12])?\s*[:#=]?\s*$/i.exec(text.slice(Math.max(0, at - 14), at));
    return m ? (m[1] ? 'IMEI ' + m[1] : 'IMEI') : '';
  }

  /**
   * IMEI candidates in a scanned payload ("IMEI1: 35…", "IMEI2: 35…", a bare 15-digit barcode, or the
   * printed 2-6-6-1 grouping). Only 15-digit runs that pass the check digit are returned, in the order
   * found, without duplicates; longer digit runs (EAN codes, serials) are never cut into an IMEI.
   * { valid: [{ imei, label }], rejected: n }  — rejected counts 15-digit runs with a wrong check digit.
   */
  function extract(payload) {
    var text = String(payload === null || payload === undefined ? '' : payload).slice(0, 4000);
    var seen = {}; var valid = []; var rejected = 0;
    function take(d, at) {
      if (seen[d]) return;
      seen[d] = true;
      if (luhn(d)) valid.push({ imei: d, label: labelBefore(text, at) });
      else rejected++;
    }
    var m;
    RUN.lastIndex = 0;
    while ((m = RUN.exec(text))) if (m[0].length === 15) take(m[0], m.index);
    GROUPED.lastIndex = 0;
    while ((m = GROUPED.exec(text))) take(m[2].replace(/[ -]/g, ''), m.index + m[1].length);
    return { valid: valid, rejected: rejected };
  }

  var core = { luhn: luhn, normalize: normalize, check: check, extract: extract, format: format };
  root.QMImeiCore = core;
  if (typeof module === 'object' && module && module.exports) module.exports = core;
  if (!root.document || !root.QM) return;

  /* ================================================================ styles */

  var css = [
    '.qm-imei-choice{display:grid;grid-template-columns:1fr 1fr;gap:.5rem;margin:0 0 .75rem}',
    '.qm-imei-choice button{font:inherit;font-weight:600;padding:.75rem .6rem;border-radius:12px;border:1.5px solid var(--qm-line,#E2E8F0);',
    'background:#fff;color:var(--qm-dark,#1F2329);cursor:pointer;display:flex;align-items:center;justify-content:center;gap:.45rem;min-height:48px}',
    '.qm-imei-choice button[aria-pressed="true"]{border-color:var(--qm-cyan,#16BCDC);background:var(--qm-cyan-soft,#E8F8FC);color:var(--qm-cyan-ink,#0B6E82)}',
    '.qm-imei-choice svg{width:20px;height:20px;flex:0 0 20px}',
    '.qm-imei-status{font-size:.88rem;margin:.35rem 0 .2rem;color:var(--cx-ink-soft,#4A5568)}',
    '.qm-imei-status.bad{color:var(--cx-danger,#B3261E)}.qm-imei-status.good{color:var(--cx-ok,#1E7A47)}',
    '.qm-imei-confirm{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;padding:.7rem .8rem;margin:.4rem 0 .9rem;border-radius:12px;',
    'background:var(--qm-cyan-soft,#E8F8FC);border:1px solid var(--qm-cyan-line,#BDEBF5)}',
    '.qm-imei-confirm .num{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:1.05rem;letter-spacing:.04em;flex:1 1 auto}',
    '.qm-imei-confirm button{font:inherit;font-weight:600;padding:.5rem .9rem;border-radius:10px;cursor:pointer;border:1.5px solid var(--qm-cyan,#16BCDC)}',
    '.qm-imei-confirm .yes{background:var(--qm-cyan,#16BCDC);color:#fff}.qm-imei-confirm .edit{background:#fff;color:var(--qm-cyan-ink,#0B6E82)}',
    '.qm-imei-confirm.done{background:var(--cx-ok-soft,#E8F5EE);border-color:#BFE3CD}',
    '.qm-scan{position:fixed;inset:0;z-index:2000;background:#0B0E12;color:#fff;display:flex;flex-direction:column}',
    '.qm-scan video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}',
    '.qm-scan-frame{position:absolute;left:50%;top:42%;width:min(84vw,520px);height:min(30vw,170px);min-height:110px;transform:translate(-50%,-50%);',
    'border:3px solid var(--qm-cyan,#16BCDC);border-radius:14px;box-shadow:0 0 0 100vmax rgba(0,0,0,.45)}',
    '.qm-scan-tip{position:absolute;left:0;right:0;top:calc(42% + min(15vw,85px) + 22px);text-align:center;font-weight:600;padding:0 1rem;text-shadow:0 1px 3px #000}',
    '.qm-scan-tip small{display:block;font-weight:400;opacity:.85;margin-top:.3rem}',
    '.qm-scan-bar{position:absolute;left:0;right:0;bottom:0;display:flex;gap:.75rem;justify-content:center;',
    'padding:1rem 1rem calc(1rem + env(safe-area-inset-bottom))}',
    '.qm-scan-bar button{font:inherit;font-weight:600;min-height:48px;padding:.7rem 1.4rem;border-radius:12px;border:0;cursor:pointer}',
    '.qm-scan-bar .cancel{background:#fff;color:#1F2329}.qm-scan-bar .torch{background:rgba(255,255,255,.18);color:#fff}',
    '.qm-scan-bar .torch[aria-pressed="true"]{background:var(--qm-cyan,#16BCDC)}',
    '.qm-imei-pick{display:grid;gap:.5rem}.qm-imei-pick button{font:inherit;text-align:left;padding:.75rem .9rem;border-radius:12px;',
    'border:1.5px solid var(--qm-line,#E2E8F0);background:#fff;cursor:pointer}.qm-imei-pick .num{font-family:ui-monospace,Menlo,monospace;font-size:1.05rem}'
  ].join('');
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  var ICON_KEY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/></svg>';
  var ICON_SCAN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 8v8M10 8v8M13 8v8M17 8v8"/></svg>';

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
  function btn(cls, html, label, qm) {
    var b = el('button', cls); b.type = 'button';
    if (html) b.innerHTML = html;            // static icon markup only — never server data
    b.appendChild(document.createTextNode(label));
    if (qm) b.setAttribute('data-qm', qm);
    return b;
  }

  /* ================================================================ scanner */

  var WANTED = ['code_128', 'code_39', 'code_93', 'qr_code', 'data_matrix', 'ean_13', 'itf', 'pdf417', 'upc_a'];
  var ZXING_SRC = '/vendor/zxing-library-0.21.3.min.js';
  var zxingLoading = null;

  function scanError(code, message) { var e = new Error(message); e.code = code; return e; }

  function loadZxing() {
    if (root.ZXing) return Promise.resolve(root.ZXing);
    if (zxingLoading) return zxingLoading;
    zxingLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = ZXING_SRC; s.async = true;
      s.onload = function () { root.ZXing ? resolve(root.ZXing) : reject(new Error('decoder')); };
      s.onerror = function () { zxingLoading = null; reject(new Error('decoder')); };
      document.head.appendChild(s);
    });
    return zxingLoading;
  }

  /** A function video -> Promise<string[]> using the browser's own detector, else the local ZXing build. */
  function makeDetector() {
    var BD = root.BarcodeDetector;
    var native = BD && typeof BD.getSupportedFormats === 'function'
      ? BD.getSupportedFormats().then(function (have) {
        var formats = WANTED.filter(function (f) { return have.indexOf(f) > -1; });
        if (!formats.length) return null;
        var d = new BD({ formats: formats });
        return { kind: 'native', formats: formats, detect: function (video) {
          return d.detect(video).then(function (rs) { return rs.map(function (r) { return r.rawValue || ''; }); });
        } };
      }).catch(function () { return null; })
      : Promise.resolve(null);
    return native.then(function (n) {
      if (n) return n;
      return loadZxing().then(function (Z) {
        var hints = new Map();
        hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.CODE_39, Z.BarcodeFormat.CODE_93,
          Z.BarcodeFormat.QR_CODE, Z.BarcodeFormat.DATA_MATRIX, Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.ITF, Z.BarcodeFormat.PDF_417]);
        hints.set(Z.DecodeHintType.TRY_HARDER, true);
        var reader = new Z.MultiFormatReader();
        reader.setHints(hints);
        var canvas = document.createElement('canvas');
        var ctx = canvas.getContext('2d', { willReadFrequently: true });
        return { kind: 'zxing', formats: ['code_128', 'code_39', 'code_93', 'qr_code', 'data_matrix', 'ean_13', 'itf', 'pdf417'], detect: function (video) {
          var w = video.videoWidth; var h = video.videoHeight;
          if (!w || !h) return Promise.resolve([]);
          var scale = Math.min(1, 1280 / w);
          canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          try {
            var bmp = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas)));
            return Promise.resolve([reader.decode(bmp).getText()]);
          } catch (e) { return Promise.resolve([]); }      // nothing readable in this frame
        } };
      });
    });
  }

  /**
   * Opens the camera full-screen and resolves with the valid IMEI candidates of the first barcode that
   * holds any. Rejects with .code = CANCELLED | DENIED | NO_CAMERA | FAILED (never throws to the page).
   */
  function scan() {
    var md = root.navigator && root.navigator.mediaDevices;
    if (!md || typeof md.getUserMedia !== 'function') {
      return Promise.reject(scanError('NO_CAMERA', 'No camera is available here. Enter the IMEI manually.'));
    }
    var overlay = el('div', 'qm-scan'); overlay.setAttribute('data-qm', 'imei-scanner');
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-label', 'Scan IMEI');
    var video = el('video'); video.setAttribute('playsinline', ''); video.muted = true; video.autoplay = true;
    var frame = el('div', 'qm-scan-frame');
    var tip = el('div', 'qm-scan-tip', 'Point the camera at the IMEI barcode');
    var sub = el('small', null, 'On the box label, or under Settings › About. Hold steady about 15 cm away.');
    tip.appendChild(sub);
    var bar = el('div', 'qm-scan-bar');
    var torch = btn('torch', '', 'Flashlight', 'imei-torch'); torch.hidden = true; torch.setAttribute('aria-pressed', 'false');
    var cancel = btn('cancel', '', 'Cancel', 'imei-scan-cancel');
    bar.appendChild(torch); bar.appendChild(cancel);
    overlay.appendChild(video); overlay.appendChild(frame); overlay.appendChild(tip); overlay.appendChild(bar);

    var stream = null; var stopped = false; var timer = null;
    function stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (stream) stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* already stopped */ } });
      try { video.srcObject = null; } catch (e) { /* ignore */ }
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    return new Promise(function (resolve, reject) {
      function fail(code, message) { if (stopped) return; stop(); reject(scanError(code, message)); }
      cancel.onclick = function () { fail('CANCELLED', 'Scanning cancelled. Enter the IMEI manually or scan again.'); };
      document.body.appendChild(overlay);
      md.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } })
        .then(function (s) {
          if (stopped) { s.getTracks().forEach(function (t) { t.stop(); }); return null; }
          stream = s;
          video.srcObject = s;
          var p = video.play(); if (p && p.catch) p.catch(function () { /* autoplay is muted; ignore */ });
          var track = s.getVideoTracks()[0];
          var caps = track && typeof track.getCapabilities === 'function' ? track.getCapabilities() : {};
          if (caps && caps.torch) {
            torch.hidden = false;
            torch.onclick = function () {
              var on = torch.getAttribute('aria-pressed') !== 'true';
              track.applyConstraints({ advanced: [{ torch: on }] }).then(function () { torch.setAttribute('aria-pressed', String(on)); })
                .catch(function () { torch.hidden = true; });
            };
          }
          return makeDetector();
        }, function (err) {
          var name = err && err.name;
          if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
            fail('DENIED', 'Camera permission was not given. Enter the IMEI manually — or allow the camera in your browser settings and try again.');
          } else if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
            fail('NO_CAMERA', 'No camera was found on this device. Enter the IMEI manually.');
          } else {
            fail('FAILED', 'The camera could not be started. Enter the IMEI manually.');
          }
          return null;
        })
        .then(function (detector) {
          if (!detector || stopped) { if (!stopped && stream) fail('FAILED', 'The scanner could not start. Enter the IMEI manually.'); return; }
          var lastHint = 0;
          (function tick() {
            if (stopped) return;
            detector.detect(video).then(function (values) {
              if (stopped) return;
              for (var i = 0; i < values.length; i++) {
                var found = extract(values[i]);
                if (found.valid.length) { stop(); resolve(found.valid); return; }
                if (values[i] && Date.now() - lastHint > 2500) {
                  lastHint = Date.now();
                  sub.textContent = found.rejected ? 'That number failed the IMEI check. Try the other barcode.' : 'That barcode is not an IMEI. Aim at the one marked IMEI.';
                }
              }
              timer = setTimeout(tick, detector.kind === 'native' ? 150 : 250);
            }, function () { fail('FAILED', 'The scanner stopped working. Enter the IMEI manually.'); });
          })();
        }, function () { fail('FAILED', 'The scanner could not start. Enter the IMEI manually.'); });
    });
  }

  /** Several IMEIs in one barcode (dual SIM): the person chooses — none is picked for them. */
  function choose(cands) {
    if (cands.length === 1) return Promise.resolve(cands[0].imei);
    return new Promise(function (resolve) {
      var scrim = el('div', 'modal-scrim'); var box = el('div', 'modal');
      box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'Which IMEI?');
      var head = el('div', 'modal-head'); head.appendChild(el('h3', null, 'Which IMEI?')); box.appendChild(head);
      var body = el('div', 'modal-body');
      body.appendChild(el('p', null, 'This barcode holds ' + cands.length + ' IMEIs (dual SIM). Choose the one for this trade-in.'));
      var list = el('div', 'qm-imei-pick'); list.setAttribute('data-qm', 'imei-pick');
      function close(v) { if (scrim.parentNode) scrim.parentNode.removeChild(scrim); resolve(v); }
      cands.forEach(function (c, i) {
        var b = btn('', '', '', 'imei-pick-' + (i + 1));
        b.appendChild(el('div', null, c.label || 'IMEI ' + (i + 1)));
        b.appendChild(el('div', 'num', format(c.imei)));
        b.onclick = function () { close(c.imei); };
        list.appendChild(b);
      });
      body.appendChild(list); box.appendChild(body);
      var foot = el('div', 'modal-foot');
      var cancel = btn('btn secondary', '', 'Cancel', 'imei-pick-cancel');
      cancel.onclick = function () { close(''); };
      foot.appendChild(cancel); box.appendChild(foot);
      scrim.appendChild(box); document.body.appendChild(scrim);
    });
  }

  /* ================================================================ the component */

  var MESSAGES = {
    malformed: 'An IMEI has digits only — no letters or symbols.',
    short: function (n) { return n + ' of 15 digits'; },
    long: 'An IMEI is exactly 15 digits — this has more.',
    checksum: 'These 15 digits are not a valid IMEI (the check digit does not match). Check each digit.'
  };

  /**
   * Adds "Enter IMEI Manually" / "Scan IMEI" above an existing IMEI input.
   *   opts.gate     a button that stays disabled until a valid IMEI is confirmed (Continue / Check IMEI)
   *   opts.field    the element to insert before (default: the input's field wrapper)
   */
  function attach(input, opts) {
    opts = opts || {};
    if (!input || input.getAttribute('data-qm-imei')) return null;
    input.setAttribute('data-qm-imei', 'manual');
    input.setAttribute('autocomplete', 'off');
    if (input.maxLength > 0 && input.maxLength < 19) input.maxLength = 19;   // room for the printed "35 123456 789012 3" grouping
    var field = opts.field || input.closest('.cx-field, .field') || input;
    var host = field.parentNode;

    var choice = el('div', 'qm-imei-choice'); choice.setAttribute('role', 'group'); choice.setAttribute('aria-label', 'How to enter the IMEI');
    var manualBtn = btn('', ICON_KEY, 'Enter IMEI Manually', 'imei-manual');
    var scanBtn = btn('', ICON_SCAN, 'Scan IMEI', 'imei-scan');
    choice.appendChild(manualBtn); choice.appendChild(scanBtn);
    host.insertBefore(choice, field);

    var status = el('div', 'qm-imei-status'); status.setAttribute('data-qm', 'imei-status'); status.setAttribute('aria-live', 'polite');
    var panel = el('div', 'qm-imei-confirm'); panel.setAttribute('data-qm', 'imei-confirm-panel'); panel.hidden = true;
    var num = el('span', 'num');
    var yes = btn('yes', '', 'Confirm', 'imei-confirm');
    var edit = btn('edit', '', 'Edit', 'imei-edit');
    panel.appendChild(num); panel.appendChild(yes); panel.appendChild(edit);
    if (field.nextSibling) { host.insertBefore(status, field.nextSibling); host.insertBefore(panel, status.nextSibling); }
    else { host.appendChild(status); host.appendChild(panel); }

    var state = { confirmed: '', source: 'manual' };
    function setMode(mode) {
      state.source = mode;
      manualBtn.setAttribute('aria-pressed', String(mode === 'manual'));
      scanBtn.setAttribute('aria-pressed', String(mode === 'scan'));
      input.setAttribute('data-qm-imei', mode);
    }
    function render() {
      var raw = input.value;
      var c = check(raw);
      var d = normalize(raw) || '';
      if (state.confirmed && state.confirmed !== d) state.confirmed = '';
      status.className = 'qm-imei-status';
      status.textContent = '';
      if (c === 'malformed' || c === 'long' || c === 'checksum') { status.className += ' bad'; status.textContent = MESSAGES[c]; }
      else if (c === 'short') status.textContent = MESSAGES.short(d.length);
      if (c === 'valid') {
        panel.hidden = false;
        num.textContent = (state.source === 'scan' && !state.confirmed ? 'Detected IMEI ' : 'IMEI ') + format(d);
        panel.classList.toggle('done', state.confirmed === d);
        yes.hidden = state.confirmed === d;
        if (state.confirmed === d) num.textContent = '✓ IMEI confirmed ' + format(d);
      } else panel.hidden = true;
      if (opts.gate) opts.gate.disabled = !(c === 'valid' && state.confirmed === d);
      return c;
    }
    input.addEventListener('input', render);
    yes.onclick = function () {
      var d = normalize(input.value);
      if (check(input.value) !== 'valid') return;
      state.confirmed = d; render();
      if (opts.gate && typeof opts.gate.focus === 'function') opts.gate.focus();
    };
    edit.onclick = function () { state.confirmed = ''; setMode('manual'); render(); input.focus(); input.select && input.select(); };
    manualBtn.onclick = function () { setMode('manual'); render(); input.focus(); };
    scanBtn.onclick = function () {
      setMode('scan');
      scan().then(choose).then(function (imei) {
        if (!imei) { setMode('manual'); render(); return; }
        input.value = imei;
        state.confirmed = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));   // the screen's own handlers run too
        setMode('scan'); render();
        yes.focus();
      }, function (err) {
        setMode('manual');
        render();
        status.className = 'qm-imei-status' + (err && err.code === 'CANCELLED' ? '' : ' bad');
        status.textContent = (err && err.message) || 'Enter the IMEI manually.';
        input.focus();
      });
    };
    setMode('manual');
    // The screen may render with a value already there (going back a step): it still needs confirming.
    render();
    return { render: render, input: input, confirmedValue: function () { return state.confirmed; } };
  }

  root.QMImei = { attach: attach, scan: scan, core: core };

  /* ================================================================ wiring into the 3.1 screens */

  // Customer registration: the IMEI step of the trade-in flow.
  if (typeof root.stepDevice === 'function') {
    var legacyDevice = root.stepDevice;
    root.stepDevice = function (body, host) {
      var out = legacyDevice.apply(this, arguments);
      var input = body && body.querySelector('input.imei-input');
      var gate = body && body.querySelector('.cx-cta:not(.back)');
      if (input) {
        // The component's own status line replaces the screen's digit counter (one message, not two).
        var field = input.closest('.cx-field');
        var counter = field && field.nextElementSibling;
        if (counter && counter.classList.contains('cx-quiet')) counter.style.display = 'none';
        attach(input, { gate: gate });
      }
      return out;
    };
  }

  // Technician inspection: the identity check.
  if (typeof root.imeiCard === 'function') {
    var legacyCard = root.imeiCard;
    root.imeiCard = function () {
      var card = legacyCard.apply(this, arguments);
      var input = card && card.querySelector('input.code-input');
      if (input) {
        var gate = null;
        card.querySelectorAll('button').forEach(function (b) { if (/Check IMEI/.test(b.textContent)) gate = b; });
        attach(input, { gate: gate });
      }
      return card;
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
