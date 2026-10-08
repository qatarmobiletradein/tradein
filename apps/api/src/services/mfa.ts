/**
 * Authenticator-app step (TOTP, Supabase Auth MFA) for the staff roles in
 * STAFF_MFA_ROLES — SUPER_ADMIN by default in staging/production.
 *
 * Flow: password sign-in returns an aal1 session marked `mfaRequired`. That
 * session can only reach these endpoints (every other request answers
 * MFA_REQUIRED). The person either enrolls an app (first time: QR code /
 * secret, then one code) or enters a code; Supabase upgrades the session to
 * aal2 and the normal sign-in reply is returned.
 *
 * Rules:
 *   - An aal1 session may enroll ONLY while the account has no verified
 *     factor; adding another app needs an aal2 session (so a stolen password
 *     alone can never register an attacker's app over an existing one).
 *   - Wrong codes: 5 per 15 minutes per account, then a pause.
 *   - Codes and secrets are never logged or stored by the API.
 *   - Lost phone: an administrator removes the factor in Supabase
 *     (Authentication → Users → the user → MFA factors); the next sign-in
 *     enrolls a new app.
 */
import { withTransaction, advisoryXactLock } from '../../../../packages/database/src/db.js';
import { ACTIONS } from '../../../../packages/domain/src/constants.js';
import { resolvePrincipal, type Principal } from '../../../../packages/auth/src/principal.js';
import type { AccessClaims } from '../../../../packages/auth/src/jwt.js';
import { AppError, fail } from '../../../../packages/shared/src/errors.js';
import { sha256Hex } from '../../../../packages/shared/src/text.js';
import type { Deps, RequestMeta } from '../context.js';
import type { AuthSession } from '../lib/gotrue.js';
import { authOptions } from '../lib/auth-options.js';
import { writeAudit } from '../lib/audit.js';
import { sessionReply } from './auth.js';

const ISSUER = 'Qatar Mobile Trade-In';
const MAX_WRONG = 5;
const WINDOW_MIN = 15;
const UNAVAILABLE = 'Sign-in is temporarily unavailable. Please try again later.';
const WRONG_CODE = 'That code is not right. Check the time on your phone and try again.';
const PAUSED = 'Too many wrong codes. Please wait 15 minutes and try again.';

const unavailable = () => new AppError('UNAVAILABLE', UNAVAILABLE);

/** The reply to a correct password when the role needs the app step. Carries the aal1 session for the MFA endpoints only. */
export async function mfaPendingReply(deps: Deps, p: Principal, s: AuthSession) {
  const f = await deps.authGateway.mfaFactors(s.accessToken);
  if (!f.ok) throw unavailable();
  const enrolled = f.factors.some((x) => x.status === 'verified');
  return {
    ok: true, mfaRequired: true, mfaEnrolled: enrolled,
    factorId: enrolled ? f.factors.find((x) => x.status === 'verified')!.id : undefined,
    token: s.accessToken, refreshToken: s.refreshToken, expiresIn: s.expiresIn,
    user: { name: p.name, role: p.role },
    message: enrolled ? 'Enter the 6-digit code from your authenticator app.' : 'Set up an authenticator app to finish signing in.',
  };
}

export async function mfaStatus(deps: Deps, p: Principal, token: string, claims: AccessClaims) {
  const f = await deps.authGateway.mfaFactors(token);
  if (!f.ok) throw unavailable();
  return {
    ok: true,
    required: p.principalType === 'STAFF' && deps.config.STAFF_MFA_ROLES.includes(p.role),
    enrolled: f.factors.some((x) => x.status === 'verified'),
    aal: claims.aal ?? 'aal1',
    factors: f.factors.filter((x) => x.status === 'verified').map((x) => ({ id: x.id, name: x.friendlyName })),
  };
}

