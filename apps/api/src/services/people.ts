/**
 * Staff (21_Admin.gs + 06b_Authz.gs), customers (13_Customers.gs),
 * partners and branches (07_Vendors.gs, 08_Branches.gs) and settings.
 *
 * Every staff path asks the four questions in the same order: may you
 * manage staff · may you grant this role · may you touch this account ·
 * may you place it in this partner and branch. Any change to role,
 * partner, branch or status revokes the person's existing sessions
 * (auth_valid_after), and the last active SUPER_ADMIN is protected by a
 * trigger as well as here.
 */
import {
  ACTIONS, ASSIGNABLE_ROLES, BILLABLE_STATUSES, CURRENCY, DEFAULT_COMMISSION_RATE, EDITABLE_SETTINGS, PLATFORM_ROLES, ROLE_GRANTS,
  ROLE_LABELS, VENDOR_ROLES, type Role,
} from '../../../../packages/domain/src/constants.js';
import {
  deny, isBranchScoped, requireBranchAdmin, requireCanAdministerTarget, requireCanGrantRole, requireCanManageStaff,
  resolveAssignableScope, scopeVendor,
} from '../../../../packages/auth/src/authz.js';
import { fail, notFound } from '../../../../packages/shared/src/errors.js';
import { centsToNumber, microToDecimal, toCentsOrNull, toMicro } from '../../../../packages/shared/src/money.js';
import { formatPhone, isBlank, maskEmail, maskPhone, normalizeEmail, normalizePhone, phoneKey, safeHttpsUrl, trim, truthy } from '../../../../packages/shared/src/text.js';
import { staffEmailTaken } from './auth.js';
import { fmtDate, fmtDateTime } from '../../../../packages/shared/src/time.js';
import type { Ctx } from '../context.js';
import { audit } from '../lib/audit.js';
import { nextId } from '../lib/ids.js';
import { appendNote, clampLimit, updateById } from './sql.js';
import { seedVendorCommission } from './pricing.js';
import { Lookups, adminTradeInView, type TradeInRow } from './views.js';

const now = (): Date => new Date();
const byPassword = (ctx: Ctx) => ctx.deps.config.STAFF_SIGN_IN === 'password';
const HOW_TO_START = 'On the sign-in screen they choose “Staff sign-in”, then “Set or reset password”, and use the code we email them.';

/**
 * A staff email is a sign-in identifier: valid, unique (case-insensitive) and,
 * with STAFF_SIGN_IN=password, required. Returns the stored form or null.
 */
async function staffEmailFor(ctx: Ctx, raw: unknown, userId = ''): Promise<string | null> {
  const typed = trim(raw);
  const email = normalizeEmail(typed);
  if (typed && !email) throw fail('Enter a valid email address.');
  if (!email) {
    if (byPassword(ctx)) throw fail('Enter their work email address — staff sign in with email and password.');
    return null;
  }
  if (await staffEmailTaken(ctx.db, email, userId)) throw fail('That email address is already used by another staff account.');
  return email;
}

interface UserRow {
  id: string; full_name: string; phone: string; email: string | null; role: Role | null; vendor_id: string | null; branch_id: string | null;
  status: string; approved_by: string | null; last_login_at: Date | null; created_at: Date; notes: string | null;
}

async function staffView(L: Lookups, u: UserRow) {
  return {
    userId: u.id, name: u.full_name, phone: formatPhone(u.phone), email: u.email ?? '', role: u.role ?? '',
    roleLabel: u.role ? ROLE_LABELS[u.role] ?? u.role : '(no role yet)', vendorId: u.vendor_id ?? '',
    vendorName: u.vendor_id ? (await L.vendor(u.vendor_id))?.name ?? '' : '', branchId: u.branch_id ?? '',
    branchName: (await L.branch(u.branch_id))?.name ?? '', status: u.status, active: u.status === 'ACTIVE',
    pending: u.status === 'PENDING_APPROVAL', approvedBy: u.approved_by ?? '', lastLogin: fmtDateTime(u.last_login_at),
    createdDate: fmtDate(u.created_at), notes: u.notes ?? '',
  };
}

