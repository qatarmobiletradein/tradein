/**
 * qm-web caching (owner report 2026-10-11): the page is revalidated on every load, /version.json is never
 * cached, a back/forward-cached page reloads, and the camera/vendor/CSP rules stay as they were.
 * Starts the real server.mjs on a free port against the built page.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let proc: ChildProcess; const port = 18000 + Math.floor(Math.random() * 1000);
const url = (p: string) => `http://127.0.0.1:${port}${p}`;

beforeAll(async () => {
  execFileSync('node', ['apps/web/build.mjs'], { env: { ...process.env, QM_API_BASE: 'https://api.example.test', QM_TRANSPORT: 'railway' }, stdio: 'pipe' });
  proc = spawn('node', ['apps/web/server.mjs'], { env: { ...process.env, PORT: String(port), QM_API_BASE: 'https://api.example.test' }, stdio: 'pipe' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(url('/health'))).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('qm-web did not start');
});
afterAll(() => { proc?.kill(); });

describe('qm-web caching', () => {
  it('the page carries an ETag, must be revalidated, and answers 304 when unchanged', async () => {
    const r = await fetch(url('/'));
    expect(r.headers.get('cache-control')).toBe('no-cache, must-revalidate');
    const etag = r.headers.get('etag')!;
    expect(etag).toMatch(/^"[0-9a-f]{12}"$/);
    const again = await fetch(url('/'), { headers: { 'if-none-match': etag } });
    expect(again.status).toBe(304);
  });
  it('/version.json is never cached and names the same build as the page', async () => {
    const page = await fetch(url('/'));
    const v = await fetch(url('/version.json'));
    expect(v.headers.get('cache-control')).toContain('no-store');
    expect(`"${((await v.json()) as { build: string }).build}"`).toBe(page.headers.get('etag'));
  });
  it('the page may call its own origin (version check) and still nothing else but the API', async () => {
    const csp = (await fetch(url('/'))).headers.get('content-security-policy')!;
    expect(csp).toContain("connect-src 'self' https://api.example.test");
    const html = await (await fetch(url('/'))).text();
    expect(html).toContain("/version.json");
    expect(html).toContain("e.persisted");
  });
  it('catalogue images are revalidated within the hour', async () => {
    const r = await fetch(url('/catalog/iphone-15.webp'));
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('public, max-age=3600, stale-while-revalidate=86400');
  });
});
