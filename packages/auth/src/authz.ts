/**
 * Server-side authorisation helpers — ported from 06_RBAC.gs and
 * 06b_Authz.gs with the same rules, the same order of checks and the
 * same "not found" wording for refusals (so a guessed id reveals nothing).
 *
 * Every guard THROWS. A caller that forgets to look at a return value
 * still fails closed.
 *
 * The only identifiers taken from a request are the OBJECT being acted
 * on; partner, branch and role always come from the Principal, which came
 * from the database, which was found from a verified token.
 */
import type { Queryable } from '../../database/src/db.js';
import {
  ADMIN_ONLY, COLLECTION_OPEN_STATUSES, PLATFORM_ROLES, ROLE_GRANTS, STAFF_MANAGER_ROLES, VENDOR_ROLES, type Role,
} from '../../domain/src/constants.js';
import { AppError, PERMISSION_MESSAGE, forbidden, notFound } from '../../shared/src/errors.js';
import type { Principal } from './principal.js';

export interface Denial {
  what: string;
  detail: string;
  /** Defaults to ACCESS_DENIED / 'ACCESS'. Other refusals worth keeping (e.g. VOUCHER_BLOCKED) set these. */
  action?: string;
  objectType?: string;
  details?: Record<string, unknown>;
  vendorId?: string;
  branchId?: string;
}

/** What a guard needs: the caller, a database handle, and somewhere to record refusals. */
export interface AuthzCtx {
  p: Principal;
  db: Queryable;
  /** Recorded OUTSIDE the request transaction, so a refusal is kept even when the work rolls back. */
  denials: Denial[];
}

export const deny = (ctx: AuthzCtx, what: string, detail = ''): void => {
  ctx.denials.push({ what, detail });
};

export const roleAllows = (allowed: readonly Role[] | '*', role: Role): boolean =>
  allowed === '*' ? true : allowed.includes(role);

export function requireRole(ctx: AuthzCtx, roles: readonly Role[], what = 'role'): void {
  if (!roles.includes(ctx.p.role)) {
    deny(ctx, what, ctx.p.role);
    throw forbidden();
  }
}

/** Qatar Mobile administrators — NOT technicians. */
export const isPlatformAdmin = (p: Principal | null): boolean =>
  !!p && p.principalType === 'STAFF' && ADMIN_ONLY.includes(p.role);

export const isBranchScoped = (p: Principal): boolean =>
  p.principalType === 'STAFF' && !p.isPlatform && !!p.branchId;

/** Only administrators may read a full IMEI (canSeeFullImei_). */
export const canSeeFullImei = (p: Principal): boolean => isPlatformAdmin(p);

export function requirePlatform(ctx: AuthzCtx): void {
  if (!ctx.p.isPlatform) {
    deny(ctx, 'platform', ctx.p.role);
    throw forbidden();
  }
}

/* ------------------------------------------------------------------ scope */

/**
 * scopeVendor_: platform staff may name any partner (null = all); partner
 * staff may not name another.
 */
export function scopeVendor(ctx: AuthzCtx, requested: string | null | undefined): string | null {
  const wanted = (requested ?? '').trim();
  if (ctx.p.isPlatform) return wanted || null;
  if (!ctx.p.vendorId) throw forbidden('Your account is not linked to a vendor.');
  if (wanted && wanted !== ctx.p.vendorId) {
    deny(ctx, 'scope.vendor', `requested ${wanted}`);
    throw forbidden();
  }
  return ctx.p.vendorId;
}

/**
 * scopeBranch_: a branch-bound user is confined to their branch; a
 * partner-wide user may name any branch OF THEIR PARTNER; platform staff
 * may name any branch. A branch id posted by a branch user that is not
 * their own is refused — this is the "submit another branch id" attack.
 */
