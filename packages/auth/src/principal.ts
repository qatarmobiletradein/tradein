/**
 * Who is calling — resolved FRESH from the database on every request.
 *
 * A Supabase access token proves "this person controls auth user X and
 * phone P". It says nothing current about their role, partner, branch or
 * status; those are read from app_users / customers every time, exactly
 * as 3.1 re-read the Users row on every call (05_Sessions.gs,
 * resolveStaffPrincipal_). So disabling an account, moving a branch or
 * deactivating a partner bites on the next request, not when a token
 * happens to expire.
 *
 * Revocation: a profile's auth_valid_after is compared with the token's
 * iat. Tokens issued before it are refused (3.1 revokeAllForPrincipal_).
 *
 * Linking: a profile imported from Google Sheets has no auth_user_id.
 * The first verified sign-in with that profile's phone number links it.
 * Staff take precedence over customers for the same number (identifyPhone_).
 *
 * Staff sign-in method (STAFF_SIGN_IN):
 *   phone     3.1 behaviour: staff sign in with the SMS code, linked by phone.
 *   password  staff sign in with email + password. A staff profile is then
 *             accepted ONLY for a Supabase session that was established with a
 *             password (amr) for the auth user the API provisioned for that
 *             profile (auth_user_id, never linked by a claim), and whose email
 *             is still the profile's email. A phone-code session, a password-
 *             recovery session, or a session for an address the profile no
 *             longer has, is refused. Staff are never linked by phone.
 */
import type { Queryable } from '../../database/src/db.js';
import { ASSIGNABLE_ROLES, PLATFORM_ROLES, VENDOR_ROLES, type Role } from '../../domain/src/constants.js';
import { normalizePhone } from '../../shared/src/text.js';
import type { AccessClaims } from './jwt.js';

export type PrincipalType = 'STAFF' | 'CUSTOMER';

export interface Principal {
  principalType: PrincipalType;
  principalId: string;
  authUserId: string;
  phone: string;
  name: string;
  role: Role;
  vendorId: string;
  branchId: string;
  isPlatform: boolean;
  isVendorScoped: boolean;
}

interface StaffRow {
  id: string; auth_user_id: string | null; full_name: string; phone: string; email: string | null; role: string | null;
  vendor_id: string | null; branch_id: string | null; status: string; auth_valid_after: Date;
  vendor_status: string | null; branch_active: boolean | null; branch_vendor_id: string | null;
}
interface CustomerRow {
  id: string; auth_user_id: string | null; full_name: string; phone: string; status: string; auth_valid_after: Date;
}

export type Resolution =
  | { ok: true; principal: Principal; linked: boolean }
  | { ok: false; reason: 'NO_PROFILE' | 'PENDING' | 'REJECTED' | 'DISABLED' | 'REVOKED' | 'SCOPE_INVALID' | 'CONFLICT' | 'STAFF_METHOD' };

export type StaffSignIn = 'password' | 'phone';

/** Was this session established with a password (not a code, not a recovery link)? */
export function passwordSession(c: AccessClaims): boolean {
  return Array.isArray(c.amr) && c.amr.some((a) => a?.method === 'password');
}
const sameEmail = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

const STAFF_SQL = `
  select u.id, u.auth_user_id, u.full_name, u.phone, u.email, u.role, u.vendor_id, u.branch_id, u.status,
         u.auth_valid_after, v.status as vendor_status, b.active as branch_active, b.vendor_id as branch_vendor_id
    from public.app_users u
    left join public.vendors v on v.id = u.vendor_id
    left join public.branches b on b.id = u.branch_id`;

/** Supabase stores phones as E.164 without "+": "97455123456". */
export function phoneFromClaims(c: AccessClaims): string {
  return normalizePhone(c.phone ?? '');
}

/** resolveStaffPrincipal_ — every check, in the same order. */
export function staffPrincipal(u: StaffRow, authUserId: string): Principal | null {
  if (u.status !== 'ACTIVE') return null;
  const role = (u.role ?? '') as Role;
  if (!role || !(ASSIGNABLE_ROLES as readonly string[]).includes(role)) return null;
  const vendorId = u.vendor_id ?? '';
  const branchId = u.branch_id ?? '';
  if (VENDOR_ROLES.includes(role) && !vendorId) return null;
  if (vendorId && u.vendor_status !== 'ACTIVE') return null;
  if (branchId) {
    if (u.branch_active !== true) return null;
    if (u.branch_vendor_id !== vendorId) return null;
  }
  return {
    principalType: 'STAFF', principalId: u.id, authUserId, phone: u.phone, name: u.full_name, role,
    vendorId, branchId, isPlatform: PLATFORM_ROLES.includes(role), isVendorScoped: VENDOR_ROLES.includes(role),
  };
}

