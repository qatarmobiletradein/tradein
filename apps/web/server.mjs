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
import { readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// Browser-tab icons (the Qatar Mobile mark from the 3.1 brand assets). The <link> tags are added here,
// at serve time, so the hash-checked legacy sources stay unchanged.
const ICON_LINKS = '<link rel="icon" href="/favicon.ico" sizes="any"><link rel="icon" href="/favicon.svg" type="image/svg+xml">'
  + '<link rel="apple-touch-icon" href="/apple-touch-icon.png">';
const icons = Object.fromEntries([
  ['/favicon.ico', 'image/x-icon'], ['/favicon.svg', 'image/svg+xml'], ['/apple-touch-icon.png', 'image/png'],
].map(([p, type]) => [p, { type, body: readFileSync(join(here, 'icons', p.slice(1))) }]));
// Catalogue product images (apps/web/catalog/*.webp, official manufacturer renders normalized to one
// frame — see catalog/SOURCES.json). Only files present at start-up are served; names are fixed slugs.
const catalogDir = join(here, 'catalog');
const catalog = new Map();
try {
  for (const name of readdirSync(catalogDir)) {
    if (/^[a-z0-9-]+\.webp$/.test(name)) catalog.set(`/catalog/${name}`, readFileSync(join(catalogDir, name)));
  }
} catch { /* no catalogue images in this build */ }
// Vendored browser libraries (apps/web/vendor/*.min.js, pinned versions, see vendor/README.md), loaded on
// demand from this origin only — e.g. the barcode decoder for "Scan IMEI" when the browser has none built in.
const vendor = new Map();
try {
  for (const name of readdirSync(join(here, 'vendor'))) {
    if (/^[a-z0-9.-]+\.min\.js$/.test(name)) vendor.set(`/vendor/${name}`, readFileSync(join(here, 'vendor', name)));
  }
} catch { /* no vendored libraries in this build */ }
// Download templates (apps/web/templates/*.xlsx), e.g. the Bulk import reference template.
const templates = new Map();
try {
  for (const name of readdirSync(join(here, 'templates'))) {
    if (/^[a-z0-9-]+\.xlsx$/.test(name)) templates.set(`/templates/${name}`, { name, body: readFileSync(join(here, 'templates', name)) });
  }
} catch { /* none in this build */ }
const page = readFileSync(join(here, '..', '..', 'dist', 'web', 'index.html'), 'utf8');
const html = Buffer.from(page.includes('</head>') ? page.replace('</head>', `${ICON_LINKS}</head>`) : page);
const gz = gzipSync(html, { level: 9 });
const origin = (u) => { try { return new URL(u).origin; } catch { return ''; } };
const apiOrigins = (process.env.QM_API_BASE ?? '').split(',').map(origin).filter(Boolean);
const storage = origin(process.env.QM_STORAGE_ORIGIN ?? '');
// Product image URLs are absolute (https://qmtradein.com/catalog/...); the page may be opened on
// www. or the Railway domain too, so that origin is allowed for images explicitly.
const catalogOrigins = (process.env.QM_CATALOG_ORIGIN ?? '').split(',').map(origin).filter(Boolean);
const imgSources = ["'self'", 'data:', 'blob:', storage, ...catalogOrigins].filter(Boolean);

const csp = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'self'",    // the 3.1 page is one file with inline scripts; 'self' = /vendor/*.min.js
  "style-src 'unsafe-inline'",
  `img-src ${[...new Set(imgSources)].join(' ')}`,
  "font-src data:",
  `connect-src ${apiOrigins.join(' ') || "'none'"}`,
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'", "object-src 'none'",
].join('; ');
const common = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // camera=(self): "Scan IMEI" reads barcodes with the device camera, on this page only.
  'Permissions-Policy': 'camera=(self), geolocation=(), microphone=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD', ...common }); res.end(); return; }
  if (path === '/health') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...common }); res.end(req.method === 'HEAD' ? undefined : '{"ok":true,"service":"qm-web"}'); return; }
  const icon = icons[path];
  if (icon) {
    res.writeHead(200, { 'Content-Type': icon.type, 'Cache-Control': 'public, max-age=86400', 'Content-Length': String(icon.body.length), ...common });
    res.end(req.method === 'HEAD' ? undefined : icon.body); return;
  }
  const image = catalog.get(path);
  if (image) {
    res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=604800', 'Content-Length': String(image.length), ...common });
    res.end(req.method === 'HEAD' ? undefined : image); return;
  }
  const lib = vendor.get(path);
  if (lib) {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Length': String(lib.length), ...common });
    res.end(req.method === 'HEAD' ? undefined : lib); return;
  }
  const tpl = templates.get(path);
  if (tpl) {
    res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${tpl.name}"`, 'Cache-Control': 'no-cache', 'Content-Length': String(tpl.body.length), ...common });
    res.end(req.method === 'HEAD' ? undefined : tpl.body); return;
  }
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