export async function scopeBranch(ctx: AuthzCtx, requested: string | null | undefined): Promise<string | null> {
  const wanted = (requested ?? '').trim();
  if (ctx.p.isPlatform) return wanted || null;
  if (wanted) {
    const r = await ctx.db.query<{ vendor_id: string }>('select vendor_id from public.branches where id = $1', [wanted]);
    if (!r.rows[0] || r.rows[0].vendor_id !== ctx.p.vendorId) {
      deny(ctx, 'scope.branch', `requested ${wanted}`);
      throw forbidden();
    }
  }
  if (!ctx.p.branchId) return wanted || null;
  if (wanted && wanted !== ctx.p.branchId) {
    deny(ctx, 'scope.branch', `requested ${wanted}`);
    throw forbidden();
  }
  return ctx.p.branchId;
}

/** assertBranchBelongsTo_: exists, same partner, active. */
export async function assertBranchBelongsTo(db: Queryable, branchId: string, vendorId: string) {
  const r = await db.query<{ id: string; vendor_id: string; active: boolean; name: string }>(
    'select id, vendor_id, active, name from public.branches where id = $1', [branchId || '']);
  const b = r.rows[0];
  if (!b || b.vendor_id !== vendorId) throw new AppError('BUSINESS_RULE', 'That branch does not exist.');
  if (!b.active) throw new AppError('BUSINESS_RULE', 'That branch is not currently accepting trade-ins.');
  return b;
}

/** The record-level rule shared by trade-ins, vouchers and collection notes. */
function inScope(ctx: AuthzCtx, row: { vendor_id: string; branch_id: string | null }, what: string, id: string, message: string): void {
  if (ctx.p.isPlatform) return;
  if (row.vendor_id !== ctx.p.vendorId) {
    deny(ctx, `object.${what}`, id);
    throw notFound(message);
  }
  // A record with NO branch is refused to a branch-bound user too: blank must not widen access.
  if (ctx.p.branchId && (row.branch_id ?? '') !== ctx.p.branchId) {
    deny(ctx, `object.${what}.branch`, id);
    throw notFound(message);
  }
}

/**
 * loadTradeInScoped_. `lock` takes a row lock for the rest of the
 * transaction — every state change on a trade-in passes lock: true.
 */
export async function loadTradeInScoped<T extends { id: string; customer_id: string; vendor_id: string; branch_id: string }>(
  ctx: AuthzCtx, tradeInId: unknown, opts: { lock?: boolean; columns?: string } = {},
): Promise<T> {
  const id = typeof tradeInId === 'string' ? tradeInId.trim() : '';
  const msg = 'Trade-in not found.';
  if (!id) throw notFound(msg);
  const r = await ctx.db.query<T>(
    `select ${opts.columns ?? '*'} from public.trade_ins where id = $1${opts.lock ? ' for update' : ''}`, [id]);
  const t = r.rows[0];
  if (!t) throw notFound(msg);
  if (ctx.p.principalType === 'CUSTOMER') {
    if (t.customer_id !== ctx.p.principalId) {
      deny(ctx, 'object.tradein', id);
      throw notFound(msg);
    }
    return t;
  }
  inScope(ctx, t, 'tradein', id, msg);
  return t;
}

/** loadVoucherScoped_ — customer ownership falls back to the trade-in for legacy rows. */
export async function loadVoucherScoped<T extends { id: string; customer_id: string | null; vendor_id: string; branch_id: string; trade_in_id: string }>(
  ctx: AuthzCtx, voucherId: unknown, opts: { lock?: boolean } = {},
): Promise<T> {
  const id = typeof voucherId === 'string' ? voucherId.trim() : '';
  const msg = 'Voucher not found.';
  if (!id) throw notFound(msg);
  const r = await ctx.db.query<T>(`select * from public.vouchers where id = $1${opts.lock ? ' for update' : ''}`, [id]);
  const v = r.rows[0];
  if (!v) throw notFound(msg);
  if (ctx.p.principalType === 'CUSTOMER') {
    let owner = v.customer_id ?? '';
    if (!owner) {
      const t = await ctx.db.query<{ customer_id: string }>('select customer_id from public.trade_ins where id = $1', [v.trade_in_id]);
      owner = t.rows[0]?.customer_id ?? '';
    }
    if (!owner || owner !== ctx.p.principalId) {
      deny(ctx, 'object.voucher', id);
      throw notFound(msg);
    }
    return v;
  }
  inScope(ctx, v, 'voucher', id, msg);
  return v;
}

