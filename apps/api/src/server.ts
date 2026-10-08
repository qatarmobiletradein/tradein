/**
 * Railway entry point: `npm start` → node dist/apps/api/src/server.js
 *
 * Reads configuration from the environment (refusing to start if it is
 * unsafe), builds the app, listens on $PORT, and shuts down gracefully on
 * SIGTERM/SIGINT: stop accepting connections, finish in-flight requests,
 * close the database pool, exit. Migrations are NOT run here; they are a
 * separate, explicit command (npm run migrate).
 */
import { GraphMailer, NoMailer } from './lib/mail/graph.js';
import { createTokenVerifier } from '../../../packages/auth/src/jwt.js';
import { createPool } from '../../../packages/database/src/db.js';
import { ConfigError, loadConfig } from '../../../packages/shared/src/config.js';
import { createLogger } from '../../../packages/shared/src/logger.js';
import { buildApp } from './app.js';
import type { Deps } from './context.js';
import { GoTrueGateway, UnavailableGateway } from './lib/gotrue.js';
import { createSmsProvider } from './lib/sms/provider.js';
import { MemoryStorage, SupabaseStorage } from './lib/storage.js';
import { isMain } from '../../../packages/shared/src/main.js';
import { settleBackgroundWork } from './services/staff-auth.js';

export async function createDeps(env: NodeJS.ProcessEnv = process.env): Promise<Deps> {
  const config = loadConfig(env);
  const log = createLogger(config.LOG_LEVEL);
  const pool = createPool({
    connectionString: config.DATABASE_URL, max: config.DATABASE_POOL_MAX, ssl: config.DATABASE_SSL, sslCa: config.DATABASE_SSL_CA, applicationName: 'qm-api',
  });
  pool.on('error', (err) => log.error({ err }, 'idle database client error'));
  const storage = config.SUPABASE_URL && config.SUPABASE_SERVICE_ROLE_KEY
    ? new SupabaseStorage(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY)
    : (config.isProductionLike ? (() => { throw new ConfigError('Storage is not configured.'); })() : new MemoryStorage());
  const authGateway = config.SUPABASE_URL && config.SUPABASE_ANON_KEY
    ? new GoTrueGateway(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, fetch, config.SUPABASE_SERVICE_ROLE_KEY, config.SUPABASE_AUTH_FORWARD_CLIENT_IP)
    : new UnavailableGateway();
  const verifyToken = createTokenVerifier({
    secret: config.SUPABASE_JWT_SECRET, jwksUrl: config.SUPABASE_JWKS_URL,
    issuer: config.SUPABASE_JWT_ISSUER, audience: config.SUPABASE_JWT_AUDIENCE,
  });
  const mailer = config.staffMailConfigured
    ? new GraphMailer(config.GRAPH_TENANT_ID!, config.GRAPH_CLIENT_ID!, config.GRAPH_CLIENT_SECRET!, config.STAFF_MAIL_FROM!)
    : new NoMailer();
  return { config, pool, log, sms: createSmsProvider(config), storage, authGateway, verifyToken, mailer };
}

async function main(): Promise<void> {
  let deps: Deps;
  try {
    deps = await createDeps();
  } catch (err) {
    // Configuration problems name variables, never values.
    console.error(err instanceof Error ? err.message : 'Refusing to start: configuration error.');
    process.exit(2);
  }
  const app = await buildApp(deps);
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.log.info({ signal }, 'shutting down');
    const timer = setTimeout(() => { deps.log.error('forced exit after timeout'); process.exit(1); }, 25_000);
    timer.unref();
    try {
      await app.close();
      await settleBackgroundWork(); // reset e-mails already promised to someone
      await deps.pool.end();
      deps.log.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      deps.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => deps.log.error({ err }, 'unhandled rejection'));

  await app.listen({ host: deps.config.HOST, port: deps.config.PORT });
  deps.log.info({ env: deps.config.APP_ENV, sms: deps.sms.name }, 'qm-api listening');
}

if (isMain(import.meta.url)) {
  void main();
}
