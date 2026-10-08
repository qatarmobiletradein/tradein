/**
 * Staff sign-in with email + password (STAFF_SIGN_IN=password) on top of
 * Supabase Auth. Customers keep the 3.1 SMS code (services/auth.ts).
 *
 *   auth.staffLogin        email + password → Supabase session, then the SAME
 *                          profile checks as every request (principal.ts).
 *   auth.staffResetStart   "Set or reset password": Supabase Auth e-mails a
 *                          6-digit code to an ACTIVE staff address. The reply
 *                          is the same, and returns as quickly, whether or not
 *                          the address is staff: the set-up and the e-mail run
 *                          after the reply (settleBackgroundWork waits for them).
 *   auth.staffResetFinish  code + new password → password set, every earlier
 *                          session of that person ended, signed in.
 *
 * Who may have a password: the API creates (or updates) the Supabase Auth
 * user for a staff profile itself, with the SERVER secret key, the first
 * time a reset code is requested for that profile's address. That covers
 * profiles created by an administrator, approved applicants and profiles
 * imported from Google Sheets alike: whoever controls the mailbox sets the
 * password. A staff profile is linked only to the Auth user the API
 * provisioned (never by a token claim), and only password sessions count
 * (principal.ts).
 *
 * Limits kept by the API (Supabase Auth has its own on top):
 *   - wrong passwords: STAFF_LOGIN_MAX_FAILURES per address per 15 minutes,
 *     then sign-in for that address pauses (a reset still works);
 *   - reset codes: one per address per 60 s, five per hour, and at most
 *     STAFF_RESET_EMAILS_PER_HOUR e-mails per hour for all staff together
 *     (kept below the Supabase project's e-mail limit);
 *   - wrong reset codes: OTP_MAX_ATTEMPTS since the last code sent.
 * Every attempt is reserved BEFORE Supabase Auth is asked, under a lock per
 * address, so concurrent attempts all count. Addresses are stored hashed;
 * passwords and codes are never stored or logged.
 */
import { authOptions } from '../lib/auth-options.js';
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { advisoryXactLock, withTransaction } from '../../../../packages/database/src/db.js';
import { ACTIONS } from '../../../../packages/domain/src/constants.js';
import { REFUSAL_MESSAGES, resolvePrincipal } from '../../../../packages/auth/src/principal.js';
import { AppError, fail } from '../../../../packages/shared/src/errors.js';
import { maskEmail, normalizeEmail, sha256Hex, trim } from '../../../../packages/shared/src/text.js';
import type { Deps, RequestMeta } from '../context.js';
import { writeAudit } from '../lib/audit.js';
import { sessionReply } from './auth.js';
import { mfaPendingReply } from './mfa.js';

const WRONG = 'The email or password is not right.';
const PAUSED = 'Too many sign-in attempts for this email. Wait 15 minutes, or set a new password with “Set or reset password”.';
const SENT = 'If this email belongs to an active staff account, we have sent it a 6-digit code. It can take a minute to arrive — check your junk folder too.';
const WAIT = 'Please wait a minute before asking for another code.';
const TOO_MANY_SENDS = 'Too many codes have been requested for this email. Please try again later.';
const BAD_CODE = (left: number) => `That code is not right or has expired. ${left} attempt${left === 1 ? '' : 's'} left.`;
const TOO_MANY_CODES = 'Too many incorrect codes. Ask for a new code.';
const UNAVAILABLE = 'Sign-in is temporarily unavailable. Please try again later.';
const NOT_ENABLED = 'Staff sign in with their mobile number on this system.';

const WINDOW_MIN = 15;

/* Work that continues after a reply was sent (reset e-mails). Tests and shutdown wait for it. */
const background = new Set<Promise<void>>();
function runInBackground(deps: Deps, what: string, fn: () => Promise<void>): void {
  const p: Promise<void> = fn()
    .catch((err: unknown) => { deps.log.error({ err: err instanceof Error ? err.message : 'error' }, `${what} failed`); })
    .finally(() => { background.delete(p); });
  background.add(p);
}
/** Resolves when every reset started so far has finished (or failed). */
export async function settleBackgroundWork(): Promise<void> {
  while (background.size) await Promise.allSettled([...background]);
}
const RESET_COOLDOWN_S = 60;
const RESET_PER_HOUR = 5;

type Kind = 'LOGIN' | 'RESET_SEND' | 'RESET_VERIFY';
const keyOf = (email: string) => sha256Hex(email.toLowerCase());
const unavailable = () => new AppError('UNAVAILABLE', UNAVAILABLE);

