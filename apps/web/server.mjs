#!/usr/bin/env node
/**
 * Static server for the built frontend (dist/web/index.html) on Railway.
 * No dependencies. Serves the single page for "/" (and any extension-less
 * path), /health for the platform, 404 for everything else.
 *
 * Security headers: HSTS, nosniff, no framing, strict referrer, and a CSP
 * that lets the page talk ONLY to the API origin(s) baked into the build
 * and load images only from itself, data:/blob: and Supabase Storage.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', '..', 'dist', 'web', 'index.html'));
const gz = gzipSync(html, { level: 9 });
const origin = (u) => { try { return new URL(u).origin; } catch { return ''; } };
const apiOrigins = (process.env.QM_API_BASE ?? '').split(',').map(origin).filter(Boolean);
const storage = origin(process.env.QM_STORAGE_ORIGIN ?? '');

const csp = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",           // the 3.1 page is one file with inline scripts
  "style-src 'unsafe-inline'",
  `img-src 'self' data: blob:${storage ? ` ${storage}` : ''}`,
  "font-src data:",
  `connect-src ${apiOrigins.join(' ') || "'none'"}`,
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'", "object-src 'none'",
].join('; ');
const common = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD', ...common }); res.end(); return; }
  if (path === '/health') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...common }); res.end(req.method === 'HEAD' ? undefined : '{"ok":true,"service":"qm-web"}'); return; }
  if (path !== '/' && path !== '/index.html' && /\.[a-z0-9]+$/i.test(path)) { res.writeHead(404, { 'Content-Type': 'text/plain', ...common }); res.end('Not found'); return; }
  const useGz = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
  const body = useGz ? gz : html;
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Security-Policy': csp,
    'Vary': 'Accept-Encoding', ...(useGz ? { 'Content-Encoding': 'gzip' } : {}), 'Content-Length': String(body.length), ...common,
  });
  res.end(req.method === 'HEAD' ? undefined : body);
});
const port = Number(process.env.PORT) || 8080;
server.listen(port, '0.0.0.0', () => console.log(JSON.stringify({ msg: 'qm-web listening', port, api: apiOrigins })));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
