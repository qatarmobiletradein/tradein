/**
 * Business-day arithmetic in Qatar time.
 *
 * 3.1 ran with the script time zone Asia/Qatar, and every "whole day"
 * boundary (settlement periods, report filters, voucher numbers) was a
 * Qatar day. Qatar is UTC+03:00 with no daylight saving, so the offset is
 * a constant; it is still computed through Intl so a future change to the
 * zone database is picked up rather than silently ignored.
 */
export const BUSINESS_TZ = 'Asia/Qatar';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Offset of the business zone from UTC at `at`, in minutes (Qatar: +180). */
export function zoneOffsetMinutes(at: Date, tz = BUSINESS_TZ): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

/** yyyy-MM-dd of `at` in Qatar. */
export function businessDate(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(at);
  return parts; // en-CA formats as yyyy-MM-dd
}

/** yyyyMMdd of `at` in Qatar (voucher numbers). */
export const businessDateCompact = (at: Date): string => businessDate(at).replace(/-/g, '');

function parseYmd(v: string): { y: number; m: number; d: number } | null {
  const m = DATE_RE.exec(v.trim());
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

function localMidnightUtc(y: number, m: number, d: number): Date {
  const guess = new Date(Date.UTC(y, m - 1, d));
  const off = zoneOffsetMinutes(guess);
  return new Date(guess.getTime() - off * 60000);
}

/** First instant of the Qatar day (parseDayStart_). Accepts yyyy-MM-dd or a Date/ISO. */
export function parseDayStart(v: unknown): Date | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string') {
    const ymd = parseYmd(v);
    if (ymd) return localMidnightUtc(ymd.y, ymd.m, ymd.d);
    // A yyyy-MM-dd that is not a real date (2026-02-30) is refused, not rolled into March.
    if (DATE_RE.test(v.trim())) return null;
  }
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return null;
  const [y, m, dd] = businessDate(d).split('-').map(Number) as [number, number, number];
  return localMidnightUtc(y, m, dd);
}

/** Last instant (…23:59:59.999) of the Qatar day (parseDayEnd_). */
export function parseDayEnd(v: unknown): Date | null {
  const start = parseDayStart(v);
  if (!start) return null;
  // Next local midnight minus 1 ms. Qatar has no DST, but compute it anyway.
  const [y, m, d] = businessDate(new Date(start.getTime() + 12 * 3600_000)).split('-').map(Number) as [number, number, number];
  const next = localMidnightUtc(y, m, d + 1);
  return new Date(next.getTime() - 1);
}

/** Inclusive whole-day range check (inDateRange_). */
export function inDateRange(when: Date | null, from: unknown, to: unknown): boolean {
  const start = parseDayStart(from);
  const end = parseDayEnd(to);
  if (!start && !end) return true;
  if (!when) return false;
  if (start && when.getTime() < start.getTime()) return false;
  if (end && when.getTime() > end.getTime()) return false;
  return true;
}

/** Half-open [from, to) (inEffectiveWindow_). */
export function inEffectiveWindow(from: Date | null, to: Date | null, at: Date): boolean {
  if (from && at.getTime() < from.getTime()) return false;
  if (to && at.getTime() >= to.getTime()) return false;
  return true;
}

export const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * 86_400_000);
export const addMinutes = (d: Date, n: number): Date => new Date(d.getTime() + n * 60_000);

/** "2026-10-08 14:05" in Qatar time (fmtDateTime_). */
export function fmtDateTime(d: Date | null | undefined): string {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  const t = new Intl.DateTimeFormat('en-GB', {
    timeZone: BUSINESS_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date);
  return `${businessDate(date)} ${t}`;
}

/** "2026-10-08" in Qatar time (fmtDate_). */
export function fmtDate(d: Date | null | undefined): string {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? '' : businessDate(date);
}
