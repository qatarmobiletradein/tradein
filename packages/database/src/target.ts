/**
 * Which database is a command about to touch — and is it allowed to?
 *
 * Every operator command that writes (migrate, seed:staging, import,
 * file migration) calls assertTargetAllowed() first:
 *
 *   - The URL must name its host explicitly, and may carry no query
 *     parameter that redirects the connection (host, port, user, options…):
 *     node-postgres would apply those AFTER this check. PG* environment
 *     variables that do the same are refused too.
 *   - It prints the target WITHOUT the password (host, port, user,
 *     database, Supabase project ref, connection mode).
 *   - Local databases (127.0.0.1 / localhost / ::1) need no confirmation.
 *   - Anything else needs MIGRATION_TARGET_CONFIRM set to the Supabase
 *     project ref (or the host, for a non-Supabase database). On Supabase
 *     the database is always called "postgres", so the NAME cannot tell
 *     staging from production — the project ref can.
 *   - Any ref/host listed in QM_PROTECTED_TARGETS (comma-separated; put
 *     the PRODUCTION project ref there on operator machines) is refused
 *     outright. This phase never writes to production.
 *   - Supabase's transaction pooler (port 6543) is refused for commands
 *     that need a session (migrations use a session advisory lock).
 */
export interface DbTarget {
  host: string;
  port: number;
  database: string;
  user: string;
  projectRef: string | null;
  mode: 'local' | 'supabase-direct' | 'supabase-session-pooler' | 'supabase-transaction-pooler' | 'other';
  label: string;
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
/** Query parameters that cannot change WHERE or AS WHOM we connect. ssl* are stripped by createPool. */
const SAFE_PARAMS = /^(application_name|connect_timeout|sslmode|sslrootcert|sslcert|sslkey|ssl)$/i;
/** Environment variables node-postgres reads as connection defaults. */
const PG_ENV = ['PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGUSER', 'PGDATABASE', 'PGOPTIONS', 'PGSERVICE'];

export function describeTarget(connectionString: string): DbTarget {
  let u: URL;
  try {
    u = new URL(connectionString);
  } catch {
    throw new Error('DATABASE_URL is not a valid postgres:// URL.');
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error('DATABASE_URL must start with postgres:// or postgresql://.');
  const host = u.hostname.toLowerCase();
  if (!host) throw new Error('DATABASE_URL must name its host explicitly.');
  for (const k of u.searchParams.keys()) {
    if (!SAFE_PARAMS.test(k)) throw new Error(`DATABASE_URL query parameter "${k}" is not allowed (it could redirect or alter the connection).`);
  }
  const port = Number(u.port || 5432);
  const user = decodeURIComponent(u.username || '');
  const database = decodeURIComponent(u.pathname.replace(/^\//, '') || 'postgres');
  const direct = /^db\.([a-z0-9]{10,40})\.supabase\.co$/.exec(host);
  const pooled = /\.pooler\.supabase\.com$/.test(host);
  const userRef = /^postgres\.([a-z0-9]{10,40})$/.exec(user);
  const projectRef = direct?.[1] ?? userRef?.[1] ?? null;
  let mode: DbTarget['mode'] = 'other';
  if (LOCAL_HOSTS.has(host)) mode = 'local';
  else if (direct) mode = port === 6543 ? 'supabase-transaction-pooler' : 'supabase-direct';
  else if (pooled) mode = port === 6543 ? 'supabase-transaction-pooler' : 'supabase-session-pooler';
  const label = `${user || '(no user)'}@${host}:${port}/${database}${projectRef ? ` [project ${projectRef}]` : ''} (${mode})`;
  return { host, port, database, user, projectRef, mode, label };
}

const protectedList = (env: NodeJS.ProcessEnv) =>
  String(env.QM_PROTECTED_TARGETS ?? '').split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);

/** Is this database (by project ref or host) or Supabase URL protected? */
export function isProtected(t: { projectRef: string | null; host: string }, env: NodeJS.ProcessEnv = process.env): boolean {
  const list = protectedList(env);
  return (!!t.projectRef && list.includes(t.projectRef.toLowerCase())) || list.includes(t.host.toLowerCase());
}

/** The project ref of a Supabase project URL (https://<ref>.supabase.co), or null. */
export function supabaseRefOf(url: string | undefined): string | null {
  if (!url) return null;
  try { return /^([a-z0-9]{10,40})\.supabase\.co$/.exec(new URL(url).hostname.toLowerCase())?.[1] ?? null; } catch { return null; }
}

export interface TargetCheck { needsSession?: boolean; purpose: string; env?: NodeJS.ProcessEnv }

/** Throws with an operator-readable sentence; never includes the password. */
export function assertTargetAllowed(connectionString: string, o: TargetCheck): DbTarget {
  const env = o.env ?? process.env;
  const pgEnv = PG_ENV.filter((k) => (env[k] ?? '').trim() !== '');
  if (pgEnv.length) throw new Error(`Refusing ${o.purpose}: unset ${pgEnv.join(', ')} — they can change which database is used.`);
  const t = describeTarget(connectionString);
  const id = t.projectRef ?? t.host;
  if (isProtected(t, env)) {
    throw new Error(`Refusing ${o.purpose}: ${id} is listed in QM_PROTECTED_TARGETS (production is out of scope for this phase).`);
  }
  if (o.needsSession && t.mode === 'supabase-transaction-pooler') {
    throw new Error(`Refusing ${o.purpose}: port 6543 is Supabase's TRANSACTION pooler. Use the direct connection or the session pooler (port 5432).`);
  }
  if (t.mode !== 'local') {
    const confirm = String(env.MIGRATION_TARGET_CONFIRM ?? '').trim();
    if (!confirm || confirm !== id) {
      throw new Error(`Refusing ${o.purpose}: set MIGRATION_TARGET_CONFIRM=${id} to confirm the target ${t.label}.`);
    }
  }
  return t;
}

/**
 * TLS settings for operator commands, from the same variables the server uses.
 * Local targets default to no TLS; anything else defaults to a VERIFIED
 * certificate, and DATABASE_SSL=disable is refused for a non-local target.
 */
export function sslFromEnv(env: NodeJS.ProcessEnv = process.env, connectionString?: string) {
  const local = connectionString ? (() => { try { return describeTarget(connectionString).mode === 'local'; } catch { return false; } })() : false;
  const ssl = (env.DATABASE_SSL as 'require' | 'no-verify' | 'disable' | undefined) || (local ? 'disable' : 'require');
  if (!local && connectionString && ssl === 'disable') throw new Error('DATABASE_SSL=disable is refused for a non-local database.');
  if (!local && ssl === 'no-verify') console.warn('WARNING: DATABASE_SSL=no-verify — the connection is encrypted but the server certificate is NOT verified.');
  return { ssl, sslCa: env.DATABASE_SSL_CA };
}
