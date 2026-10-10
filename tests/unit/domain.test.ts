/** Pure business rules, ported from the 3.1 self-tests and extended. */
import { describe, expect, it } from 'vitest';
import { computeGrade, gradeForScore, gradeLadderFor, gradeValue, validateGradeLadder, validateLadderShape, batteryBandFor, technicianRuleView } from '../../packages/domain/src/grading.js';
import { customerAnswersComplete, customerAnswersToRules, gradeCustomerAnswers, normalizeCustomerAnswers, assessmentComparison } from '../../packages/domain/src/questionnaire.js';
import { commissionFor, pickEffective, resolveBasePrice, resolveCommissionRule, type CommissionRuleRow } from '../../packages/domain/src/pricing.js';
import { canSettlementTransition, canTransition, inCustody, recalcBatch } from '../../packages/domain/src/workflow.js';
import { TRADEIN_FLOW } from '../../packages/domain/src/constants.js';
import { LADDER, RULES, allGood } from '../helpers/rules-fixture.js';

describe('grading (internalTestAutomaticGrading_)', () => {
  const ctx = { batteryHealth: 100, imeiMatch: true, imeiRequired: true };
  it('flawless device → 100, A', () => {
    const g = computeGrade(allGood(), ctx, RULES, LADDER);
    expect([g.score, g.gradeCode, g.complete]).toEqual([100, 'A', true]);
  });
  it('one cracked screen → 82, B', () => {
    const g = computeGrade({ ...allGood(), SCREEN_CRACK: false }, ctx, RULES, LADDER);
    expect([g.score, g.gradeCode]).toEqual([82, 'B']);
  });
  it('locked device → blocked, terminal grade, score 0', () => {
    const g = computeGrade({ ...allGood(), ACTIVATION_LOCK: false }, ctx, RULES, LADDER);
    expect([g.blocked, g.score, g.gradeCode]).toEqual([true, 0, 'R']);
    expect(g.blockedReason).toContain('activation lock');
  });
  it('IMEI mismatch → blocked', () => {
    const g = computeGrade(allGood(), { ...ctx, imeiMatch: false }, RULES, LADDER);
    expect([g.blocked, g.score]).toEqual([true, 0]);
  });
  it('battery bands: 100→0, 88→−3, 82→−6, 75→−9, 55→−12', () => {
    expect([100, 88, 82, 75, 55].map((h) => computeGrade(allGood(), { ...ctx, batteryHealth: h }, RULES, LADDER).score)).toEqual([100, 97, 94, 91, 88]);
    expect(batteryBandFor(85).label).toBe('Good');
  });
  it('an unanswered battery question is MISSING, never 0% health', () => {
    for (const v of [null, undefined, '']) {
      const g = computeGrade(allGood(), { ...ctx, batteryHealth: v }, RULES, LADDER);
      expect(g.missing).toContain('BATTERY_HEALTH');
      expect(g.score).toBe(100);
    }
  });
  it('unanswered inspection is incomplete', () => {
    const g = computeGrade({}, { batteryHealth: null, imeiMatch: true, imeiRequired: true }, RULES, LADDER);
    expect(g.complete).toBe(false);
    expect(g.missing.length).toBe(18);
  });
  it('score is clamped at 0 and grades to the terminal grade', () => {
    const bad = Object.fromEntries(Object.keys(allGood()).map((k) => [k, k === 'ACTIVATION_LOCK']));
    const g = computeGrade(bad, { ...ctx, batteryHealth: 10 }, RULES, LADDER);
    expect(g.score).toBe(0);
    expect(g.gradeCode).toBe('R');
  });
  it('gradeForScore boundaries', () => {
    expect([95, 94.99, 80, 79, 60, 59, 35, 34, 0, -5, 150].map((s) => gradeForScore(s, LADDER))).toEqual(['A', 'B', 'B', 'C', 'C', 'D', 'D', 'R', 'R', 'R', 'A']);
  });
  it('ladder values come from the BASE (2000 → 2000/1400/1000/600/0), no compounding', () => {
    expect(gradeLadderFor(200000, LADDER).map((g) => g.value)).toEqual([200000, 140000, 100000, 60000, 0]);
    const b = gradeValue(200000, 'B', LADDER);
    expect(b.ok && b.value).toBe(140000);
    expect(gradeValue(-1, 'A', LADDER).ok).toBe(false);
    expect(gradeValue(100, 'Z', LADDER).ok).toBe(false);
  });
  it('ladder validation catches each of the four failure modes', () => {
    expect(validateGradeLadder(LADDER).ok).toBe(true);
    expect(validateGradeLadder(LADDER.map((g) => (g.code === 'A' ? { ...g, percentageBp: 9000 } : g))).ok).toBe(false);
    expect(validateGradeLadder(LADDER.filter((g) => !g.terminal)).ok).toBe(false);
    expect(validateGradeLadder(LADDER.map((g) => (g.code === 'C' ? { ...g, percentageBp: 8000 } : g))).problems.join()).toContain('rewards worse condition');
    expect(validateLadderShape([]).ok).toBe(false);
  });
  it('technician view carries no impacts and no blocking flags', () => {
    expect(JSON.stringify(technicianRuleView(RULES))).not.toMatch(/impact|blocking/);
  });
});

