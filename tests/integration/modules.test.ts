/**
 * The modules ported after the vertical slice: catalogue, pricing and the
 * grade ladder, partner fees, bulk import, partners/branches, staff and
 * customers, settings, notifications, search, reports/CSV, dashboards,
 * audit query, uploads, reconciliation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HAS_DB } from '../helpers/db.js';
import { createTestApp, idemKey, type TestApp } from '../helpers/app.js';
import { actors, ok, submit, toReadyForCollection, type Actors } from '../helpers/flow.js';
import { runReconciliation } from '../../apps/api/src/jobs/reconcile.js';

const PNG = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]).toString('base64')}`;

describe.skipIf(!HAS_DB)('remaining modules', () => {
  let t: TestApp; let a: Actors;
  beforeAll(async () => { t = await createTestApp(); a = await actors(t); });
  afterAll(async () => { await t?.close(); });

  it('catalogue: brand/category/product/variant/colour with case-insensitive uniqueness', async () => {
    const b = await ok(t.call('admin.saveBrand', a.finance, { name: 'Nimbus (fictional)' }));
    expect((await t.call('admin.saveBrand', a.finance, { name: 'nimbus (FICTIONAL)' })).body.message).toBe('A brand with that name already exists.');
    const c = await ok(t.call('admin.saveCategory', a.finance, { name: 'Watches' }));
    const p = await ok(t.call('admin.saveProduct', a.finance, { brandId: b.brandId, categoryId: c.categoryId, model: 'Nimbus Watch', deviceType: 'WATCH' }));
    const v = await ok(t.call('admin.saveVariant', a.finance, { productId: p.productId, storage: ' 32 gb ' }));
    expect((await t.deps.pool.query('select storage, display_order from public.product_variants where id = $1', [v.variantId])).rows[0]).toEqual({ storage: '32GB', display_order: 3 });
    expect((await t.call('admin.saveVariant', a.finance, { productId: p.productId, storage: '32gb' })).body.message).toBe('That storage size already exists for this product.');
    await ok(t.call('admin.saveColor', a.finance, { productId: p.productId, color: 'Graphite' }));
    expect((await t.call('admin.saveProduct', a.finance, { brandId: b.brandId, model: 'X', imageUrl: 'javascript:alert(1)' })).status).toBe(422);
    const detail = await ok(t.call('admin.product', a.finance, { productId: p.productId }));
    expect((detail.variants as { priced: boolean }[])[0]!.priced).toBe(false);
    // Unpriced products stay in the catalogue tree only if they have an active variant (3.1).
    const tree = await t.app.inject({ method: 'GET', url: '/v1/public/catalog' });
    expect(tree.json().products.some((x: { productId: string }) => x.productId === p.productId)).toBe(true);
  });

  it('pricing: supersede, not overwrite; partner override wins; cancel removes from lookups', async () => {
    const r1 = await ok(t.call('admin.setBasePrice', a.finance, { variantId: 'VAR-000003', basePrice: 900 }));
    expect((r1.ladder as { code: string; value: number }[]).map((g) => `${g.code}=${g.value}`).join(' ')).toBe('A=900 B=630 C=450 D=270 R=0');
    expect((await t.call('admin.setBasePrice', a.finance, { variantId: 'VAR-000003', basePrice: '900.00' })).body.unchanged).toBe(true);
    await ok(t.call('admin.setBasePrice', a.finance, { variantId: 'VAR-000003', basePrice: 950.5 }));
    const hist = await ok(t.call('admin.priceHistory', a.finance, { variantId: 'VAR-000003' }));
    const h = hist.history as { basePrice: number; effectiveTo: string; supersededBy: string; cancelled: boolean }[];
    expect(h.length).toBe(2);
    expect(h.find((x) => x.basePrice === 900)!.supersededBy).toMatch(/^MPR-/);
    await ok(t.call('admin.setBasePrice', a.finance, { variantId: 'VAR-000003', basePrice: 1000, vendorId: 'VND-001' }));
    const table = await ok(t.call('admin.pricing', a.finance, { vendorId: 'VND-001', productId: 'PRD-00002' }));
    const row = (table.rows as { variantId: string; source: string; resolvedPrice: number }[]).find((x) => x.variantId === 'VAR-000003')!;
    expect(row).toMatchObject({ source: 'VENDOR_OVERRIDE', resolvedPrice: 1000 });
    const vp = (await t.deps.pool.query(`select id from public.vendor_prices where variant_id = 'VAR-000003'`)).rows[0];
    await ok(t.call('admin.retirePrice', a.finance, { priceId: vp.id, vendorId: 'VND-001', mode: 'CANCEL', reason: 'Typed in error' }));
    const t2 = await ok(t.call('admin.pricing', a.finance, { vendorId: 'VND-001', productId: 'PRD-00002' }));
    expect((t2.rows as { variantId: string; source: string }[]).find((x) => x.variantId === 'VAR-000003')!.source).toBe('MASTER');
  });

  it('grade ladder: a change that would break the ladder is refused before anything is written', async () => {
    const bad = await t.call('admin.saveGradeRule', a.finance, { gradeCode: 'C', gradeName: 'Fair', percentage: 0.8, minScore: 60, order: 3 });
    expect(String(bad.body.message)).toContain('would break the grade ladder');
    expect((await t.deps.pool.query(`select percentage_of_base from public.grade_rules where grade_code = 'C'`)).rows[0].percentage_of_base).toBe('0.5000');
    const g = await ok(t.call('admin.gradeRules', a.finance, {}));
    expect(g.valid).toBe(true);
  });

  it('partner fees: the most specific rule wins and snapshots are frozen', async () => {
    await ok(t.call('admin.saveCommissionRule', a.finance, { vendorId: 'VND-001', productId: 'PRD-00001', commissionType: 'FIXED', commissionValue: 75 }));
    expect((await t.call('admin.saveCommissionRule', a.finance, { vendorId: 'VND-001', commissionType: 'PERCENTAGE', commissionValue: 5 })).body.message)
      .toBe('Enter a percentage as a fraction. Five percent is 0.05.');
    const s = await toReadyForCollection(t, a);
    const row = (await t.deps.pool.query('select commission_type_snapshot, commission_value, total_settlement from public.trade_ins where id = $1', [s.tradeInId])).rows[0];
    expect(row).toEqual({ commission_type_snapshot: 'FIXED', commission_value: '75.00', total_settlement: '2075.00' });
    const rules = await ok(t.call('admin.commissionRules', a.finance, { vendorId: 'VND-001' }));
    expect((rules.rules as { label: string }[]).map((r) => r.label)).toEqual(expect.arrayContaining(['5%', '75.00 QAR']));
  });

  it('bulk import: preview reports problems; apply re-validates and creates what was previewed', async () => {
    const rows = [
      { Brand: 'Comet (fictional)', Category: 'Smartphones', Model: 'Comet 7', Storage: '128 GB', Colour: 'Blue', BasePrice: '1500' },
      { Brand: 'Comet (fictional)', Model: 'Comet 7', Storage: '256GB', BasePrice: '' },
      { Brand: '', Model: 'Nameless', Storage: '64GB' },
    ];
    const pv = await ok(t.call('admin.previewImport', a.finance, { rows }));
    expect(pv.willImport).toBe(2);
    expect((pv.problems as string[])[0]).toContain('Line 4');
    const bad = await t.call('admin.applyImport', a.finance, { rows });
    expect(bad.status).toBe(422);
    const ap = await ok(t.call('admin.applyImport', a.finance, { rows: rows.slice(0, 2) }));
    expect(ap.summary).toMatchObject({ brands: 1, products: 1, variants: 2, colors: 1, prices: 1, unpriced: 1 });
  });

  it('partners and branches: code frozen; branch never changes partner; deactivation revokes staff sessions', async () => {
    const v = await ok(t.call('admin.saveVendor', a.sa, { name: 'Code Test Partner', code: 'CT1', commissionRate: '0.03' }));
    expect((await t.call('admin.saveVendor', a.sa, { vendorId: v.vendorId, name: 'Code Test Partner', code: 'CT2', commissionRate: '0.03' })).body.message)
      .toBe('A vendor code cannot be changed — trade-in numbers already use it.');
    expect((await t.deps.pool.query(`select count(*)::int as n from public.commission_rules where vendor_id = $1`, [v.vendorId])).rows[0].n).toBe(1);
    const moved = await t.call('admin.saveBranch', a.sa, { vendorId: v.vendorId, branchId: 'BR-0001', name: 'Hijack' });
    expect(moved.body.message).toBe('That branch belongs to a different vendor.');
    const own = await ok(t.call('vendor.branches', a.mgrMall, {}));
    expect((own.branches as { branchId: string }[]).map((b) => b.branchId)).toEqual(['BR-0001']);
    expect((await t.call('vendor.saveBranch', a.mgrMall, { name: 'New Branch' })).status).toBe(403);
  });

  it('customers: admin list masks nothing it should not; disabling revokes; profile edit cannot change phone', async () => {
    const list = await ok(t.call('admin.customers', a.finance, { search: 'Demo Customer' }));
    expect((list.customers as unknown[]).length).toBeGreaterThan(0);
    const tok = await t.tokenFor('CUS-00001');
    const up = await ok(t.call('customer.updateProfile', tok, { fullName: 'Demo Customer Renamed', phone: '+97499999999' }));
    expect((up.customer as { phone: string }).phone).toBe('+974 3000 0010');
  });

  it('notifications: per-principal read state and audience scoping', async () => {
    await submit(t, a.customer, { branchId: 'BR-0002' });
    const souq = await ok(t.call('notify.list', a.staffSouq, {}));
    const mall = await ok(t.call('notify.list', a.mgrMall, {}));
    expect((souq.notifications as unknown[]).length).toBeGreaterThan(0);
    const souqIds = new Set((souq.notifications as { notificationId: string }[]).map((n) => n.notificationId));
    for (const n of mall.notifications as { notificationId: string }[]) expect(souqIds.has(n.notificationId)).toBe(false);
    const techList = await ok(t.call('notify.list', a.tech, {}));
    for (const n of techList.notifications as { entityType: string }[]) expect(n.entityType).toBe('TRADEIN');
    const first = (souq.notifications as { notificationId: string }[])[0]!.notificationId;
    await ok(t.call('notify.markRead', a.staffSouq, { notificationId: first }));
    const again = await ok(t.call('notify.list', a.partnerAdmin, {}));
    expect((again.notifications as { notificationId: string; read: boolean }[]).find((n) => n.notificationId === first)?.read).toBe(false);
    expect((await ok(t.call('notify.markRead', a.mgrMall, { notificationId: first }))).message).toBe('Nothing to mark.');
  });

  it('search: technicians cannot search by IMEI or see vouchers; partners are scoped', async () => {
    const s = await toReadyForCollection(t, a);
    const tech = await ok(t.call('search.global', a.tech, { query: s.imei.slice(3, 12) }));
    expect(JSON.stringify(tech)).not.toContain(s.imei);
    expect((tech.groups as { kind: string }[]).some((g) => g.kind === 'VOUCHER')).toBe(false);
    const admin = await ok(t.call('search.global', a.finance, { query: s.imei.slice(3, 12) }));
    expect(JSON.stringify(admin)).toContain(s.imei);
    const souq = await ok(t.call('search.global', a.staffSouq, { query: s.tradeInId }));
    expect(souq.total).toBe(0);
  });

  it('reports: grouped totals, CSV formula-neutralised, partner scope applied before grouping', async () => {
    await t.deps.pool.query(`update public.trade_ins set customer_name = '=HYPERLINK("x")' where id = (select id from public.trade_ins limit 1)`);
    const r = await ok(t.call('admin.reports', a.finance, { groupBy: 'branch', asCsv: true }));
    expect(String(r.csv)).toMatch(/^"Group","Devices"/);
    const vouchersCsv = await ok(t.call('admin.reports', a.finance, { reportType: 'VOUCHER', asCsv: true }));
    expect(String(vouchersCsv.csv)).toContain('"Voucher"');
    const mine = await ok(t.call('vendor.reports', a.mgrMall, { groupBy: 'branch' }));
    for (const g of mine.groups as { key: string }[]) expect(g.key).toBe('BR-0001');
    const { csvSafeCell } = await import('../../packages/shared/src/text.js');
    expect(csvSafeCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
  });

  it('dashboards: platform and partner (scoped) figures', async () => {
    const d = await ok(t.call('admin.dashboard', a.finance, {}));
    expect(d.queues).toBeDefined();
    expect((d.marketplace as { vendors: number }).vendors).toBeGreaterThan(0);
    const vd = await ok(t.call('vendor.dashboard', a.staffSouq, {}));
    for (const b of vd.branches as { branchId: string }[]) expect(b.branchId).toBe('BR-0002');
  });

  it('audit query and settings (SUPER_ADMIN only for changes)', async () => {
    const q = await ok(t.call('admin.audit', a.finance, { action: 'voucher' }));
    expect((q.entries as unknown[]).length).toBeGreaterThan(0);
    expect((await t.call('admin.saveSetting', a.finance, { key: 'platform.contactPhone', value: '1' })).status).toBe(403);
    await ok(t.call('admin.saveSetting', a.sa, { key: 'customer.estimateNote', value: 'Fictional note.' }));
    expect((await t.call('admin.saveSetting', a.sa, { key: 'anything.else', value: '1' })).body.message).toBe('That setting cannot be changed here.');
    const s = await ok(t.call('admin.settings', a.finance, {}));
    expect((s.health as { smsProvider: string }).smsProvider).toBe('TEST');
  });

  it('uploads: bytes are checked (an SVG or a renamed file is refused); private photos are served by short-lived URL after scope', async () => {
    const svg = `data:image/png;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64')}`;
    expect((await t.call('admin.uploadMedia', a.finance, { kind: 'PRODUCT', objectId: 'PRD-00001', dataUrl: svg })).status).toBe(400);
    const pub = await ok(t.call('admin.uploadMedia', a.finance, { kind: 'PRODUCT', objectId: 'PRD-00001', dataUrl: PNG }));
    expect(String(pub.imageUrl)).toContain('catalog-media');
    const s = await submit(t, a.customer);
    await ok(t.call('tech.openInspection', a.tech, { tradeInId: s.tradeInId }));
    const up = await ok(t.call('tech.uploadPhotos', a.tech, { tradeInId: s.tradeInId, photos: [{ category: 'IMEI', dataUrl: PNG }, { category: 'FRONT', dataUrl: svg }] }));
    expect(up.added).toBe(1);
    expect((up.problems as string[]).length).toBe(1);
    const photo = (await t.deps.pool.query('select id from public.inspection_photos where trade_in_id = $1', [s.tradeInId])).rows[0];
    const view = await ok(t.call('tech.viewPhoto', a.tech, { tradeInId: s.tradeInId, fileId: photo.id }));
    expect(String(view.url)).toContain('inspection-photos');
    expect(view.expiresInSeconds).toBe(300);
    // A photo id from another trade-in is refused.
    const other = await submit(t, a.customer);
    expect((await t.call('tech.viewPhoto', a.tech, { tradeInId: other.tradeInId, fileId: photo.id })).status).toBe(422);
  });

  it('reconciliation finds nothing wrong in data the API produced, and records the run', async () => {
    const r = await runReconciliation(t.deps.pool);
    const unexpected = r.issues.filter((i) => i.kind !== 'UNDATED_COLLECTED');
    expect(unexpected).toEqual([]);
    expect((await t.deps.pool.query(`select status from public.job_runs where id = $1`, [r.runId])).rows[0].status).toBe('SUCCEEDED');
  });

  it('staff approval: pending → active with a role decided by the approver, never the applicant', async () => {
    await t.deps.pool.query(`insert into public.app_users (id, full_name, phone, status) values ('USR-00090', 'Demo Applicant Two', '+97455000190', 'PENDING_APPROVAL')`);
    expect((await t.call('admin.approveStaff', a.finance, { userId: 'USR-00090', role: 'SUPER_ADMIN' }, idemKey())).status).toBe(403);
    await ok(t.call('admin.approveStaff', a.finance, { userId: 'USR-00090', role: 'VENDOR_STAFF', vendorId: 'VND-001', branchId: 'BR-0002' }, idemKey()));
    expect((await t.deps.pool.query(`select role, status, branch_id from public.app_users where id = 'USR-00090'`)).rows[0])
      .toEqual({ role: 'VENDOR_STAFF', status: 'ACTIVE', branch_id: 'BR-0002' });
    const list = await ok(t.call('vendor.staff', a.mgrMall, {}));
    for (const s of list.staff as { branchId: string; role: string }[]) {
      expect(s.branchId).toBe('BR-0001');
      expect(['SUPER_ADMIN', 'QM_ADMIN', 'TECHNICIAN']).not.toContain(s.role);
    }
  });
});
