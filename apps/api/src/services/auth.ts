/**
 * Sign-in and registration (04_Auth.gs) on top of Supabase Auth.
 *
 *   auth.start     pre-checks the number exactly as apiAuthStart_ did, then
 *                  asks Supabase Auth to send a code (delivered by the Send
 *                  SMS hook, which applies the rate limits).
 *   auth.verify    verifies the code with Supabase Auth, resolves/links the
 *                  profile, refuses pending/rejected/disabled accounts, and
 *                  returns the Supabase session.
 *   auth.register  stage 1 sends a code to an UNKNOWN number; stage 2
 *                  verifies it and creates the profile: a customer is active
 *                  at once (session returned), staff are PENDING_APPROVAL
 *                  with no role and get NO session.
 *
 * Apps Script sessions are not migrated and are never accepted here.
 */
import { authOptions } from '../lib/auth-options.js';
import type pg from 'pg';
import { createHash } from 'node:crypto';
import { advisoryXactLock, withTransaction } from '../../../../packages/database/src/db.js';
import { ACTIONS, CURRENCY, PLATFORM_NAME, APP_VERSION, ROLE_HOME, ROLE_LABELS } from '../../../../packages/domain/src/constants.js';
import { REFUSAL_MESSAGES, resolvePrincipal, type Principal } from '../../../../packages/auth/src/principal.js';
import { AppError, fail } from '../../../../packages/shared/src/errors.js';
import { formatPhone, maskPhone, normalizeEmail, normalizePhone, trim } from '../../../../packages/shared/src/text.js';
import type { Deps, RequestMeta } from '../context.js';
import { writeAudit } from '../lib/audit.js';
import type { GatewayError } from '../lib/gotrue.js';
import { nextId } from '../lib/ids.js';
import { emit } from '../lib/notify.js';
import { purposeFor } from '../lib/otp.js';
import { mfaPendingReply } from './mfa.js';

const INVALID_PHONE = 'Enter a valid Qatar mobile number.';

/** The hook's refusal reaches us only as a GoTrue error; say something true and generic. */
function sendFailureMessage(e: GatewayError): AppError {
  if (e.status === 429 || /rate|limit|too_many/i.test(e.code)) {
    return new AppError('RATE_LIMITED', 'Too many code requests. Please try again later.');
  }
  if (e.status === 422) return new AppError('UNAVAILABLE', 'We could not send your code right now. Please try again shortly.', { unavailable: true });
  return new AppError('UNAVAILABLE', 'Sign-in by text message is temporarily unavailable. Please try again later.', { unavailable: true });
}

/** Is this address already a staff sign-in address (case-insensitive)? */
export async function staffEmailTaken(db: pg.Pool | pg.PoolClient, email: string, exceptUserId = ''): Promise<boolean> {
  return !!(await db.query('select 1 from public.app_users where email is not null and lower(btrim(email)) = $1 and id <> $2',
    [email.toLowerCase(), exceptUserId])).rowCount;
}

async function profileFor(pool: pg.Pool | pg.PoolClient, phone: string) {
  const s = (await pool.query<{ id: string; status: string; auth_user_id: string | null }>(
    'select id, status, auth_user_id from public.app_users where phone = $1', [phone])).rows[0];
  if (s) return { kind: 'STAFF' as const, ...s };
  const c = (await pool.query<{ id: string; status: string; auth_user_id: string | null }>(
    'select id, status, auth_user_id from public.customers where phone = $1', [phone])).rows[0];
  if (c) return { kind: 'CUSTOMER' as const, ...c };
  return null;
}

