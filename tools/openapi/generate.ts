/**
 * OpenAPI 3.1 description of the Railway API, GENERATED from the code that
 * serves it: the action registry (roles, idempotency, read-only), the Zod
 * input schemas, the REST route table, and the auth/public/health routes.
 *
 *   npm run openapi          → docs/openapi.json
 *
 * Because it is generated, it cannot drift: tests/unit/openapi.test.ts
 * fails if docs/openapi.json is out of date or not valid OpenAPI.
 * No credentials or hosts are embedded: servers are placeholders.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';
import { REGISTRY } from '../../apps/api/src/registry.js';
import { REST_ROUTES } from '../../apps/api/src/routes/rest.js';
import { S } from '../../packages/validation/src/index.js';
import { APP_VERSION } from '../../packages/domain/src/constants.js';
import { isMain } from '../../packages/shared/src/main.js';

type Json = Record<string, unknown>;
const schemaOf = (z: ZodTypeAny): Json => {
  const j = zodToJsonSchema(z, { target: 'openApi3', $refStrategy: 'none', effectStrategy: 'input' }) as Json;
  delete j.$schema;
  return j;
};

const ERR = { $ref: '#/components/responses/Error' };
const errorResponses = (idem: boolean, open = false): Json => ({
  400: ERR, ...(open ? {} : { 401: ERR, 403: ERR }), 404: ERR, 409: ERR, 422: ERR, ...(idem ? { 428: ERR } : {}), 429: ERR, 500: ERR, 503: ERR,
});

/** Request/response examples for the vertical slice (fictional values). */
const EXAMPLES: Record<string, { request?: Json; response?: Json }> = {
  'customer.submitTradeIn': {
    request: { vendorId: 'VND-001', branchId: 'BR-0001', variantId: 'VAR-000001', colorId: 'CLR-000001', imei: '990000000000001', conditionAnswers: { POWER: 'ON', SCREEN: 'PERFECT', BODY: 'EXCELLENT', BATTERY: 'GOOD', ACTIVATION_LOCK: 'YES' } },
    response: { ok: true, tradeInId: 'TI-DEMO-000001', estimate: 2000, estimatedGrade: 'A', gradeName: 'Excellent', currency: 'QAR', message: 'Bring your device to Demo Mall Branch (fictional). The final value is confirmed after inspection.' },
  },
  'tech.submitOffer': { request: { tradeInId: 'TI-DEMO-000001' }, response: { ok: true, tradeInId: 'TI-DEMO-000001', grade: 'A', gradeName: 'Excellent', finalValue: 2000, currency: 'QAR', message: 'Final offer of 2,000.00 QAR sent to the customer.' } },
  'customer.acceptOffer': { request: { tradeInId: 'TI-DEMO-000001' }, response: { ok: true, message: 'Offer accepted. Hand the device over at the shop to receive your voucher.' } },
  'tech.receiveDevice': { request: { tradeInId: 'TI-DEMO-000001' }, response: { ok: true, message: 'Device received. A voucher can now be issued.' } },
  'vendor.issueVoucher': { request: { tradeInId: 'TI-DEMO-000001' }, response: { ok: true, voucherId: 'VCH-000001', voucherNumber: 'DEMO-20261008-0001', value: 2000, currency: 'QAR' } },
  'vendor.voidVoucher': { request: { voucherId: 'VCH-000001', reason: 'Printed with a typo', reissue: true }, response: { ok: true, voucherId: 'VCH-000002', voucherNumber: 'DEMO-20261008-0002', message: 'Voucher reissued as DEMO-20261008-0002.' } },
  'admin.createBatch': { request: { vendorId: 'VND-001', branchId: 'BR-0001' }, response: { ok: true, batchId: 'BAT-00001', deviceCount: 1, message: 'Collection note created for 1 device(s).' } },
  'admin.updateBatch': { request: { batchId: 'BAT-00001', action: 'COLLECT' }, response: { ok: true, collected: 1, notCollected: 0, unresolved: [], status: 'COLLECTED', actualAmount: 2100, message: '1 device(s) collected.' } },
  'admin.createSettlement': { request: { vendorId: 'VND-001', from: '2026-10-01', to: '2026-10-31' }, response: { ok: true, settlementId: 'STL-00001', tradeInCount: 1, total: 2100, currency: 'QAR' } },
  'admin.advanceSettlement': { request: { settlementId: 'STL-00001', toStatus: 'APPROVED' }, response: { ok: true, message: 'Settlement approved.' } },
};

function rolesText(roles: unknown): string {
  return roles === '*' ? 'any signed-in person (scope still applies)' : (roles as string[]).join(', ');
}

