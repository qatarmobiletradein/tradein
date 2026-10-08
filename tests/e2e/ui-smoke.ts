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
interface PwLocator { first(): PwLocator; nth(i: number): PwLocator; fill(v: string): Promise<void>; click(o?: { timeout?: number }): Promise<void>; waitFor(o?: { timeout?: number }): Promise<void> }
interface PwPage {
  on(ev: 'pageerror', fn: (e: Error) => void): void; on(ev: 'console', fn: (m: { type(): string; text(): string }) => void): void;
  goto(url: string): Promise<unknown>; locator(sel: string): PwLocator; getByRole(role: string, o: { name: string }): PwLocator;
  waitForTimeout(ms: number): Promise<void>; screenshot(o: { path: string; fullPage?: boolean }): Promise<unknown>;
}
interface PwBrowser { newContext(): Promise<{ newPage(): Promise<PwPage>; close(): Promise<void> }>; close(): Promise<void> }
const { chromium } = require(process.env.QM_PLAYWRIGHT ?? '/opt/npm-tools/node_modules/playwright') as { chromium: { launch(): Promise<PwBrowser> } };

const STAFF_PORTAL = 'aside.sidebar';
const results: string[] = [];
const errors: string[] = [];

async function serve(mode: 'phone' | 'password') {
  const web = createServer();
  await new Promise<void>((r) => web.listen(0, '127.0.0.1', () => r()));
  const webOrigin = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
  const t = await createTestApp({ CORS_ALLOWED_ORIGINS: webOrigin, STAFF_SIGN_IN: mode, ...(mode === 'password' ? { STAFF_MFA_ROLES: 'SUPER_ADMIN' } : {}) });
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
  } finally {
    await browser.close();
  }
  for (const r of results) console.log(r);
  if (errors.length) { console.log('BROWSER ERRORS:'); for (const e of errors) console.log(`  ${e}`); process.exitCode = 1; }
  if (results.length !== 8) process.exitCode = 1;
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

main().catch((e) => { console.error(`UI smoke failed: ${(e as Error).message}`); process.exit(1); });