/** loadBatchScoped_ — a partner-wide (blank branch) note is refused to a branch-bound user. */
export async function loadBatchScoped<T extends { id: string; vendor_id: string; branch_id: string | null }>(
  ctx: AuthzCtx, batchId: unknown, opts: { lock?: boolean } = {},
): Promise<T> {
  const id = typeof batchId === 'string' ? batchId.trim() : '';
  const msg = 'Collection note not found.';
  if (!id) throw notFound(msg);
  const r = await ctx.db.query<T>(`select * from public.collections where id = $1${opts.lock ? ' for update' : ''}`, [id]);
  const b = r.rows[0];
  if (!b) throw notFound(msg);
  if (ctx.p.principalType === 'CUSTOMER') {
    deny(ctx, 'object.collection', id);
    throw notFound(msg);
  }
  inScope(ctx, b, 'collection', id, msg);
  return b;
}

/**
 * Settlement visibility — POLICY "A" (06b_Authz.gs settlementVisibleTo_):
 *   administrators: all; technicians: none; partner-wide: own partner;
 *   branch-bound: only a settlement whose EVERY line is in their branch.
 */
export async function settlementVisibleTo(ctx: AuthzCtx, s: { id: string; vendor_id: string }): Promise<boolean> {
  const p = ctx.p;
  if (isPlatformAdmin(p)) return true;
  if (p.isPlatform) return false;
  if (p.principalType !== 'STAFF') return false;
  if (!p.vendorId || s.vendor_id !== p.vendorId) return false;
  if (!p.branchId) return true;
  const r = await ctx.db.query<{ n: number; branches: string[] }>(
    `select count(*)::int as n, coalesce(array_agg(distinct branch_id), '{}') as branches
       from public.trade_ins where settlement_id = $1`, [s.id]);
  const info = r.rows[0];
  if (!info || !info.n) return false;
  return info.branches.length === 1 && info.branches[0] === p.branchId;
}

export const OPEN_BATCH_STATUSES = COLLECTION_OPEN_STATUSES;

/* ------------------------------------------------------------ staff admin */

export const canGrantRole = (p: Principal, role: string): boolean =>
  (ROLE_GRANTS[p.role] ?? []).includes(role as never);

export function requireCanGrantRole(ctx: AuthzCtx, role: string): void {
  if (!canGrantRole(ctx.p, role)) {
    deny(ctx, 'role.grant', role);
    throw forbidden('You do not have permission to assign that role.');
  }
}

/** 1. May this person manage staff at all? */
export function requireCanManageStaff(ctx: AuthzCtx): void {
  if (ctx.p.principalType !== 'STAFF' || !STAFF_MANAGER_ROLES.includes(ctx.p.role)) {
    deny(ctx, 'staff.manage', ctx.p.role);
    throw forbidden();
  }
}

export interface TargetUser { id: string; role: string | null; vendor_id: string | null; branch_id: string | null }

/**
 * 3. May they administer THIS account? (requireCanAdministerTarget_)
 *   - only a SUPER_ADMIN may change a SUPER_ADMIN account, in any way;
 *   - administrators may administer everybody else;
 *   - partner managers: same partner, never platform staff, own branch if
 *     branch-bound, and only people whose CURRENT role they could grant.
 */