/** listStaff_: filtered from the principal; partner managers never see platform staff. */
export async function listStaff(ctx: Ctx, f: { status?: string; role?: string; vendorId?: string; search?: string }) {
  requireCanManageStaff(ctx);
  const rows = (await ctx.db.query<UserRow>('select * from public.app_users')).rows.filter((u) => {
    if (!ctx.p.isPlatform) {
      if ((u.vendor_id ?? '') !== ctx.p.vendorId) return false;
      if (u.role && PLATFORM_ROLES.includes(u.role)) return false;
      if (ctx.p.branchId && (u.branch_id ?? '') !== ctx.p.branchId) return false;
    }
    if (f.status && u.status !== f.status) return false;
    if (f.role && u.role !== f.role) return false;
    if (f.vendorId && (u.vendor_id ?? '') !== f.vendorId) return false;
    if (f.search) {
      const q = f.search.toLowerCase(); const key = phoneKey(f.search);
      if (!u.full_name.toLowerCase().includes(q) && !(key && phoneKey(u.phone).includes(key)) && !(u.email ?? '').toLowerCase().includes(q)) return false;
    }
    return true;
  }).sort((a, b) => {
    const ap = a.status === 'PENDING_APPROVAL' ? 0 : 1; const bp = b.status === 'PENDING_APPROVAL' ? 0 : 1;
    return ap !== bp ? ap - bp : a.full_name.localeCompare(b.full_name);
  });
  const L = new Lookups(ctx.db);
  const staff = [];
  for (const u of rows) staff.push(await staffView(L, u));
  return {
    ok: true, total: rows.length, pending: rows.filter((u) => u.status === 'PENDING_APPROVAL').length, staff,
    grantableRoles: (ROLE_GRANTS[ctx.p.role] ?? []).map((r) => ({ role: r, label: ROLE_LABELS[r] ?? r, isVendorRole: VENDOR_ROLES.includes(r) })),
    canAssignAllBranches: ctx.p.isPlatform || !ctx.p.branchId,
  };
}

async function loadUser(ctx: Ctx, userId: unknown): Promise<UserRow> {
  const u = (await ctx.db.query<UserRow>('select * from public.app_users where id = $1 for update', [trim(userId)])).rows[0];
  if (!u) throw notFound('That person does not exist.');
  return u;
}

/** approveStaff_: the applicant's own choices are ignored; role/partner/branch are decided here. */
export async function approveStaff(ctx: Ctx, d: { userId?: string; role?: string; vendorId?: string; branchId?: string; email?: string; notes?: string }) {
  requireCanManageStaff(ctx);
  const u = await loadUser(ctx, d.userId);
  requireCanAdministerTarget(ctx, u);
  if (u.status !== 'PENDING_APPROVAL') throw fail('That access request has already been dealt with.');
  const role = trim(d.role).toUpperCase();
  if (!(ASSIGNABLE_ROLES as readonly string[]).includes(role)) throw fail('Choose a role.');
  requireCanGrantRole(ctx, role);
  const scope = await resolveAssignableScope(ctx, role, d.vendorId, d.branchId, { defaultToOwnBranch: true });
  // The administrator may correct the applicant's address while approving.
  const email = await staffEmailFor(ctx, isBlank(d.email) ? u.email : d.email, u.id);
  await updateById(ctx.db, 'app_users', u.id, {
    role, vendor_id: scope.vendorId || null, branch_id: scope.branchId || null, status: 'ACTIVE', approved_by: ctx.p.principalId,
    approved_at: now(), notes: appendNote(u.notes, d.notes, fmtDateTime(now())) || null, email,
  });
  await audit(ctx, ACTIONS.STAFF_APPROVED, 'USER', u.id, { oldValue: 'PENDING_APPROVAL', newValue: role,
    details: { vendorId: scope.vendorId, branchId: scope.branchId, approvedBy: ctx.p.name, ...(email ? { email: maskEmail(email) } : {}) } });
  const label = ROLE_LABELS[role as Role] ?? role;
  return { ok: true, message: byPassword(ctx) ? `${u.full_name} is approved as ${label}. ${HOW_TO_START}` : `${u.full_name} can now sign in as ${label}.` };
}

