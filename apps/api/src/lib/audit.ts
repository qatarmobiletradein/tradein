/**
 * The audit trail (20_Audit.gs). Append-only — enforced by a trigger.
 *
 * Writes that describe a change are made in the SAME transaction as the
 * change, so the record and its audit row commit or vanish together.
 * Refusals are written on a separate connection after the request, so a
 * rolled-back attempt still leaves its trace (3.1 auditDenied_).
 *
 * Never put an OTP, password, token, secret or full IMEI in `details`.
 */
import type pg from 'pg';
import type { Queryable } from '../../../../packages/database/src/db.js';
import type { Denial, Principal } from '../../../../packages/auth/src/index.js';
import { ACTIONS } from '../../../../packages/domain/src/constants.js';
import type { Ctx, RequestMeta } from '../context.js';

export interface AuditPatch {
  oldValue?: unknown;
  newValue?: unknown;
  details?: Record<string, unknown>;
  vendorId?: string;
  branchId?: string;
}

const SECRET_KEYS = /^(otp|code|token|access_token|refresh_token|password|secret|apikey|authorization|imei|scannedimei)$/i;

/** Defence in depth: strip secret-looking keys from anything audited. */
export function sanitizeAuditValue(v: unknown, depth = 0): unknown {
  if (v === null || v === undefined) return v ?? null;
  if (depth > 6) return '[depth]';
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => sanitizeAuditValue(x, depth + 1));
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? '[redacted]' : sanitizeAuditValue(x, depth + 1);
    }
    return out;
  }
  if (typeof v === 'string' && v.length > 2000) return `${v.slice(0, 2000)}…`;
  return v;
}

const json = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(sanitizeAuditValue(v)));

export async function writeAudit(
  db: Queryable, actor: Principal | null, meta: RequestMeta | null,
  action: string, objectType: string, objectId: string, patch: AuditPatch = {},
): Promise<void> {
  await db.query(
    `insert into public.audit_logs
       (request_id, actor_id, actor_name, actor_role, vendor_id, branch_id, action, object_type, object_id,
        old_value, new_value, details, ip_address, user_agent)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14)`,
    [
      meta?.requestId ?? null,
      actor?.principalId ?? null, actor?.name ?? null, actor?.role ?? null,
      patch.vendorId ?? (actor?.vendorId || null), patch.branchId ?? (actor?.branchId || null),
      action, objectType, objectId,
      json(patch.oldValue), json(patch.newValue), json(patch.details),
      meta?.ip ?? null, meta?.userAgent ? meta.userAgent.slice(0, 300) : null,
    ],
  );
}

/** auditAs_ inside the request transaction. */
export const audit = (ctx: Ctx, action: string, objectType: string, objectId: string, patch: AuditPatch = {}): Promise<void> =>
  writeAudit(ctx.db, ctx.p, ctx.meta, action, objectType, objectId, patch);

/** Persist refusals collected during a request, outside its transaction. Best effort. */
export async function flushDenials(pool: pg.Pool, actor: Principal | null, meta: RequestMeta, denials: Denial[]): Promise<void> {
  if (!denials.length) return;
  try {
    for (const d of denials.slice(0, 20)) {
      await writeAudit(pool, actor, meta, d.action ?? ACTIONS.ACCESS_DENIED, d.objectType ?? 'ACCESS', d.what, {
        details: d.details ?? { detail: d.detail }, vendorId: d.vendorId, branchId: d.branchId,
      });
    }
  } catch {
    // A failure to record a refusal must never turn the refusal into an error page.
  }
}