export function requireCanAdministerTarget(ctx: AuthzCtx, target: TargetUser | null | undefined): TargetUser {
  requireCanManageStaff(ctx);
  if (!target) throw notFound('That person does not exist.');
  const tRole = target.role ?? '';
  if (tRole === 'SUPER_ADMIN' && ctx.p.role !== 'SUPER_ADMIN') {
    deny(ctx, 'staff.target.superAdmin', target.id);
    // Partner staff get the same "not found" as any out-of-scope person, so the
    // answer cannot be used to discover who the platform owners are (review finding;
    // 3.1 told them). Platform admins still get the explicit sentence.
    if (!isPlatformAdmin(ctx.p)) throw notFound('That person does not exist.');
    throw forbidden('Only a platform owner can change a platform owner\'s account.');
  }
  if (isPlatformAdmin(ctx.p)) return target;
  if ((PLATFORM_ROLES as readonly string[]).includes(tRole)) {
    deny(ctx, 'staff.target.platform', target.id);
    throw notFound('That person does not exist.');
  }
  if (!ctx.p.vendorId || (target.vendor_id ?? '') !== ctx.p.vendorId) {
    deny(ctx, 'staff.target.vendor', target.id);
    throw notFound('That person does not exist.');
  }
  if (ctx.p.branchId && (target.branch_id ?? '') !== ctx.p.branchId) {
    deny(ctx, 'staff.target.branch', target.id);
    throw notFound('That person does not exist.');
  }
  if (target.id !== ctx.p.principalId && tRole && !canGrantRole(ctx.p, tRole)) {
    deny(ctx, 'staff.target.rank', target.id);
    throw forbidden('You cannot change the account of somebody at or above your own level.');
  }
  return target;
}

/**
 * 4. Where may the account be placed? Never wider than the caller.
 * (resolveAssignableScope_)
 */
export async function resolveAssignableScope(
  ctx: AuthzCtx, role: string, requestedVendorId: string | null | undefined, requestedBranchId: string | null | undefined,
  opts: { defaultToOwnBranch?: boolean } = {},
): Promise<{ vendorId: string; branchId: string }> {
  if (!(VENDOR_ROLES as readonly string[]).includes(role)) {
    if (!isPlatformAdmin(ctx.p)) {
      deny(ctx, 'staff.scope.platformRole', role);
      throw forbidden('You cannot assign that role.');
    }
    return { vendorId: '', branchId: '' };
  }
  const wantVendor = (requestedVendorId ?? '').trim();
  let vendorId: string;
  if (isPlatformAdmin(ctx.p)) {
    vendorId = wantVendor;
  } else {
    if (wantVendor && wantVendor !== ctx.p.vendorId) {
      deny(ctx, 'staff.scope.vendor', wantVendor);
      throw forbidden();
    }
    vendorId = ctx.p.vendorId;
  }
  if (!vendorId) throw new AppError('BUSINESS_RULE', 'Choose which vendor this person works for.');
  const v = await ctx.db.query<{ status: string }>('select status from public.vendors where id = $1', [vendorId]);
  if (!v.rows[0] || v.rows[0].status !== 'ACTIVE') throw new AppError('BUSINESS_RULE', 'That vendor is not active.');

  let branchId = (requestedBranchId ?? '').trim();
  if (!isPlatformAdmin(ctx.p) && ctx.p.branchId) {
    if (!branchId && opts.defaultToOwnBranch) branchId = ctx.p.branchId;
    if (branchId !== ctx.p.branchId) {
      deny(ctx, 'staff.scope.branch', branchId || '(all branches)');
      throw forbidden('You can only assign people to your own branch.');
    }
  }
  if (branchId) branchId = (await assertBranchBelongsTo(ctx.db, branchId, vendorId)).id;
  return { vendorId, branchId };
}

/** requireBranchAdmin_: a branch-bound manager may see/edit only their own branch, never create one. */
export function requireBranchAdmin(ctx: AuthzCtx, branchId: string, creating: boolean): void {
  if (ctx.p.isPlatform || !ctx.p.branchId) return;
  if (creating || branchId !== ctx.p.branchId) {
    deny(ctx, 'branch.scope', branchId || '(new)');
    throw forbidden('You can only manage your own branch.');
  }
}

/** Financial permissions (18_Settlements.gs): prepare/submit/pay = administrators; APPROVE = SUPER_ADMIN only. */
export function requireSettlementApprover(ctx: AuthzCtx, settlementId: string): void {
  if (ctx.p.role !== 'SUPER_ADMIN') {
    deny(ctx, 'settlement.approve', settlementId);
    throw new AppError('FORBIDDEN', 'Only the platform owner can approve a settlement.');
  }
}

export { PERMISSION_MESSAGE };
