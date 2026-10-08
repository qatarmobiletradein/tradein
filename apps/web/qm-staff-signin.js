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
  if (cfg.mode !== 'railway' || cfg.staffSignIn !== 'password') return;
  if (typeof window.buildAuthScreen !== 'function') return;

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
      host.appendChild(QM.el('p', 'soft',
        'Once somebody has approved you, choose “Staff sign-in”, then “Set or reset password” with the work email you gave.'));
      var back = QM.el('button', 'btn secondary block', 'Back to sign in');
      back.onclick = function () { window.buildAuthScreen(); };
      host.appendChild(back);
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
