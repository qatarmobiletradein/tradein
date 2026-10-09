/*
 * qm-staff-signin.js — staff email + password sign-in for the Railway build.
 *
 * Owner decision (staging phase): staff sign in with their work email and a
 * password; customers keep the 3.1 SMS code. The 3.1 screens stay byte-for-
 * byte unchanged (LEGACY_SOURCES.sha256): this file is injected right after
 * Auth.html and only ADDS to it —
 *
 *   - a "Staff sign-in" link under the 3.1 phone screen;
 *   - the staff sign-in form (email + password);
 *   - "Set or reset password": a 6-digit code is e-mailed by Supabase Auth,
 *     the person types it with a new password and is signed in.
 *
 * It uses only the 3.1 client helpers (QM.el, QM.input, QM.field, QM.call,
 * QM.setToken, QM.renderPortal) and Auth.html's showMessage, so it looks
 * and behaves like the rest of the screen. Passwords live only in the input
 * fields and the single HTTPS request; nothing is stored in the browser
 * except the session tokens the 3.1 client already keeps.
 *
 * Active only when the build says staff sign in by password
 * (QM_STAFF_SIGN_IN, default "password").
 */
(function () {
  'use strict';
  var cfg = window.QM_TRANSPORT || {};
  if (cfg.mode !== 'railway') return;

  /* ---------------------------------------------- input hygiene (all modes) */
  // Sign-in / sign-up mobile number: exactly the 8 local digits; "+974" is shown in front and never typed.
  // A pasted "+974 3312 3456" or "00974…" keeps its last 8 digits. Only the sign-in card — IMEI fields
  // elsewhere are also type=tel and must not be touched.
  function eightDigits(v) {
    var d = String(v || '').replace(/\D/g, '');
    if (d.length > 8) { if (d.indexOf('00974') === 0) d = d.slice(5); else if (d.indexOf('974') === 0) d = d.slice(3); }
    return d.slice(0, 8);
  }
  function isSignInPhone(t) {
    return t.type === 'tel' && !t.classList.contains('code-input') && t.getAttribute('autocomplete') !== 'one-time-code' &&
      !!(t.closest && t.closest('#root .auth-card'));
  }
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (!t || t.tagName !== 'INPUT') return;
    if (isSignInPhone(t)) { var v = eightDigits(t.value); if (v !== t.value) t.value = v; }
    // An address copied from a link arrives as "mailto:name@company.qa".
    else if (t.type === 'email' && /^\s*mailto:/i.test(t.value)) t.value = t.value.replace(/^\s*mailto:\s*/i, '');
  }, true);
  var ccStyle = document.createElement('style');
  ccStyle.textContent = '.qm-cc{display:flex;align-items:stretch}' +
    '.qm-cc>span{display:flex;align-items:center;padding:0 .7rem;border:1px solid var(--line);border-right:0;' +
    'border-radius:var(--radius) 0 0 var(--radius);background:var(--surface-2,#F5F7F9);color:var(--ink-soft,#5B5F66);font-size:16px;direction:ltr}' +
    '.qm-cc>input{flex:1;min-width:0;border-top-left-radius:0!important;border-bottom-left-radius:0!important}';
  document.head.appendChild(ccStyle);
  function decoratePhones(root) {
    var list = (root || document).querySelectorAll('#root .auth-card input[type=tel]');
    for (var i = 0; i < list.length; i++) {
      var input = list[i];
      if (!isSignInPhone(input) || input.getAttribute('data-qm-cc')) continue;
      input.setAttribute('data-qm-cc', '1');
      input.setAttribute('placeholder', '33123456');
      input.setAttribute('maxlength', '16'); // room for a pasted "+974 …"; trimmed to 8 digits on input
      var wrap = document.createElement('div');
      wrap.className = 'qm-cc';
      input.parentNode.insertBefore(wrap, input);
      var cc = document.createElement('span');
      cc.textContent = '+974';
      wrap.appendChild(cc);
      wrap.appendChild(input);
    }
  }
  // The 3.1 screens draw their fields on the fly: decorate whatever sign-in card appears.
  new MutationObserver(function () { decoratePhones(); }).observe(document.body || document.documentElement, { childList: true, subtree: true });

  /* -------------------------------- "Send code": count the wait down */
  // When a code request is refused or could not be sent, the server says how long the number must wait
  // (retryAfterS). The button shows the seconds and stays disabled until then, instead of letting the
  // person press into another refusal. (After a successful send the 3.1 code screen has its own timer.)
  function countDown(seconds) {
    var btn = null;
    var all = document.querySelectorAll('#root .auth-card button');
    for (var i = 0; i < all.length; i++) if (/^Send code/.test(all[i].textContent)) { btn = all[i]; break; }
    if (!btn || !(seconds > 0)) return;
    if (btn._qmTimer) clearInterval(btn._qmTimer);
    var left = Math.min(Math.ceil(seconds), 600);
    btn.disabled = true;
    btn.textContent = 'Send code (' + left + 's)';
    btn._qmTimer = setInterval(function () {
      left--;
      if (!btn.isConnected) { clearInterval(btn._qmTimer); return; }
      if (left <= 0) { clearInterval(btn._qmTimer); btn._qmTimer = null; btn.disabled = false; btn.textContent = 'Send code'; return; }
      btn.textContent = 'Send code (' + left + 's)';
    }, 1000);
  }
  if (window.QM && typeof QM.call === 'function') {
    var sendCall = QM.call;
    QM.call = function (action, params) {
      var p = sendCall.apply(this, arguments);
      var isSend = action === 'auth.start' || (action === 'auth.register' && !(params && params.code));
      if (!isSend) return p;
      return p.then(function (res) {
        // after the 3.1 handler has re-enabled the button and shown the message
        if (res && !res.ok && res.retryAfterS) setTimeout(function () { countDown(res.retryAfterS); }, 0);
        return res;
      });
    };
  }

  if (cfg.staffSignIn !== 'password' && cfg.staffSignIn !== 'both') return;
  if (typeof window.buildAuthScreen !== 'function') return;
  var staffByPhoneToo = cfg.staffSignIn === 'both';

  var legacyBuild = window.buildAuthScreen;
  // 3.1 styled every input type it used; password was not one of them. Same rule, same tokens.
  var style = document.createElement('style');
  style.textContent = 'input[type=password]{width:100%;min-height:44px;padding:.55rem .7rem;border:1px solid var(--line);' +
    'border-radius:var(--radius);font-size:16px;font-family:inherit;color:var(--ink);background:var(--surface);}';
  document.head.appendChild(style);
  var PASSWORD_HINT = 'At least 12 characters, with letters and at least one number. Do not reuse your email address.';

  window.buildAuthScreen = function (mode) {
    legacyBuild(mode);
    if (mode === 'register') return;
    var card = document.querySelector('#root .auth-card');
    if (!card) return;
    var host = card.lastElementChild;
    var footer = QM.el('div', 'center mt small qm-staff-entry');
    var link = QM.el('a', null, 'Staff sign-in (email and password)');
    link.href = '#';
    link.onclick = function (e) { e.preventDefault(); renderStaffSignIn(host, footer, ''); };
    footer.appendChild(QM.el('span', 'muted', 'Qatar Mobile or partner staff? '));
    footer.appendChild(link);
    card.appendChild(footer);
  };

  // An approved applicant now signs in by email, not by mobile number.
  if (typeof window.renderPendingScreen === 'function') {
    window.renderPendingScreen = function (host, message) {
      QM.clear(host);
      var notice = QM.el('div', 'notice ok');
      notice.appendChild(QM.el('strong', null, 'Request submitted'));
      notice.appendChild(document.createTextNode(message || 'Your access request is waiting for administrator approval.'));
      host.appendChild(notice);
      host.appendChild(QM.el('p', 'soft', staffByPhoneToo
        ? 'Once somebody has approved you, sign in with your mobile number — or choose “Staff sign-in”, then “Set or reset password” with the work email you gave.'
        : 'Once somebody has approved you, choose “Staff sign-in”, then “Set or reset password” with the work email you gave.'));
      var back = QM.el('button', 'btn secondary block', 'Back to sign in');
      back.onclick = function () { window.buildAuthScreen(); };
      host.appendChild(back);
    };
  }

  // STAFF_SIGN_IN=both: a SUPER_ADMIN who signed in with an SMS code still needs the authenticator app.
  // The 3.1 code step does not know that step, so the reply is taken over here before it sees it.
  if (staffByPhoneToo && typeof QM.call === 'function') {
    var legacyCall = QM.call;
    QM.call = function (action, params) {
      var p = legacyCall.apply(this, arguments);
      if (action !== 'auth.verify') return p;
      return p.then(function (res) {
        if (!res || !res.ok || !res.mfaRequired) return res;
        var card = document.querySelector('#root .auth-card');
        var host = card && card.lastElementChild;
        var footer = card && card.querySelector('.qm-staff-entry');
        if (!host) return res;
        if (footer && footer.parentNode !== card) footer = null;
        if (host === footer) host = footer.previousElementSibling;
        renderMfa(host, footer || QM.el('div'), res);
        return new Promise(function () {}); // the 3.1 step must not continue with an aal1 session
      });
    };
  }

  function linkRow(label, onClick) {
    var row = QM.el('div', 'center mt small');
    var a = QM.el('a', null, label);
    a.href = '#';
    a.onclick = function (e) { e.preventDefault(); onClick(); };
    row.appendChild(a);
    return row;
  }

  function emailInput(value) {
    var i = QM.input('email', value || '', 'name@company.qa');
    i.setAttribute('autocomplete', 'username');
    i.setAttribute('autocapitalize', 'none');
    i.setAttribute('spellcheck', 'false');
    return i;
  }

  function passwordInput(autocomplete) {
    var i = QM.input('password', '', '');
    i.setAttribute('autocomplete', autocomplete);
    i.maxLength = 128;
    return i;
  }

  function busyButton(btn, busy, idle, working) {
    btn.disabled = !!busy;
    btn.textContent = busy ? working : idle;
  }

  /** Same ending as the 3.1 code step: keep the token, load the context, draw the portal the server named. */
  function enterPortal(res, msg) {
    QM.setToken(res.token);
    QM.call('me.context', {}).then(function (me) {
      if (!me.ok) { showMessage(msg, 'Could not load your account.', 'danger'); return; }
      QM.state.me = me;
      QM.renderPortal(me.portal);
    });
  }

  /* ---------------------------------------------------------- sign in */
  function renderStaffSignIn(host, footer, presetEmail) {
    QM.clear(host);
    footer.style.display = 'none';
    var msg = QM.el('div');
    host.appendChild(msg);
    host.appendChild(QM.el('p', 'soft', 'Staff of Qatar Mobile and its partners sign in with their work email.'));

    var email = emailInput(presetEmail);
    host.appendChild(QM.field('Work email', email));
    var password = passwordInput('current-password');
    host.appendChild(QM.field('Password', password));

    var submit = QM.el('button', 'btn block', 'Sign in');
    host.appendChild(submit);
    host.appendChild(linkRow('Set or reset password', function () { renderResetRequest(host, footer, email.value.trim()); }));
    host.appendChild(linkRow('Back to mobile number sign-in', function () { window.buildAuthScreen(); }));

    function go() {
      var e = email.value.trim();
      if (!e || !password.value) { showMessage(msg, 'Enter your work email and password.', 'danger'); return; }
      busyButton(submit, true, 'Sign in', 'Signing in…');
      QM.call('auth.staffLogin', { email: e, password: password.value }).then(function (res) {
        busyButton(submit, false, 'Sign in');
        if (!res.ok) { password.value = ''; showMessage(msg, res.message, 'danger'); password.focus(); return; }
        password.value = '';
        if (res.mfaRequired) { renderMfa(host, footer, res); return; }
        enterPortal(res, msg);
      });
    }
    submit.onclick = go;
    password.onkeydown = function (ev) { if (ev.key === 'Enter') go(); };
    email.onkeydown = function (ev) { if (ev.key === 'Enter') password.focus(); };
    (presetEmail ? password : email).focus();
  }

  /* ------------------------------------- authenticator app (SUPER_ADMIN) */
  // The password was right; this account also needs a code from an authenticator app.
  // The session from the password step works only for these three calls.
  function renderMfa(host, footer, login) {
    QM.clear(host);
    footer.style.display = 'none';
    QM.setToken(login.token);
    var msg = QM.el('div');
    host.appendChild(msg);
    var factorId = login.factorId || '';
    var code = QM.input('text', '', '6-digit code');
    code.setAttribute('inputmode', 'numeric');
    code.setAttribute('autocomplete', 'one-time-code');
    code.maxLength = 6;
    var submit = QM.el('button', 'btn block', 'Verify and sign in');

    function askCode() {
      host.appendChild(QM.field('Code from your authenticator app', code));
      host.appendChild(submit);
      host.appendChild(linkRow('Back to staff sign-in', function () { QM.setToken(''); renderStaffSignIn(host, footer, ''); }));
      code.focus();
    }

    if (login.mfaEnrolled) {
      host.appendChild(QM.el('p', 'soft', 'Open your authenticator app and enter the 6-digit code for Qatar Mobile Trade-In.'));
      askCode();
    } else {
      host.appendChild(QM.el('p', 'soft', 'This account must be protected with an authenticator app (for example Microsoft Authenticator or Google Authenticator). Scan the code below with the app, then enter the 6-digit code it shows.'));
      QM.call('auth.mfaEnroll', {}).then(function (res) {
        if (!res.ok) { showMessage(msg, res.message, 'danger'); return; }
        factorId = res.factorId;
        // Supabase returns the QR code as SVG text, sometimes behind an XML prologue and a
        // "<!-- Generated by SVGo -->" comment, sometimes as an unencoded data: URL. Whatever the wrapper,
        // keep the <svg>…</svg> part and show it through <img>, which never runs scripts.
        var qr = typeof res.qrCode === 'string' ? res.qrCode.trim() : '';
        if (qr.indexOf('data:image/svg+xml') === 0 && qr.indexOf('<') !== -1) qr = qr.slice(qr.indexOf(',') + 1);
        var svgAt = qr.indexOf('data:') === 0 ? -1 : qr.search(/<svg[\s>]/i);
        if (svgAt !== -1) qr = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(qr.slice(svgAt));
        if (qr.indexOf('data:image/svg+xml') === 0) {
          var img = document.createElement('img');
          img.src = qr; img.alt = 'QR code for your authenticator app';
          img.style.width = '200px'; img.style.height = '200px'; img.style.display = 'block'; img.style.margin = '8px auto';
          host.appendChild(img);
        }
        host.appendChild(QM.el('p', 'soft', 'Cannot scan? Enter this key in the app instead:'));
        var key = QM.el('p', 'mono', String(res.secret || '').replace(/(.{4})/g, '$1 ').trim());
        key.style.userSelect = 'all';
        host.appendChild(key);
        askCode();
      });
    }

    function verify() {
      var c = code.value.replace(/\D/g, '');
      if (c.length !== 6) { showMessage(msg, 'Enter the 6-digit code from the app.', 'danger'); code.focus(); return; }
      busyButton(submit, true, 'Verify and sign in', 'Checking…');
      QM.call('auth.mfaVerify', { factorId: factorId, code: c }).then(function (res) {
        busyButton(submit, false, 'Verify and sign in');
        code.value = '';
        if (!res.ok) { showMessage(msg, res.message, 'danger'); code.focus(); return; }
        enterPortal(res, msg);
      });
    }
    submit.onclick = verify;
    code.onkeydown = function (ev) { if (ev.key === 'Enter') verify(); };
  }

  /* ------------------------------------------- set / reset: ask for code */
  function renderResetRequest(host, footer, presetEmail) {
    QM.clear(host);
    footer.style.display = 'none';
    var msg = QM.el('div');
    host.appendChild(msg);
    host.appendChild(QM.el('p', 'soft',
      'First time, or forgot your password? We email a 6-digit code to your work address.'));
    var email = emailInput(presetEmail);
    host.appendChild(QM.field('Work email', email));
    var submit = QM.el('button', 'btn block', 'Email me a code');
    host.appendChild(submit);
    host.appendChild(linkRow('Back to staff sign-in', function () { renderStaffSignIn(host, footer, email.value.trim()); }));

    function send() {
      var e = email.value.trim();
      if (!e) { showMessage(msg, 'Enter your work email.', 'danger'); return; }
      busyButton(submit, true, 'Email me a code', 'Sending…');
      QM.call('auth.staffResetStart', { email: e }).then(function (res) {
        busyButton(submit, false, 'Email me a code');
        if (!res.ok) { showMessage(msg, res.message, 'danger'); return; }
        renderResetFinish(host, footer, e, res);
      });
    }
    submit.onclick = send;
    email.onkeydown = function (ev) { if (ev.key === 'Enter') send(); };
    email.focus();
  }

  /* ------------------------------------- set / reset: code + new password */
  function renderResetFinish(host, footer, email, sent) {
    QM.clear(host);
    var msg = QM.el('div');
    host.appendChild(msg);
    showMessage(msg, sent.message, 'ok');

    var code = QM.input('tel', '', '••••••');
    code.className = 'code-input';
    code.maxLength = 10;
    code.setAttribute('inputmode', 'numeric');
    code.setAttribute('autocomplete', 'one-time-code');
    host.appendChild(QM.field('Code from the email', code));

    var pw1 = passwordInput('new-password');
    host.appendChild(QM.field('New password', pw1, PASSWORD_HINT));
    var pw2 = passwordInput('new-password');
    host.appendChild(QM.field('Repeat the new password', pw2));

    var submit = QM.el('button', 'btn block', 'Set password and sign in');
    host.appendChild(submit);

    var resendRow = QM.el('div', 'center mt small');
    var resend = QM.el('a', 'muted', '');
    resend.href = '#';
    resendRow.appendChild(resend);
    host.appendChild(resendRow);
    var seconds = sent.cooldownSeconds || 60;
    var timer = setInterval(tick, 1000);
    function tick() {
      seconds--;
      if (seconds <= 0) { clearInterval(timer); resend.textContent = 'Email me a new code'; resend.style.pointerEvents = 'auto'; resend.classList.remove('muted'); }
      else resend.textContent = 'Email me a new code in ' + seconds + 's';
    }
    resend.textContent = 'Email me a new code in ' + seconds + 's';
    resend.style.pointerEvents = 'none';
    resend.onclick = function (e) {
      e.preventDefault();
      clearInterval(timer);
      QM.call('auth.staffResetStart', { email: email }).then(function (res) {
        if (res.ok) renderResetFinish(host, footer, email, res);
        else showMessage(msg, res.message, 'danger');
      });
    };
    host.appendChild(linkRow('Back to staff sign-in', function () { clearInterval(timer); renderStaffSignIn(host, footer, email); }));

    function finish() {
      var c = code.value.replace(/\D/g, '');
      if (c.length < 6) { showMessage(msg, 'Enter the code from the email.', 'danger'); code.focus(); return; }
      if (!pw1.value) { showMessage(msg, 'Choose a new password.', 'danger'); pw1.focus(); return; }
      if (pw1.value !== pw2.value) { showMessage(msg, 'The two passwords are not the same.', 'danger'); pw2.value = ''; pw2.focus(); return; }
      busyButton(submit, true, 'Set password and sign in', 'Saving…');
      QM.call('auth.staffResetFinish', { email: email, code: c, password: pw1.value }).then(function (res) {
        busyButton(submit, false, 'Set password and sign in');
        if (!res.ok) { showMessage(msg, res.message, 'danger'); return; }
        clearInterval(timer);
        pw1.value = ''; pw2.value = '';
        if (res.mfaRequired) { renderMfa(host, footer, res); return; }
        enterPortal(res, msg);
      });
    }
    submit.onclick = finish;
    pw2.onkeydown = function (ev) { if (ev.key === 'Enter') finish(); };
    code.focus();
  }
})();