function requirePasswordMode(deps: Deps) {
  if (deps.config.STAFF_SIGN_IN !== 'password') throw fail(NOT_ENABLED);
}

/** The password rules the API enforces (Supabase Auth's own policy should be set at least as strict). */
export function passwordProblem(password: string, email: string, minLength: number): string | null {
  const rule = `Choose a password of at least ${minLength} characters, with letters and at least one number.`;
  if (password.length < minLength || !/[A-Za-z]/.test(password) || !/\d/.test(password)) return rule;
  // Supabase Auth stores passwords with bcrypt, which reads at most 72 bytes.
  if (Buffer.byteLength(password, 'utf8') > 72) return 'Choose a password of at most 72 characters.';
  const local = email.split('@')[0] ?? '';
  if (local.length >= 3 && password.toLowerCase().includes(local.toLowerCase())) return 'Do not use your email address in your password.';
  return null;
}

/**
 * Reserve one attempt of `kind` for this address, or refuse. `limit` sees
 * the attempts that count and returns a refusal sentence (or null).
 */
async function reserve(pool: pg.Pool, key: string, kind: Kind,
  limit: (s: { failures: number; lastAt: Date | null; lastHour: number; sinceSend: number }) => AppError | null): Promise<number> {
  return withTransaction(pool, async (tx) => {
    await advisoryXactLock(tx, `qm.staffauth:${key}`);
    const s = (await tx.query<{ failures: number; last_at: Date | null; last_hour: number; since_send: number }>(
      `select
         -- wrong passwords in the window since the last successful sign-in or password set
         (select count(*) from public.staff_auth_attempts a
           where a.email_key = $1 and a.kind = 'LOGIN' and not a.succeeded
             and a.created_at > now() - make_interval(mins => $2)
             and a.created_at > coalesce((select max(b.created_at) from public.staff_auth_attempts b
                                           where b.email_key = $1 and b.succeeded and b.kind in ('LOGIN','RESET_VERIFY')), '-infinity'))::int as failures,
         (select max(created_at) from public.staff_auth_attempts where email_key = $1 and kind = 'RESET_SEND') as last_at,
         (select count(*) from public.staff_auth_attempts where email_key = $1 and kind = 'RESET_SEND'
             and created_at > now() - interval '1 hour')::int as last_hour,
         -- wrong reset codes since the last code actually sent
         (select count(*) from public.staff_auth_attempts a
           where a.email_key = $1 and a.kind = 'RESET_VERIFY' and not a.succeeded
             and a.created_at > coalesce((select max(b.created_at) from public.staff_auth_attempts b
                                           where b.email_key = $1 and b.kind = 'RESET_SEND' and b.succeeded), '-infinity'))::int as since_send`,
      [key, WINDOW_MIN])).rows[0]!;
    const refusal = limit({ failures: s.failures, lastAt: s.last_at, lastHour: s.last_hour, sinceSend: s.since_send });
    if (refusal) throw refusal;
    const r = await tx.query<{ id: string }>('insert into public.staff_auth_attempts (email_key, kind) values ($1, $2) returning id', [key, kind]);
    return Number(r.rows[0]!.id);
  });
}
const markSucceeded = (pool: pg.Pool, id: number) =>
  pool.query('update public.staff_auth_attempts set succeeded = true where id = $1', [id]);
const giveBack = (pool: pg.Pool, id: number) =>
  pool.query('delete from public.staff_auth_attempts where id = $1', [id]).catch(() => undefined);
const auditEmail = (pool: pg.Pool, meta: RequestMeta | null, action: string, email: string, details: Record<string, unknown> = {}) =>
  writeAudit(pool, null, meta, action, 'EMAIL', maskEmail(email), { details }).catch(() => undefined);

/* ------------------------------------------------------------------ login */