export function buildOpenApi(): Json {
  const paths: Json = {};
  const tagOf = (action: string) => action.split('.')[0]!;

  paths['/health'] = { get: { tags: ['operations'], summary: 'Liveness — the process answers', security: [], responses: { 200: { description: 'Up', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, service: { type: 'string' }, status: { type: 'string' } } } } } } } } };
  paths['/ready'] = {
    get: {
      tags: ['operations'], summary: 'Readiness — database reachable (and SMS configured in staging/production)', security: [],
      responses: {
        200: { description: 'Ready', content: { 'application/json': { example: { ok: true, environment: 'staging', version: APP_VERSION, checks: { database: true, sms: 'configured', idempotencyKeysRequired: true, staffSignIn: 'password' } } } } },
        503: { description: 'Not ready (same shape, ok:false)' },
      },
    },
  };

  const auth: [string, string, ZodTypeAny | null, string][] = [
    ['/v1/auth/start', 'Send a sign-in code to a registered number', S.authStart, 'Sends a code through Supabase Auth → Send SMS hook → SMS provider. Unknown numbers are told to register; nothing else is revealed.'],
    ['/v1/auth/verify', 'Exchange the code for a session', S.authVerify, 'Returns the Supabase access token (use as Bearer) and refresh token. Wrong codes are limited (5 since the last code sent).'],
    ['/v1/auth/register', 'Register a customer, or request staff access', S.authRegister, 'Stage 1 without `code` sends a code; stage 2 with `code` creates the profile. Staff are created PENDING_APPROVAL and get no session.'],
    ['/v1/auth/refresh', 'Refresh the session', S.authRefresh, 'A refreshed token is still refused for a disabled or revoked profile.'],
    ['/v1/auth/logout', 'Sign out this session', null, 'Requires the Bearer token.'],
    ['/v1/auth/logout-all', 'Sign out every session of this person', null, 'Requires the Bearer token. All earlier tokens are refused from now on.'],
    ['/v1/auth/staff/login', 'Staff: sign in with work email and password', S.staffLogin,
      'STAFF_SIGN_IN=password (staging/production). A wrong password and an unknown address get the same answer. After STAFF_LOGIN_MAX_FAILURES wrong passwords in 15 minutes, sign-in for that address pauses (429). Returns the same session object as /v1/auth/verify.'],
    ['/v1/auth/staff/reset/start', 'Staff: e-mail a code to set or reset the password', S.staffResetStart,
      'Same reply for every address. For an ACTIVE staff address the API sets up the Supabase Auth user if needed and Supabase Auth e-mails a 6-digit code. One request per address per 60 s, five per hour (429).'],
    ['/v1/auth/staff/reset/finish', 'Staff: code + new password → signed in', S.staffResetFinish,
      'Sets the password, ends every earlier session of that person and returns a session. Wrong codes are limited (OTP_MAX_ATTEMPTS since the last code sent).'],
  ];
  for (const [p, summary, schema, description] of auth) {
    paths[p] = {
      post: {
        tags: ['auth'], summary, description, security: p.endsWith('logout') || p.endsWith('logout-all') ? [{ bearerAuth: [] }] : [],
        ...(schema ? { requestBody: { required: true, content: { 'application/json': { schema: schemaOf(schema) } } } } : {}),
        responses: {
          200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Ok' }, ...(p === '/v1/auth/verify' ? { example: { ok: true, token: '<access token>', refreshToken: '<refresh token>', expiresIn: 3600, portal: 'customer', user: { name: 'Demo Customer', role: 'CUSTOMER', roleLabel: 'Customer' } } } : {}) } } },
          ...errorResponses(false, true),
        },
      },
    };
  }
  paths['/v1/hooks/send-sms'] = {
    post: {
      tags: ['hooks'], summary: 'Supabase Auth "Send SMS" hook (server-to-server)', security: [{ webhookSignature: [] }],
      description: 'Called by Supabase Auth only. Standard Webhooks signature (webhook-id, webhook-timestamp, webhook-signature) with the hook secret; ±5 min. Success: 200 {}. A policy refusal: 200 {"error":{"http_code":429,"message":"…"}} which Supabase Auth relays. Bad signature: 401.',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { user: { type: 'object', properties: { phone: { type: 'string' } } }, sms: { type: 'object', properties: { otp: { type: 'string' } } } } } } } },
      responses: { 200: { description: 'Handled (success, or a refusal in the body)' }, 401: { description: 'Signature rejected' } },
    },
  };
  for (const [p, action, summary] of [['/v1/public/vendor-context', 'public.vendorContext', 'Partners and branches a customer can choose (public fields only)'], ['/v1/public/catalog', 'public.catalogTree', 'Active catalogue (no prices, no fees)'], ['/v1/public/questions', 'customer.questions', 'Customer condition questions']] as const) {
    paths[p] = { get: { tags: ['public'], operationId: `get_${action}`, summary, security: [], responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Ok' } } } }, 500: ERR } } };
  }

  // Every registry action through the compatibility endpoint (the one the 3.1 screens use).
  for (const [action, def] of Object.entries(REGISTRY).sort(([a], [b]) => a.localeCompare(b))) {
    const d = def as { roles: unknown; schema: ZodTypeAny; idem?: readonly string[]; readOnly?: boolean };
    const idem = !!d.idem;
    const ex = EXAMPLES[action];
    paths[`/v1/actions/${action}`] = {
      post: {
        tags: [tagOf(action)], operationId: action.replace('.', '_'),
        summary: `${action}${d.readOnly ? ' (read)' : ''}`,
        description: `Roles: ${rolesText(d.roles)}.${idem ? ` Idempotent: send an Idempotency-Key (required in staging/production; missing → 428). Key scope: ${d.idem!.join(', ') || 'principal + action'}.` : ''} Partner, branch and ownership scope are enforced inside the action; an out-of-scope object answers 404.`,
        'x-roles': d.roles, 'x-idempotent': idem, 'x-read-only': !!d.readOnly,
        parameters: idem ? [{ $ref: '#/components/parameters/IdempotencyKey' }] : [],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['params'], properties: { params: schemaOf(d.schema) } }, ...(ex?.request ? { example: { params: ex.request } } : {}) } } },
        responses: { 200: { description: 'OK (a replay of an idempotent request adds "replayed": true)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Ok' }, ...(ex?.response ? { example: ex.response } : {}) } } }, ...errorResponses(idem) },
      },
    };
  }

  // REST routes for the vertical slice (same implementation as the action they map to).
  for (const r of REST_ROUTES as { method: string; url: string; action: string; extra?: Json }[]) {
    const def = REGISTRY[r.action] as { roles: unknown; schema: ZodTypeAny; idem?: readonly string[] };
    const p = `/v1${r.url.replace(/:([A-Za-z]+)/g, '{$1}')}`;
    const pathParams = [...r.url.matchAll(/:([A-Za-z]+)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    const idem = !!def.idem;
    const op: Json = {
      tags: [`rest:${r.action.split('.')[0]}`], operationId: `rest_${r.method.toLowerCase()}_${r.url.replace(/[/:-]+/g, '_').replace(/^_|_$/g, '')}`,
      summary: `→ ${r.action}${r.extra ? ` ${JSON.stringify(r.extra)}` : ''}`,
      description: `Same code path as POST /v1/actions/${r.action}. Roles: ${rolesText(def.roles)}.`,
      parameters: [...pathParams, ...(idem ? [{ $ref: '#/components/parameters/IdempotencyKey' }] : [])],
      responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Ok' } } } }, ...errorResponses(idem) },
    };
    if (r.method === 'POST') op.requestBody = { required: false, content: { 'application/json': { schema: schemaOf(def.schema) } } };
    paths[p] = { ...(paths[p] as Json ?? {}), [r.method.toLowerCase()]: op };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Qatar Mobile Trade-In API', version: APP_VERSION,
      description: 'Railway API in front of Supabase (PostgreSQL, Auth, Storage). Every response carries X-Request-Id. Errors: {ok:false, message, code}. Generated from the code by `npm run openapi`.',
    },
    servers: [
      { url: 'https://{stagingHost}', description: 'Staging (placeholder — fill in after deployment)', variables: { stagingHost: { default: 'STAGING-API-HOST' } } },
      { url: 'https://{productionHost}', description: 'Production (placeholder — next phase)', variables: { productionHost: { default: 'PRODUCTION-API-HOST' } } },
    ],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: 'operations' }, { name: 'auth' }, { name: 'hooks' }, { name: 'public' },
      { name: 'customer' }, { name: 'tech' }, { name: 'vendor' }, { name: 'admin' }, { name: 'search' }, { name: 'notify' }, { name: 'me' },
    ],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Supabase Auth access token of a signed-in person. Service-role and anon keys are refused.' },
        webhookSignature: { type: 'apiKey', in: 'header', name: 'webhook-signature', description: 'Standard Webhooks HMAC signature (Supabase Auth hooks).' },
      },
      parameters: {
        IdempotencyKey: { name: 'Idempotency-Key', in: 'header', required: false, description: '16–128 chars [A-Za-z0-9_-]. Same key + same request → the original result. Same key + different request → 409. Required in staging/production for idempotent actions (428 when missing).', schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{16,128}$' } },
      },
      schemas: {
        Ok: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean', const: true }, replayed: { type: 'boolean' } }, additionalProperties: true },
        Error: {
          type: 'object', required: ['ok', 'message'],
          properties: {
            ok: { type: 'boolean', const: false }, message: { type: 'string', description: 'A sentence for a person. Never a stack trace or a constraint name.' },
            code: { type: 'string', enum: ['VALIDATION', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'BUSINESS_RULE', 'IDEMPOTENCY_KEY_REUSED', 'IDEMPOTENCY_KEY_REQUIRED', 'RATE_LIMITED', 'UNAVAILABLE', 'INTERNAL', 'REQUEST'] },
            reauth: { type: 'boolean', description: 'true when the client must sign in again' },
          },
        },
      },
      responses: { Error: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } },
    },
  };
}

if (isMain(import.meta.url)) {
  const out = resolve(process.argv[2] ?? 'docs/openapi.json');
  writeFileSync(out, `${JSON.stringify(buildOpenApi(), null, 2)}\n`);
  console.log(`OpenAPI written to ${out}`);
}
