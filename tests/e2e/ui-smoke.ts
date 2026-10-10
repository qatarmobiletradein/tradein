/**
 * Browser smoke test of the UNCHANGED 3.1 frontend running on the Railway
 * API through qm-transport.js, in headless Chromium.
 *
 * Run A — STAFF_SIGN_IN=phone (3.1 behaviour):
 *   customer signs in with an OTP → customer portal renders, lists trade-ins;
 *   finance (QM_ADMIN) signs in → admin portal (sidebar) renders;
 *   branch manager signs in → partner portal (sidebar) renders.
 * Run B — STAFF_SIGN_IN=password (staging/production):
 *   customer still signs in with an OTP;
 *   a staff number on the phone screen is told to use staff sign-in;
 *   finance sets a first password with the e-mailed code → admin portal;
 *   branch manager signs in with email + password → partner portal;
 *   a wrong password shows the generic sentence.
 * Everything is local: throwaway PostgreSQL, test SMS provider, Supabase
 * Auth stub. Run: npm run test:ui
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { setup } from '../helpers/global-setup.js';
import { createTestApp } from '../helpers/app.js';
import { actors, submit } from '../helpers/flow.js';
import { settleBackgroundWork } from '../../apps/api/src/services/staff-auth.js';
import { totp } from '../helpers/totp.js';

const require = createRequire(import.meta.url);
// The browser ships with the environment (PLAYWRIGHT_BROWSERS_PATH); the library is resolved from the global install.
// Playwright is not a project dependency, so only the few calls used here are typed.
interface PwLocator { first(): PwLocator; last(): PwLocator; nth(i: number): PwLocator; fill(v: string): Promise<void>; click(o?: { timeout?: number }): Promise<void>; waitFor(o?: { timeout?: number }): Promise<void>;
  setInputFiles(f: { name: string; mimeType: string; buffer: Buffer }): Promise<void>; getAttribute(n: string): Promise<string | null>; innerText(): Promise<string> }
interface PwPage {
  on(ev: 'pageerror', fn: (e: Error) => void): void; on(ev: 'console', fn: (m: { type(): string; text(): string }) => void): void;
  on(ev: 'request', fn: (r: { url(): string }) => void): void; addInitScript(script: string): Promise<void>;
  evaluate<T = unknown>(fn: string): Promise<T>;
  goto(url: string): Promise<unknown>; locator(sel: string, o?: never): PwLocator; getByRole(role: string, o: { name: string }): PwLocator;
  waitForTimeout(ms: number): Promise<void>; screenshot(o: { path: string; fullPage?: boolean }): Promise<unknown>;
}
interface PwBrowser { newContext(): Promise<{ newPage(): Promise<PwPage>; close(): Promise<void> }>; close(): Promise<void> }
const { chromium } = require(process.env.QM_PLAYWRIGHT ?? '/opt/npm-tools/node_modules/playwright') as { chromium: { launch(): Promise<PwBrowser> } };

const STAFF_PORTAL = 'aside.sidebar';
const results: string[] = [];
const errors: string[] = [];

async function serve(mode: 'phone' | 'password' | 'both') {
  const web = createServer();
  await new Promise<void>((r) => web.listen(0, '127.0.0.1', () => r()));
  const webOrigin = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
  const t = await createTestApp({ CORS_ALLOWED_ORIGINS: webOrigin, STAFF_SIGN_IN: mode, ...(mode !== 'phone' ? { STAFF_MFA_ROLES: 'SUPER_ADMIN' } : {}) });
  await t.app.listen({ host: '127.0.0.1', port: 0 });
  const apiBase = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  execFileSync('node', ['apps/web/build.mjs'], { env: { ...process.env, QM_API_BASE: apiBase, QM_TRANSPORT: 'railway', QM_ENVIRONMENT_LABEL: 'TEST', QM_STAFF_SIGN_IN: mode }, stdio: 'pipe' });
  const page = readFileSync('dist/web/index.html');
  web.on('request', (req, res) => {
    const m = /^\/vendor\/([a-z0-9.-]+\.min\.js)$/.exec(req.url ?? '');
    if (m) { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(readFileSync(`apps/web/vendor/${m[1]}`)); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page);
  });
  return { t, web, webOrigin };
}

function watch(p: PwPage, label: string) {
  p.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error' && !/favicon|status of 4\d\d/.test(m.text())) errors.push(`${label} console: ${m.text()}`); });
}

async function main(): Promise<void> {
  await setup();
  mkdirSync('tests/e2e/artifacts', { recursive: true });
  const browser = await chromium.launch();
  try {
    await runPhoneMode(browser);
    await runPasswordMode(browser);
    await runBothMode(browser);
    await runImeiMode(browser);
  } finally {
    await browser.close();
  }
  for (const r of results) console.log(r);
  if (errors.length) { console.log('BROWSER ERRORS:'); for (const e of errors) console.log(`  ${e}`); process.exitCode = 1; }
  if (results.length !== 27) process.exitCode = 1;
}

async function runPhoneMode(browser: PwBrowser): Promise<void> {
  const { t, web, webOrigin } = await serve('phone');

  const a = await actors(t);
  await submit(t, a.customer);
  try {
    const signIn = async (localPhone: string, e164: string, expectSelector: string, label: string) => {
      const ctx = await browser.newContext();
      const p = await ctx.newPage();
      watch(p, label);
      await p.goto(webOrigin);
      await p.locator('input[type=tel]').first().fill(localPhone);
      await p.getByRole('button', { name: 'Send code' }).click();
      await p.locator('input.code-input').waitFor({ timeout: 10_000 });
      const code = t.sms.lastCodeFor(e164);
      if (!code) throw new Error(`${label}: no code was delivered`);
      await p.locator('input.code-input').fill(code);
      // The 3.1 screen submits by itself once six digits are typed; press the button only if it is still there.
      await p.getByRole('button', { name: 'Sign in' }).click({ timeout: 1500 }).catch(() => undefined);
      await p.locator(expectSelector).first().waitFor({ timeout: 15_000 });
      await p.waitForTimeout(1500);
      await p.screenshot({ path: `tests/e2e/artifacts/${label}.png`, fullPage: false });
      results.push(`PASS phone-mode ${label}: signed in with OTP and the portal rendered (${expectSelector})`);
      await ctx.close();
    };
    await signIn('30000010', '+97430000010', '.cx', 'customer');
    await signIn('30000002', '+97430000002', STAFF_PORTAL, 'finance-admin');
    await signIn('30000005', '+97430000005', STAFF_PORTAL, 'branch-manager');
  } finally {
    await t.close();
    web.close();
  }
}

async function runPasswordMode(browser: PwBrowser): Promise<void> {
  const { t, web, webOrigin } = await serve('password');
  await t.deps.pool.query(`update public.app_users set email = lower(id) || '@staff.example.test'`);
  // A second partner with its own branch: the customer must not see it under the first partner.
  await t.deps.pool.query(`insert into public.vendors (id, name, code, status) values ('VND-090', 'Other Partner (test)', 'OTHR', 'ACTIVE')`);
  await t.deps.pool.query(`insert into public.branches (id, vendor_id, name, active, display_order) values ('BR-0090', 'VND-090', 'Other Branch A', true, 1)`);
  const PW = 'Ui-Smoke-Demo-2026';
  try {
    // Customer: unchanged SMS code.
    {
      const ctx = await browser.newContext(); const p = await ctx.newPage(); watch(p, 'pw-customer');
      await p.goto(webOrigin);
      await p.locator('input[type=tel]').first().fill('30000010');
      await p.getByRole('button', { name: 'Send code' }).click();
      await p.locator('input.code-input').waitFor({ timeout: 10_000 });
      await p.locator('input.code-input').fill(t.sms.lastCodeFor('+97430000010')!);
      await p.getByRole('button', { name: 'Sign in' }).click({ timeout: 1500 }).catch(() => undefined);
      await p.locator('.cx').first().waitFor({ timeout: 15_000 });
      results.push('PASS password-mode customer: SMS code sign-in unchanged');
      // The trade-in flow: one progress indicator (the phase rail), line icons, no colour emoji.
      await p.locator('[data-tab="c-new"]').first().click();
      await p.locator('.cx-rail').first().waitFor({ timeout: 10_000 });
      await p.waitForTimeout(500);
      const ev = (fn: string) => (p as unknown as { evaluate(f: string): Promise<unknown> }).evaluate(fn);
      const barShown = await ev(`getComputedStyle(document.querySelector('.cx-progress .bar')).display !== 'none'`);
      const emoji = await ev(`/[\u{1F50D}\u{1F514}\u{1F4F1}\u{1F512}]/u.test(document.body.innerText)`);
      const glyph = await ev(`/[\u2302\uFF0B\u2630\u263A\u263B]/.test([...document.querySelectorAll('.cx-tabs .icon')].map((e) => e.textContent).join('')) && getComputedStyle(document.querySelector('.cx-tabs .icon')).fontSize !== '0px'`);
      await p.screenshot({ path: 'tests/e2e/artifacts/customer-flow.png', fullPage: false });
      if (barShown || emoji || glyph) throw new Error(`flow look: bar=${barShown} emoji=${emoji} glyph=${glyph}`);
      results.push('PASS customer flow: one progress indicator, line icons, no emoji');
      // Partner first, then ONLY that partner's branches, then the catalogue.
      await p.locator('text=Where will you bring your device?').waitFor({ timeout: 10_000 });
      const partners = await ev(`[...document.querySelectorAll('#flow .cx-choice .label')].map((e) => e.textContent)`) as string[];
      if (!partners.includes('Demo Electronics (fictional)') || !partners.includes('Other Partner (test)')) throw new Error(`partners: ${partners}`);
      await p.locator('#flow .cx-choice', { hasText: 'Demo Electronics (fictional)' } as never).first().click();
      await p.locator('text=Which Demo Electronics (fictional) branch?').waitFor({ timeout: 10_000 });
      await p.locator('#flow .cx-choice').first().waitFor({ timeout: 10_000 });
      const branches = (await ev(`[...document.querySelectorAll('#flow .cx-choice .label')].map((e) => e.textContent)`) as string[]).sort();
      await p.screenshot({ path: 'tests/e2e/artifacts/customer-branch-step.png', fullPage: false });
      if (JSON.stringify(branches) !== JSON.stringify(['Demo Mall Branch (fictional)', 'Demo Souq Branch (fictional)'])) throw new Error(`branches: ${branches}`);
      await p.locator('#flow .cx-choice', { hasText: 'Demo Mall Branch (fictional)' } as never).first().click();
      await p.locator('text=What brand is your device?').waitFor({ timeout: 10_000 });
      results.push('PASS customer flow: partner → only that partner\'s branches → catalogue');
      await ctx.close();
    }
    // A staff number on the phone screen: told to use staff sign-in, no code sent.
    {
      const ctx = await browser.newContext(); const p = await ctx.newPage(); watch(p, 'pw-staff-phone');
      await p.goto(webOrigin);
      await p.locator('input[type=tel]').first().fill('30000002');
      await p.getByRole('button', { name: 'Send code' }).click();
      await p.locator('text=Staff accounts sign in with email and password').first().waitFor({ timeout: 10_000 });
      if (t.sms.lastCodeFor('+97430000002')) throw new Error('a code was sent to a staff number');
      results.push('PASS password-mode staff number: told to use staff sign-in, no SMS sent');
      await ctx.close();
    }
    // Finance admin: first password with the e-mailed code, straight into the admin portal.
    {
      const ctx = await browser.newContext(); const p = await ctx.newPage(); watch(p, 'pw-finance-first');
      await p.goto(webOrigin);
      await p.screenshot({ path: 'tests/e2e/artifacts/password-signin-screen.png', fullPage: false });
      await p.locator('text=Staff sign-in (email and password)').click();
      await p.screenshot({ path: 'tests/e2e/artifacts/password-staff-form.png', fullPage: false });
      await p.locator('text=Set or reset password').click();
      await p.locator('input[type=email]').fill('usr-00002@staff.example.test');
      await p.getByRole('button', { name: 'Email me a code' }).click();
      await p.locator('input.code-input').waitFor({ timeout: 10_000 });
      await settleBackgroundWork(); // the e-mail is sent after the reply
      const code = [...t.auth.mail].reverse().find((m) => m.to === 'usr-00002@staff.example.test')?.code;
      if (!code) throw new Error('no reset code was e-mailed');
      await p.locator('input.code-input').fill(code);
      await p.locator('input[type=password]').first().fill(PW);
      await p.locator('input[type=password]').nth(1).fill(PW);
      await p.getByRole('button', { name: 'Set password and sign in' }).click();
      await p.locator(STAFF_PORTAL).first().waitFor({ timeout: 15_000 });
      await p.waitForTimeout(1000);
      await p.screenshot({ path: 'tests/e2e/artifacts/password-finance-admin.png', fullPage: false });
      results.push('PASS password-mode finance admin: first password via e-mailed code → admin portal');
      // Bulk import: the reference template is on the page; an uploaded .xlsx is previewed (nothing written).
      await p.locator('[data-page="a-import"]').first().click();
      await p.locator('[data-qm="template-link"]').waitFor({ timeout: 10_000 });
      const href = await p.locator('[data-qm="template-link"]').getAttribute('href');
      if (href !== '/templates/qm-catalogue-import-template.xlsx') throw new Error(`template link: ${href}`);
      const ExcelJS = (await import('exceljs')).default;
      const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Products');
      ws.addRow(['Brand*', 'Category*', 'Model*', 'Release year', 'Storage options*', 'Colour options', 'Base prices (QAR)']);
      ws.addRow(['Nova', 'Smartphones', 'Nova One', 2025, '128GB, 256GB', 'Black, White', '900, 1100']);
      await p.locator('[data-qm="import-file"]').setInputFiles({ name: 'nova.xlsx', buffer: Buffer.from(await wb.xlsx.writeBuffer()),
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      await p.locator('[data-qm="import-preview"]').click();
      await p.locator('[data-qm="import-summary"]').waitFor({ timeout: 10_000 });
      const summary = await p.locator('[data-qm="import-summary"]').innerText();
      await p.screenshot({ path: 'tests/e2e/artifacts/admin-bulk-import.png', fullPage: true });
      if (!/1 new model/.test(summary) || !/2 new storage/.test(summary)) throw new Error(`import summary: ${summary}`);
      if ((await t.deps.pool.query(`select 1 from public.products where model = 'Nova One'`)).rowCount) throw new Error('preview wrote a product');
      results.push('PASS admin bulk import: template link on the page, .xlsx upload → preview with exact counts, nothing written');
      // Commission: the rule dialog offers "share of the invoice" and shows the Carrefour example (1500 -> 1578.95).
      await p.locator('[data-page="a-commission"]').first().click();
      await p.getByRole('button', { name: 'Add a rule' }).click();
      await p.locator('[data-qm="commission-example"]').waitFor({ timeout: 10_000 });
      const ex = await p.locator('[data-qm="commission-example"]').innerText();
      await p.screenshot({ path: 'tests/e2e/artifacts/admin-commission-rule.png', fullPage: false });
      if (!/1578\.95/.test(ex) || !/78\.95/.test(ex)) throw new Error(`commission example: ${ex}`);
      results.push('PASS admin commission: share-of-invoice rule with the 1500 -> 1578.95 example');
      await ctx.close();
    }
    // Branch manager: password set through the API, then email + password in the browser; a wrong password first.
    {
      await t.app.inject({ method: 'POST', url: '/v1/auth/staff/reset/start', payload: { email: 'usr-00005@staff.example.test' } });
      await settleBackgroundWork();
      const code = [...t.auth.mail].reverse().find((m) => m.to === 'usr-00005@staff.example.test')!.code;
      await t.app.inject({ method: 'POST', url: '/v1/auth/staff/reset/finish', payload: { email: 'usr-00005@staff.example.test', code, password: PW } });
      const ctx = await browser.newContext(); const p = await ctx.newPage(); watch(p, 'pw-branch-manager');
      await p.goto(webOrigin);
      await p.locator('text=Staff sign-in (email and password)').click();
      await p.locator('input[type=email]').fill('usr-00005@staff.example.test');
      await p.locator('input[type=password]').fill('Wrong-password-2026');
      await p.getByRole('button', { name: 'Sign in' }).click();
      await p.locator('text=The email or password is not right.').first().waitFor({ timeout: 10_000 });
      results.push('PASS password-mode wrong password: generic sentence shown');
      await p.locator('input[type=password]').fill(PW);
      await p.getByRole('button', { name: 'Sign in' }).click();
      await p.locator(STAFF_PORTAL).first().waitFor({ timeout: 15_000 });
      await p.waitForTimeout(1000);
      await p.screenshot({ path: 'tests/e2e/artifacts/password-branch-manager.png', fullPage: false });
      results.push('PASS password-mode branch manager: email + password → partner portal');
      await ctx.close();
    }
    // Platform owner (SUPER_ADMIN): password, then the authenticator-app set-up screen, then the admin portal.
    {
      await t.app.inject({ method: 'POST', url: '/v1/auth/staff/reset/start', payload: { email: 'usr-00001@staff.example.test' } });
      await settleBackgroundWork();
      const code = [...t.auth.mail].reverse().find((m) => m.to === 'usr-00001@staff.example.test')!.code;
      await t.app.inject({ method: 'POST', url: '/v1/auth/staff/reset/finish', payload: { email: 'usr-00001@staff.example.test', code, password: PW } });
      const ctx = await browser.newContext(); const p = await ctx.newPage(); watch(p, 'pw-super-admin-mfa');
      await p.goto(webOrigin);
      await p.locator('text=Staff sign-in (email and password)').click();
      await p.locator('input[type=email]').fill('usr-00001@staff.example.test');
      await p.locator('input[type=password]').fill(PW);
      await p.getByRole('button', { name: 'Sign in' }).click();
      await p.locator('text=Cannot scan?').waitFor({ timeout: 10_000 });
      await p.locator('img[alt="QR code for your authenticator app"]').waitFor({ timeout: 5_000 }); // Supabase's raw SVG is shown
      await p.screenshot({ path: 'tests/e2e/artifacts/password-super-admin-mfa.png', fullPage: false });
      const key = (await (p.locator('p.mono') as unknown as { innerText(): Promise<string> }).innerText()).replace(/\s+/g, '');
      await p.locator('input[autocomplete=one-time-code]').fill(totp(key));
      await p.getByRole('button', { name: 'Verify and sign in' }).click();
      await p.locator(STAFF_PORTAL).first().waitFor({ timeout: 15_000 });
      results.push('PASS password-mode SUPER_ADMIN: password → authenticator app set-up (QR + key) → code → admin portal');
      await ctx.close();
    }
  } finally {
    await t.close();
    web.close();
  }
}

/** Run C — STAFF_SIGN_IN=both: staff may also use their mobile number; SUPER_ADMIN still gets the app step. */
async function runBothMode(browser: PwBrowser): Promise<void> {
  const { t, web, webOrigin } = await serve('both');
  await t.deps.pool.query(`update public.app_users set email = lower(id) || '@staff.example.test'`);
  const value = (l: PwLocator) => (l as unknown as { inputValue(): Promise<string> }).inputValue();
  try {
    // Finance admin by phone: "+974" is shown in front, a pasted "+974 3000 0002" becomes the 8 digits.
    {
      const ctx = await browser.newContext(); const p = await ctx.newPage(); watch(p, 'both-staff-phone');
      await p.goto(webOrigin);
      await p.locator('.qm-cc >> text=+974').waitFor({ timeout: 10_000 });
      const phone = p.locator('input[type=tel]').first();
      await phone.fill('+974 3000 0002');
      await (phone as unknown as { dispatchEvent(t: string): Promise<void> }).dispatchEvent('input');
      if (await value(phone) !== '30000002') throw new Error(`phone field kept "${await value(phone)}"`);
      await p.screenshot({ path: 'tests/e2e/artifacts/both-phone-field.png', fullPage: false });
      await p.getByRole('button', { name: 'Send code' }).click();
      await p.locator('input.code-input').waitFor({ timeout: 10_000 });
      await p.locator('input.code-input').fill(t.sms.lastCodeFor('+97430000002')!);
      await p.getByRole('button', { name: 'Sign in' }).click({ timeout: 1500 }).catch(() => undefined);
      await p.locator(STAFF_PORTAL).first().waitFor({ timeout: 15_000 });
      results.push('PASS both-mode finance admin: +974 shown, pasted number trimmed to 8 digits, SMS code → admin portal');
      await ctx.close();
    }
    // SUPER_ADMIN by phone: after the SMS code, the authenticator-app set-up, then the portal.
    {
      const ctx = await browser.newContext(); const p = await ctx.newPage(); watch(p, 'both-super-admin-phone');
      await p.goto(webOrigin);
      await p.locator('input[type=tel]').first().fill('30000001');
      await p.getByRole('button', { name: 'Send code' }).click();
      await p.locator('input.code-input').waitFor({ timeout: 10_000 });
      await p.locator('input.code-input').fill(t.sms.lastCodeFor('+97430000001')!);
      await p.getByRole('button', { name: 'Sign in' }).click({ timeout: 1500 }).catch(() => undefined);
      await p.locator('text=Cannot scan?').waitFor({ timeout: 10_000 });
      await p.locator('img[alt="QR code for your authenticator app"]').waitFor({ timeout: 5_000 });
      const key = (await (p.locator('p.mono') as unknown as { innerText(): Promise<string> }).innerText()).replace(/\s+/g, '');
      await p.locator('input[autocomplete=one-time-code]').last().fill(totp(key));
      await p.getByRole('button', { name: 'Verify and sign in' }).click();
      await p.locator(STAFF_PORTAL).first().waitFor({ timeout: 15_000 });
      results.push('PASS both-mode SUPER_ADMIN: SMS code → authenticator app set-up → admin portal');
      await ctx.close();
    }
    // A second code request inside the wait: the exact seconds, and the button counts down, disabled.
    {
      const ctx = await browser.newContext(); const p = await ctx.newPage(); watch(p, 'both-countdown');
      await p.goto(webOrigin);
      await p.locator('input[type=tel]').first().fill('30000010');
      await p.getByRole('button', { name: 'Send code' }).click();
      await p.locator('input.code-input').waitFor({ timeout: 10_000 });
      await p.locator('text=Use a different number').click();
      await p.locator('input[type=tel]').first().fill('30000010');
      await p.getByRole('button', { name: 'Send code' }).click();
      await p.locator('text=/Please wait \\d+ seconds/').first().waitFor({ timeout: 10_000 });
      await p.waitForTimeout(1200);
      const state = await (p as unknown as { evaluate(f: string): Promise<{ text: string; disabled: boolean }> }).evaluate(
        `(() => { const b = [...document.querySelectorAll('#root .auth-card button')].find((x) => /^Send code/.test(x.textContent)); return { text: b.textContent, disabled: b.disabled }; })()`);
      await p.screenshot({ path: 'tests/e2e/artifacts/both-countdown.png', fullPage: false });
      if (!/^Send code \(\d+s\)$/.test(state.text) || !state.disabled) throw new Error(`countdown button: ${JSON.stringify(state)}`);
      results.push('PASS sign-in: a code request inside the wait shows the seconds and a disabled countdown button');
      await ctx.close();
    }
    // "mailto:" pasted into the work email is dropped.
    {
      const ctx = await browser.newContext(); const p = await ctx.newPage(); watch(p, 'both-mailto');
      await p.goto(webOrigin);
      await p.locator('text=Staff sign-in (email and password)').click();
      const email = p.locator('input[type=email]');
      await email.fill('mailto:usr-00002@staff.example.test');
      await (email as unknown as { dispatchEvent(t: string): Promise<void> }).dispatchEvent('input');
      if (await value(email) !== 'usr-00002@staff.example.test') throw new Error(`email field kept "${await value(email)}"`);
      results.push('PASS both-mode email field: "mailto:" removed');
      await ctx.close();
    }
  } finally {
    await t.close();
    web.close();
  }
}