export async function mfaEnroll(deps: Deps, meta: RequestMeta, p: Principal, token: string, claims: AccessClaims) {
  if (p.principalType !== 'STAFF') throw new AppError('FORBIDDEN', 'You do not have permission to do that.');
  const f = await deps.authGateway.mfaFactors(token);
  if (!f.ok) throw unavailable();
  if (f.factors.some((x) => x.status === 'verified') && claims.aal !== 'aal2') {
    throw fail('An authenticator app is already set up for this account. Sign in with it first, or ask an administrator to reset it.');
  }
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const e = await deps.authGateway.mfaEnroll(token, ISSUER, `Authenticator ${stamp}`);
  if (!e.ok) {
    if (e.status >= 500) throw unavailable();
    if (e.status === 429) throw new AppError('RATE_LIMITED', 'Too many requests right now. Please try again in a few minutes.');
    throw fail('The authenticator app could not be set up. Please sign in again and retry.');
  }
  await writeAudit(deps.pool, p, meta, ACTIONS.MFA_ENROLL_STARTED, 'USER', p.principalId, { details: { factor: e.factorId } }).catch(() => undefined);
  // The secret goes to this person only, once, so they can add it to their app. It is not stored here.
  return { ok: true, factorId: e.factorId, qrCode: e.qrCode, secret: e.secret, uri: e.uri };
}

async function reserveAttempt(deps: Deps, key: string): Promise<number> {
  return withTransaction(deps.pool, async (tx) => {
    await advisoryXactLock(tx, `qm.mfa:${key}`);
    const n = (await tx.query<{ n: number }>(
      `select count(*)::int as n from public.mfa_attempts a
        where a.account_key = $1 and not a.succeeded
          and a.created_at > now() - make_interval(mins => $2)
          and a.created_at > coalesce((select max(b.created_at) from public.mfa_attempts b
                                        where b.account_key = $1 and b.succeeded), '-infinity')`,
      [key, WINDOW_MIN])).rows[0]!.n;
    if (n >= MAX_WRONG) throw new AppError('RATE_LIMITED', PAUSED);
    return Number((await tx.query<{ id: number }>(
      `insert into public.mfa_attempts (account_key) values ($1) returning id`, [key])).rows[0]!.id);
  });
}

export async function mfaVerify(deps: Deps, meta: RequestMeta, p: Principal, token: string, input: { factorId?: unknown; code?: unknown }) {
  if (p.principalType !== 'STAFF') throw new AppError('FORBIDDEN', 'You do not have permission to do that.');
  const factorId = typeof input.factorId === 'string' ? input.factorId.trim() : '';
  const code = typeof input.code === 'string' ? input.code.replace(/\s+/g, '') : '';
  if (!/^[0-9a-f-]{36}$/i.test(factorId) || !/^\d{6}$/.test(code)) throw fail(WRONG_CODE);

  const key = sha256Hex(`mfa:${p.principalId}`);
  const slot = await reserveAttempt(deps, key);
  const v = await deps.authGateway.mfaVerify(token, factorId, code);
  if (!v.ok) {
    if (v.status >= 500 || v.status === 429) {
      await deps.pool.query('delete from public.mfa_attempts where id = $1', [slot]).catch(() => undefined);
      if (v.status === 429) throw new AppError('RATE_LIMITED', 'Too many requests right now. Please try again in a few minutes.');
      throw unavailable();
    }
    await writeAudit(deps.pool, p, meta, ACTIONS.MFA_FAILED, 'USER', p.principalId).catch(() => undefined);
    throw fail(WRONG_CODE);
  }
  await deps.pool.query('update public.mfa_attempts set succeeded = true where id = $1', [slot]);

  const claims = await deps.verifyToken(v.accessToken);
  if (!claims || claims.aal !== 'aal2') throw unavailable();
  return withTransaction(deps.pool, async (tx) => {
    const r = await resolvePrincipal(tx, claims, authOptions(deps.config, { allowLink: false }));
    if (!r.ok) throw new AppError('UNAUTHENTICATED', 'Your session has ended. Please sign in again.', { reauth: true });
    await tx.query('update public.app_users set last_login_at = now() where id = $1', [r.principal.principalId]);
    await writeAudit(tx, r.principal, meta, ACTIONS.LOGIN, 'STAFF', r.principal.principalId, { details: { method: 'password+totp' } });
    return sessionReply(r.principal, v);
  });
}
