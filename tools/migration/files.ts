/**
 * Evidence-photo file migration (Google Drive → Supabase Storage, PRIVATE
 * bucket). Input is a local directory of files downloaded from Drive and
 * named by their Drive file id (an operator step, see DATA_MIGRATION.md).
 * Each file is validated by its bytes and size, uploaded under
 * inspection-photos/<TradeInID>/legacy/<uuid>.<ext>, recorded in
 * legacy_file_map, and the inspection_photos row is updated with the real
 * path, type, size and hash. Already-mapped files are skipped (resumable).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { MEDIA } from '../../packages/domain/src/constants.js';
import { objectName, validateImage, type StorageClient } from '../../apps/api/src/lib/storage.js';

export interface FileReport { uploaded: number; skipped: number; missing: string[]; rejected: { fileId: string; reason: string }[] }

export async function migrateFiles(pool: pg.Pool, storage: StorageClient, dir: string, dryRun: boolean): Promise<FileReport> {
  const report: FileReport = { uploaded: 0, skipped: 0, missing: [], rejected: [] };
  const available = new Set(existsSync(dir) ? readdirSync(dir) : []);
  const pending = (await pool.query<{ id: string; trade_in_id: string; legacy_drive_file_id: string }>(
    `select p.id, p.trade_in_id, p.legacy_drive_file_id from public.inspection_photos p
      where p.legacy_drive_file_id is not null
        and not exists (select 1 from public.legacy_file_map m where m.legacy_drive_file_id = p.legacy_drive_file_id)`)).rows;
  for (const p of pending) {
    const name = [...available].find((f) => f === p.legacy_drive_file_id || f.startsWith(`${p.legacy_drive_file_id}.`));
    if (!name) { report.missing.push(p.legacy_drive_file_id); continue; }
    let img;
    try {
      // Bare base64 (no declared type): the type is decided by the bytes alone.
      img = validateImage(readFileSync(join(dir, name)).toString('base64'), MEDIA.MAX_PHOTO_BYTES);
    } catch (e) {
      report.rejected.push({ fileId: p.legacy_drive_file_id, reason: (e as Error).message });
      continue;
    }
    if (dryRun) { report.skipped++; continue; }
    const path = objectName(`${p.trade_in_id}/legacy`, img.ext);
    await storage.upload('inspection-photos', path, img.bytes, img.mime);
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query(`update public.inspection_photos set object_path = $2, mime_type = $3, size_bytes = $4, sha256 = $5 where id = $1`, [p.id, path, img.mime, img.size, img.sha256]);
      await c.query(`insert into public.legacy_file_map (legacy_drive_file_id, bucket, object_path, sha256, size_bytes) values ($1,'inspection-photos',$2,$3,$4)`,
        [p.legacy_drive_file_id, path, img.sha256, img.size]);
      await c.query('commit');
      report.uploaded++;
    } catch (e) {
      await c.query('rollback').catch(() => undefined);
      await storage.remove('inspection-photos', path);
      report.rejected.push({ fileId: p.legacy_drive_file_id, reason: (e as Error).message.slice(0, 200) });
    } finally { c.release(); }
  }
  return report;
}