export async function staffLogin(deps: Deps, meta: RequestMeta, p: { email?: string; password?: string }) {
  requirePasswordMode(deps);
  const email = normalizeEmail(p.email);
  const password = typeof p.password === 'string' ? p.password : '';
  if (!email || !password || password.length > 256) throw fail(WRONG);
  const key = keyOf(email);
  const max = deps.config.STAFF_LOGIN_MAX_FAILURES;

  let slot: number;
  try {
    slot = await reserve(deps.pool, key, 'LOGIN', (s) => (s.failures >= max ? new AppError('RATE_LIMITED', PAUSED) : null));
  } catch (e) {
    if (e instanceof AppError && e.code === 'RATE_LIMITED') await auditEmail(deps.pool, meta, ACTIONS.STAFF_LOGIN_PAUSED, email);
    throw e;
  }

  const v = await deps.authGateway.passwordLogin(email, password, meta.ip);
  if (!v.ok) {
    if (v.status >= 500) { await giveBack(deps.pool, slot); throw unavailable(); }
    if (v.status === 429) { await giveBack(deps.pool, slot); throw new AppError('RATE_LIMITED', 'Too many sign-in attempts. Please try again later.'); }
    await auditEmail(deps.pool, meta, ACTIONS.STAFF_LOGIN_FAILED, email);
    throw fail(WRONG);
  }
  await markSucceeded(deps.pool, slot);

  const claims = await deps.verifyToken(v.accessToken);
  if (!claims) {
    await deps.authGateway.logout(v.accessToken, 'local').catch(() => undefined);
    throw unavailable();
  }
  return withTransaction(deps.pool, async (tx) => {
    const r = await resolvePrincipal(tx, claims, authOptions(deps.config, { allowLink: false, staffSignIn: 'password', allowPendingMfa: true }));
    // A password session that is not a staff profile's (a stray Auth user) is just a wrong login.
    if (!r.ok || r.principal.principalType !== 'STAFF') {
      await deps.authGateway.logout(v.accessToken, 'local').catch(() => undefined);
      const known = !r.ok && ['PENDING', 'REJECTED', 'DISABLED', 'SCOPE_INVALID'].includes(r.reason);
      throw fail(known && !r.ok ? REFUSAL_MESSAGES[r.reason]! : WRONG);
    }
    const pr = r.principal;
    if (r.mfaPending) {
      // Password right; this role also needs the authenticator app. The aal1 session works only on /v1/auth/mfa/*.
      await writeAudit(tx, pr, meta, ACTIONS.MFA_PENDING, 'STAFF', pr.principalId, { details: { email: maskEmail(email) } });
      return mfaPendingReply(deps, pr, v);
    }
    await tx.query('update public.app_users set last_login_at = now() where id = $1', [pr.principalId]);
    await writeAudit(tx, pr, meta, ACTIONS.LOGIN, 'STAFF', pr.principalId, { details: { method: 'password', email: maskEmail(email) } });
    return sessionReply(pr, v);
  });
}

/* ---------------------------------------------------- provisioning (admin) */

interface StaffRow { id: string; email: string; status: string; auth_user_id: string | null }

/** A random password nobody knows — set whenever the API creates or re-addresses an Auth user. */
const unknowablePassword = () => `${randomBytes(30).toString('base64url')}a1`;

/**
 * An Auth user holding this address that NO profile uses has no rights here
 * (staff are linked only to Auth users the API set up; customers sign in by
 * phone). It is removed so the profile that now owns the address can be set
 * up — but only when it is clearly a leftover:
 *   - it never confirmed the address (someone signed up directly with a
 *     staff address), or
 *   - this API created/managed it (app_metadata.qm_staff, which only the
 *     secret key can set), e.g. the Auth user unlinked when an administrator
 *     moved a person to a new address.
 * Anything else (confirmed and not ours, or linked to a profile) is a
 * conflict for an administrator. Needs read access to auth.users (Supabase:
 * the postgres role — verify on the real project).
 */
async function clearStrayHolder(deps: Deps, email: string): Promise<boolean> {
  try {
    const u = (await deps.pool.query<{ id: string; removable: boolean }>(
      `select a.id,
              not (exists (select 1 from public.app_users p where p.auth_user_id = a.id)
                   or exists (select 1 from public.customers c where c.auth_user_id = a.id))
              and (a.email_confirmed_at is null or coalesce(a.raw_app_meta_data ->> 'qm_staff', '') = 'true') as removable
         from auth.users a where lower(a.email) = $1`, [email])).rows;
    if (u.length !== 1 || !u[0]!.removable) return false;
    return (await deps.authGateway.adminDeleteUser(u[0]!.id)).ok;
  } catch {
    return false;
  }
}

type Provisioned = 'READY' | 'CONFLICT' | 'UNAVAILABLE';

