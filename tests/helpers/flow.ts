/**
 * Drives a trade-in through the vertical slice using the public API only.
 * Seed actors: USR-00001 SUPER_ADMIN, USR-00002 QM_ADMIN (finance),
 * USR-00003 TECHNICIAN, USR-00004 VENDOR_ADMIN (partner-wide),
 * USR-00005 VENDOR_MANAGER @ BR-0001, USR-00006 VENDOR_STAFF @ BR-0002,
 * CUS-00001 customer.
 */
import { GOOD_ANSWERS, idemKey, makeImei, type TestApp } from './app.js';

export const ALL_GOOD_TECH_ANSWERS: Record<string, boolean> = {
  ACTIVATION_LOCK: true, SCREEN_WORKS: true, SCREEN_CRACK: true, SCREEN_SCRATCH: true, BODY_INTACT: true, BODY_DENT: true,
  BODY_SCRATCH: true, BACK_GLASS: true, DEVICE_POWERS_ON: true, CAMERA_WORKS: true, BIOMETRIC_WORKS: true, SPEAKER_WORKS: true,
  MIC_WORKS: true, BUTTONS_WORK: true, CHARGING_WORKS: true, WIFI_WORKS: true, BLUETOOTH_WORKS: true,
};

export interface Actors { sa: string; finance: string; tech: string; partnerAdmin: string; mgrMall: string; staffSouq: string; customer: string }

export async function actors(t: TestApp): Promise<Actors> {
  return {
    sa: await t.tokenFor('USR-00001'), finance: await t.tokenFor('USR-00002'), tech: await t.tokenFor('USR-00003'),
    partnerAdmin: await t.tokenFor('USR-00004'), mgrMall: await t.tokenFor('USR-00005'), staffSouq: await t.tokenFor('USR-00006'),
    customer: await t.tokenFor('CUS-00001'),
  };
}

export async function ok(p: Promise<{ status: number; body: Record<string, unknown> }>) {
  const r = await p;
  if (r.status !== 200 || r.body.ok !== true) throw new Error(`expected ok, got ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

export async function submit(t: TestApp, customer: string, opts: { branchId?: string; imei?: string; variantId?: string; answers?: Record<string, string> } = {}) {
  const imei = opts.imei ?? makeImei();
  const body = await ok(t.call('customer.submitTradeIn', customer, {
    vendorId: 'VND-001', branchId: opts.branchId ?? 'BR-0001', variantId: opts.variantId ?? 'VAR-000001', colorId: 'CLR-000001',
    imei, conditionAnswers: opts.answers ?? GOOD_ANSWERS,
  }, idemKey()));
  return { tradeInId: String(body.tradeInId), imei, body };
}

/**
 * Inspect, price and (unless approve: false) have the owner approve, so the offer reaches the customer
 * (owner decision 2026-10-10: tech.submitOffer -> AWAITING_OWNER_APPROVAL -> admin.approveTradeIn -> FINAL_OFFER_READY).
 */
export async function inspectAndOffer(t: TestApp, tech: string, tradeInId: string, imei: string,
  opts: { battery?: number; answers?: Record<string, boolean>; approve?: boolean } = {}) {
  await ok(t.call('tech.openInspection', tech, { tradeInId }));
  const chk = await ok(t.call('tech.checkImei', tech, { tradeInId, scannedImei: imei }));
  if (chk.match !== true) throw new Error('IMEI check did not match');
  await ok(t.call('tech.saveInspection', tech, { tradeInId, answers: opts.answers ?? ALL_GOOD_TECH_ANSWERS, batteryHealth: opts.battery ?? 95 }));
  const offer = await ok(t.call('tech.submitOffer', tech, { tradeInId }, idemKey()));
  if (opts.approve !== false) await approve(t, tradeInId);
  return offer;
}

/** The owner approves an evaluated trade-in (USR-00001, SUPER_ADMIN). */
export async function approve(t: TestApp, tradeInId: string, owner?: string) {
  return ok(t.call('admin.approveTradeIn', owner ?? await t.tokenFor('USR-00001'), { tradeInId, decision: 'APPROVE' }, idemKey()));
}

export async function toReadyForCollection(t: TestApp, a: Actors, opts: { branchId?: string; issuer?: string } = {}) {
  const s = await submit(t, a.customer, { branchId: opts.branchId });
  await inspectAndOffer(t, a.tech, s.tradeInId, s.imei);
  await ok(t.call('customer.acceptOffer', a.customer, { tradeInId: s.tradeInId }, idemKey()));
  await ok(t.call('tech.receiveDevice', a.tech, { tradeInId: s.tradeInId }, idemKey()));
  const v = await ok(t.call('vendor.issueVoucher', opts.issuer ?? a.partnerAdmin, { tradeInId: s.tradeInId }, idemKey()));
  return { ...s, voucherId: String(v.voucherId), voucherNumber: String(v.voucherNumber) };
}

export async function tradeIn(t: TestApp, id: string) {
  return (await t.deps.pool.query('select * from public.trade_ins where id = $1', [id])).rows[0];
}

/**
 * Make a voucher-created trade-in look like one from before the owner-approval step (2026-10-10), so the
 * older batch path (collection -> COLLECTED -> settlement batch) still applies to it. Test data only.
 */
export async function markLegacy(t: TestApp, tradeInId: string) {
  await t.deps.pool.query('update public.trade_ins set owner_approved_at = null, owner_approved_by = null where id = $1', [tradeInId]);
}

/** A seeded ACCOUNTANT (finance only), created on first use. */
export async function accountant(t: TestApp, id = 'USR-00070', phone = '+97430000070') {
  await t.deps.pool.query(`insert into public.app_users (id, full_name, phone, email, role, status)
    values ($1, 'Test Accountant', $2, 'accounts@example.test', 'ACCOUNTANT', 'ACTIVE') on conflict (id) do nothing`, [id, phone]);
  return t.tokenFor(id);
}

/** A tiny but real PDF (magic bytes %PDF-) as a data URL, for receipt uploads. */
export const RECEIPT_PDF = `data:application/pdf;base64,${Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n').toString('base64')}`;
