/**
 * LOCAL EMULATION — browser check of the UNCHANGED 3.1 screens (plus the
 * staff sign-in screen) against the containerised API in APP_ENV=staging,
 * signing in through the REAL Supabase Auth (GoTrue):
 *   customer        SMS code (Send SMS hook → Twilio emulation);
 *   finance admin   "Set or reset password" in the browser, code from the
 *                   real e-mail GoTrue sent to the SMTP sink;
 *   branch manager  email + password in the browser.
 * The page is served over HTTPS from an allow-listed origin, as in staging.
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { sleep } from '../../../tools/staging/lib.js';

const require = createRequire(import.meta.url);
interface PwLocator { first(): PwLocator; nth(i: number): PwLocator; fill(v: string): Promise<void>; click(o?: { timeout?: number }): Promise<void>; waitFor(o?: { timeout?: number }): Promise<void> }
interface PwPage {
  on(ev: 'pageerror', fn: (e: Error) => void): void; on(ev: 'console', fn: (m: { type(): string; text(): string }) => void): void;
  goto(url: string): Promise<unknown>; locator(sel: string): PwLocator; getByRole(role: string, o: { name: string }): PwLocator;
  waitForTimeout(ms: number): Promise<void>; screenshot(o: { path: string }): Promise<unknown>;
}
interface PwBrowser { newContext(o: { ignoreHTTPSErrors: boolean }): Promise<{ newPage(): Promise<PwPage>; close(): Promise<void> }>; close(): Promise<void> }
const { chromium } = require(process.env.QM_PLAYWRIGHT ?? '/opt/npm-tools/node_modules/playwright') as { chromium: { launch(): Promise<PwBrowser> } };

const E = (k: string) => process.env[k] ?? '';

async function lastCode(phone: string): Promise<string | null> {
  const r = await fetch(`${E('CTL')}/sms?phone=${encodeURIComponent(phone.replace(/^\+/, ''))}`);
  return ((await r.json()) as { code: string | null }).code;
}

async function lastMail(to: string): Promise<{ code: string | null; count: number }> {
  const r = await fetch(`${E('CTL')}/mail?to=${encodeURIComponent(to)}`);
  return (await r.json()) as { code: string | null; count: number };
}
async function apiPost(path: string, body: unknown) {
  const r = await fetch(`${E('API')}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}
/** Reset e-mails are limited to one per address per minute: wait out a recent one (the driver set these up earlier). */
async function waitForReset(email: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const before = (await lastMail(email)).count;
    const r = await apiPost('/v1/auth/staff/reset/start', { email });
    if (r.status === 200) { for (let j = 0; j < 60 && (await lastMail(email)).count === before; j++) await sleep(250); return; }
    if (r.status !== 429) throw new Error(`reset/start ${r.status}`);
    await sleep(5000);
  }
  throw new Error('reset never allowed');
}
const PASSWORD = `Ui-Emulation-${Date.now() % 100000}-x`;