describe('customer questionnaire (25_Questionnaire.gs)', () => {
  const answers = { POWER: 'on', SCREEN: 'PERFECT', BODY: 'EXCELLENT', CAMERA: 'OK', CHARGING: 'OK', BIOMETRIC: 'NA', BATTERY: 'GOOD', ACTIVATION_LOCK: 'YES', JUNK: 'X' };
  it('normalises, upper-cases and drops unknown answers', () => {
    expect(normalizeCustomerAnswers(answers)).not.toHaveProperty('JUNK');
    expect(normalizeCustomerAnswers(answers).POWER).toBe('ON');
    expect(customerAnswersComplete(answers)).toBe(true);
    expect(customerAnswersComplete({ POWER: 'ON' })).toBe(false);
  });
  it('fills unasked checks as good and NAMES them', () => {
    const tr = customerAnswersToRules(normalizeCustomerAnswers(answers), RULES);
    expect(tr.assumed.map((a) => a.code).sort()).toEqual(['BACK_GLASS', 'BLUETOOTH_WORKS', 'BUTTONS_WORK', 'MIC_WORKS', 'SPEAKER_WORKS', 'WIFI_WORKS']);
    expect(tr.batteryHealth).toBe(95);
  });
  it('a worse description gives a lower grade, through the same engine', () => {
    const good = gradeCustomerAnswers(normalizeCustomerAnswers(answers), RULES, LADDER);
    const worse = gradeCustomerAnswers(normalizeCustomerAnswers({ ...answers, SCREEN: 'CRACKED', BATTERY: 'POOR' }), RULES, LADDER);
    expect(good.ok && good.graded.gradeCode).toBe('A');
    // cracked → crack −18 and scratch −7; POOR battery = 65% → bottom band → −12
    expect(worse.ok && worse.graded.score).toBe(100 - 18 - 7 - 12);
  });
  it('an activation lock that cannot be removed is refused, with a reason', () => {
    const r = gradeCustomerAnswers(normalizeCustomerAnswers({ ...answers, ACTIVATION_LOCK: 'NO' }), RULES, LADDER);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('BLOCKED');
  });
  it('comparison joins on rule codes', () => {
    const cmp = assessmentComparison({ SCREEN: 'PERFECT' }, { SCREEN_WORKS: true, SCREEN_CRACK: false, SCREEN_SCRATCH: true }, RULES);
    expect(cmp[0]).toMatchObject({ key: 'SCREEN', agrees: false });
  });
});

