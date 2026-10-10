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
import { submit, actors } from '../helpers/flow.js';
import { settleBackgroundWork } from '../../apps/api/src/services/staff-auth.js';
import { totp } from '../helpers/totp.js';

const require = createRequire(import.meta.url);
// The browser ships with the environment (PLAYWRIGHT_BROWSERS_PATH); the library is resolved from the global install.
// Playwright is not a project dependency, so only the few calls used here are typed.
interface PwLocator { first(): PwLocator; last(): PwLocator; nth(i: number): PwLocator; fill(v: string): Promise<void>; click(o?: { timeout?: number }): Promise<void>; waitFor(o?: { timeout?: number }): Promise<void>;
  setInputFiles(f: { name: string; mimeType: string; buffer: Buffer }): Promise<void>; getAttribute(n: string): Promise<string | null>; innerText(): Promise<string> }
interface PwPage {
  on(ev: 'pageerror', fn: (e: Error) => void): void; on(ev: 'console', fn: (m: { type(): string; text(): string }) => void): void;
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
  web.on('request', (_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page); });
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
  } finally {
    await browser.close();
  }
  for (const r of results) console.log(r);
  if (errors.length) { console.log('BROWSER ERRORS:'); for (const e of errors) console.log(`  ${e}`); process.exitCode = 1; }
  if (results.length !== 15) process.exitCode = 1;
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