/** apiAuthStart_: says whether an account exists / is blocked — never who it is. */
export async function authStart(deps: Deps, meta: RequestMeta, p: { phone?: string }) {
  const phone = normalizePhone(p.phone);
  if (!phone) throw fail(INVALID_PHONE);
  const who = await profileFor(deps.pool, phone);
  if (!who) throw fail('We do not have an account for this number.', { needsRegistration: true });
  if (who.kind === 'STAFF' && deps.config.STAFF_SIGN_IN === 'password') {
    // Says "staff" for this number — the same class of disclosure as 3.1's "no account for this number".
    throw fail(REFUSAL_MESSAGES.STAFF_METHOD!, { useStaffSignIn: true });
  }
  if (who.kind === 'STAFF') {
    if (who.status === 'PENDING_APPROVAL') throw fail('Your access request is still waiting for administrator approval.');
    if (who.status === 'REJECTED') throw fail('This access request was not approved.');
    if (who.status === 'DISABLED') throw fail('This account has been disabled.');
  } else if (who.status === 'DISABLED') {
    throw fail('This account has been disabled.');
  }
  // STAFF_SIGN_IN=both: the code must reach the profile's own Auth user (the one its email/password and
  // authenticator app belong to), so that user gets the profile's number before Supabase sends a code.
  let authUserId = who.auth_user_id;
  if (who.kind === 'STAFF' && deps.config.STAFF_SIGN_IN === 'both' && authUserId) {
    authUserId = await staffNumberOnAuthUser(deps, meta, who.id, authUserId, phone);
  }
  // A profile imported from Sheets has no Supabase user yet: let Auth create it on first sign-in.
  const sent = await deps.authGateway.sendOtp(phone, !authUserId, meta.ip);
  if (!sent.ok) throw sendFailureMessage(sent);
  return { ok: true, cooldownSeconds: deps.config.otp.cooldownS };
}

/**
 * Make the staff profile's Auth user carry the profile's mobile number (confirmed). Returns the Auth
 * user id to use, or null when the linked Auth user no longer exists (it is then set up again on sign-in).
 */
async function staffNumberOnAuthUser(deps: Deps, meta: RequestMeta, staffId: string, authUserId: string, phone: string): Promise<string | null> {
  const gw = deps.authGateway;
  const u = await gw.adminGetUser(authUserId);
  if (!u.ok) {
    if (u.status === 404) {
      await deps.pool.query('update public.app_users set auth_user_id = null where id = $1 and auth_user_id = $2', [staffId, authUserId]);
      return null;
    }
    throw new AppError('UNAVAILABLE', 'Sign-in is temporarily unavailable. Please try again later.');
  }
  if (normalizePhone(u.phone ?? '') === phone) return authUserId;
  const set = await gw.adminSetPhone(authUserId, phone);
  if (set.ok) {
    await writeAudit(deps.pool, null, meta, ACTIONS.STAFF_SIGNIN_PROVISIONED, 'USER', staffId, { details: { phone: maskPhone(phone), authUser: 'number added' } }).catch(() => undefined);
    return authUserId;
  }
  if (set.status >= 500) throw new AppError('UNAVAILABLE', 'Sign-in is temporarily unavailable. Please try again later.');
  // Another Auth user already holds the number (e.g. an old customer sign-up): an administrator decides.
  await writeAudit(deps.pool, null, meta, ACTIONS.STAFF_SIGNIN_CONFLICT, 'USER', staffId, { details: { phone: maskPhone(phone), why: `phone ${set.status} ${set.code}` } }).catch(() => undefined);
  throw fail(REFUSAL_MESSAGES.CONFLICT!);
}

export function sessionReply(principal: Principal, s: { accessToken: string; refreshToken: string; expiresIn: number }) {
  return {
    ok: true, token: s.accessToken, refreshToken: s.refreshToken, expiresIn: s.expiresIn,
    portal: ROLE_HOME[principal.role] ?? 'customer',
    user: { name: principal.name, role: principal.role, roleLabel: ROLE_LABELS[principal.role] ?? principal.role },
  };
}

/** apiAuthVerify_. */
/* ------------------------------------------------------------------
 * Wrong-code limit (04_Auth.gs, CFG.OTP.MAX_ATTEMPTS). Supabase Auth
 * checks the code; the API counts attempts per number since the last
 * code was SENT. An attempt is reserved BEFORE the check (under a lock
 * per number) so concurrent guesses are all counted, then marked as a
 * success or left as a failure. The code itself is never stored.
 * ------------------------------------------------------------------ */
const TOO_MANY = 'Too many incorrect attempts. Ask for a new code.';

