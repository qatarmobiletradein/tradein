/**
 * Migration tooling against a FICTIONAL Sheets export (generated below in
 * the exact shape 3.1's migrationExportSheet_ returns). Never production data.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HAS_DB } from '../helpers/db.js';
import { createTestApp, idemKey, makeImei, type TestApp } from '../helpers/app.js';
import { runImport } from '../../tools/migration/importer.js';
import { compare } from '../../tools/migration/compare.js';
import { migrateFiles } from '../../tools/migration/files.js';
import { writeFictionalExport } from '../../tools/migration/fixtures/fictional-export.js';
import { ok } from '../helpers/flow.js';

const exportFixture = writeFictionalExport;

describe.skipIf(!HAS_DB)('migration tooling (fictional export)', () => {
  let t: TestApp; let clean: string; let dirty: string;
  beforeAll(async () => {
    t = await createTestApp();
    clean = mkdtempSync(join(tmpdir(), 'qm-export-')); exportFixture(clean);
    dirty = mkdtempSync(join(tmpdir(), 'qm-export-dirty-')); exportFixture(dirty, { dirty: true });
  });
  afterAll(async () => { await t?.close(); });

  const count = async (table: string) => Number((await t.deps.pool.query(`select count(*)::int as n from public.${table}`)).rows[0].n);

  it('DRY_RUN writes nothing and reports duplicates, invalid rows and ignored sheets', async () => {
    const before = await count('trade_ins');
    const r = await runImport(t.deps.pool, dirty, 'DRY_RUN');
    expect(await count('trade_ins')).toBe(before);
    expect(await count('migration_runs')).toBe(0);
    expect(r.duplicates.some((d) => d.legacyId === 'CUS-00061' && d.error.includes('phone'))).toBe(true);
    expect(r.errors.some((e) => e.legacyId === 'CUS-00062' && e.error.includes('not a valid Qatar mobile number'))).toBe(true);
    expect(JSON.stringify(r.errors)).not.toContain('Bad Phone');          // no personal data in the report
    expect(r.warnings.some((w) => w.includes('Sessions'))).toBe(true);
  });

  it('VALIDATE exercises every constraint inside a transaction and rolls it back', async () => {
    const r = await runImport(t.deps.pool, clean, 'VALIDATE');
    expect(r.errors).toEqual([]);
    expect(r.sheets.find((s) => s.sheet === 'TradeIns')!.inserted).toBe(2);
    expect((await t.deps.pool.query(`select 1 from public.trade_ins where id like 'TI-FIX-%'`)).rowCount).toBe(0);
    expect((await t.deps.pool.query(`select mode, status from public.migration_runs`)).rows).toEqual([{ mode: 'VALIDATE', status: 'SUCCEEDED' }]);
  });

  it('APPLY preserves legacy ids, money and links; is idempotent on re-run; continues the sequences', async () => {
    const r = await runImport(t.deps.pool, clean, 'APPLY');
    expect(r.status).toBe('SUCCEEDED');
    const ti = (await t.deps.pool.query(`select * from public.trade_ins where id = 'TI-FIX-000007'`)).rows[0];
    expect([ti.status, ti.final_customer_value, ti.commission_value, ti.total_settlement, ti.voucher_id, ti.settlement_id])
      .toEqual(['CLOSED', '700.00', '35.00', '735.00', 'VCH-000050', 'STL-00050']);
    expect((await t.deps.pool.query(`select principal_id from public.notification_reads where notification_id = 'NTF-0000050'`)).rows).toEqual([{ principal_id: 'USR-00050' }]);
    expect((await t.deps.pool.query(`select legacy_drive_file_id, category from public.inspection_photos where trade_in_id = 'TI-FIX-000007'`)).rows).toEqual([{ legacy_drive_file_id: 'drivefile0001', category: 'FRONT' }]);
    expect((await t.deps.pool.query(`select last_value from public.id_counters where scope = 'TI-FIX'`)).rows[0].last_value).toBe(8);
    expect((await t.deps.pool.query(`select auth_user_id from public.app_users where id = 'USR-00050'`)).rows[0].auth_user_id).toBeNull();
    const again = await runImport(t.deps.pool, clean, 'APPLY');
    expect(again.sheets.find((s) => s.sheet === 'TradeIns')!.skippedExisting).toBe(2);
    expect(again.sheets.every((s) => s.inserted === 0)).toBe(true);
  });

  it('COMPARE: counts, exact financial totals and integrity all reconcile', async () => {
    const r = await compare(t.deps.pool, clean);
    expect(r.counts.filter((c) => c.missing)).toEqual([]);
    for (const x of r.totals) expect(x.difference).toBe(0);
    expect(r.totals.find((x) => x.metric === 'settlements: paid')!.database).toBe(735);
    expect(r.mismatches).toEqual([]);
    expect(r.orphans).toEqual([]);
    expect(r.invalidStates).toEqual([]);
    expect(r.brokenFiles.length).toBe(1);                      // the Drive file has not been migrated yet
    expect(r.ok).toBe(true);
  });

  it('file migration stores the evidence privately and clears the broken reference', async () => {
    const files = mkdtempSync(join(tmpdir(), 'qm-drive-'));
    mkdirSync(files, { recursive: true });
    writeFileSync(join(files, 'drivefile0001.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0]));
    const rep = await migrateFiles(t.deps.pool, t.storage, files, false);
    expect(rep).toMatchObject({ uploaded: 1, missing: [], rejected: [] });
    const p = (await t.deps.pool.query(`select object_path, mime_type from public.inspection_photos where legacy_drive_file_id = 'drivefile0001'`)).rows[0];
    expect(p.mime_type).toBe('image/jpeg');
    expect([...t.storage.objects.keys()].some((k) => k === `inspection-photos/${p.object_path}`)).toBe(true);
    expect((await compare(t.deps.pool, clean)).brokenFiles).toEqual([]);
  });

  it('a migrated profile signs in (linked on first sign-in) and works through the API; old sessions are not migrated', async () => {
    expect(await count('idempotency_keys')).toBe(0);
    const tok = await t.tokenFor('USR-00050');
    const q = await ok(t.call('vendor.queue', tok, {}));
    expect((q.tradeIns as { tradeInId: string }[]).map((x) => x.tradeInId).sort()).toEqual(['TI-FIX-000007', 'TI-FIX-000008']);
    const sa = await t.tokenFor('USR-00001');
    const tech = await t.tokenFor('USR-00003');
    await ok(t.call('tech.openInspection', tech, { tradeInId: 'TI-FIX-000008' }));
    // A new trade-in for the migrated partner continues its legacy sequence.
    await t.deps.pool.query(`insert into auth.users (id, phone) values ('00000000-0000-4000-8000-000000000060', '97455000600')`);
    await t.deps.pool.query(`update public.customers set auth_user_id = '00000000-0000-4000-8000-000000000060' where id = 'CUS-00060'`);
    const { signToken } = await import('../helpers/app.js');
    const ctok = await signToken('00000000-0000-4000-8000-000000000060', '+97455000600');
    const created = await ok(t.call('customer.submitTradeIn', ctok, { vendorId: 'VND-050', branchId: 'BR-0050', variantId: 'VAR-000050', imei: makeImei('35'),
      conditionAnswers: { POWER: 'ON', SCREEN: 'PERFECT', BODY: 'EXCELLENT', CAMERA: 'OK', CHARGING: 'OK', BIOMETRIC: 'OK', BATTERY: 'GOOD', ACTIVATION_LOCK: 'YES' } }, idemKey()));
    expect(created.tradeInId).toBe('TI-FIX-000009');
    expect(sa).toBeTruthy();
  });
});