export async function rejectStaff(ctx: Ctx, d: { userId?: string; reason?: string }) {
  requireCanManageStaff(ctx);
  const u = await loadUser(ctx, d.userId);
  requireCanAdministerTarget(ctx, u);
  if (u.status !== 'PENDING_APPROVAL') throw fail('That access request has already been dealt with.');
  await updateById(ctx.db, 'app_users', u.id, { status: 'REJECTED', notes: appendNote(u.notes, `Rejected: ${trim(d.reason)}`, fmtDateTime(now())) });
  await audit(ctx, ACTIONS.STAFF_REJECTED, 'USER', u.id, { details: { reason: trim(d.reason) } });
  return { ok: true, message: 'Access request rejected.' };
}

/** updateStaff_: never your own role/partner/branch/status; SUPER_ADMIN only by SUPER_ADMIN; sessions revoked on change. */
export async function updateStaff(ctx: Ctx, d: { userId?: string; role?: string; status?: string; vendorId?: string; branchId?: string; fullName?: string; email?: string; notes?: string }) {
  requireCanManageStaff(ctx);
  const u = await loadUser(ctx, d.userId);
  requireCanAdministerTarget(ctx, u);
  const self = u.id === ctx.p.principalId;
  const currentRole = u.role ?? '';
  const wantRole = d.role !== undefined ? trim(d.role).toUpperCase() : currentRole;
  const wantStatus = d.status !== undefined ? trim(d.status).toUpperCase() : u.status;
  const roleChanges = wantRole !== currentRole;
  const statusChanges = wantStatus !== u.status;
  const vendorAsked = d.vendorId !== undefined && trim(d.vendorId) !== (u.vendor_id ?? '') && !(!ctx.p.isPlatform && trim(d.vendorId) === '');
  const branchAsked = d.branchId !== undefined && trim(d.branchId) !== (u.branch_id ?? '');
  if (self && (roleChanges || statusChanges || vendorAsked || branchAsked)) {
    deny(ctx, 'staff.self', u.id);
    throw fail('You cannot change your own role, vendor, branch or status. Ask another administrator.');
  }
  const changes: Record<string, unknown> = {};
  const audits: { action: string; from: string; to: string }[] = [];
  if (roleChanges) {
    if (!(ASSIGNABLE_ROLES as readonly string[]).includes(wantRole)) throw fail('That is not a role.');
    requireCanGrantRole(ctx, wantRole);
    changes.role = wantRole;
    audits.push({ action: ACTIONS.ROLE_CHANGED, from: currentRole, to: wantRole });
  }
  if (roleChanges || vendorAsked || branchAsked) {
    const nextVendor = vendorAsked ? trim(d.vendorId) : (u.vendor_id ?? '');
    const nextBranch = branchAsked ? trim(d.branchId) : (vendorAsked ? '' : (u.branch_id ?? ''));
    const scope = await resolveAssignableScope(ctx, wantRole, nextVendor, nextBranch, { defaultToOwnBranch: false });
    if (scope.vendorId !== (u.vendor_id ?? '')) { changes.vendor_id = scope.vendorId || null; audits.push({ action: ACTIONS.VENDOR_ASSIGNED, from: u.vendor_id ?? '', to: scope.vendorId }); }
    if (scope.branchId !== (u.branch_id ?? '')) { changes.branch_id = scope.branchId || null; audits.push({ action: ACTIONS.BRANCH_ASSIGNED, from: u.branch_id ?? '', to: scope.branchId }); }
  }
  if (statusChanges) {
    if (wantStatus !== 'ACTIVE' && wantStatus !== 'DISABLED') throw fail('A member of staff is either active or disabled.');
    changes.status = wantStatus;
    audits.push({ action: wantStatus === 'ACTIVE' ? ACTIONS.STAFF_ENABLED : ACTIONS.STAFF_DISABLED, from: u.status, to: wantStatus });
  }
  if (d.fullName !== undefined && trim(d.fullName) && trim(d.fullName) !== u.full_name) changes.full_name = trim(d.fullName);
  if (d.email !== undefined && trim(d.email).toLowerCase() !== (u.email ?? '').toLowerCase()) {
    if (isBlank(d.email) && byPassword(ctx)) throw fail('Staff need an email address to sign in.');
    changes.email = await staffEmailFor(ctx, d.email, u.id);
    // Email sign-in: the person's Supabase Auth user (old address, old password, and any refresh token
    // issued for it) is unlinked at once, so nothing minted from it is ever this profile's session again.
    // The next "set or reset password" for the new address sets up a fresh Auth user.
    if (byPassword(ctx)) changes.auth_user_id = null;
  }
  if (d.notes !== undefined && trim(d.notes)) changes.notes = appendNote(u.notes, d.notes, fmtDateTime(now()));
  if (!Object.keys(changes).length) return { ok: true, message: 'Nothing changed.', unchanged: true };
  // A new sign-in address ends the person's sessions; they set a password for the new address.
  const revoke = changes.role !== undefined || changes.vendor_id !== undefined || changes.branch_id !== undefined || changes.status !== undefined
    || changes.email !== undefined;
  if (revoke) changes.auth_valid_after = now();
  // The last-SUPER_ADMIN trigger refuses a demotion/disable that would leave none.
  await updateById(ctx.db, 'app_users', u.id, changes);
  for (const a of audits) await audit(ctx, a.action, 'USER', u.id, { oldValue: a.from, newValue: a.to });
  if (changes.email !== undefined) {
    await audit(ctx, 'STAFF_EMAIL_CHANGED', 'USER', u.id, { oldValue: u.email ? maskEmail(u.email) : '', newValue: changes.email ? maskEmail(String(changes.email)) : '' });
  }
  const who = String(changes.full_name ?? u.full_name);
  return { ok: true, message: changes.email !== undefined && byPassword(ctx) ? `${who} updated. They need to set a password for the new address. ${HOW_TO_START}` : `${who} updated.` };
}

