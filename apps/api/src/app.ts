/**
 * The Fastify application. Built by a function so tests can create it with
 * a test pool, a fake auth gateway and in-memory storage, and drive it
 * with app.inject() — no network, no production anything.
 */
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { bearerToken } from '../../../packages/auth/src/jwt.js';
import { ping } from '../../../packages/database/src/db.js';
import { APP_VERSION } from '../../../packages/domain/src/constants.js';
import type { Deps, RequestMeta } from './context.js';
import { REGISTRY } from './registry.js';
import { runAction } from './runner.js';
import { authRoutes } from './routes/auth.js';
import { hookRoutes } from './routes/hooks.js';
import { PUBLIC_ACTIONS, publicDispatch, publicRoutes } from './routes/public.js';
import { restRoutes } from './routes/rest.js';

export function requestMeta(req: FastifyRequest): RequestMeta {
  const ua = req.headers['user-agent'];
  return { requestId: String(req.id), ip: req.ip, userAgent: typeof ua === 'string' ? ua : '' };
}

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const c = deps.config;
  const app = Fastify({
    loggerInstance: deps.log as unknown as FastifyBaseLogger,
    // Number of proxy hops in front of the app (Railway's edge = 1). Never `true`: that would let a
    // client choose its own IP with X-Forwarded-For and walk around the per-IP rate limits.
    trustProxy: c.TRUST_PROXY_HOPS > 0 ? (_addr: string, hop: number) => hop < c.TRUST_PROXY_HOPS : false,
    bodyLimit: c.BODY_LIMIT_BYTES,
    genReqId: (req) => {
      const given = req.headers['x-request-id'];
      return typeof given === 'string' && /^[A-Za-z0-9._-]{8,64}$/.test(given) ? given : randomUUID();
    },
    requestIdHeader: false,
    ajv: { customOptions: { removeAdditional: false } },
  });

  // ---- secure headers. The API serves JSON only, so the CSP is "nothing". ----
  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: c.isProductionLike ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });

  // ---- CORS: an explicit allow-list; no credentials cookies are used. ----
  const allowed = new Set(c.CORS_ALLOWED_ORIGINS);
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || allowed.has(origin)),
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
    credentials: false,
    maxAge: 600,
  });

  // ---- rate limits: a general ceiling per client, stricter on sign-in. ----
  await app.register(rateLimit, {
    global: true,
    max: c.RATE_LIMIT_MAX,
    timeWindow: c.RATE_LIMIT_WINDOW_MS,
    allowList: (req) => req.url === '/health' || req.url === '/ready',
    errorResponseBuilder: () => ({ statusCode: 429, ok: false, code: 'RATE_LIMITED', message: 'Too many requests. Please wait a moment and try again.' }),
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Request-Id', String(req.id));
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // Never echo internals. Fastify's own errors (bad JSON, body too large) become sentences.
  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, 'unhandled error');
    const message = status === 413 ? 'That upload is too large.'
      : status === 429 ? 'Too many requests. Please wait a moment and try again.'
      : status === 400 ? 'The request could not be read.'
      : status < 500 ? 'The request was refused.' : 'Something went wrong. Please try again.';
    void reply.status(status).send({ ok: false, message, code: status >= 500 ? 'INTERNAL' : 'REQUEST' });
  });
  app.setNotFoundHandler((_req, reply) => { void reply.status(404).send({ ok: false, message: 'Not found.', code: 'NOT_FOUND' }); });

  // ---- health ----
  // Liveness: the process answers. No dependency, no configuration detail.
  app.get('/health', async () => ({ ok: true, service: 'qm-api', status: 'up' }));
  // Readiness: the database answers within 2 s and (staging/production) an SMS provider is configured.
  // Booleans and the environment NAME only — never a host, URL, key or error text.
  app.get('/ready', async (_req, reply) => {
    const db = await ping(deps.pool);
    const sms = deps.sms.configured();
    // Production needs SMS to be ready; staging may run without a provider (reported, customer sign-in fails closed).
    const ready = db && (sms || !c.isProduction);
    return reply.status(ready ? 200 : 503).send({
      ok: ready, environment: c.APP_ENV, version: APP_VERSION,
      checks: { database: db, sms: sms ? 'configured' : 'not configured', idempotencyKeysRequired: c.IDEMPOTENCY_KEY_REQUIRED, staffSignIn: c.STAFF_SIGN_IN },
    });
  });

  // ---- the compatibility endpoint for the unchanged 3.1 frontend ----
  app.post<{ Params: { action: string }; Body: unknown }>('/v1/actions/:action', {
    bodyLimit: c.UPLOAD_BODY_LIMIT_BYTES,
  }, async (req, reply) => {
    const action = req.params.action;
    // Sign-in actions are served ONLY by /v1/auth/* (stricter rate limit, smaller body limit).
    // Here they fall through to the registry and look like any unknown action.
    if (PUBLIC_ACTIONS.includes(action)) {
      const b = (req.body && typeof req.body === 'object') ? req.body as Record<string, unknown> : {};
      const pp = (b.params && typeof b.params === 'object') ? b.params as Record<string, unknown> : b;
      try { return reply.send(await publicDispatch(deps, action, pp)); } catch (err) {
        const { errorResult } = await import('./runner.js');
        const r = errorResult(err, deps, requestMeta(req), action);
        return reply.status(r.status).send(r.body);
      }
    }
    const def = Object.prototype.hasOwnProperty.call(REGISTRY, action) ? REGISTRY[action] : undefined;
    const body = (req.body && typeof req.body === 'object') ? req.body as Record<string, unknown> : {};
    const params = (body.params && typeof body.params === 'object') ? body.params : body;
    const keyHeader = req.headers['idempotency-key'];
    const r = await runAction(deps, {
      action, def, accessToken: bearerToken(req.headers.authorization), rawParams: params,
      idempotencyKey: typeof keyHeader === 'string' ? keyHeader : '', meta: requestMeta(req),
    });
    return reply.status(r.status).send(r.body);
  });

  await app.register(authRoutes(deps), { prefix: '/v1/auth' });
  await app.register(publicRoutes(deps), { prefix: '/v1/public' });
  await app.register(hookRoutes(deps), { prefix: '/v1/hooks' });
  await app.register(restRoutes(deps), { prefix: '/v1' });

  return app as unknown as FastifyInstance;
}