main().catch((e) => { console.error(`UI smoke failed: ${(e as Error).message}`); process.exit(1); });

/**
 * "Enter IMEI Manually" / "Scan IMEI" in a real browser (2026-10-10). The camera is replaced by a canvas
 * stream and, for the native path, BarcodeDetector by a stub that returns a chosen payload; the ZXing
 * fallback decodes a real QR code drawn on that canvas (this ZXing build has no 1D writer to draw CODE_128). Every request must stay on this origin.
 */
const FAKE_CAMERA = `
(() => {
  window.__scan = { mode: 'ok', payload: '' };
  const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
  window.__scanCanvas = canvas;
  const g = canvas.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 640, 360);
  const md = navigator.mediaDevices || {};
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, get: () => (window.__scan.mode === 'nocamera-api' ? undefined : md) });
  md.getUserMedia = async () => {
    const m = window.__scan.mode;
    if (m === 'denied') throw new DOMException('denied', 'NotAllowedError');
    if (m === 'nocam') throw new DOMException('none', 'NotFoundError');
    return canvas.captureStream(10);
  };
  class FakeDetector {
    static async getSupportedFormats() { return window.__scan.mode === 'zxing' ? [] : ['code_128', 'code_39', 'qr_code']; }
    async detect() {
      const m = window.__scan.mode;
      if (m === 'broken') throw new Error('detector failed');
      if (m === 'never') return [];
      return [{ rawValue: window.__scan.payload, format: 'code_128' }];
    }
  }
  window.BarcodeDetector = FakeDetector;
})();`;