function staffRefusal(u: StaffRow): Resolution {
  if (u.status === 'PENDING_APPROVAL') return { ok: false, reason: 'PENDING' };
  if (u.status === 'REJECTED') return { ok: false, reason: 'REJECTED' };
  if (u.status === 'DISABLED') return { ok: false, reason: 'DISABLED' };
  return { ok: false, reason: 'SCOPE_INVALID' };
}

/**
 * Resolve (and if necessary link) the principal for verified claims.
 * `db` must be a transaction when linking is allowed, so the link and its
 * audit row commit together.
 */
export async function resolvePrincipal(
  db: Queryable, claims: AccessClaims, opts: { allowLink: boolean; staffSignIn?: StaffSignIn },
): Promise<Resolution> {
  const sub = claims.sub;
  const phone = phoneFromClaims(claims);
  const iat = new Date(claims.iat * 1000);
  const staffByPassword = opts.staffSignIn === 'password';

  // ---- staff first (identifyPhone_ precedence) ------------------------
  let staff = (await db.query<StaffRow>(`${STAFF_SQL} where u.auth_user_id = $1`, [sub])).rows[0];
  let linked = false;
  if (staffByPassword) {
    if (staff) {
      if (!passwordSession(claims) || !sameEmail(claims.email, staff.email)) return { ok: false, reason: 'STAFF_METHOD' };
    } else if (phone && (await db.query('select 1 from public.app_users where phone = $1', [phone])).rowCount) {
      // A phone-code session for a staff number: never a staff session, never linked.
      return { ok: false, reason: 'STAFF_METHOD' };
    }
  } else if (!staff && phone) {
    const byPhone = (await db.query<StaffRow>(`${STAFF_SQL} where u.phone = $1`, [phone])).rows[0];
    if (byPhone) {
      if (byPhone.auth_user_id && byPhone.auth_user_id !== sub) return { ok: false, reason: 'CONFLICT' };
      if (!opts.allowLink) return { ok: false, reason: 'NO_PROFILE' };
      const r = await db.query(
        'update public.app_users set auth_user_id = $1 where id = $2 and auth_user_id is null', [sub, byPhone.id]);
      if (r.rowCount !== 1) return { ok: false, reason: 'CONFLICT' };
      staff = { ...byPhone, auth_user_id: sub };
      linked = true;
    }
  }
  if (staff) {
    if (iat.getTime() < new Date(staff.auth_valid_after).getTime()) return { ok: false, reason: 'REVOKED' };
    const p = staffPrincipal(staff, sub);
    return p ? { ok: true, principal: p, linked } : staffRefusal(staff);
  }

  // ---- then customers -------------------------------------------------
  let cust = (await db.query<CustomerRow>(
    'select id, auth_user_id, full_name, phone, status, auth_valid_after from public.customers where auth_user_id = $1', [sub])).rows[0];
  if (!cust && phone) {
    const byPhone = (await db.query<CustomerRow>(
      'select id, auth_user_id, full_name, phone, status, auth_valid_after from public.customers where phone = $1', [phone])).rows[0];
    if (byPhone) {
      if (byPhone.auth_user_id && byPhone.auth_user_id !== sub) return { ok: false, reason: 'CONFLICT' };
      if (!opts.allowLink) return { ok: false, reason: 'NO_PROFILE' };
      const r = await db.query(
        'update public.customers set auth_user_id = $1 where id = $2 and auth_user_id is null', [sub, byPhone.id]);
      if (r.rowCount !== 1) return { ok: false, reason: 'CONFLICT' };
      cust = { ...byPhone, auth_user_id: sub };
      linked = true;
    }
  }
  if (cust) {
    if (iat.getTime() < new Date(cust.auth_valid_after).getTime()) return { ok: false, reason: 'REVOKED' };
    if (cust.status !== 'ACTIVE') return { ok: false, reason: 'DISABLED' };
    return {
      ok: true, linked,
      principal: {
        principalType: 'CUSTOMER', principalId: cust.id, authUserId: sub, phone: cust.phone, name: cust.full_name,
        role: 'CUSTOMER', vendorId: '', branchId: '', isPlatform: false, isVendorScoped: false,
      },
    };
  }
  return { ok: false, reason: 'NO_PROFILE' };
}

/** Sentences for the sign-in screen (apiAuthStart_ / apiAuthVerify_ wording). */
export const REFUSAL_MESSAGES: Record<string, string> = {
  NO_PROFILE: 'We do not have an account for this number.',
  PENDING: 'Your access request is still waiting for administrator approval.',
  REJECTED: 'This access request was not approved.',
  DISABLED: 'This account has been disabled.',
  REVOKED: 'Your session has ended. Please sign in again.',
  SCOPE_INVALID: 'This account is not active.',
  CONFLICT: 'This account cannot be signed in to. Please contact support.',
  STAFF_METHOD: 'Staff accounts sign in with email and password. Choose “Staff sign-in”.',
};