/** createStaff_: same rules as approval; starts active; never wider than the creator. */
export async function createStaff(ctx: Ctx, d: { phone?: string; fullName?: string; role?: string; vendorId?: string; branchId?: string; email?: string; notes?: string }) {
  requireCanManageStaff(ctx);
  const phone = normalizePhone(d.phone);
  if (!phone) throw fail('Enter a valid Qatar mobile number.');
  const name = trim(d.fullName);
  if (name.length < 3) throw fail('Enter their full name.');
  const role = trim(d.role).toUpperCase();
  if (!(ASSIGNABLE_ROLES as readonly string[]).includes(role)) throw fail('Choose a role.');
  requireCanGrantRole(ctx, role);
  const scope = await resolveAssignableScope(ctx, role, d.vendorId, d.branchId, { defaultToOwnBranch: true });
  await ctx.db.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`qm.register:${phone}`]);
  const clash = await ctx.db.query('select 1 from public.app_users where phone = $1 union all select 1 from public.customers where phone = $1', [phone]);
  if (clash.rowCount) throw fail('That number already has an account.');
  const email = await staffEmailFor(ctx, d.email);
  const id = await nextId(ctx.db, 'USR');
  await ctx.db.query(`insert into public.app_users (id, full_name, phone, email, role, vendor_id, branch_id, status, approved_by, approved_at, notes)
    values ($1,$2,$3,$4,$5,$6,$7,'ACTIVE',$8,now(),$9)`, [id, name, phone, email, role, scope.vendorId || null, scope.branchId || null, ctx.p.principalId, trim(d.notes) || null]);
  await audit(ctx, ACTIONS.STAFF_APPROVED, 'USER', id, { newValue: role,
    details: { vendorId: scope.vendorId, branchId: scope.branchId, createdDirectly: true, phone: maskPhone(phone), ...(email ? { email: maskEmail(email) } : {}) } });
  return { ok: true, userId: id, message: byPassword(ctx) ? `${name} can sign in with ${email}. ${HOW_TO_START}` : `${name} can sign in with their mobile number.` };
}

/** vendor.saveStaff: mode CREATE | APPROVE | REJECT | (update). */
export async function saveStaffByMode(ctx: Ctx, p: Record<string, string | undefined>) {
  const mode = trim(p.mode).toUpperCase();
  if (mode === 'CREATE') return createStaff(ctx, p);
  if (mode === 'APPROVE') return approveStaff(ctx, p);
  if (mode === 'REJECT') return rejectStaff(ctx, p);
  return updateStaff(ctx, p);
}