async function runImeiMode(browser: PwBrowser): Promise<void> {
  const { t, web, webOrigin } = await serve('phone');
  const a = await actors(t);
  const pending = await submit(t, a.customer);
  const offHost: string[] = [];
  try {
    const ctx = await browser.newContext(); const p = await ctx.newPage(); watch(p, 'imei');
    p.on('request', (r) => { const u = new URL(r.url()); if (!['127.0.0.1', 'localhost'].includes(u.hostname) && u.protocol !== 'data:' && u.protocol !== 'blob:') offHost.push(u.origin); });
    await p.addInitScript(FAKE_CAMERA);
    await p.goto(webOrigin);
    await p.locator('input[type=tel]').first().fill('30000010');
    await p.getByRole('button', { name: 'Send code' }).click();
    await p.locator('input.code-input').waitFor({ timeout: 10_000 });
    await p.locator('input.code-input').fill(t.sms.lastCodeFor('+97430000010')!);
    await p.getByRole('button', { name: 'Sign in' }).click({ timeout: 1500 }).catch(() => undefined);
    await p.locator('.cx').first().waitFor({ timeout: 15_000 });
    // The customer's IMEI step of the trade-in flow, drawn by the unchanged 3.1 function.
    await p.evaluate(`(() => { const box = document.createElement('div'); box.id = 'imei-test'; document.body.prepend(box);
      F = freshFlow(); F.step = 1; stepDevice(box, box); })()`);
    const S = '#imei-test ';
    const val = () => p.evaluate<string>(`document.querySelector('${S}input.imei-input').value`);
    const gateDisabled = () => p.evaluate<boolean>(`document.querySelector('${S}.cx-cta:not(.back)').disabled`);
    const statusText = () => p.evaluate<string>(`document.querySelector('${S}[data-qm=imei-status]').textContent`);
    const panelText = () => p.evaluate<string>(`(e => e.hidden ? '' : e.textContent)(document.querySelector('${S}[data-qm=imei-confirm-panel]'))`);
    const fields = await p.evaluate<number>(`document.querySelectorAll('${S}input.imei-input').length`);
    const labels = await p.evaluate<string>(`[...document.querySelectorAll('${S}.qm-imei-choice button')].map(b => b.textContent).join('|')`);
    if (fields !== 1 || labels !== 'Enter IMEI Manually|Scan IMEI') throw new Error(`choices: ${fields} field(s), ${labels}`);
    const until = async (fn: () => Promise<boolean>, what: string) => {
      for (let i = 0; i < 60; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); }
      throw new Error(`timed out: ${what}`);
    };
    await p.screenshot({ path: 'tests/e2e/artifacts/imei-choices.png' });

    // Manual entry: validate, confirm, continue.
    const input = p.locator(`${S}input.imei-input`);
    await input.fill('49015420323751a');
    if (!/digits only/.test(await statusText()) || !(await gateDisabled())) throw new Error('letters were not refused');
    await input.fill('4901542032375');
    if (!/13 of 15/.test(await statusText())) throw new Error(`short: ${await statusText()}`);
    await input.fill('4901542032375189');
    if (!/more/.test(await statusText())) throw new Error(`long: ${await statusText()}`);
    await input.fill('490154203237519');
    if (!/check digit/.test(await statusText()) || !(await gateDisabled())) throw new Error('bad check digit was not refused');
    await input.fill('49 015420 323751 8');
    if (!(await gateDisabled()) || !/490154203237518|49 015420 323751 8/.test(await panelText())) throw new Error('valid IMEI should wait for Confirm');
    await p.locator(`${S}[data-qm=imei-confirm]`).click();
    if (await gateDisabled()) throw new Error('Continue stayed disabled after Confirm');
    await p.screenshot({ path: 'tests/e2e/artifacts/imei-manual-confirmed.png' });
    results.push('PASS IMEI manual: letters/short/long/check digit refused; a valid IMEI is confirmed before Continue');

    // Scan: payload with text around the IMEI fills the SAME field; Confirm or Edit.
    await p.evaluate(`window.__scan.mode = 'ok'; window.__scan.payload = 'Model A1 IMEI: 356938035643809 S/N F2LXX'`);
    await p.locator(`${S}[data-qm=imei-scan]`).click();
    await until(async () => (await val()) === '356938035643809', 'scan fills the field');
    if (!/Detected IMEI/.test(await panelText()) || !(await gateDisabled())) throw new Error('scanned IMEI must be shown and confirmed');
    if (await p.evaluate<boolean>(`!!document.querySelector('[data-qm=imei-scanner]')`)) throw new Error('camera overlay still open');
    await p.screenshot({ path: 'tests/e2e/artifacts/imei-scanned.png' });
    await p.locator(`${S}[data-qm=imei-edit]`).click();
    await input.fill('490154203237518');
    await p.locator(`${S}[data-qm=imei-confirm]`).click();
    if ((await val()) !== '490154203237518' || (await gateDisabled())) throw new Error('editing a scanned IMEI failed');
    results.push('PASS IMEI scan: IMEI found inside the barcode text, put in the existing field, shown, confirmed or edited; camera stopped');

    // Dual SIM: both are offered, nothing is picked silently.
    await p.evaluate(`window.__scan.payload = 'IMEI1: 490154203237518\\nIMEI2: 356938035643809'`);
    await p.locator(`${S}[data-qm=imei-scan]`).click();
    await p.locator('[data-qm=imei-pick]').waitFor({ timeout: 5000 });
    const offered = await p.evaluate<string>(`document.querySelector('[data-qm=imei-pick]').textContent`);
    if (!/IMEI 1/.test(offered) || !/IMEI 2/.test(offered)) throw new Error(`dual SIM choices: ${offered}`);
    await p.screenshot({ path: 'tests/e2e/artifacts/imei-dual-sim.png' });
    await p.locator('[data-qm=imei-pick-2]').click();
    await until(async () => (await val()) === '356938035643809', 'chosen IMEI 2');
    results.push('PASS IMEI dual SIM: IMEI 1 and IMEI 2 offered; the chosen one is used');

    // Refusals all come back to manual entry, with a sentence and no application error.
    const backToManual = async (mode: string, pattern: RegExp, label: string) => {
      await p.evaluate(`window.__scan.mode = '${mode}'`);
      await p.locator(`${S}[data-qm=imei-scan]`).click();
      if (mode === 'never') {
        await p.locator('[data-qm=imei-scanner]').waitFor({ timeout: 5000 });
        await p.screenshot({ path: 'tests/e2e/artifacts/imei-camera.png' });
        await p.locator('[data-qm=imei-scan-cancel]').click();
      }
      await until(async () => pattern.test(await statusText()), label);
      const manual = await p.evaluate<string>(`document.querySelector('${S}[data-qm=imei-manual]').getAttribute('aria-pressed')`);
      const open = await p.evaluate<boolean>(`!!document.querySelector('[data-qm=imei-scanner]')`);
      if (manual !== 'true' || open) throw new Error(`${label}: not back to manual entry`);
    };
    await backToManual('denied', /permission/i, 'permission denied');
    results.push('PASS IMEI camera permission denied: message shown, back to manual entry');
    await backToManual('nocam', /No camera was found/, 'no camera');
    await backToManual('nocamera-api', /No camera is available/, 'no camera API');
    results.push('PASS IMEI no camera (device or browser): message shown, manual entry kept');
    await backToManual('never', /cancelled/i, 'cancel');
    results.push('PASS IMEI cancel: the camera closes and manual entry is selected');
    await backToManual('broken', /stopped working/, 'scanner failure');
    results.push('PASS IMEI scanner failure: back to manual entry, no application error');

    // No native detector: the self-hosted ZXing build decodes a real CODE_128 barcode from the camera.
    await p.evaluate(`window.__scan.mode = 'zxing'`);
    await p.evaluate(`new Promise((ok, no) => { const s = document.createElement('script'); s.src = '/vendor/zxing-library-0.21.3.min.js'; s.onload = ok; s.onerror = no; document.head.appendChild(s); })`);
    await p.evaluate(`(() => { const m = new ZXing.QRCodeWriter().encode('IMEI: 358240051111110', ZXing.BarcodeFormat.QR_CODE, 240, 240, new Map());
      const g = window.__scanCanvas.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 640, 360); g.fillStyle = '#000';
      for (let x = 0; x < m.getWidth(); x++) for (let y = 0; y < m.getHeight(); y++) if (m.get(x, y)) g.fillRect(200 + x, 60 + y, 1, 1);
      window.__scanTimer = setInterval(() => { g.fillStyle = 'rgba(255,255,255,0.01)'; g.fillRect(0, 0, 1, 1); }, 100); })()`);
    await p.locator(`${S}[data-qm=imei-scan]`).click();
    await until(async () => (await val()) === '358240051111110', 'ZXing decode');
    results.push('PASS IMEI fallback decoder: no native BarcodeDetector → the local ZXing build read the IMEI from a QR code');

    if (offHost.length) throw new Error(`requests left this origin: ${[...new Set(offHost)].join(', ')}`);
    results.push('PASS IMEI privacy: no request left the app while scanning (no frame or IMEI sent anywhere)');
    await ctx.close();

    // Technician: the same component on the inspection's identity check; "Check IMEI" waits for Confirm.
    const tctx = await browser.newContext(); const tp = await tctx.newPage(); watch(tp, 'imei-tech');
    await tp.goto(webOrigin);
    await tp.locator('input[type=tel]').first().fill('30000003');
    await tp.getByRole('button', { name: 'Send code' }).click();
    await tp.locator('input.code-input').waitFor({ timeout: 10_000 });
    await tp.locator('input.code-input').fill(t.sms.lastCodeFor('+97430000003')!);
    await tp.getByRole('button', { name: 'Sign in' }).click({ timeout: 1500 }).catch(() => undefined);
    await tp.locator(STAFF_PORTAL).first().waitFor({ timeout: 15_000 });
    await tp.evaluate(`openInspection(${JSON.stringify(pending.tradeInId)})`);
    await tp.locator('[data-qm=imei-manual]').waitFor({ timeout: 10_000 });
    const checkDisabled = () => tp.evaluate<boolean>(`[...document.querySelectorAll('button')].find(b => /Check IMEI/.test(b.textContent)).disabled`);
    if (!(await checkDisabled())) throw new Error('Check IMEI should wait for a confirmed IMEI');
    await tp.locator('input[data-qm-imei]').fill(pending.imei);
    await tp.locator('[data-qm=imei-confirm]').click();
    if (await checkDisabled()) throw new Error('Check IMEI stayed disabled');
    await tp.screenshot({ path: 'tests/e2e/artifacts/imei-technician.png' });
    await tp.evaluate(`[...document.querySelectorAll('button')].find(b => /Check IMEI/.test(b.textContent)).click()`);
    await until(async () => (await t.deps.pool.query('select imei_match from public.inspections where trade_in_id = $1', [pending.tradeInId])).rows[0]?.imei_match === true, 'technician IMEI match');
    results.push('PASS IMEI technician: the two choices on the identity check; confirmed IMEI matched by the server');
    await tctx.close();
  } finally {
    await t.close();
    web.close();
  }
}