async function ensureStaffIdentity(deps: Deps, meta: RequestMeta, s: StaffRow): Promise<Provisioned> {
  const gw = deps.authGateway;
  const email = s.email.trim().toLowerCase();
  const conflict = async (why: string): Promise<Provisioned> => {
    await writeAudit(deps.pool, null, meta, ACTIONS.STAFF_SIGNIN_CONFLICT, 'USER', s.id, { details: { email: maskEmail(email), why } }).catch(() => undefined);
    return 'CONFLICT';
  };
  const exists = (e: { status: number; code: string }) => e.status === 422 && /email_exists|already/i.test(e.code);

  if (s.auth_user_id) {
    const u = await gw.adminGetUser(s.auth_user_id);
    if (u.ok) {
      if (u.email && u.email.toLowerCase() === email && u.emailConfirmed) return 'READY';
      // First password set-up for a phone-era Auth user, or the address was changed by an administrator:
      // give the Auth user the profile's address AND a fresh unknowable password (an old one must not keep working).
      let up = await gw.adminUpdateUser(s.auth_user_id, email, unknowablePassword());
      if (!up.ok && exists(up) && await clearStrayHolder(deps, email)) up = await gw.adminUpdateUser(s.auth_user_id, email, unknowablePassword());
      if (!up.ok) return up.status >= 500 ? 'UNAVAILABLE' : conflict(`update ${up.status} ${up.code}`);
      await deps.pool.query('update public.app_users set auth_valid_after = now() where id = $1', [s.id]);
      await writeAudit(deps.pool, null, meta, ACTIONS.STAFF_SIGNIN_PROVISIONED, 'USER', s.id, { details: { email: maskEmail(email), authUser: 'updated' } });
      return 'READY';
    }
    if (u.status >= 500) return 'UNAVAILABLE';
    if (u.status !== 404) return conflict(`lookup ${u.status} ${u.code}`);
    // The linked Auth user was deleted in Supabase: set the profile up again below.
  }

  let c = await gw.adminCreateUser(email, unknowablePassword());
  if (!c.ok && exists(c) && await clearStrayHolder(deps, email)) c = await gw.adminCreateUser(email, unknowablePassword());
  if (!c.ok) return c.status >= 500 ? 'UNAVAILABLE' : conflict(`create ${c.status} ${c.code}`);
  const linked = await deps.pool.query(
    `update public.app_users set auth_user_id = $1, auth_valid_after = now()
      where id = $2 and auth_user_id is not distinct from $3`, [c.id, s.id, s.auth_user_id]);
  if (linked.rowCount !== 1) {
    await gw.adminDeleteUser(c.id).catch(() => undefined);
    return conflict('profile changed while setting up');
  }
  await writeAudit(deps.pool, null, meta, ACTIONS.STAFF_SIGNIN_PROVISIONED, 'USER', s.id, { details: { email: maskEmail(email), authUser: 'created' } });
  return 'READY';
}

/* ------------------------------------------------------------ reset: send */

export async function staffResetStart(deps: Deps, meta: RequestMeta, p: { email?: string }) {
  requirePasswordMode(deps);
  const email = normalizeEmail(p.email);
  if (!email) throw fail('Enter a valid email address.');
  const key = keyOf(email);
  // The same limits for every address, staff or not, so the reply tells nobody anything.
  const slot = await reserve(deps.pool, key, 'RESET_SEND', (s) => {
    if (s.lastAt && Date.now() - new Date(s.lastAt).getTime() < RESET_COOLDOWN_S * 1000) return new AppError('RATE_LIMITED', WAIT);
    if (s.lastHour >= RESET_PER_HOUR) return new AppError('RATE_LIMITED', TOO_MANY_SENDS);
    return null;
  });
  // Everything that depends on whether the address is staff happens AFTER the reply,
  // so the answer and its timing are the same for every address.
  runInBackground(deps, 'staff reset e-mail', () => sendResetEmail(deps, meta, email, slot));
  return { ok: true, message: SENT, cooldownSeconds: RESET_COOLDOWN_S };
}

/**
 * Reserve one of the platform's reset e-mails for this hour, under one lock, or say no.
 * Returns the reservation id (deleted again if the e-mail is not handed to Supabase).
 */
async function reserveEmail(deps: Deps, key: string): Promise<number | null> {
  return withTransaction(deps.pool, async (tx) => {
    await advisoryXactLock(tx, 'qm.staffauth:emails');
    const n = (await tx.query<{ n: number }>(
      `select count(*)::int as n from public.staff_auth_attempts where kind = 'RESET_EMAIL' and created_at > now() - interval '1 hour'`)).rows[0]!.n;
    if (n >= deps.config.STAFF_RESET_EMAILS_PER_HOUR) return null;
    return Number((await tx.query<{ id: string }>(
      `insert into public.staff_auth_attempts (email_key, kind) values ($1, 'RESET_EMAIL') returning id`, [key])).rows[0]!.id);
  });
}

/*
 * Runs after the reply. The per-address RESET_SEND row is NEVER given back here: the 60 s / 5-per-hour
 * limits must hold even while Supabase fails (otherwise an outage would allow hammering, and "wait" vs
 * "sent" answers would differ by address). A person whose e-mail failed asks again after a minute.
 */
