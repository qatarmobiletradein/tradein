#!/usr/bin/env node
/**
 * Build the static frontend from the UNCHANGED 3.1 HTML (apps/web/legacy).
 *
 *   QM_TRANSPORT=railway QM_API_BASE=https://api.example.com node apps/web/build.mjs
 *   QM_TRANSPORT=apps-script node apps/web/build.mjs   (no shim: for comparison only)
 *
 * It does what 23_Router.gs doGet did on the server: inline the partials
 * into Shell.html and print the boot object. It also injects the transport
 * (qm-transport.js) before Client.html so google.script.run is served by
 * the Railway API. Output: dist/web/index.html. It verifies the legacy
 * sources against LEGACY_SOURCES.sha256 so an accidental edit is caught.
 *
 * Only BROWSER-SAFE values are embedded: the API base URL and display
 * strings. No key of any kind.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { navIconCss } from './qm-icons.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const legacy = join(here, 'legacy');
const mode = process.env.QM_TRANSPORT === 'apps-script' ? 'apps-script' : 'railway';
const apiBase = process.env.QM_API_BASE ?? '';
// Must match the API's STAFF_SIGN_IN (staging/production: password).
const staffSignIn = (process.env.QM_STAFF_SIGN_IN ?? 'password').toLowerCase();
if (!['password', 'phone', 'both'].includes(staffSignIn)) { console.error('QM_STAFF_SIGN_IN must be password, phone or both.'); process.exit(2); }
if (mode === 'railway' && !/^https:\/\/[^\s"'<>]+$/.test(apiBase) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(apiBase)) {
  console.error('Set QM_API_BASE to the https:// origin of the Railway API (or http://localhost for development).');
  process.exit(2);
}

// 1. The legacy sources must be exactly the 3.1 files.
for (const line of readFileSync(join(here, 'LEGACY_SOURCES.sha256'), 'utf8').trim().split('\n')) {
  const [sum, name] = line.trim().split(/\s+/);
  const actual = createHash('sha256').update(readFileSync(join(legacy, name))).digest('hex');
  if (actual !== sum) { console.error(`${name} differs from the 3.1 source (checksum mismatch). Refusing to build.`); process.exit(3); }
}

// 2. Same escaping as jsonForScript_ (00b_Security.gs).
const LS = String.fromCharCode(0x2028); const PS = String.fromCharCode(0x2029);
const jsonForScript = (v) => JSON.stringify(v).replace(new RegExp(`[<>&'${LS}${PS}]`, 'g'), (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

const PARTIALS = ['BrandAssets', 'Styles', 'StylesCustomer', 'Client', 'Frame', 'Auth', 'PortalCustomer', 'PortalCustomerFlow', 'PortalTechnician', 'PortalVendor', 'PortalAdmin'];
const PAGE_ALLOWLIST = ['app', 'a-home', 'a-tradeins', 'a-collections', 'a-settlements', 'a-reports', 'a-audit', 'a-vendors', 'a-branches', 'a-commission',
  'a-brands', 'a-categories', 'a-products', 'a-pricing', 'a-grades', 'a-inspection', 'a-import', 'a-customers', 'a-staff', 'a-settings',
  'c-home', 'c-new', 'c-orders', 'c-detail', 'c-profile', 't-queue', 't-offers', 't-receive', 't-returns',
  'v-home', 'v-queue', 'v-vouchers', 'v-branches', 'v-staff', 'v-settlements', 'v-reports'];

const bootStatic = {
  platform: 'Qatar Mobile', currency: 'QAR', countryCode: '+974', baseUrl: '',
  testMode: false, environment: (process.env.QM_ENVIRONMENT_LABEL ?? 'PRODUCTION').toUpperCase(),
  version: '4.2.0', versionLabel: 'Qatar Mobile Trade-In',
};

let html = readFileSync(join(legacy, 'Shell.html'), 'utf8');

// The boot object, with the requested page checked against the same allow-list as safePage_.
const bootScript = `<script>
window.QM_TRANSPORT = ${jsonForScript({ mode, apiBase, staffSignIn })};
window.__QM_BOOT__ = (function () {
  var b = ${jsonForScript(bootStatic)};
  var allow = ${jsonForScript(PAGE_ALLOWLIST)};
  var m = /[?&]page=([^&#]*)/.exec(location.search);
  var page = m ? decodeURIComponent(m[1]) : 'app';
  b.requestedPage = allow.indexOf(page) > -1 ? page : 'app';
  return b;
})();
</script>
<script>
${readFileSync(join(here, 'qm-transport.js'), 'utf8')}
</script>`;
// The transport must exist before Client.html runs.
html = html.replace('<?!= partials.Client ?>', () => `${bootScript}\n<?!= partials.Client ?>`);
// Staff email + password: added right AFTER the unchanged Auth.html (it wraps buildAuthScreen).
if (mode === 'railway') {
  html = html.replace('<?!= partials.Auth ?>', () => `<?!= partials.Auth ?>\n<script>\n${readFileSync(join(here, 'qm-staff-signin.js'), 'utf8')}\n</script>`);
}
for (const p of PARTIALS) html = html.replace(`<?!= partials.${p} ?>`, () => readFileSync(join(legacy, `${p}.html`), 'utf8'));
html = html.replace('QM.boot(<?!= boot ?>);', 'QM.boot(window.__QM_BOOT__);');
// Visual fixes over the unchanged 3.1 styles, last in the page so they apply.
html = html.replace('</body>', () => `<style>\n${readFileSync(join(here, 'qm-overrides.css'), 'utf8')}\n${navIconCss()}\n</style>\n<script>\n${readFileSync(join(here, 'qm-ui.js'), 'utf8')}\n</script>\n<script>\n${readFileSync(join(here, 'qm-flow.js'), 'utf8')}\n</script>\n<script>\n${readFileSync(join(here, 'qm-import.js'), 'utf8')}\n</script>\n<script>\n${readFileSync(join(here, 'qm-commission.js'), 'utf8')}\n</script>\n<script>\n${readFileSync(join(here, 'qm-imei.js'), 'utf8')}\n</script>\n</body>`);
html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n  <title>Qatar Mobile Trade-In</title>');
if (/<\?!?=/.test(html)) { console.error('Unresolved template tag left in the output.'); process.exit(4); }

const out = resolve('dist/web');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'index.html'), html);
console.log(JSON.stringify({ output: join(out, 'index.html'), mode, apiBase, staffSignIn, bytes: Buffer.byteLength(html) }));
