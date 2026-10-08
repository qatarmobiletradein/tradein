/**
 * Railway Infrastructure as Code — STAGING ONLY (this phase).
 *
 * Railway's older railway.json ("config as code") cannot be used by NEW
 * services and stops working for existing ones on 2026-12-01, so the
 * service is described here instead. Typed against railway@3.11.0.
 *
 *   railway config plan      # ALWAYS review first
 *   railway config apply
 *
 * WARNING (from Railway's docs): this file describes the WHOLE project —
 * a resource that exists in Railway but not here is DELETED on apply. Use a
 * Railway project dedicated to this API's staging environment.
 *
 * Secrets are never written here: every secret is preserve()d, i.e. Railway
 * keeps the (sealed) value you set in the dashboard. Only non-secret
 * settings are literal. See docs/CLOUD_CONFIGURATION.md for the full list.
 *
 * Not executed: no Railway account was available when this was written.
 */
import { defineRailway, preserve, service } from 'railway/iac';

export default defineRailway((ctx, project) => {
  // Positive allow-list: only an environment literally named "staging" may be managed by this file.
  if (!ctx.isEnvironment('staging')) {
    throw new Error('This file manages the "staging" environment only. Production is configured in the cutover phase.');
  }

  const secret = preserve();
  const api = service('qm-api', {
    // Source: connect the GitHub repository in the dashboard, or deploy with `railway up`.
    build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' },
    start: 'node dist/apps/api/src/server.js',
    healthcheck: '/ready',
    healthcheckTimeout: 60,
    deploy: { restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 5, drainingSeconds: 30 },
    env: {
      APP_ENV: 'staging',
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
      TRUST_PROXY_HOPS: '1',
      IDEMPOTENCY_KEY_REQUIRED: 'true',
      DATABASE_SSL: 'require',
      DATABASE_POOL_MAX: '10',
      SMS_PROVIDER: preserve(),
      // Secrets and per-project values (set and seal them in the dashboard):
      DATABASE_URL: secret,
      DATABASE_SSL_CA: preserve(),
      SUPABASE_URL: preserve(),
      SUPABASE_PUBLISHABLE_KEY: preserve(),
      SUPABASE_SECRET_KEY: preserve(),
      SUPABASE_JWKS_URL: preserve(),
      SUPABASE_JWT_SECRET: preserve(),
      SUPABASE_JWT_ISSUER: preserve(),
      SEND_SMS_HOOK_SECRET: preserve(),
      CORS_ALLOWED_ORIGINS: preserve(),
      TWILIO_ACCOUNT_SID: preserve(),
      TWILIO_AUTH_TOKEN: preserve(),
      TWILIO_FROM: preserve(),
      // Optional — declared so an apply never removes values set in the dashboard.
      CUSTOM_SMS_URL: preserve(),
      CUSTOM_SMS_KEY: preserve(),
      SMS_SENDER_ID: preserve(),
      SUPABASE_JWT_AUDIENCE: preserve(),
      SUPABASE_ANON_KEY: preserve(),
      SUPABASE_SERVICE_ROLE_KEY: preserve(),
      AUTH_RATE_LIMIT_MAX: preserve(),
      RATE_LIMIT_MAX: preserve(),
    },
  });

  // Hourly integrity check (exits when done; findings land in job_runs / reconciliation_issues).
  const jobs = service('qm-reconcile', {
    build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' },
    start: 'node dist/apps/api/src/jobs/run-job.js reconcile',
    deploy: { cronSchedule: '7 * * * *', restartPolicyType: 'NEVER' },
    env: { APP_ENV: 'staging', NODE_ENV: 'production', DATABASE_SSL: 'require', DATABASE_URL: preserve(), DATABASE_SSL_CA: preserve() },
  });

  return project('qatar-mobile-tradein-staging', { resources: [api, jobs] });
});
