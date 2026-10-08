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

export async function inspectAndOffer(t: TestApp, tech: string, tradeInId: string, imei: string, opts: { battery?: number; answers?: Record<string, boolean> } = {}) {
  await ok(t.call('tech.openInspection', tech, { tradeInId }));
  const chk = await ok(t.call('tech.checkImei', tech, { tradeInId, scannedImei: imei }));
  if (chk.match !== true) throw new Error('IMEI check did not match');
  await ok(t.call('tech.saveInspection', tech, { tradeInId, answers: opts.answers ?? ALL_GOOD_TECH_ANSWERS, batteryHealth: opts.battery ?? 95 }));
  return ok(t.call('tech.submitOffer', tech, { tradeInId }, idemKey()));
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
