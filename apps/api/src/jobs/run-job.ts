/**
 * One-off jobs: `npm run job:reconcile` / `npm run job:purge`.
 * Suitable for a Railway cron service. Exit code 0 = ran (findings are in
 * job_runs / reconciliation_issues), 1 = the job itself failed.
 */
import { createPool } from '../../../../packages/database/src/db.js';
import { sslFromEnv } from '../../../../packages/database/src/target.js';
import { runPurge, runReconciliation } from './reconcile.js';

async function main(): Promise<void> {
  const job = process.argv[2];
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const pool = createPool({ connectionString: url, max: 2, ...sslFromEnv(process.env, url), applicationName: `qm-job-${job}` });
  try {
    if (job === 'reconcile') {
      const r = await runReconciliation(pool);
      console.log(JSON.stringify({ job, runId: r.runId, issues: r.issues.length, counts: r.counts }));
    } else if (job === 'purge') {
      console.log(JSON.stringify({ job, ...(await runPurge(pool)) }));
    } else {
      console.error('Usage: run-job.js reconcile|purge');
      process.exitCode = 2;
    }
  } catch (err) {
    console.error(`Job ${job} failed: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
void main();
