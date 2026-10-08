/**
 * A long-running worker (optional Railway service): runs reconciliation
 * every RECONCILE_INTERVAL_MINUTES (default 60) and purge daily. Every run
 * is recorded in job_runs, so a failed or silent job is visible on the
 * admin side and to monitoring that watches job_runs.
 */
import { createPool } from '../../../../packages/database/src/db.js';
import { sslFromEnv } from '../../../../packages/database/src/target.js';
import { createLogger } from '../../../../packages/shared/src/logger.js';
import { runPurge, runReconciliation } from './reconcile.js';

const log = createLogger(process.env.LOG_LEVEL ?? 'info');
const url = process.env.DATABASE_URL;
if (!url) { log.fatal('DATABASE_URL is not set'); process.exit(2); }
const pool = createPool({ connectionString: url, max: 2, ...sslFromEnv(process.env, url), applicationName: 'qm-worker' });
const every = Math.max(5, Number(process.env.RECONCILE_INTERVAL_MINUTES) || 60) * 60_000;
let lastPurge = 0;

async function tick(): Promise<void> {
  try {
    const r = await runReconciliation(pool);
    log.info({ runId: r.runId, issues: r.issues.length }, 'reconciliation finished');
    if (Date.now() - lastPurge > 86_400_000) { log.info(await runPurge(pool), 'purge finished'); lastPurge = Date.now(); }
  } catch (err) {
    log.error({ err }, 'job failed');
  }
}
const timer = setInterval(() => void tick(), every);
void tick();
const stop = async () => { clearInterval(timer); await pool.end(); process.exit(0); };
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
