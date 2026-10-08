/**
 * Tiny SQL helpers. Column names come from code, never from a request,
 * and are still checked against an identifier pattern; every value is a
 * bound parameter.
 */
import type { Queryable } from '../../../../packages/database/src/db.js';

const IDENT = /^[a-z_][a-z0-9_]*$/;

export async function updateById(
  db: Queryable, table: string, id: string, patch: Record<string, unknown>, idColumn = 'id',
): Promise<number> {
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  if (!keys.length) return 0;
  for (const k of [table, idColumn, ...keys]) if (!IDENT.test(k)) throw new Error(`bad identifier ${k}`);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const values = keys.map((k) => {
    const v = patch[k];
    return v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) ? JSON.stringify(v) : v;
  });
  const r = await db.query(`update public.${table} set ${sets} where ${idColumn} = $1`, [id, ...values]);
  return r.rowCount ?? 0;
}

export async function insertRow(db: Queryable, table: string, row: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(row).filter((k) => row[k] !== undefined);
  for (const k of [table, ...keys]) if (!IDENT.test(k)) throw new Error(`bad identifier ${k}`);
  const values = keys.map((k) => {
    const v = row[k];
    return v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) ? JSON.stringify(v) : v;
  });
  await db.query(
    `insert into public.${table} (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, values);
}

/** Append "[2026-10-08 14:05] text" to a notes field (appendNote_). */
export function appendNote(existing: string | null | undefined, addition: unknown, stamp: string): string {
  const add = typeof addition === 'string' ? addition.trim() : '';
  if (!add) return existing ?? '';
  return `${existing ? `${existing}\n` : ''}[${stamp}] ${add}`;
}

export const clampLimit = (v: unknown, dflt: number, max: number): number => {
  const n = Number(v);
  return Math.min(Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt, max);
};
