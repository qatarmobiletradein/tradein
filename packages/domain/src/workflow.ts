/**
 * State machines and derived statuses (00_Config.gs TRADEIN_FLOW,
 * 18_Settlements.gs SETTLEMENT_FLOW, 17_Collections.gs recalcBatch_).
 *
 * The database enforces the same tables with triggers
 * (20261008000200_integrity.sql); these functions exist so the API can
 * refuse with a sentence BEFORE the database refuses with an error.
 */
import {
  COLLECTION_STATUS, CUSTODY_STATUSES, SETTLEMENT_FLOW, TRADEIN_FLOW,
  type CollectionItemStatus, type SettlementStatus, type TradeInStatus,
} from './constants.js';

export const canTransition = (from: string, to: string): boolean =>
  (TRADEIN_FLOW[from as TradeInStatus] ?? []).includes(to as TradeInStatus);

export const canSettlementTransition = (from: string, to: string): boolean =>
  (SETTLEMENT_FLOW[from as SettlementStatus] ?? []).includes(to as SettlementStatus);

export const inCustody = (status: string): boolean => CUSTODY_STATUSES.includes(status as TradeInStatus);

export interface BatchSummary {
  status: string;
  pending: number; collected: number; missing: number; rejected: number; exception: number;
  expected: number; actualCents: number;
}

/**
 * recalcBatch_ — the note's status is DERIVED from its lines, never set.
 * Order matters: an unresolved exception outranks a tidy count.
 */
export function recalcBatch(lines: { itemStatus: CollectionItemStatus | string; settlementCents: number }[]): BatchSummary {
  const count = (s: string) => lines.filter((l) => l.itemStatus === s).length;
  const pending = count('PENDING');
  const collected = count('COLLECTED');
  const missing = count('MISSING');
  const rejected = count('REJECTED');
  const exception = count('EXCEPTION');
  const actualCents = lines.filter((l) => l.itemStatus === 'COLLECTED').reduce((t, l) => t + l.settlementCents, 0);

  let status: string;
  if (missing || rejected || exception) {
    status = pending ? COLLECTION_STATUS.PARTIALLY_COLLECTED : COLLECTION_STATUS.COLLECTION_EXCEPTION;
  } else if (pending && collected) {
    status = COLLECTION_STATUS.PARTIALLY_COLLECTED;
  } else if (pending) {
    status = COLLECTION_STATUS.READY_FOR_COLLECTION;
  } else {
    status = COLLECTION_STATUS.COLLECTED;
  }
  return { status, pending, collected, missing, rejected, exception, expected: lines.length, actualCents };
}