describe('pricing and partner fees (10_Pricing.gs, 12_CommissionRules.gs)', () => {
  const d = (s: string) => new Date(s);
  const row = (id: string, cents: number, from: string, to: string | null, active = true) =>
    ({ id, basePriceCents: cents, effectiveFrom: d(from), effectiveTo: to ? d(to) : null, active, currency: 'QAR' });
  it('effective window is half-open and the newest start wins; cancelled rows never count', () => {
    const rows = [row('old', 100, '2026-01-01', '2026-06-01'), row('new', 200, '2026-06-01', null), row('typo', 999, '2026-07-01', null, false)];
    expect(pickEffective(rows, d('2026-05-31T23:59:59Z'))!.id).toBe('old');
    expect(pickEffective(rows, d('2026-06-01T00:00:00Z'))!.id).toBe('new');
    expect(pickEffective(rows, d('2026-08-01'))!.id).toBe('new');
  });
  it('partner price beats master; none → explicit refusal', () => {
    expect(resolveBasePrice([row('v', 300, '2026-01-01', null)], [row('m', 200, '2026-01-01', null)], d('2026-03-01'))).toMatchObject({ ok: true, source: 'VENDOR_OVERRIDE', basePriceCents: 300 });
    expect(resolveBasePrice([], [], d('2026-03-01'))).toMatchObject({ ok: false, message: 'This model has no trade-in price yet.' });
  });
  const rule = (id: string, over: Partial<CommissionRuleRow>): CommissionRuleRow =>
    ({ id, vendorId: 'V', brandId: null, categoryId: null, productId: null, type: 'PERCENTAGE', value: '0.050000', effectiveFrom: d('2026-01-01'), effectiveTo: null, active: true, ...over });
  it('most specific rule wins: product > category > brand > partner-wide; ties by newest start', () => {
    const rules = [rule('wide', {}), rule('brand', { brandId: 'B' }), rule('cat', { categoryId: 'C' }), rule('prod', { productId: 'P' }), rule('prod2', { productId: 'P', effectiveFrom: d('2026-02-01') })];
    expect(resolveCommissionRule(rules, 'V', { productId: 'P', brandId: 'B', categoryId: 'C' }, d('2026-03-01'))!.id).toBe('prod2');
    expect(resolveCommissionRule(rules, 'V', { productId: 'X', brandId: 'B', categoryId: 'C' }, d('2026-03-01'))!.id).toBe('cat');
    expect(resolveCommissionRule(rules, 'V', { productId: 'X', brandId: 'B', categoryId: null }, d('2026-03-01'))!.id).toBe('brand');
    expect(resolveCommissionRule(rules, 'OTHER', null, d('2026-03-01'))).toBeNull();
  });
  it('commission: 1400 × 5% = 70, settlement 1470 (internalTestCommission_)', () => {
    const c = commissionFor(140000, rule('w', {}), null);
    expect([c.commissionCents, c.totalSettlementCents]).toEqual([7000, 147000]);
  });
  it('fixed fee; partner default; platform default 5%; negative → 0', () => {
    expect(commissionFor(100000, rule('f', { type: 'FIXED', value: '75.000000' }), null).commissionCents).toBe(7500);
    expect(commissionFor(100000, null, '0.030000')).toMatchObject({ commissionCents: 3000, source: 'VENDOR_DEFAULT' });
    expect(commissionFor(100000, null, null)).toMatchObject({ commissionCents: 5000, source: 'PLATFORM_DEFAULT' });
    expect(commissionFor(100000, rule('n', { value: '-0.1' }), null).commissionCents).toBe(0);
  });
  it('INVOICE_PERCENTAGE (Carrefour -> QM): invoice = value / (1 - rate), fee = the difference', () => {
    const inv = (cents: number) => commissionFor(cents, rule('i', { type: 'INVOICE_PERCENTAGE', value: '0.050000' }), null);
    expect(inv(150000)).toMatchObject({ commissionType: 'INVOICE_PERCENTAGE', totalSettlementCents: 157895, commissionCents: 7895 }); // 1500 / .95 = 1578.947 -> 1578.95
    expect(inv(228000)).toMatchObject({ totalSettlementCents: 240000, commissionCents: 12000 });
    for (const v of [1, 99, 12345, 999999]) { const c = inv(v); expect(c.customerValueCents + c.commissionCents).toBe(c.totalSettlementCents); }
    expect(commissionFor(150000, rule('i', { type: 'INVOICE_PERCENTAGE', value: '1.000000' }), null).commissionCents).toBe(0); // not a share
  });
  it('half-cent rounding goes up, exactly (no float drift)', () => {
    expect(commissionFor(1, rule('w', { value: '0.500000' }), null).commissionCents).toBe(1);      // 0.5 cent → 1
    expect(commissionFor(33333, rule('w', { value: '0.015000' }), null).commissionCents).toBe(500); // 499.995 → 500
  });
});

describe('workflow', () => {
  it('trade-in flow matches 3.1 TRADEIN_FLOW exactly and has no shortcut to CLOSED from COLLECTED', () => {
    expect(canTransition('COLLECTED', 'CLOSED')).toBe(false);
    expect(canTransition('DEVICE_RECEIVED', 'CANCELLED')).toBe(false);
    expect(canTransition('FINAL_OFFER_READY', 'CUSTOMER_ACCEPTED')).toBe(true);
    expect(Object.values(TRADEIN_FLOW).flat().length).toBe(28);
    expect(inCustody('RETURN_PENDING')).toBe(true);
  });
  it('settlement flow', () => {
    expect(canSettlementTransition('DRAFT', 'PAID')).toBe(false);
    expect(canSettlementTransition('SUBMITTED', 'DRAFT')).toBe(true);
    expect(canSettlementTransition('CANCELLED', 'DRAFT')).toBe(false);
  });
  it('collection note status is derived from its lines; an exception outranks a tidy count', () => {
    const L = (s: string) => ({ itemStatus: s, settlementCents: 1000 });
    expect(recalcBatch([L('PENDING'), L('PENDING')]).status).toBe('READY_FOR_COLLECTION');
    expect(recalcBatch([L('PENDING'), L('COLLECTED')]).status).toBe('PARTIALLY_COLLECTED');
    expect(recalcBatch([L('COLLECTED'), L('MISSING')]).status).toBe('COLLECTION_EXCEPTION');
    expect(recalcBatch([L('PENDING'), L('MISSING')]).status).toBe('PARTIALLY_COLLECTED');
    const all = recalcBatch([L('COLLECTED'), L('COLLECTED')]);
    expect([all.status, all.actualCents]).toEqual(['COLLECTED', 2000]);
  });
});
