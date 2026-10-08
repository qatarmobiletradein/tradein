/*
 * qm-transport.js — the API client layer for the UNCHANGED 3.1 frontend.
 *
 * The 3.1 screens call the server through exactly one function:
 *   google.script.run.withSuccessHandler(..).withFailureHandler(..).apiCall(token, action, params)
 * (Client.html, send()). This file provides that same interface on top of
 * the Railway API, so no screen, no business logic and no design changes.
 *
 * Switchable: with window.QM_TRANSPORT.mode === 'apps-script' this file
 * does nothing and the real google.script.run (inside Apps Script) is used.
 * With 'railway' every call becomes an HTTPS request:
 *   auth.start / verify / register / logout / logoutAll → POST {api}/v1/auth/...
 *   auth.staffLogin / staffResetStart / staffResetFinish → POST {api}/v1/auth/staff/...
 *   everything else                                     → POST {api}/v1/actions/<action>
 * with  Authorization: Bearer <Supabase access token>
 * and   Idempotency-Key: <the key 3.1 already generates for money actions>.
 *
 * The browser holds ONLY: the API base URL and the user's own Supabase
 * session tokens (sessionStorage, as 3.1 did with its session token). No
 * service key, no anon key and no business rule is in this file.
 */
(function () {
  'use strict';
  var cfg = window.QM_TRANSPORT || { mode: 'apps-script' };
  if (cfg.mode !== 'railway') return;

  var API = String(cfg.apiBase || '').replace(/\/+$/, '');
  var AUTH_ROUTES = {
    'auth.start': '/v1/auth/start', 'auth.verify': '/v1/auth/verify', 'auth.register': '/v1/auth/register',
    'auth.logout': '/v1/auth/logout', 'auth.logoutAll': '/v1/auth/logout-all',
    // Staff email + password (qm-staff-signin.js).
    'auth.staffLogin': '/v1/auth/staff/login', 'auth.staffResetStart': '/v1/auth/staff/reset/start',
    'auth.staffResetFinish': '/v1/auth/staff/reset/finish',
    // Authenticator-app step (SUPER_ADMIN): sent with the session the password step returned.
    'auth.mfaStatus': '/v1/auth/mfa/status', 'auth.mfaEnroll': '/v1/auth/mfa/enroll', 'auth.mfaVerify': '/v1/auth/mfa/verify'
  };
  var REFRESH_KEY = 'qm.refresh';
  // The client keeps its own copy of the access token; after a refresh we
  // map the stale one to the fresh one so the screens need not change.
  var replaced = {};

  function store(key, value) {
    try { if (value) sessionStorage.setItem(key, value); else sessionStorage.removeItem(key); } catch (e) { /* in-memory only */ }
  }
  function read(key) { try { return sessionStorage.getItem(key); } catch (e) { return null; } }

  function post(path, body, token, idemKey) {
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (idemKey) headers['Idempotency-Key'] = idemKey;
    return fetch(API + path, {
      method: 'POST', headers: headers, body: JSON.stringify(body || {}),
      credentials: 'omit', mode: 'cors', cache: 'no-store', redirect: 'error'
    }).then(function (res) {
      return res.json().then(function (json) { return { status: res.status, body: json }; },
        function () { return { status: res.status, body: { ok: false, message: 'The server sent an unexpected reply.' } }; });
    });
  }

  function refresh() {
    var rt = read(REFRESH_KEY);
    if (!rt) return Promise.resolve(null);
    return post('/v1/auth/refresh', { refreshToken: rt }).then(function (r) {
      if (r.status === 200 && r.body && r.body.ok && r.body.token) {
        store(REFRESH_KEY, r.body.refreshToken);
        store('qm.token', r.body.token);
        return r.body.token;
      }
      store(REFRESH_KEY, null);
      return null;
    }, function () { return null; });
  }

  function apiCall(token, action, params) {
    var p = params && typeof params === 'object' ? Object.assign({}, params) : {};
    var key = p.idempotencyKey || '';
    delete p.idempotencyKey;
    var current = replaced[token] || token || '';
    var path = AUTH_ROUTES[action] || ('/v1/actions/' + encodeURIComponent(action));
    var body = AUTH_ROUTES[action] ? p : { params: p };

    return post(path, body, current, key).then(function (r) {
      // An expired access token: refresh once, retry once, with the same idempotency key.
      if (r.status === 401 && current && !AUTH_ROUTES[action]) {
        return refresh().then(function (fresh) {
          if (!fresh) return r.body;
          replaced[token] = fresh;
          return post(path, body, fresh, key).then(function (r2) { return r2.body; });
        });
      }
      if (r.body && r.body.refreshToken) store(REFRESH_KEY, r.body.refreshToken);
      if (action === 'auth.logout' || action === 'auth.logoutAll') store(REFRESH_KEY, null);
      return r.body;
    });
  }

  function runner() {
    var ok = function () {}; var fail = function () {};
    var api = {
      withSuccessHandler: function (fn) { ok = fn; return api; },
      withFailureHandler: function (fn) { fail = fn; return api; },
      apiCall: function (token, action, params) {
        apiCall(token, action, params).then(function (res) { ok(res); }, function (err) { fail(err); });
      }
    };
    return api;
  }

  window.google = window.google || {};
  window.google.script = window.google.script || {};
  // A new runner per access, exactly like google.script.run's builder.
  Object.defineProperty(window.google.script, 'run', { get: runner, configurable: true });
  window.QM_TRANSPORT_INFO = { mode: 'railway', apiBase: API };
})();