/* -------------------------------------------------------------- customers */

interface CustomerRow { id: string; full_name: string; phone: string; email: string | null; status: string; last_login_at: Date | null; created_at: Date; notes: string | null }

async function adminCustomerView(ctx: Ctx, c: CustomerRow) {
  const s = (await ctx.db.query<{ n: number; paid: string }>(
    `select count(*)::int as n, coalesce(sum(final_customer_value) filter (where status = any($2::text[])), 0)::text as paid
       from public.trade_ins where customer_id = $1`, [c.id, BILLABLE_STATUSES])).rows[0]!;
  return {
    customerId: c.id, name: c.full_name, phone: formatPhone(c.phone), email: c.email ?? '', status: c.status, active: c.status === 'ACTIVE',
    tradeInCount: s.n, totalPaid: centsToNumber(toCentsOrNull(s.paid) ?? 0), currency: CURRENCY, lastLogin: fmtDateTime(c.last_login_at),
    createdDate: fmtDate(c.created_at), notes: c.notes ?? '',
  };
}

export async function listCustomers(ctx: Ctx, f: { status?: string; search?: string; limit?: number }) {
  const search = trim(f.search).toLowerCase(); const key = phoneKey(f.search);
  const rows = (await ctx.db.query<CustomerRow>('select * from public.customers order by created_at desc')).rows.filter((c) => {
    if (f.status && c.status !== f.status) return false;
    if (!search) return true;
    return c.full_name.toLowerCase().includes(search) || (!!key && phoneKey(c.phone).includes(key)) || (c.email ?? '').toLowerCase().includes(search);
  });
  const limit = clampLimit(f.limit, 200, 1000);
  const customers = [];
  for (const c of rows.slice(0, limit)) customers.push(await adminCustomerView(ctx, c));
  return { ok: true, total: rows.length, shown: Math.min(rows.length, limit), customers };
}

/** admin.customer: detail, or a status change when `status` is sent. */
export async function adminCustomer(ctx: Ctx, p: { customerId?: string; status?: string; reason?: string }) {
  const c = (await ctx.db.query<CustomerRow>(`select * from public.customers where id = $1${p.status ? ' for update' : ''}`, [trim(p.customerId)])).rows[0];
  if (!c) throw fail('That customer does not exist.');
  if (p.status) {
    const want = trim(p.status).toUpperCase();
    if (want !== 'ACTIVE' && want !== 'DISABLED') throw fail('A customer is either active or disabled.');
    if (want === 'DISABLED' && isBlank(p.reason)) throw fail('Say why this account is being disabled.');
    const open = (await ctx.db.query<{ n: number }>(`select count(*)::int as n from public.trade_ins where customer_id = $1 and status not in ('CLOSED','CANCELLED')`, [c.id])).rows[0]!.n;
    await updateById(ctx.db, 'customers', c.id, {
      status: want, notes: want === 'DISABLED' ? `${c.notes ?? ''} | Disabled: ${trim(p.reason)}` : c.notes,
      auth_valid_after: want === 'DISABLED' ? now() : undefined,
    });
    await audit(ctx, want === 'ACTIVE' ? ACTIONS.STAFF_ENABLED : ACTIONS.STAFF_DISABLED, 'CUSTOMER', c.id, {
      oldValue: c.status, newValue: want, details: { reason: trim(p.reason), openTradeIns: open } });
    return { ok: true, message: want === 'DISABLED' ? (open > 0 ? `Account disabled. ${open} trade-in(s) are still open and must be resolved.` : 'Account disabled.') : 'Account enabled.' };
  }
  const view: Record<string, unknown> = await adminCustomerView(ctx, c);
  const L = new Lookups(ctx.db);
  const t = (await ctx.db.query<TradeInRow>('select * from public.trade_ins where customer_id = $1 order by created_at desc', [c.id])).rows;
  const list = [];
  for (const r of t) list.push(await adminTradeInView(L, r));
  view.tradeIns = list;
  return { ok: true, customer: view };
}

