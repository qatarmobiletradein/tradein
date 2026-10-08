/** npm run compare:sheets -- --dir <export-dir> [--out <report-dir>]  (read-only) */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createPool } from '../../packages/database/src/db.js';
import { describeTarget, sslFromEnv } from '../../packages/database/src/target.js';
import { compare } from './compare.js';

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : undefined; };

async function main(): Promise<void> {
  const dir = arg('dir');
  const url = process.env.DATABASE_URL;
  if (!dir || !url) { console.error('Usage: DATABASE_URL=... compare-cli --dir <export-dir>'); process.exit(2); }
  try { console.log(`target (read-only): ${describeTarget(url).label}`); } catch (e) { console.error((e as Error).message); process.exit(2); }
  const pool = createPool({ connectionString: url, max: 2, ...sslFromEnv(process.env, url), applicationName: 'qm-compare' });
  try {
    const r = await compare(pool, resolve(dir));
    const out = resolve(arg('out') ?? 'migration-reports');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `compare-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(r, null, 2));
    console.log(JSON.stringify({ ok: r.ok, totals: r.totals, missing: r.counts.filter((c) => c.missing), mismatches: r.mismatches.length,
      orphans: r.orphans.length, duplicates: r.duplicates.length, invalidStates: r.invalidStates.length, brokenFiles: r.brokenFiles.length }, null, 2));
    process.exitCode = r.ok ? 0 : 1;
  } finally { await pool.end(); }
}
main().catch((e) => { console.error(`Compare failed: ${(e as Error).message}`); process.exit(1); });