async function reserveAttempt(deps: Deps, phone: string): Promise<{ id: number; used: number }> {
  return withTransaction(deps.pool, async (tx) => {
    await advisoryXactLock(tx, `qm.verify:${phone}`);
    const r = await tx.query<{ n: number }>(
      `select count(*)::int as n from public.otp_verify_attempts a
        where a.phone = $1 and not a.succeeded
          and a.created_at > coalesce((select max(s.created_at) from public.otp_send_log s
                                        where s.phone = $1 and s.outcome = 'SENT'), '-infinity'::timestamptz)`, [phone]);
    const used = r.rows[0]?.n ?? 0;
    if (used >= deps.config.otp.maxAttempts) throw fail(TOO_MANY);
    const ins = await tx.query<{ id: number }>(`insert into public.otp_verify_attempts (phone) values ($1) returning id`, [phone]);
    return { id: Number(ins.rows[0]!.id), used: used + 1 };
  });
}

/** Verify through Supabase Auth with the attempt limit applied; throws the 3.1 sentences on failure. */
async function verifyWithLimit(deps: Deps, meta: RequestMeta, phone: string, code: string, purpose: 'LOGIN' | 'REGISTER') {
  const slot = await reserveAttempt(deps, phone);
  const v = await deps.authGateway.verifyOtp(phone, code, meta.ip);
  if (v.ok) {
    await deps.pool.query('update public.otp_verify_attempts set succeeded = true where id = $1', [slot.id]);
    return v;
  }
  if (v.status >= 500 || v.status === 429) {
    // Not the person's fault (Auth unavailable, or Supabase's own rate limit): give the attempt back.
    await deps.pool.query('delete from public.otp_verify_attempts where id = $1', [slot.id]);
    if (v.status === 429) throw new AppError('RATE_LIMITED', 'Too many sign-in attempts right now. Please try again in a few minutes.');
    throw new AppError('UNAVAILABLE', 'Sign-in is temporarily unavailable. Please try again later.');
  }
  const max = deps.config.otp.maxAttempts;
  const dead = slot.used >= max;
  await writeAudit(deps.pool, null, meta, dead ? ACTIONS.OTP_LOCKED_OUT : ACTIONS.OTP_FAILED, 'PHONE', maskPhone(phone),
    { details: { attempts: slot.used, burned: dead, purpose } }).catch(() => undefined);
  throw fail(dead ? TOO_MANY : `That code is not right or has expired. ${max - slot.used} attempt${max - slot.used === 1 ? '' : 's'} left.`);
}

export async function authVerify(deps: Deps, meta: RequestMeta, p: { phone?: string; code?: string }) {
  const phone = normalizePhone(p.phone);
  if (!phone) throw fail(INVALID_PHONE);
  const code = trim(p.code);
  if (!/^\d{4,10}$/.test(code)) throw fail('That code is not right. Check it and try again.');
  const v = await verifyWithLimit(deps, meta, phone, code, 'LOGIN');
  const claims = await deps.verifyToken(v.accessToken);
  if (!claims) throw new AppError('UNAVAILABLE', 'Sign-in is temporarily unavailable. Please try again later.');

  return withTransaction(deps.pool, async (tx) => {
    const r = await resolvePrincipal(tx, claims, authOptions(deps.config, { allowLink: true, allowPendingMfa: true }));
    if (!r.ok) {
      await deps.authGateway.logout(v.accessToken, 'local').catch(() => undefined);
      throw fail(REFUSAL_MESSAGES[r.reason] ?? 'This account is not active.');
    }
    const pr = r.principal;
    if (r.linked) {
      await writeAudit(tx, pr, meta, ACTIONS.PROFILE_LINKED, pr.principalType, pr.principalId, { details: { phone: maskPhone(phone) } });
    }
    if (r.mfaPending) {
      // Code right; this role also needs the authenticator app (SUPER_ADMIN). The aal1 session works only on /v1/auth/mfa/*.
      await writeAudit(tx, pr, meta, ACTIONS.MFA_PENDING, 'STAFF', pr.principalId, { details: { phone: maskPhone(phone) } });
      return mfaPendingReply(deps, pr, v);
    }
    await tx.query(`update public.${pr.principalType === 'STAFF' ? 'app_users' : 'customers'} set last_login_at = now() where id = $1`, [pr.principalId]);
    await writeAudit(tx, pr, meta, ACTIONS.LOGIN, pr.principalType, pr.principalId, { details: { phone: maskPhone(phone) } });
    return sessionReply(pr, v);
  });
}

