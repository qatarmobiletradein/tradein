/**
 * Human-readable identifiers, in the 3.1 formats (00_Config.gs ID_PREFIX),
 * allocated from app.next_counter inside the caller's transaction. A
 * rolled-back transaction gives its number back; two transactions can
 * never receive the same number (the counter row is locked until commit).
 *
 * The migration tool sets each counter to the highest imported number, so
 * new records continue the legacy sequences.
 */
import { nextCounter, type Queryable } from '../../../../packages/database/src/db.js';
import { pad } from '../../../../packages/shared/src/text.js';
import { businessDateCompact } from '../../../../packages/shared/src/time.js';

export const ID_SPEC = {
  USR: 5, CUS: 5, VND: 3, BR: 4, CMR: 5, BRD: 3, CAT: 3, PRD: 5, VAR: 6, CLR: 6,
  GRD: 3, IRL: 3, MPR: 6, VPR: 6, INS: 6, VCH: 6, BAT: 5, CLI: 7, STL: 5, NTF: 7,
} as const;
export type IdPrefix = keyof typeof ID_SPEC;

export async function nextId(db: Queryable, prefix: IdPrefix): Promise<string> {
  const n = await nextCounter(db, prefix);
  return `${prefix}-${pad(n, ID_SPEC[prefix])}`;
}

/** TI-<CODE>-000001, a sequence per partner code (nextTradeInId_). */
export async function nextTradeInId(db: Queryable, vendorCode: string): Promise<string> {
  const code = (vendorCode || 'QM').trim().toUpperCase();
  const n = await nextCounter(db, `TI-${code}`);
  return `TI-${code}-${pad(n, 6)}`;
}

/** CODE-yyyyMMdd-NNNN, a sequence per partner per Qatar day (voucherNumber_). */
export async function nextVoucherNumber(db: Queryable, vendorCode: string, at: Date): Promise<string> {
  const code = vendorCode.trim().toUpperCase();
  const day = businessDateCompact(at);
  const n = await nextCounter(db, `VOUCHER-${code}-${day}`);
  return `${code}-${day}-${pad(n, 4)}`;
}