async function sendResetEmail(deps: Deps, meta: RequestMeta, email: string, slot: number): Promise<void> {
  const staff = (await deps.pool.query<StaffRow>(
    `select id, email, status, auth_user_id from public.app_users where email is not null and lower(btrim(email)) = $1`, [email])).rows[0];
  if (!staff || staff.status !== 'ACTIVE') return;

  const prov = await ensureStaffIdentity(deps, meta, staff);
  if (prov !== 'READY') return; // UNAVAILABLE: try again later; CONFLICT: audited for an administrator

  // All staff together stay below the project's e-mail limit.
  const mailSlot = await reserveEmail(deps, keyOf(email));
  if (mailSlot === null) {
    await writeAudit(deps.pool, null, meta, ACTIONS.STAFF_RESET_SENT, 'USER', staff.id,
      { details: { email: maskEmail(email), delivered: false, reason: 'platform hourly e-mail limit' } }).catch(() => undefined);
    return;
  }
  const sent = await deps.authGateway.sendRecovery(email, meta.ip);
  if (!sent.ok) {
    await giveBack(deps.pool, mailSlot);
    await auditEmail(deps.pool, meta, ACTIONS.STAFF_RESET_SENT, email, { delivered: false, status: sent.status });
    return;
  }
  await markSucceeded(deps.pool, slot);
  await writeAudit(deps.pool, null, meta, ACTIONS.STAFF_RESET_SENT, 'USER', staff.id, { details: { email: maskEmail(email) } }).catch(() => undefined);
}

/* ---------------------------------------------------------- reset: finish */

export async function staffResetFinish(deps: Deps, meta: RequestMeta, p: { email?: string; code?: string; password?: string }) {
  requirePasswordMode(deps);
  const email = normalizeEmail(p.email);
  if (!email) throw fail('Enter a valid email address.');
  const code = trim(p.code).replace(/\s/g, '');
  if (!/^\d{6,10}$/.test(code)) throw fail('Enter the code from the email.');
  const password = typeof p.password === 'string' ? p.password : '';
  const problem = passwordProblem(password, email, deps.config.STAFF_PASSWORD_MIN_LENGTH);
  if (problem) throw fail(problem);

  const key = keyOf(email);
  const max = deps.config.otp.maxAttempts;
  let used = 0;
  const slot = await reserve(deps.pool, key, 'RESET_VERIFY', (s) => {
    used = s.sinceSend + 1;
    return s.sinceSend >= max ? fail(TOO_MANY_CODES) : null;
  });

  const v = await deps.authGateway.verifyRecovery(email, code, meta.ip);
  if (!v.ok) {
    if (v.status >= 500) { await giveBack(deps.pool, slot); throw unavailable(); }
    if (v.status === 429) { await giveBack(deps.pool, slot); throw new AppError('RATE_LIMITED', 'Too many attempts right now. Please try again in a few minutes.'); }
    await auditEmail(deps.pool, meta, ACTIONS.STAFF_RESET_CODE_FAILED, email, { attempts: used });
    throw fail(used >= max ? TOO_MANY_CODES : BAD_CODE(max - used));
  }
  await markSucceeded(deps.pool, slot);

  // The recovery session is used for exactly one thing: setting the password. It is never a staff session.
  const set = await deps.authGateway.setPassword(v.accessToken, password);
  if (!set.ok) {
    await deps.authGateway.logout(v.accessToken, 'local').catch(() => undefined);
    if (set.status === 422 && /same_password/i.test(set.code)) throw fail('Choose a password you have not used for this account before.');
    if (set.status === 422 && /weak_password/i.test(set.code)) throw fail(`That password is too weak or too common. ${passwordProblem('', email, deps.config.STAFF_PASSWORD_MIN_LENGTH)}`);
    throw unavailable();
  }
  // End every other session of this person: refresh tokens (Auth) and earlier access tokens (API).
  await deps.authGateway.logout(v.accessToken, 'global').catch(() => undefined);
  // Earlier access tokens: refused from this second on (the new sign-in below is issued in this second or later).
  const staffId = v.userId
    ? (await deps.pool.query<{ id: string }>(
      `update public.app_users set auth_valid_after = date_trunc('second', now()) where auth_user_id = $1 returning id`, [v.userId])).rows[0]?.id
    : undefined;
  await writeAudit(deps.pool, null, meta, ACTIONS.STAFF_PASSWORD_SET, staffId ? 'USER' : 'EMAIL', staffId ?? maskEmail(email),
    { details: { email: maskEmail(email) } }).catch(() => undefined);

  // Signed in with the new password straight away (the same checks as a normal sign-in).
  return staffLogin(deps, meta, { email, password });
}
