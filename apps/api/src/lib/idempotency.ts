/**
 * Idempotent execution (28_Idempotency.gs), now one database transaction.
 *
 * The key is bound to: the authenticated principal, the action, the target
 * object(s) named by the registry, and a hash of the request payload. In
 * the SAME transaction as the work:
 *   1. a transaction-scoped advisory lock on the key serialises duplicates;
 *   2. a stored COMPLETED record → its response is returned (replayed: true)
 *      and nothing runs again;
 *   3. the same key with a DIFFERENT payload → refused (409);
 *   4. otherwise the work runs and the record is inserted before COMMIT.
 * A failed attempt rolls back and stores nothing, so it can be retried —
 * the same "store successes only" rule 3.1 used.
 */
import { advisoryXactLock, type Queryable } from '../../../../packages/database/src/db.js';
import { AppError } from '../../../../packages/shared/src/errors.js';
import { canonicalJson, sha256Hex } from '../../../../packages/shared/src/text.js';
import type { Principal } from '../../../../packages/auth/src/index.js';

export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
const RESULT_MAX = 64_000;

export interface IdemRecord {
  id: string;
  requestHash: string;
  target: string;
}

export function idemTarget(keys: readonly string[], params: Record<string, unknown>): string {
  return keys.map((k) => {
    const v = params[k];
    return v === undefined || v === null ? '' : String(v);
  }).join('|').slice(0, 300);
}

export function idemIds(p: Principal, action: string, target: string, key: string, params: Record<string, unknown>): IdemRecord {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) if (k !== 'idempotencyKey') clean[k] = v;
  return {
    id: sha256Hex([p.principalType, p.principalId, action, target, key].join('|')),
    requestHash: sha256Hex(canonicalJson(clean)),
    target,
  };
}

export type Begin = { kind: 'replay'; status: number; body: Record<string, unknown> } | { kind: 'run'; rec: IdemRecord };

export async function beginIdempotent(
  db: Queryable, rec: IdemRecord, onKeyReuse: () => void,
): Promise<Begin> {
  await advisoryXactLock(db, `qm.idem:${rec.id}`);
  const r = await db.query<{ request_hash: string; response_status: number; response: Record<string, unknown>; expired: boolean }>(
    `select request_hash, response_status, response, expires_at < now() as expired
       from public.idempotency_keys where id = $1`, [rec.id]);
  const row = r.rows[0];
  if (row) {
    if (row.expired) {
      await db.query('delete from public.idempotency_keys where id = $1', [rec.id]);
    } else if (row.request_hash !== rec.requestHash) {
      onKeyReuse();
      throw new AppError('IDEMPOTENCY_KEY_REUSED',
        'This request key was already used for a different request. Please refresh the page and try again.');
    } else {
      return { kind: 'replay', status: row.response_status, body: { ...row.response, replayed: true } };
    }
  }
  return { kind: 'run', rec };
}

function slim(body: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(body);
  if (json.length <= RESULT_MAX) return body;
  const keep = ['ok', 'message', 'tradeInId', 'voucherId', 'voucherNumber', 'batchId', 'settlementId', 'userId',
    'value', 'total', 'tradeInCount', 'deviceCount', 'currency', 'finalValue'];
  const out: Record<string, unknown> = { truncated: true };
  for (const k of keep) if (body[k] !== undefined) out[k] = body[k];
  return out;
}

export async function completeIdempotent(
  db: Queryable, p: Principal, action: string, rec: IdemRecord, status: number, body: Record<string, unknown>, ttlDays: number,
): Promise<void> {
  await db.query(
    `insert into public.idempotency_keys
       (id, principal_type, principal_id, action, target_id, request_hash, status, response_status, response, expires_at)
     values ($1,$2,$3,$4,$5,$6,'COMPLETED',$7,$8::jsonb, now() + make_interval(days => $9))`,
    [rec.id, p.principalType, p.principalId, action, rec.target, rec.requestHash, status, JSON.stringify(slim(body)), ttlDays],
  );
}
