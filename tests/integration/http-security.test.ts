/**
 * HTTP-level controls: health/readiness, secure headers, CORS allow-list,
 * body limits, generic errors, request ids, no secrets in responses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HAS_DB } from '../helpers/db.js';
import { createTestApp, type TestApp } from '../helpers/app.js';

describe.skipIf(!HAS_DB)('HTTP security controls', () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp({ BODY_LIMIT_BYTES: '16384' }); });
  afterAll(async () => { await t?.close(); });

  it('GET /health and GET /ready', async () => {
    const h = await t.app.inject({ method: 'GET', url: '/health' });
    expect(h.statusCode).toBe(200);
    expect(h.json()).toMatchObject({ ok: true });
    const r = await t.app.inject({ method: 'GET', url: '/ready' });
    expect(r.statusCode).toBe(200);
    expect(r.json().checks.database).toBe(true);
  });

  it('secure headers on every response', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/health' });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(String(r.headers['content-security-policy'])).toContain("default-src 'none'");
    expect(r.headers['x-frame-options']).toBeDefined();
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-request-id']).toBeTruthy();
  });

  it('CORS: the allow-listed origin is echoed; others are not', async () => {
    const okO = await t.app.inject({ method: 'OPTIONS', url: '/v1/actions/me.context', headers: { origin: 'https://app.example.test', 'access-control-request-method': 'POST' } });
    expect(okO.headers['access-control-allow-origin']).toBe('https://app.example.test');
    const bad = await t.app.inject({ method: 'OPTIONS', url: '/v1/actions/me.context', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('oversized and malformed bodies get a sentence, not a stack trace', async () => {
    const big = await t.app.inject({ method: 'POST', url: '/v1/auth/start', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ phone: 'x'.repeat(40_000) }) });
    expect(big.statusCode).toBe(413);
    expect(big.json()).toMatchObject({ ok: false, message: 'That upload is too large.' });
    const bad = await t.app.inject({ method: 'POST', url: '/v1/auth/start', headers: { 'content-type': 'application/json' }, payload: '{"phone":' });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toMatch(/at \w+ \(|node_modules|SyntaxError/);
  });

  it('validation errors are generic; unknown routes are 404 JSON', async () => {
    const tok = await t.tokenFor('CUS-00001');
    const r = await t.call('customer.tradeIn', tok, { tradeInId: { $ne: 1 } });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('Some of the information sent was not valid. Please check it and try again.');
    const nf = await t.app.inject({ method: 'GET', url: '/nope' });
    expect(nf.statusCode).toBe(404);
  });

  it('a caller-supplied request id is propagated only when well-formed', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'req-12345678' } });
    expect(r.headers['x-request-id']).toBe('req-12345678');
    const r2 = await t.app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': '<script>' } });
    expect(r2.headers['x-request-id']).not.toBe('<script>');
  });

  it('sign-in actions are not reachable through the compatibility endpoint (only /v1/auth/* with its stricter limit)', async () => {
    const via = await t.app.inject({ method: 'POST', url: '/v1/actions/auth.verify', payload: { params: { phone: '30000010', code: '123456' } } });
    const unknown = await t.app.inject({ method: 'POST', url: '/v1/actions/no.such.action', payload: { params: {} } });
    expect(via.statusCode).toBe(unknown.statusCode);
    expect(via.json().message).toBe(unknown.json().message);
  });

  it('a spoofed X-Forwarded-For does not escape the per-IP auth rate limit', async () => {
    const t2 = await createTestApp({ AUTH_RATE_LIMIT_MAX: '3' });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await t2.app.inject({
          method: 'POST', url: '/v1/auth/start', payload: { phone: '30000099' },
          // The client controls the left part; only the hop added by the trusted proxy counts.
          headers: { 'x-forwarded-for': `10.0.0.${i}, 203.0.113.7` },
        });
        codes.push(r.statusCode);
      }
      expect(codes.slice(0, 3).every((c) => c !== 429)).toBe(true);
      expect(codes.slice(3)).toEqual([429, 429]);
    } finally { await t2.close(); }
  });
});