/** customer.updateProfile: name and email only — the phone is the credential. */
export async function updateOwnProfile(ctx: Ctx, d: { fullName?: string; email?: string }) {
  if (ctx.p.principalType !== 'CUSTOMER') throw fail('Account not found.');
  const name = trim(d.fullName);
  if (name.length < 3) throw fail('Please enter your full name.');
  await updateById(ctx.db, 'customers', ctx.p.principalId, { full_name: name, email: trim(d.email) || null });
  await audit(ctx, ACTIONS.CUSTOMER_PROFILE_UPDATED, 'CUSTOMER', ctx.p.principalId, {});
  const c = (await ctx.db.query<CustomerRow>('select * from public.customers where id = $1', [ctx.p.principalId])).rows[0]!;
  return { ok: true, message: 'Your details were saved.', customer: { customerId: c.id, name: c.full_name, phone: formatPhone(c.phone), email: c.email ?? '', memberSince: fmtDate(c.created_at) } };
}

/* -------------------------------------------------------- partners/branches */

interface VendorRow { id: string; name: string; code: string; logo_url: string | null; default_commission_rate: string; status: string; contact_name: string | null; contact_phone: string | null; contact_email: string | null; settlement_terms: string | null; created_at: Date; notes: string | null }
interface BranchRow { id: string; vendor_id: string; name: string; code: string | null; address: string | null; location: string | null; contact_phone: string | null; active: boolean; display_order: number; created_at: Date; notes: string | null }

export async function adminVendors(ctx: Ctx) {
  const rows = (await ctx.db.query<VendorRow & { branch_count: number; active_branches: number; staff_count: number; trade_in_count: number }>(
    `select v.*,
       (select count(*)::int from public.branches b where b.vendor_id = v.id) as branch_count,
       (select count(*)::int from public.branches b where b.vendor_id = v.id and b.active) as active_branches,
       (select count(*)::int from public.app_users u where u.vendor_id = v.id and u.status = 'ACTIVE') as staff_count,
       (select count(*)::int from public.trade_ins t where t.vendor_id = v.id) as trade_in_count
     from public.vendors v order by v.name`)).rows;
  return {
    ok: true,
    vendors: rows.map((v) => {
      const rate = Number(v.default_commission_rate) || 0;
      return {
        vendorId: v.id, name: v.name, code: v.code, logoUrl: safeHttpsUrl(v.logo_url), status: v.status, active: v.status === 'ACTIVE',
        commissionRate: rate, commissionLabel: `${(rate * 100).toFixed(2).replace(/\.?0+$/, '')}%`, contactName: v.contact_name ?? '',
        contactPhone: formatPhone(v.contact_phone), contactEmail: v.contact_email ?? '', settlementTerms: v.settlement_terms ?? '',
        branchCount: v.branch_count, activeBranches: v.active_branches, staffCount: v.staff_count, tradeInCount: v.trade_in_count,
        createdDate: fmtDate(v.created_at), notes: v.notes ?? '',
      };
    }),
  };
}

