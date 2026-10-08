/**
 * docs/openapi.json is generated from the code (npm run openapi). This test
 * fails if it is not valid OpenAPI 3.1, if it has drifted from the code, or
 * if it contains anything that looks like a credential.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import SwaggerParser from '@apidevtools/swagger-parser';
import { buildOpenApi } from '../../tools/openapi/generate.js';
import { REGISTRY } from '../../apps/api/src/registry.js';

describe('OpenAPI description', () => {
  const spec = buildOpenApi();
  it('is valid OpenAPI and lists every registry action, the auth routes, health and readiness', async () => {
    await SwaggerParser.validate(structuredClone(spec) as never);
    const paths = Object.keys(spec.paths as object);
    for (const a of Object.keys(REGISTRY)) expect(paths).toContain(`/v1/actions/${a}`);
    for (const p of ['/health', '/ready', '/v1/auth/start', '/v1/auth/verify', '/v1/hooks/send-sms', '/v1/customer/trade-ins']) expect(paths).toContain(p);
  });
  it('marks idempotent actions with the Idempotency-Key header and a 428 response', () => {
    const op = (spec.paths as Record<string, { post: Record<string, unknown> }>)['/v1/actions/customer.submitTradeIn']!.post;
    expect(op['x-idempotent']).toBe(true);
    expect(JSON.stringify(op.parameters)).toContain('IdempotencyKey');
    expect(Object.keys(op.responses as object)).toContain('428');
    const read = (spec.paths as Record<string, { post: Record<string, unknown> }>)['/v1/actions/customer.myTradeIns']!.post;
    expect(Object.keys(read.responses as object)).not.toContain('428');
  });
  it('docs/openapi.json is up to date and holds no credentials or real hosts', () => {
    const file = readFileSync('docs/openapi.json', 'utf8');
    expect(JSON.parse(file)).toEqual(JSON.parse(JSON.stringify(spec)));
    expect(file).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.|sb_secret_|whsec_|postgres:\/\/|supabase\.co|railway\.app/);
  });
});
