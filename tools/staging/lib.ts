/**
 * Shared pieces of the staging verification: an HTTP client for the
 * Railway API and for Supabase REST/Storage, a check recorder that writes
 * an honest report (PASS / FAIL / SKIPPED, never "assumed"), and helpers.
 *
 * Nothing here prints a token, a phone number, a one-time code or a key.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type Json = Record<string, unknown>;
export interface Res { status: number; body: Json; headers: Headers }

export const idemKey = (): string => `stg_${randomBytes(12).toString('hex')}`;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A Luhn-valid 15-digit IMEI with this project's fixed test prefix "99" so staging records are easy to recognise. Random digits; not a known device. */
export function testImei(): string {
  let body = '99';
  while (body.length < 14) body += String(randomInt(0, 10));
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let d = Number(body[i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return body + String((10 - (sum % 10)) % 10);
}

/** A complete, valid 1×1 PNG (fictional evidence photo). */
export const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
export const SVG_AS_PNG = `data:image/png;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64')}`;

const SECRET_PATTERNS = [/postgres(ql)?:\/\//i, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, /sb_secret_/, /whsec_/, /service_role/i, /\bat [A-Za-z]+ \(.*:\d+:\d+\)/];
/** Does a response body contain anything that looks like a secret, a connection string or a stack trace? */
export const leaksSecrets = (text: string): boolean => SECRET_PATTERNS.some((r) => r.test(text));

export class Api {
  constructor(readonly base: string) {}

  async raw(method: string, path: string, init: { headers?: Record<string, string>; body?: unknown } = {}): Promise<Res & { text: string }> {
    const res = await fetch(`${this.base}${path}`, {
      method, headers: { ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body), redirect: 'manual', signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let body: Json = {};
    try { body = JSON.parse(text) as Json; } catch { body = {}; }
    return { status: res.status, body, headers: res.headers, text };
  }

  /** POST /v1/actions/:action — the compatibility endpoint the 3.1 screens use. */
  async call(action: string, token: string | null, params: Json = {}, key?: string): Promise<Res> {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (key) headers['Idempotency-Key'] = key;
    return this.raw('POST', `/v1/actions/${encodeURIComponent(action)}`, { headers, body: { params } });
  }
}

/** Supabase REST/Storage as a CLIENT would reach them: publishable (anon) key + optional user token. */
export class Supa {
  constructor(readonly url: string, readonly anonKey: string) {}
  private headers(userToken?: string, extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { apikey: this.anonKey, ...extra };
    if (userToken) h.Authorization = `Bearer ${userToken}`;
    else if (/^eyJ/.test(this.anonKey)) h.Authorization = `Bearer ${this.anonKey}`;
    return h;
  }
  async rest(method: string, path: string, userToken?: string, body?: unknown): Promise<{ status: number; rows: unknown[] | null; text: string }> {
    const res = await fetch(`${this.url}/rest/v1/${path}`, {
      method, headers: this.headers(userToken, { 'Content-Type': 'application/json', Prefer: 'return=representation' }),
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let rows: unknown[] | null = null;
    try { const j = JSON.parse(text); rows = Array.isArray(j) ? j : null; } catch { rows = null; }
    return { status: res.status, rows, text };
  }
  async storage(method: string, path: string, userToken?: string, body?: unknown): Promise<{ status: number; text: string }> {
    const res = await fetch(`${this.url}/storage/v1/${path}`, {
      method, headers: this.headers(userToken, body === undefined ? {} : { 'Content-Type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(20_000),
    });
    return { status: res.status, text: await res.text() };
  }
}

export type Status = 'PASS' | 'FAIL' | 'SKIPPED';
export interface CheckResult { group: string; id: string; name: string; status: Status; detail: string; ms: number }

export class Report {
  readonly results: CheckResult[] = [];
  constructor(readonly meta: Json) {}

  /** Run one check. A thrown error is a FAIL with its message (messages never contain secrets). */
  async check(group: string, id: string, name: string, fn: () => Promise<string | void>): Promise<boolean> {
    const t0 = Date.now();
    try {
      const detail = (await fn()) ?? '';
      this.results.push({ group, id, name, status: 'PASS', detail, ms: Date.now() - t0 });
      console.log(`PASS  ${id}  ${name}${detail ? ` — ${detail}` : ''}`);
      return true;
    } catch (e) {
      const detail = e instanceof Skip ? e.message : (e as Error).message;
      const status: Status = e instanceof Skip ? 'SKIPPED' : 'FAIL';
      this.results.push({ group, id, name, status, detail, ms: Date.now() - t0 });
      console.log(`${status === 'FAIL' ? 'FAIL ' : 'SKIP '} ${id}  ${name} — ${detail}`);
      return false;
    }
  }

  skip(group: string, id: string, name: string, why: string): void {
    this.results.push({ group, id, name, status: 'SKIPPED', detail: why, ms: 0 });
    console.log(`SKIP  ${id}  ${name} — ${why}`);
  }

  counts() {
    const c = { PASS: 0, FAIL: 0, SKIPPED: 0 };
    for (const r of this.results) c[r.status]++;
    return c;
  }

  write(dir: string): { json: string; md: string } {
    const out = resolve(dir);
    mkdirSync(out, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const json = join(out, `verify-${stamp}.json`);
    const md = join(out, `verify-${stamp}.md`);
    const c = this.counts();
    writeFileSync(json, JSON.stringify({ meta: this.meta, counts: c, results: this.results }, null, 2));
    const lines = [
      `# Staging verification report`, '',
      ...Object.entries(this.meta).map(([k, v]) => `- **${k}**: ${typeof v === 'string' ? v : JSON.stringify(v)}`), '',
      `**PASS ${c.PASS} · FAIL ${c.FAIL} · SKIPPED ${c.SKIPPED}**`, '',
      '| Status | ID | Check | Detail |', '|---|---|---|---|',
      ...this.results.map((r) => `| ${r.status} | ${r.id} | ${r.name} | ${r.detail.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`),
    ];
    writeFileSync(md, lines.join('\n') + '\n');
    return { json, md };
  }
}

export class Skip extends Error {}
export function skip(why: string): never {
  throw new Skip(why);
}

export function expect(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

export function expectStatus(r: { status: number; body?: Json }, allowed: number[], what: string): void {
  if (!allowed.includes(r.status)) {
    const msg = typeof r.body?.message === 'string' ? ` (${String(r.body.message).slice(0, 160)})` : '';
    throw new Error(`${what}: expected HTTP ${allowed.join('/')} but got ${r.status}${msg}`);
  }
}

export function ok(r: Res, what: string): Json {
  if (r.status !== 200 || r.body.ok !== true) {
    throw new Error(`${what}: HTTP ${r.status} ${typeof r.body.message === 'string' ? r.body.message : ''}`.trim());
  }
  return r.body;
}

/** Find the first value under `key` anywhere in a JSON body. */
export function find(v: unknown, key: string): unknown {
  if (!v || typeof v !== 'object') return undefined;
  if (key in (v as Json)) return (v as Json)[key];
  for (const x of Object.values(v as Json)) {
    const r = find(x, key);
    if (r !== undefined) return r;
  }
  return undefined;
}

/** Decode (NOT verify) a JWT's header and claims, for configuration hints only. */
export function peekJwt(token: string): { alg?: string; iss?: string; aud?: unknown; exp?: number; role?: string; amr?: unknown; email?: string } {
  try {
    const [h, p] = token.split('.');
    const header = JSON.parse(Buffer.from(h!, 'base64url').toString('utf8')) as Json;
    const claims = JSON.parse(Buffer.from(p!, 'base64url').toString('utf8')) as Json;
    return {
      alg: String(header.alg ?? ''), iss: String(claims.iss ?? ''), aud: claims.aud, exp: Number(claims.exp), role: String(claims.role ?? ''),
      amr: claims.amr, email: typeof claims.email === 'string' ? claims.email : undefined,
    };
  } catch {
    return {};
  }
}