/** saveVendor_: the code is 2–6 characters, unique, and frozen once created. Deactivation revokes the partner's sessions. */
export async function saveVendor(ctx: Ctx, d: { vendorId?: string; name?: string; code?: string; logoUrl?: string; commissionRate?: unknown; status?: string; contactName?: string; contactPhone?: string; contactEmail?: string; settlementTerms?: string; notes?: string }) {
  const name = trim(d.name);
  if (name.length < 2) throw fail('Enter the vendor name.');
  const existing = d.vendorId ? (await ctx.db.query<VendorRow>('select * from public.vendors where id = $1 for update', [d.vendorId])).rows[0] : undefined;
  if (d.vendorId && !existing) throw fail('That vendor does not exist.');
  const code = trim(d.code).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!existing) {
    if (code.length < 2 || code.length > 6) throw fail('The vendor code is two to six letters, such as CAR.');
    if ((await ctx.db.query('select 1 from public.vendors where upper(code) = $1', [code])).rowCount) throw fail('That vendor code is already in use.');
  } else if (code && code !== existing.code.toUpperCase()) {
    throw fail('A vendor code cannot be changed — trade-in numbers already use it.');
  }
  const logo = trim(d.logoUrl);
  if (logo && (!/^https:\/\//i.test(logo) || !safeHttpsUrl(logo))) throw fail('Image links must be a full https:// address.');
  let rate: bigint;
  try { rate = toMicro(d.commissionRate); } catch { throw fail('The commission rate is a fraction between 0 and 1. Five percent is 0.05.'); }
  if (rate < 0n || rate > 1_000_000n) throw fail('The commission rate is a fraction between 0 and 1. Five percent is 0.05.');
  const status = trim(d.status).toUpperCase() === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';
  const row = {
    name, default_commission_rate: microToDecimal(rate), status, contact_name: trim(d.contactName) || null,
    contact_phone: normalizePhone(d.contactPhone) || trim(d.contactPhone) || null, contact_email: trim(d.contactEmail) || null,
    settlement_terms: trim(d.settlementTerms) || null, notes: trim(d.notes) || null,
  };
  if (existing) {
    await updateById(ctx.db, 'vendors', existing.id, row);
    if (existing.status === 'ACTIVE' && status === 'INACTIVE') {
      await ctx.db.query('update public.app_users set auth_valid_after = now() where vendor_id = $1', [existing.id]);
    }
    await audit(ctx, ACTIONS.VENDOR_UPDATED, 'VENDOR', existing.id, {
      oldValue: { name: existing.name, status: existing.status, rate: Number(existing.default_commission_rate) },
      newValue: { name, status, rate: Number(microToDecimal(rate)) }, vendorId: existing.id,
    });
    return { ok: true, vendorId: existing.id, message: 'Vendor saved.' };
  }
  const id = await nextId(ctx.db, 'VND');
  await ctx.db.query(`insert into public.vendors (id, name, code, logo_url, default_commission_rate, status, contact_name, contact_phone, contact_email, settlement_terms, notes)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, name, code, logo || null, row.default_commission_rate, status, row.contact_name, row.contact_phone, row.contact_email, row.settlement_terms, row.notes]);
  await seedVendorCommission(ctx, id, row.default_commission_rate || DEFAULT_COMMISSION_RATE);
  await audit(ctx, ACTIONS.VENDOR_CREATED, 'VENDOR', id, { newValue: { name, code, rate: Number(row.default_commission_rate) }, vendorId: id });
  return { ok: true, vendorId: id, message: 'Vendor created.' };
}

async function branchView(ctx: Ctx, b: BranchRow) {
  const c = (await ctx.db.query<{ staff: number; tradeins: number }>(
    `select (select count(*)::int from public.app_users where branch_id = $1 and status = 'ACTIVE') as staff,
            (select count(*)::int from public.trade_ins where branch_id = $1) as tradeins`, [b.id])).rows[0]!;
  return {
    branchId: b.id, vendorId: b.vendor_id, name: b.name, code: b.code ?? '', address: b.address ?? '', location: b.location ?? '',
    phone: formatPhone(b.contact_phone), active: b.active, displayOrder: b.display_order || 99, staffCount: c.staff, tradeInCount: c.tradeins,
    createdDate: fmtDate(b.created_at), notes: b.notes ?? '',
  };
}

export async function listBranches(ctx: Ctx, vendorId: string | null) {
  const rows = (await ctx.db.query<BranchRow>(`select * from public.branches ${vendorId ? 'where vendor_id = $1' : ''} order by display_order, name`, vendorId ? [vendorId] : [])).rows;
  const out = [];
  for (const b of rows) out.push(await branchView(ctx, b));
  return out;
}

/** vendor.branches: own partner; a branch-bound manager sees their own branch only. */
export async function vendorBranches(ctx: Ctx, p: { vendorId?: string }) {
  const vendorId = scopeVendor(ctx, p.vendorId);
  let rows = await listBranches(ctx, vendorId);
  if (isBranchScoped(ctx.p)) rows = rows.filter((b) => b.branchId === ctx.p.branchId);
  return { ok: true, branches: rows };
}

/** saveBranch_: a branch never changes partner; closing it revokes the sessions of its staff. */
export async function saveBranch(ctx: Ctx, vendorId: string, d: { branchId?: string; name?: string; code?: string; address?: string; location?: string; phone?: string; active?: unknown; displayOrder?: unknown; notes?: string }) {
  if (!(await ctx.db.query('select 1 from public.vendors where id = $1', [vendorId])).rowCount) throw fail('That vendor does not exist.');
  const name = trim(d.name);
  if (name.length < 2) throw fail('Enter the branch name.');
  const existing = d.branchId ? (await ctx.db.query<BranchRow>('select * from public.branches where id = $1 for update', [d.branchId])).rows[0] : undefined;
  if (d.branchId && !existing) throw fail('That branch does not exist.');
  if (existing && existing.vendor_id !== vendorId) {
    deny(ctx, 'branch.vendorMismatch', existing.id);
    throw fail('That branch belongs to a different vendor.');
  }
  const isActive = d.active === undefined ? true : truthy(d.active);
  const row = {
    name, code: trim(d.code).toUpperCase().replace(/[^A-Z0-9-]/g, '') || null, address: trim(d.address) || null, location: trim(d.location) || null,
    contact_phone: normalizePhone(d.phone) || trim(d.phone) || null, active: isActive, display_order: Number(d.displayOrder) || 99, notes: trim(d.notes) || null,
  };
  if (existing) {
    await updateById(ctx.db, 'branches', existing.id, row);
    if (existing.active && !isActive) await ctx.db.query('update public.app_users set auth_valid_after = now() where branch_id = $1', [existing.id]);
    await audit(ctx, ACTIONS.BRANCH_UPDATED, 'BRANCH', existing.id, { oldValue: { name: existing.name, active: existing.active },
      newValue: { name, active: isActive }, details: { vendorId }, vendorId, branchId: existing.id });
    return { ok: true, branchId: existing.id, message: 'Branch saved.' };
  }
  const id = await nextId(ctx.db, 'BR');
  await ctx.db.query(`insert into public.branches (id, vendor_id, name, code, address, location, contact_phone, active, display_order, notes)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, vendorId, name, row.code, row.address, row.location, row.contact_phone, isActive, row.display_order, row.notes]);
  await audit(ctx, ACTIONS.BRANCH_CREATED, 'BRANCH', id, { newValue: { name, vendorId }, vendorId, branchId: id });
  return { ok: true, branchId: id, message: 'Branch created.' };
}