async function main(): Promise<void> {
  execFileSync('node', ['apps/web/build.mjs'], { env: { ...process.env, QM_API_BASE: E('API'), QM_TRANSPORT: 'railway', QM_ENVIRONMENT_LABEL: 'STAGING' }, stdio: 'pipe' });
  const page = readFileSync('dist/web/index.html');
  const web = createServer({ cert: readFileSync(E('TLS_CERT')), key: readFileSync(E('TLS_KEY')) }, (_q, r) => { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(page); });
  const port = Number(E('WEB_PORT'));
  await new Promise<void>((r) => web.listen(port, '127.0.0.1', () => r()));
  const browser = await chromium.launch();
  const out = E('OUT');
  mkdirSync(out, { recursive: true });
  const errors: string[] = []; const passed: string[] = [];
  try {
    for (const [label, phone, local, selector] of [
      ['customer', '+97430000010', '30000010', '.cx'],
    ] as const) {
      const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
      const p = await ctx.newPage();
      p.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
      p.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(`${label} console: ${m.text()}`); });
      const before = await lastCode(phone);
      await p.goto(`https://127.0.0.1:${port}/`);
      await p.locator('input[type=tel]').first().fill(local);
      await p.getByRole('button', { name: 'Send code' }).click();
      await p.locator('input.code-input').waitFor({ timeout: 15_000 });
      let code: string | null = null;
      for (let i = 0; i < 40 && (!code || code === before); i++) { await sleep(250); code = await lastCode(phone); }
      if (!code || code === before) throw new Error(`${label}: no code arrived`);
      await p.locator('input.code-input').fill(code);
      await p.getByRole('button', { name: 'Sign in' }).click({ timeout: 1500 }).catch(() => undefined);
      await p.locator(selector).first().waitFor({ timeout: 20_000 });
      await p.waitForTimeout(1500);
      await p.screenshot({ path: `${out}/ui-${label}.png` });
      passed.push(`PASS  UI-${label}: real OTP through Supabase Auth, portal rendered (${selector})`);
      await ctx.close();
    }

    // Finance admin: first password set in the browser with the code GoTrue e-mailed.
    {
      const email = 'usr-00002@staff.example.test';
      const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
      const p = await ctx.newPage();
      p.on('pageerror', (e) => errors.push(`finance: ${e.message}`));
      await p.goto(`https://127.0.0.1:${port}/`);
      await p.locator('text=Staff sign-in (email and password)').click();
      await p.locator('text=Set or reset password').click();
      await p.locator('input[type=email]').fill(email);
      // Wait out the per-minute limit left by the driver (the browser button would say "Please wait a minute").
      for (let i = 0; i < 20; i++) {
        const before = (await lastMail(email)).count;
        await p.getByRole('button', { name: 'Email me a code' }).click();
        await p.waitForTimeout(1500);
        if ((await lastMail(email)).count > before) break;
        await sleep(5000);
      }
      await p.locator('input.code-input').waitFor({ timeout: 15_000 });
      const code = (await lastMail(email)).code;
      if (!code) throw new Error('finance: no e-mailed code');
      await p.locator('input.code-input').fill(code);
      await p.locator('input[type=password]').first().fill(PASSWORD);
      await p.locator('input[type=password]').nth(1).fill(PASSWORD);
      await p.getByRole('button', { name: 'Set password and sign in' }).click();
      await p.locator('aside.sidebar').first().waitFor({ timeout: 20_000 });
      await p.waitForTimeout(1500);
      await p.screenshot({ path: `${out}/ui-finance-admin.png` });
      passed.push('PASS  UI-finance-admin: first password with the code Supabase Auth e-mailed, admin portal rendered');
      await ctx.close();
    }

    // Branch manager: password set through the API, then email + password in the browser.
    {
      const email = 'usr-00005@staff.example.test';
      await waitForReset(email);
      const code = (await lastMail(email)).code;
      const f = await apiPost('/v1/auth/staff/reset/finish', { email, code, password: PASSWORD });
      if (f.status !== 200) throw new Error(`branch manager set-up ${f.status} ${String(f.body.message)}`);
      const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
      const p = await ctx.newPage();
      p.on('pageerror', (e) => errors.push(`branch: ${e.message}`));
      await p.goto(`https://127.0.0.1:${port}/`);
      await p.locator('text=Staff sign-in (email and password)').click();
      await p.locator('input[type=email]').fill(email);
      await p.locator('input[type=password]').fill(PASSWORD);
      await p.getByRole('button', { name: 'Sign in' }).click();
      await p.locator('aside.sidebar').first().waitFor({ timeout: 20_000 });
      await p.waitForTimeout(1500);
      await p.screenshot({ path: `${out}/ui-branch-manager.png` });
      passed.push('PASS  UI-branch-manager: email + password through Supabase Auth, partner portal rendered');
      await ctx.close();
    }
  } finally {
    await browser.close();
    web.close();
  }
  for (const l of passed) console.log(l);
  if (errors.length) { console.log('BROWSER ERRORS:'); for (const e of errors) console.log(`  ${e}`); process.exitCode = 1; }
  if (passed.length !== 3) process.exitCode = 1;
}
main().catch((e) => { console.error(`UI check failed: ${(e as Error).message}`); process.exit(1); });
