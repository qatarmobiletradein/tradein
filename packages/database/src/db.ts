/**
 * PostgreSQL access: one pool, real transactions, parameterised SQL only.
 *
 * Every state change in the API runs inside withTransaction(). The 3.1
 * script lock (LockService) becomes, in order of preference:
 *   1. a constraint or partial unique index the database enforces;
 *   2. a row lock (SELECT ... FOR UPDATE) on the record being changed;
 *   3. a transaction-scoped advisory lock for "no row exists yet" races
 *      (idempotency keys, counters).
 * Serialization failures and deadlocks are retried a bounded number of
 * times; anything else propagates.
 */
import pg from 'pg';
import { CommitThenFail } from '../../shared/src/errors.js';

const { Pool, types } = pg;

// int8 (count(*), identity ids) as JS numbers: every value we read is far below 2^53.
types.setTypeParser(20, (v) => Number(v));
// numeric stays a STRING (money is converted exactly in shared/money.ts).

export type Queryable = Pick<pg.PoolClient, 'query'>;
export type Tx = pg.PoolClient;
export type DbPool = pg.Pool;

export interface PoolOptions {
  connectionString: string;
  max?: number;
  ssl?: 'require' | 'no-verify' | 'disable';
  /** PEM of the CA that signed the server certificate (Supabase publishes one). */
  sslCa?: string;
  applicationName?: string;
  /** Server options at connect, e.g. '-c default_transaction_read_only=on'. */
  options?: string;
}

/**
 * ssl* query parameters in a connection string OVERRIDE the `ssl` option in
 * node-postgres (it merges the parsed URL last). They are removed so the
 * explicit setting below is the one that applies.
 */
export function withoutSslParams(connectionString: string, alsoRemove: string[] = []): string {
  try {
    const u = new URL(connectionString);
    for (const k of [...u.searchParams.keys()]) if (/^ssl/i.test(k) || alsoRemove.includes(k.toLowerCase())) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return connectionString;
  }
}

/** Accepts a PEM pasted as one line with literal "\n", or base64 of the PEM. */
export function normalizePem(v: string | undefined): string | undefined {
  if (!v || !v.trim()) return undefined;
  let s = v.trim().replace(/\\n/g, '\n');
  if (!s.includes('-----BEGIN')) {
    try { s = Buffer.from(s, 'base64').toString('utf8'); } catch { return undefined; }
  }
  return s.includes('-----BEGIN CERTIFICATE-----') ? s : undefined;
}

export function createPool(o: PoolOptions): pg.Pool {
  const ca = normalizePem(o.sslCa);
  if (o.sslCa && o.sslCa.trim() && !ca) throw new Error('DATABASE_SSL_CA is set but is not a PEM certificate (paste the certificate text, not a file path).');
  const ssl = o.ssl === 'disable' ? false
    : o.ssl === 'no-verify' ? { rejectUnauthorized: false }
    : ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
  const pool = new Pool({
    // When we pass server options, a URL ?options= must not replace them.
    connectionString: withoutSslParams(o.connectionString, o.options ? ['options'] : []),
    max: o.max ?? 10,
    ssl,
    application_name: o.applicationName ?? 'qm-api',
    ...(o.options ? { options: o.options } : {}),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Detect dead pooled connections (cloud poolers close idle ones).
    keepAlive: true,
  });
  // An idle client error must not crash the process; it is logged by the caller.
  pool.on('error', () => undefined);
  return pool;
}

/** A connection-level failure (network error, admin shutdown, SQLSTATE class 08): the client must not be reused. */
export function isBrokenConnection(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') {
    return code.startsWith('08') || code === '57P01' || code === '57P02' || code === '57P03'
      || /^E(CONNRESET|PIPE|TIMEDOUT|CONNREFUSED|HOSTUNREACH|NETUNREACH|AI_AGAIN|NOTFOUND)$/.test(code);
  }
  return /Connection terminated|connection timeout|Client has encountered a connection error/i.test(err.message);
}

const RETRYABLE = new Set(['40001', '40P01']);

export interface TxOptions {
  isolation?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
  statementTimeoutMs?: number;
  retries?: number;
}

/**
 * Run `fn` in one transaction. Commits on success, rolls back on any
 * throw — except CommitThenFail, which commits the work done so far and
 * then re-throws the inner refusal.
 */
export async function withTransaction<T>(pool: pg.Pool, fn: (tx: Tx) => Promise<T>, o: TxOptions = {}): Promise<T> {
  const retries = o.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    let released = false;
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${o.isolation ?? 'READ COMMITTED'}`);
      await client.query(`SET LOCAL statement_timeout = ${Math.max(1000, Math.floor(o.statementTimeoutMs ?? 15000))}`);
      await client.query(`SET LOCAL lock_timeout = '10s'`);
      try {
        const out = await fn(client);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        if (err instanceof CommitThenFail) {
          await client.query('COMMIT');
          throw err.inner;
        }
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (!released && isBrokenConnection(err)) {
        // Throw the connection away rather than hand a dead one to the next request.
        client.release(true);
        released = true;
      }
      if (code && RETRYABLE.has(code) && attempt < retries) {
        if (!released) client.release();
        released = true;
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1) + Math.floor(Math.random() * 30)));
        continue;
      }
      throw err;
    } finally {
      if (!released) client.release();
    }
  }
}

/** A transaction-scoped advisory lock on an arbitrary string key. */
export async function advisoryXactLock(tx: Queryable, key: string): Promise<void> {
  await tx.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}

/** Next value of a named counter, inside the caller's transaction (app.next_counter). */
export async function nextCounter(tx: Queryable, scope: string, floor = 0): Promise<number> {
  const r = await tx.query<{ v: number }>('select app.next_counter($1, $2)::bigint as v', [scope, floor]);
  return Number(r.rows[0]!.v);
}

/** Readiness probe: can we run a trivial query within a short timeout? */
export async function ping(pool: pg.Pool, timeoutMs = 2000): Promise<boolean> {
  const timer = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs));
  const probe = pool.query('select 1').then(() => true).catch(() => false);
  return Promise.race([probe, timer]);
}