/** vendor.saveBranch: partner scoped; a branch-bound manager edits only their own branch and cannot create one. */
export async function vendorSaveBranch(ctx: Ctx, p: { vendorId?: string; branchId?: string } & Record<string, unknown>) {
  const vendorId = scopeVendor(ctx, p.vendorId);
  if (!vendorId) throw fail('Choose a vendor.');
  requireBranchAdmin(ctx, trim(p.branchId), !trim(p.branchId));
  return saveBranch(ctx, vendorId, p as never);
}

/* ---------------------------------------------------------------- settings */

export async function listSettings(ctx: Ctx) {
  const rows = (await ctx.db.query<{ key: string; value: string }>('select key, value from public.settings where key = any($1::text[])', [EDITABLE_SETTINGS.map((s) => s.key)])).rows;
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  return EDITABLE_SETTINGS.map((s) => ({ key: s.key, label: s.label, section: s.section, type: s.type, value: byKey.get(s.key) ?? '' }));
}

/** saveSetting_: a whitelist, not validation of an arbitrary key. SUPER_ADMIN only (registry). */
export async function saveSetting(ctx: Ctx, p: { key?: string; value?: unknown }) {
  const spec = EDITABLE_SETTINGS.find((s) => s.key === trim(p.key));
  if (!spec) throw fail('That setting cannot be changed here.');
  const value = p.value === undefined || p.value === null ? '' : String(p.value).trim().slice(0, 2000);
  if (spec.type === 'NUMBER' && !Number.isFinite(Number(value))) throw fail('That setting needs a number.');
  const before = (await ctx.db.query<{ value: string }>('select value from public.settings where key = $1 for update', [spec.key])).rows[0]?.value ?? '';
  await ctx.db.query(`insert into public.settings (key, value, type, section, description, updated_by, updated_at) values ($1,$2,$3,$4,$5,$6,now())
    on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [spec.key, value, spec.type, spec.section, spec.label, ctx.p.principalId]);
  await audit(ctx, ACTIONS.SETTINGS_CHANGED, 'SETTING', spec.key, { oldValue: before, newValue: value });
  return { ok: true, message: `${spec.label} saved.` };
}

export { PLATFORM_ROLES };
