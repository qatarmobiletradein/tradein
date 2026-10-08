/**
 * Exact money arithmetic.
 *
 * 3.1 used JavaScript floats with an epsilon nudge (01_Utils.gs, money_):
 *   Math.round((x + Number.EPSILON) * 100) / 100
 * Its INTENT is "round to the cent, halves up". This module implements the
 * intent exactly, on integers:
 *
 *   - amounts are integer CENTS (QAR has 2 decimals; CFG.MONEY_DECIMALS = 2);
 *   - grade percentages are integer basis points of a fraction (×10 000,
 *     numeric(5,4) in the schema);
 *   - commission rates are integer micro-units (×1 000 000, numeric(12,6));
 *   - every product is computed in BigInt and rounded ONCE, with the same
 *     rule Math.round uses: halves go towards +infinity.
 *
 * A float can disagree with this module only on inputs whose decimal value
 * sits exactly on a half cent and whose binary representation falls just
 * below it — the case the 3.1 epsilon nudge tried to paper over. That is
 * documented in PHASE2_CHANGELOG.md as an intent-preserving correction.
 *
 * Database numerics arrive from `pg` as strings ("1400.00"), which is what
 * keeps this exact end to end. Never call parseFloat on money.
 */

export type Cents = number;

const DECIMAL_RE = /^([+-])?(\d+)(?:\.(\d+))?$/;

/** floor(a / b) for BigInt with b > 0. */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q;
}

/** Math.round semantics on a rational num/den (den > 0): floor(x + 1/2). */
export function roundRatio(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new RangeError('denominator must be positive');
  return floorDiv(2n * num + den, 2n * den);
}

/**
 * Parse a decimal (string from pg, or a JS number from a request) into an
 * integer number of `scale`-ths, rounding halves up. Returns null for
 * anything that is not a finite decimal.
 */
export function parseScaled(v: unknown, scaleDigits: number): bigint | null {
  if (v === null || v === undefined) return null;
  let s: string;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    // Shortest round-trip representation; no exponent for sane magnitudes.
    s = Math.abs(v) < 1e-6 && v !== 0 ? v.toFixed(12) : String(v);
    if (/e/i.test(s)) s = v.toFixed(12);
  } else if (typeof v === 'bigint') {
    return v * 10n ** BigInt(scaleDigits);
  } else if (typeof v === 'string') {
    s = v.trim().replace(/,/g, '');
  } else {
    return null;
  }
  const m = DECIMAL_RE.exec(s);
  if (!m) return null;
  const sign = m[1] === '-' ? -1n : 1n;
  const whole = BigInt(m[2] ?? '0');
  const frac = m[3] ?? '';
  const scale = 10n ** BigInt(scaleDigits);
  const fracDen = 10n ** BigInt(frac.length);
  const fracNum = frac ? BigInt(frac) : 0n;
  // value = sign * (whole + fracNum / fracDen); scaled = value * scale
  const num = sign * (whole * fracDen + fracNum) * scale;
  return roundRatio(num, fracDen);
}

/** Decimal → cents (Math.round semantics). Throws on garbage. */
export function toCents(v: unknown): Cents {
  const c = parseScaled(v, 2);
  if (c === null) throw new RangeError('not a money amount');
  return Number(c);
}

/** Decimal → cents, or null when absent/blank. */
export function toCentsOrNull(v: unknown): Cents | null {
  if (v === null || v === undefined || v === '') return null;
  return toCents(v);
}

/** cents → "1400.00" for SQL numeric and JSON. */
export function centsToDecimal(c: Cents): string {
  const neg = c < 0;
  const a = Math.abs(c);
  const whole = Math.floor(a / 100);
  const frac = String(a % 100).padStart(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

/** cents → number of currency units (1400.5) for API replies, as 3.1 returned numbers. */
export function centsToNumber(c: Cents): number {
  return Number(centsToDecimal(c));
}

/** 1400 → "1,400.00" (01_Utils.gs, formatMoney_). */
export function formatMoney(c: Cents): string {
  const [w, f] = centsToDecimal(c).split('.') as [string, string];
  return `${w.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${f}`;
}

/** Fraction with 4 decimals (grade percentage) → basis points of 1 (0.7 → 7000). */
export function toFraction4(v: unknown): number {
  const x = parseScaled(v, 4);
  if (x === null) throw new RangeError('not a fraction');
  return Number(x);
}

/** Rate with 6 decimals (commission) → micro-units (0.05 → 50000). */
export function toMicro(v: unknown): bigint {
  const x = parseScaled(v, 6);
  if (x === null) throw new RangeError('not a rate');
  return x;
}

export function microToDecimal(m: bigint): string {
  const neg = m < 0n;
  const a = neg ? -m : m;
  const whole = a / 1_000_000n;
  const frac = (a % 1_000_000n).toString().padStart(6, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

export function fraction4ToDecimal(bp: number): string {
  const whole = Math.floor(bp / 10000);
  return `${whole}.${String(bp % 10000).padStart(4, '0')}`;
}

/** clampMoney_: never below zero. */
export const clampCents = (c: Cents): Cents => (c < 0 ? 0 : c);

/** base × fraction(4dp), rounded to the cent, clamped at zero (gradeValue_). */
export function applyFraction4(baseCents: Cents, fractionBp: number): Cents {
  return clampCents(Number(roundRatio(BigInt(baseCents) * BigInt(fractionBp), 10_000n)));
}

/** value × rate(6dp), rounded to the cent, clamped at zero (commissionFor_ PERCENTAGE). */
export function applyRateMicro(valueCents: Cents, rateMicro: bigint): Cents {
  return clampCents(Number(roundRatio(BigInt(valueCents) * rateMicro, 1_000_000n)));
}

/**
 * Variance as 3.1 stored it (14_TradeIns.gs, varianceOf_):
 *   amount  = final − estimate
 *   percent = Math.round(amount / estimate × 10000) / 100, or null when the
 *             estimate is zero.
 * Returns the percent as a decimal string with 2 places.
 */
export function variance(estimateCents: Cents, finalCents: Cents): { amount: Cents; percent: string | null } {
  const amount = finalCents - estimateCents;
  if (estimateCents <= 0) return { amount, percent: null };
  const hundredths = roundRatio(BigInt(amount) * 10_000n, BigInt(estimateCents));
  const neg = hundredths < 0n;
  const a = neg ? -hundredths : hundredths;
  const pct = `${neg ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`;
  return { amount, percent: pct };
}

export const sumCents = (xs: Iterable<Cents>): Cents => {
  let t = 0;
  for (const x of xs) t += x;
  return t;
};
