/**
 * String helpers ported from 01_Utils.gs and 00b_Security.gs.
 */
import { timingSafeEqual, createHash } from 'node:crypto';

export const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
export const trim = (v: unknown): string => str(v).trim();
export const isBlank = (v: unknown): boolean => trim(v) === '';

/** Sheets-era truthiness (truthy_): true, "TRUE", "YES", "1", "Y". */
export function truthy(v: unknown): boolean {
  if (v === true) return true;
  if (v === false || v === null || v === undefined) return false;
  const s = String(v).trim().toUpperCase();
  return s === 'TRUE' || s === 'YES' || s === '1' || s === 'Y';
}

/** Case- and space-insensitive label comparison (sameLabel_). */
export const sameLabel = (a: unknown, b: unknown): boolean =>
  trim(a).toLowerCase() === trim(b).toLowerCase();

/**
 * Qatar mobile number → "+974XXXXXXXX", or '' (normalizePhone_).
 * Accepts 8 digits starting 3/5/6/7, optionally prefixed 974 or 00974.
 */
export function normalizePhone(raw: unknown): string {
  let digits = str(raw).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length > 8) {
    if (digits.startsWith('00974')) digits = digits.slice(5);
    else if (digits.startsWith('974')) digits = digits.slice(3);
  }
  if (digits.length !== 8) return '';
  if (!/^[3567]/.test(digits)) return '';
  return `+974${digits}`;
}

/** Last eight digits, for comparison only (phoneKey_). */
export const phoneKey = (raw: unknown): string => str(raw).replace(/\D/g, '').slice(-8);

/** "+974 5512 3456" (formatPhone_). */
export function formatPhone(p: unknown): string {
  const n = normalizePhone(p);
  if (!n) return str(p);
  const d = n.slice(4);
  return `+974 ${d.slice(0, 4)} ${d.slice(4)}`;
}

/** "••••3456" (maskPhone_). */
export function maskPhone(p: unknown): string {
  const d = str(p).replace(/\D/g, '');
  return d.length < 4 ? '' : `••••${d.slice(-4)}`;
}

/** 15 digits and a valid Luhn check digit (isValidImei_). */
export function isValidImei(imei: unknown): boolean {
  const s = str(imei).replace(/\D/g, '');
  if (!/^\d{15}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let d = Number(s.charAt(i));
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** First 6, stars, last 4 (maskImei_). */
export function maskImei(imei: unknown): string {
  const s = str(imei).replace(/\D/g, '');
  if (!s) return '';
  if (s.length <= 10) return s;
  return s.slice(0, 6) + s.slice(6, -4).replace(/./g, '*') + s.slice(-4);
}

export const digitsOnly = (v: unknown): string => str(v).replace(/\D/g, '');

/** Constant-time comparison (safeEquals_). */
export function safeEquals(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

export const sha256Hex = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

/** JSON with keys sorted at every level (28_Idempotency.gs canonicalJson_). */
export function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * Spreadsheet-formula neutraliser for CSV exports (csvSafeCell_, OWASP).
 */
// Built from code points so no literal line/paragraph separator sits in the source.
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const NBSP = String.fromCharCode(0xa0);
const FORMULA_TRIGGER = new RegExp(
  '^[=+\\-@\\x00-\\x1f]|^[\\s' + NBSP + LS + PS + ']+[=+\\-@]');
export function csvSafeCell(v: unknown): string {
  if (v === null || v === undefined) return '""';
  if (typeof v === 'number') return Number.isFinite(v) ? `"${String(v)}"` : '""';
  if (typeof v === 'boolean') return `"${String(v)}"`;
  if (v instanceof Date) return `"${v.toISOString()}"`;
  let s = String(v);
  if (FORMULA_TRIGGER.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvSafeCell).join(',')).join('\r\n');
}

/** "Inspection in progress" (statusLabel_). */
export function statusLabel(s: unknown): string {
  return str(s).replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
}

export function slugify(s: unknown): string {
  return trim(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Storage label → display order (09_Catalog.gs, storageOrder_). */
export function storageOrder(storage: unknown): number {
  const m = /^(\d+)\s*(GB|TB|MB)$/.exec(str(storage).toUpperCase());
  if (!m) return 99;
  let n = Number(m[1]);
  if (m[2] === 'TB') n *= 1024;
  if (m[2] === 'MB') n /= 1024;
  return Math.min(98, Math.round(n / 16) + 1);
}

/** Pad an integer: 7 → "000007". */
export const pad = (n: number | bigint, width: number): string => String(n).padStart(width, '0');

/** Only https: (or nothing) for image URLs; SVG is excluded elsewhere (safeImageUrl_). */
export function safeHttpsUrl(url: unknown): string {
  const s = trim(url);
  if (!s) return '';
  try {
    const u = new URL(s);
    return u.protocol === 'https:' ? u.toString() : '';
  } catch {
    return '';
  }
}

/**
 * A sign-in email address: trimmed, lower-cased, one "@", a dot in the
 * domain, printable ASCII only, at most 254 characters. '' when it is not one.
 * ASCII only: lower-casing non-ASCII letters differs between JavaScript and
 * Supabase Auth (Go), which could make two spellings reach one account while
 * the API counts them separately.
 */
export function normalizeEmail(raw: unknown): string {
  const e = trim(raw).toLowerCase();
  if (e.length > 254 || !/^[\x21-\x7e]+$/.test(e) || !/^[^@]+@[^@]+\.[^@]+$/.test(e)) return '';
  return e;
}

/** "a•••@example.com" — enough for an audit line, not enough to read the address. */
export function maskEmail(e: unknown): string {
  const s = trim(e);
  const at = s.lastIndexOf('@');
  if (at < 1) return '•••';
  return `${s[0]}•••${s.slice(at)}`;
}