/** apiAuthRegister_: stage 1 (no code) sends; stage 2 (code) creates. */
export async function authRegister(deps: Deps, meta: RequestMeta, p: {
  phone?: string; fullName?: string; accountType?: string; email?: string; notes?: string; code?: string;
}) {
  const phone = normalizePhone(p.phone);
  if (!phone) throw fail(INVALID_PHONE);
  const name = trim(p.fullName);
  if (name.length < 3) throw fail('Please enter your full name.');
  const wantsStaff = trim(p.accountType).toUpperCase() === 'EMPLOYEE';
  if (await profileFor(deps.pool, phone)) throw fail('An account already exists for this number.', { needsLogin: true });
  const staffEmail = normalizeEmail(p.email);
  if (wantsStaff) {
    if (trim(p.email) && !staffEmail) throw fail('Enter a valid email address.');
    if (!staffEmail && deps.config.STAFF_SIGN_IN === 'password') throw fail('Enter your work email address — staff sign in with email and password.');
    if (staffEmail && await staffEmailTaken(deps.pool, staffEmail)) throw fail('That email address is already used by a staff account.');
  }

  if (!trim(p.code)) {
    const sent = await deps.authGateway.sendOtp(phone, true, meta.ip);
    if (!sent.ok) throw sendFailureMessage(sent);
    return { ok: true, cooldownSeconds: deps.config.otp.cooldownS };
  }

  const regCode = trim(p.code);
  if (!/^\d{4,10}$/.test(regCode)) throw fail('That code is not right. Check it and try again.');
  const v = await verifyWithLimit(deps, meta, phone, regCode, 'REGISTER');
  const claims = await deps.verifyToken(v.accessToken);
  if (!claims) throw new AppError('UNAVAILABLE', 'Sign-in is temporarily unavailable. Please try again later.');

  const email = (wantsStaff ? staffEmail : '') || trim(p.email) || null;
  return withTransaction(deps.pool, async (tx) => {
    // Two tabs racing to here: one lock per number, then re-check.
    await advisoryXactLock(tx, `qm.register:${phone}`);
    if (await profileFor(tx, phone)) throw fail('An account already exists for this number.');
    // STAFF_SIGN_IN=both: a staff member's Auth user can still hold a number the profile no longer has.
    // That Auth user must never become a second (customer) profile.
    if ((await tx.query('select 1 from public.app_users where auth_user_id = $1', [claims.sub])).rowCount) {
      await deps.authGateway.logout(v.accessToken, 'local').catch(() => undefined);
      throw fail('An account already exists for this number.');
    }
    if (wantsStaff) {
      if (staffEmail && await staffEmailTaken(tx, staffEmail)) throw fail('That email address is already used by a staff account.');
      const userId = await nextId(tx, 'USR');
      await tx.query(
        `insert into public.app_users (id, auth_user_id, full_name, phone, email, role, vendor_id, branch_id, status, notes)
         values ($1,$2,$3,$4,$5,null,null,null,'PENDING_APPROVAL',$6)`, [userId, claims.sub, name, phone, email, trim(p.notes) || null]);
      await writeAudit(tx, null, meta, ACTIONS.EMPLOYEE_REQUESTED, 'USER', userId, { details: { phone: maskPhone(phone) } });
      await emit.staffPending(tx, userId, name, '');
      await deps.authGateway.logout(v.accessToken, 'local').catch(() => undefined);
      return { ok: true, pending: true, message: 'Your access request has been submitted and is waiting for administrator approval.' };
    }
    const custId = await nextId(tx, 'CUS');
    await tx.query(
      `insert into public.customers (id, auth_user_id, full_name, phone, email, status, last_login_at) values ($1,$2,$3,$4,$5,'ACTIVE',now())`,
      [custId, claims.sub, name, phone, email]);
    const pr: Principal = {
      principalType: 'CUSTOMER', principalId: custId, authUserId: claims.sub, phone, name, role: 'CUSTOMER',
      vendorId: '', branchId: '', isPlatform: false, isVendorScoped: false,
    };
    await writeAudit(tx, pr, meta, ACTIONS.CUSTOMER_REGISTERED, 'CUSTOMER', custId, { details: { phone: maskPhone(phone) } });
    return { ...sessionReply(pr, v), portal: 'customer' };
  });
}

