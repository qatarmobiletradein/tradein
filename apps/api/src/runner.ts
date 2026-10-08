/**
 * The one way an authenticated action runs (06_RBAC.gs apiCall, now with
 * a real transaction):
 *
 *   1. the action must exist in the registry (unknown = not available);
 *   2. the token is verified and the principal re-read from the database
 *      INSIDE the transaction;
 *   3. the role must be allowed (refusals audited);
 *   4. parameters are validated by the action's schema;
 *   5. idempotent actions consult/record their key in the same transaction;
 *   6. the service runs; its audit rows commit with its changes;
 *   7. refusals are recorded on a separate connection afterwards.
 * Errors leave as a sentence for a person; internals go to the log only.
 */
import { authOptions } from './lib/auth-options.js';
import type { ZodType } from 'zod';
import type { Role } from '../../../packages/domain/src/constants.js';
import { resolvePrincipal, roleAllows, type Denial, type Principal } from '../../../packages/auth/src/index.js';
import { withTransaction } from '../../../packages/database/src/db.js';
import { AppError, GENERIC_MESSAGE, fromPgError, mfaRequired, unauthenticated } from '../../../packages/shared/src/errors.js';
import { flushDenials } from './lib/audit.js';
import { IDEMPOTENCY_KEY_RE, beginIdempotent, completeIdempotent, idemIds, idemTarget } from './lib/idempotency.js';
import type { Ctx, Deps, RequestMeta } from './context.js';

export interface ActionDef {
  roles: readonly Role[] | '*';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: ZodType<any, any, any>;
  idem?: readonly string[];
  readOnly?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: (ctx: Ctx, params: any) => Promise<Record<string, unknown>>;
}

export interface ActionResult { status: number; body: Record<string, unknown> }

export function errorResult(err: unknown, deps: Deps, meta: RequestMeta, action: string): ActionResult {
  const app = err instanceof AppError ? err : fromPgError(err);
  if (app) {
    if (app.code === 'INTERNAL' || app.code === 'UNAVAILABLE') {
      deps.log.warn({ requestId: meta.requestId, action, err }, 'action refused by infrastructure');
    }
    return { status: app.status, body: { ok: false, message: app.message, code: app.code, ...app.extra } };
  }
  deps.log.error({ requestId: meta.requestId, action, err }, 'action failed');
  return { status: 500, body: { ok: false, message: GENERIC_MESSAGE, code: 'INTERNAL' } };
}

export interface RunInput {
  action: string;
  def: ActionDef | undefined;
  accessToken: string;
  rawParams: unknown;
  idempotencyKey: string;
  meta: RequestMeta;
}

export async function runAction(deps: Deps, input: RunInput): Promise<ActionResult> {
  const { action, def, meta } = input;
  if (!def) return { status: 404, body: { ok: false, message: 'This action is not available.', code: 'NOT_FOUND' } };

  const denials: Denial[] = [];
  let principal: Principal | null = null;
  try {
    const claims = input.accessToken ? await deps.verifyToken(input.accessToken) : null;
    if (!claims) throw unauthenticated();

    const raw = (input.rawParams && typeof input.rawParams === 'object' && !Array.isArray(input.rawParams))
      ? input.rawParams as Record<string, unknown> : {};
    // Keys beginning "_" are reserved for the server (cleanParams_).
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) if (!k.startsWith('_') && k !== 'constructor' && k !== 'prototype') cleaned[k] = v;

    const key = input.idempotencyKey || (typeof cleaned.idempotencyKey === 'string' ? cleaned.idempotencyKey : '');
    delete cleaned.idempotencyKey;
    if (key && !IDEMPOTENCY_KEY_RE.test(key)) {
      throw new AppError('VALIDATION', 'This request could not be processed. Please refresh the page and try again.');
    }
    if (def.idem && !key && deps.config.IDEMPOTENCY_KEY_REQUIRED) {
      // Same sentence 3.1 showed; the code tells an integrator exactly what is missing.
      throw new AppError('IDEMPOTENCY_KEY_REQUIRED', 'This request could not be processed. Please refresh the page and try again.');
    }

    const body = await withTransaction(deps.pool, async (tx) => {
      if (def.readOnly) await tx.query('set transaction read only');
      const res = await resolvePrincipal(tx, claims, authOptions(deps.config, { allowLink: false }));
      if (!res.ok) throw res.reason === 'MFA_REQUIRED' ? mfaRequired() : unauthenticated();
      principal = res.principal;
      const ctx: Ctx = { p: principal, db: tx, denials, meta, deps, action, operationId: '', rawParams: cleaned };

      if (!roleAllows(def.roles, principal.role)) {
        denials.push({ what: action, detail: 'role' });
        throw new AppError('FORBIDDEN', 'You do not have permission to do that.');
      }
      const parsed = def.schema.safeParse(cleaned);
      if (!parsed.success) {
        throw new AppError('VALIDATION', 'Some of the information sent was not valid. Please check it and try again.');
      }

      if (def.idem && key) {
        const rec = idemIds(principal, action, idemTarget(def.idem, cleaned), key, cleaned);
        const begun = await beginIdempotent(tx, rec, () => denials.push({ what: 'idempotency.keyReused', detail: action }));
        if (begun.kind === 'replay') return begun.body;
        ctx.operationId = rec.id;
        const out = await def.run(ctx, parsed.data);
        await completeIdempotent(tx, principal, action, rec, 200, out, deps.config.IDEMPOTENCY_TTL_DAYS);
        return out;
      }
      return def.run(ctx, parsed.data);
    }, { statementTimeoutMs: deps.config.DATABASE_STATEMENT_TIMEOUT_MS });

    return { status: 200, body };
  } catch (err) {
    return errorResult(err, deps, meta, action);
  } finally {
    if (denials.length) await flushDenials(deps.pool, principal, meta, denials);
  }
}
