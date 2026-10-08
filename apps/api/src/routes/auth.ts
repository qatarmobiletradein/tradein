/**
 * Sign-in routes. Public (no principal), with a tighter per-client rate
 * limit than the rest of the API. OTP sends are additionally limited per
 * number and platform-wide by the Send SMS hook (lib/otp.ts).
 */
import { authOptions } from '../lib/auth-options.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { bearerToken } from '../../../../packages/auth/src/jwt.js';
import { resolvePrincipal } from '../../../../packages/auth/src/principal.js';
import { S } from '../../../../packages/validation/src/index.js';
import { AppError, unauthenticated } from '../../../../packages/shared/src/errors.js';
import type { Deps } from '../context.js';
import { errorResult } from '../runner.js';
import { requestMeta } from '../app.js';
import { authLogout, authLogoutAll, authRefresh, authRegister, authStart, authVerify } from '../services/auth.js';
import { staffLogin, staffResetFinish, staffResetStart } from '../services/staff-auth.js';
import { mfaEnroll, mfaStatus, mfaVerify } from '../services/mfa.js';

type Handler = (req: FastifyRequest, params: Record<string, unknown>) => Promise<Record<string, unknown>>;

export function publicAuthHandlers(deps: Deps): Record<string, Handler> {
  const parse = <T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }, v: unknown): T => {
    const r = schema.safeParse(v);
    if (!r.success) throw new AppError('VALIDATION', 'Some of the information sent was not valid. Please check it and try again.');
    return r.data as T;
  };
  const principalOf = async (req: FastifyRequest) => {
    const token = bearerToken(req.headers.authorization);
    const claims = token ? await deps.verifyToken(token) : null;
    if (!claims) throw unauthenticated();
    const r = await resolvePrincipal(deps.pool, claims, authOptions(deps.config, { allowLink: false, allowPendingMfa: true }));
    if (!r.ok) throw unauthenticated();
    return { p: r.principal, token, claims };
  };
  return {
    'auth.start': async (req, p) => authStart(deps, requestMeta(req), parse(S.authStart, p)),
    'auth.verify': async (req, p) => authVerify(deps, requestMeta(req), parse(S.authVerify, p)),
    'auth.register': async (req, p) => authRegister(deps, requestMeta(req), parse(S.authRegister, p)),
    'auth.refresh': async (req, p) => authRefresh(deps, requestMeta(req), parse(S.authRefresh, p)),
    'auth.logout': async (req) => { const { p, token } = await principalOf(req); return authLogout(deps, requestMeta(req), p, token); },
    'auth.logoutAll': async (req) => { const { p, token } = await principalOf(req); return authLogoutAll(deps, requestMeta(req), p, token); },
    'auth.staffLogin': async (req, p) => staffLogin(deps, requestMeta(req), parse(S.staffLogin, p)),
    'auth.staffResetStart': async (req, p) => staffResetStart(deps, requestMeta(req), parse(S.staffResetStart, p)),
    'auth.staffResetFinish': async (req, p) => staffResetFinish(deps, requestMeta(req), parse(S.staffResetFinish, p)),
    // Authenticator app (SUPER_ADMIN): reachable with the aal1 session a correct password returns.
    'auth.mfaStatus': async (req) => { const { p, token, claims } = await principalOf(req); return mfaStatus(deps, p, token!, claims); },
    'auth.mfaEnroll': async (req) => { const { p, token, claims } = await principalOf(req); return mfaEnroll(deps, requestMeta(req), p, token!, claims); },
    'auth.mfaVerify': async (req, b) => { const { p, token } = await principalOf(req); return mfaVerify(deps, requestMeta(req), p, token!, b); },
  };
}

export async function sendHandled(deps: Deps, req: FastifyRequest, reply: FastifyReply, name: string, h: Handler, params: unknown) {
  try {
    const body = await h(req, (params && typeof params === 'object') ? params as Record<string, unknown> : {});
    return reply.status(200).send(body);
  } catch (err) {
    const r = errorResult(err, deps, requestMeta(req), name);
    return reply.status(r.status).send(r.body);
  }
}

export function authRoutes(deps: Deps) {
  return async (app: FastifyInstance) => {
    const handlers = publicAuthHandlers(deps);
    const limit = { config: { rateLimit: { max: deps.config.AUTH_RATE_LIMIT_MAX, timeWindow: 60_000 } } };
    const map: [string, string][] = [
      ['/start', 'auth.start'], ['/verify', 'auth.verify'], ['/register', 'auth.register'],
      ['/refresh', 'auth.refresh'], ['/logout', 'auth.logout'], ['/logout-all', 'auth.logoutAll'],
      ['/staff/login', 'auth.staffLogin'], ['/staff/reset/start', 'auth.staffResetStart'], ['/staff/reset/finish', 'auth.staffResetFinish'],
      ['/mfa/status', 'auth.mfaStatus'], ['/mfa/enroll', 'auth.mfaEnroll'], ['/mfa/verify', 'auth.mfaVerify'],
    ];
    for (const [path, name] of map) {
      app.post(path, limit, async (req, reply) => sendHandled(deps, req, reply, name, handlers[name]!, req.body));
    }
  };
}