export async function authRefresh(deps: Deps, meta: RequestMeta, p: { refreshToken?: string }) {
  const rt = trim(p.refreshToken);
  if (!rt || rt.length > 4096) throw new AppError('UNAUTHENTICATED', 'Your session has ended. Please sign in again.', { reauth: true });
  const r = await deps.authGateway.refresh(rt, meta.ip);
  // Supabase Auth unreachable or rate-limiting: say so, and do NOT sign the person out.
  if (!r.ok && r.status >= 500) throw new AppError('UNAVAILABLE', 'Sign-in is temporarily unavailable. Please try again later.');
  if (!r.ok && r.status === 429) throw new AppError('RATE_LIMITED', 'Too many requests right now. Please try again in a few minutes.');
  if (!r.ok) throw new AppError('UNAUTHENTICATED', 'Your session has ended. Please sign in again.', { reauth: true });
  const claims = await deps.verifyToken(r.accessToken);
  if (!claims) throw new AppError('UNAUTHENTICATED', 'Your session has ended. Please sign in again.', { reauth: true });
  // A refreshed token is still useless to a disabled or revoked profile: resolution re-checks everything.
  const res = await resolvePrincipal(deps.pool, claims, authOptions(deps.config, { allowLink: false, allowPendingMfa: true }));
  if (!res.ok) throw new AppError('UNAUTHENTICATED', 'Your session has ended. Please sign in again.', { reauth: true });
  return { ok: true, token: r.accessToken, refreshToken: r.refreshToken, expiresIn: r.expiresIn, ...(res.mfaPending ? { mfaRequired: true } : {}) };
}

/** apiAuthResume_. */
export function authResume(p: Principal) {
  return {
    ok: true, portal: ROLE_HOME[p.role] ?? 'customer',
    user: { name: p.name, role: p.role, roleLabel: ROLE_LABELS[p.role] ?? p.role, vendorId: p.vendorId, branchId: p.branchId },
  };
}

/** apiAuthLogout_: the token THIS request was authenticated with — never one from the body. */
export async function authLogout(deps: Deps, meta: RequestMeta, p: Principal, accessToken: string) {
  await deps.authGateway.logout(accessToken, 'local').catch(() => undefined);
  await writeAudit(deps.pool, p, meta, ACTIONS.LOGOUT, p.principalType, p.principalId, {});
  return { ok: true, message: 'Signed out.' };
}

/** apiAuthLogoutAll_: every token issued before now is refused from now on. */
export async function authLogoutAll(deps: Deps, meta: RequestMeta, p: Principal, accessToken: string) {
  await deps.pool.query(`update public.${p.principalType === 'STAFF' ? 'app_users' : 'customers'} set auth_valid_after = now() where id = $1`, [p.principalId]);
  await deps.authGateway.logout(accessToken, 'global').catch(() => undefined);
  await writeAudit(deps.pool, p, meta, ACTIONS.LOGOUT, p.principalType, p.principalId, { details: { scope: 'all devices' } });
  return { ok: true, message: 'Signed out everywhere.' };
}

/** apiMeContext_: what a portal shell needs, nothing more. */
export async function meContext(pool: pg.Pool | pg.PoolClient, p: Principal) {
  const out: Record<string, unknown> = {
    ok: true, principalType: p.principalType, name: p.name, role: p.role, roleLabel: ROLE_LABELS[p.role] ?? p.role,
    phone: formatPhone(p.phone), portal: ROLE_HOME[p.role] ?? 'customer', platform: PLATFORM_NAME, currency: CURRENCY,
    isPlatform: p.isPlatform, version: APP_VERSION, versionLabel: APP_VERSION,
  };
  if (p.vendorId) {
    const v = (await pool.query<{ id: string; name: string; code: string }>('select id, name, code from public.vendors where id = $1', [p.vendorId])).rows[0];
    out.vendor = v ? { vendorId: v.id, name: v.name, code: v.code } : null;
  }
  if (p.branchId) {
    const b = (await pool.query<{ id: string; name: string; code: string | null }>('select id, name, code from public.branches where id = $1', [p.branchId])).rows[0];
    out.branch = b ? { branchId: b.id, name: b.name, code: b.code ?? '' } : null;
  }
  return out;
}

/** Re-exported for the hook route. */
export { purposeFor };
export const tokenFingerprint = (t: string): string => createHash('sha256').update(t).digest('hex').slice(0, 16);
