/**
 * The customer's own description of their device (25_Questionnaire.gs).
 *
 * The questionnaire is a translation layer onto the technician's rule
 * codes, so the estimate runs through the SAME computeGrade and the same
 * ladder as the final offer.
 */
import { CUSTOMER_QUESTIONS, INPUT_TYPE, type CustomerQuestion, type QuestionOption } from './constants.js';
import { computeGrade, type GradeResult, type GradeRule, type InspectionRule, sortInspectionRules } from './grading.js';
import { str } from '../../shared/src/text.js';

export function getCustomerQuestion(key: unknown): CustomerQuestion | null {
  const want = str(key).toUpperCase();
  return CUSTOMER_QUESTIONS.find((q) => q.key === want) ?? null;
}

export function getCustomerOption(q: CustomerQuestion | null, value: unknown): QuestionOption | null {
  if (!q) return null;
  const want = str(value).toUpperCase();
  return q.options.find((o) => o.value === want) ?? null;
}

/** What the customer's browser receives: no rule mappings, no battery proxies. */
export function customerQuestionView() {
  return CUSTOMER_QUESTIONS.map((q) => ({
    key: q.key, group: q.group, question: q.question, help: q.help ?? '',
    options: q.options.map((o) => ({ value: o.value, label: o.label, sub: o.sub ?? '', note: o.note ?? '' })),
  }));
}

/** Keep only recognised answers, upper-cased (normalizeCustomerAnswers_). */
export function normalizeCustomerAnswers(answers: unknown): Record<string, string> {
  const given = (answers && typeof answers === 'object' && !Array.isArray(answers))
    ? (answers as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  for (const q of CUSTOMER_QUESTIONS) {
    const o = getCustomerOption(q, given[q.key]);
    if (o) out[q.key] = o.value;
  }
  return out;
}

export const customerAnswersComplete = (answers: unknown): boolean =>
  Object.keys(normalizeCustomerAnswers(answers)).length === CUSTOMER_QUESTIONS.length;

export interface Translated {
  ruleAnswers: Record<string, boolean>;
  batteryHealth: number | null;
  missing: string[];
  assumed: { code: string; question: string }[];
  chosen: { key: string; group: string; question: string; value: string; label: string }[];
}

/** customerAnswersToRules_ — including the NAMED "assumed good" fill-in. */
export function customerAnswersToRules(answers: Record<string, unknown>, inspectionRules: InspectionRule[]): Translated {
  const ruleAnswers: Record<string, boolean> = {};
  let batteryHealth: number | null = null;
  const missing: string[] = [];
  const chosen: Translated['chosen'] = [];

  for (const q of CUSTOMER_QUESTIONS) {
    const option = getCustomerOption(q, answers[q.key]);
    if (!option) { missing.push(q.key); continue; }
    chosen.push({ key: q.key, group: q.group, question: q.question, value: option.value, label: option.label });
    if (option.battery !== undefined) { batteryHealth = option.battery; continue; }
    for (const [code, v] of Object.entries(option.rules ?? {})) ruleAnswers[code] = v;
  }

  const assumed: Translated['assumed'] = [];
  for (const rule of sortInspectionRules(inspectionRules)) {
    if (rule.input === INPUT_TYPE.PERCENTAGE) continue;
    if (ruleAnswers[rule.code] !== undefined) continue;
    ruleAnswers[rule.code] = true;
    assumed.push({ code: rule.code, question: rule.question });
  }
  return { ruleAnswers, batteryHealth, missing, assumed, chosen };
}

export type EstimateGrade =
  | { ok: false; reason: 'MISSING'; missing: string[] }
  | { ok: false; reason: 'BLOCKED'; blockedReason: string }
  | { ok: true; graded: GradeResult; translated: Translated };

/**
 * The grading half of estimateFromQuestionnaire_. Pricing is applied by
 * the caller through the same quote path as the final offer.
 * imeiRequired is false: nothing has been scanned yet.
 */
export function gradeCustomerAnswers(
  answers: Record<string, unknown>, inspectionRules: InspectionRule[], ladder: GradeRule[],
): EstimateGrade {
  const translated = customerAnswersToRules(answers, inspectionRules);
  if (translated.missing.length) return { ok: false, reason: 'MISSING', missing: translated.missing };
  const graded = computeGrade(translated.ruleAnswers, {
    batteryHealth: translated.batteryHealth, imeiMatch: true, imeiRequired: false,
  }, inspectionRules, ladder);
  if (graded.blocked) {
    return { ok: false, reason: 'BLOCKED', blockedReason: graded.blockedReason || 'We are not able to accept this device.' };
  }
  return { ok: true, graded, translated };
}

/** customerAnswerSummary_. */
export function customerAnswerSummary(stored: unknown) {
  const s = (stored && typeof stored === 'object') ? stored as Record<string, unknown> : {};
  return CUSTOMER_QUESTIONS.map((q) => {
    const o = getCustomerOption(q, s[q.key]);
    return { key: q.key, group: q.group, question: q.question, answer: o ? o.label : '', value: o ? o.value : '' };
  }).filter((r) => r.answer !== '');
}

/** assessmentComparison_: customer description against technician findings, joined on rule codes. */
export function assessmentComparison(stored: unknown, inspectionAnswers: Record<string, unknown>, rules: InspectionRule[]) {
  const s = (stored && typeof stored === 'object') ? stored as Record<string, unknown> : {};
  const byCode = new Map(rules.map((r) => [r.code, r]));
  const out: { key: string; item: string; question: string; customer: string; technician: string; agrees: boolean | null }[] = [];
  for (const q of CUSTOMER_QUESTIONS) {
    const option = getCustomerOption(q, s[q.key]);
    if (!option) continue;
    const codes = Object.keys(option.rules ?? {});
    let technician = '';
    let agrees: boolean | null = null;
    if (option.battery !== undefined) {
      technician = 'See battery health';
    } else if (codes.length) {
      const faults = codes.filter((c) => inspectionAnswers[c] === false);
      const answered = codes.filter((c) => inspectionAnswers[c] !== undefined);
      if (!answered.length) technician = 'Not inspected';
      else if (!faults.length) technician = 'No fault found';
      else technician = faults.map((c) => byCode.get(c)?.bad ?? c).join(', ');
      if (answered.length) {
        const claimed = codes.filter((c) => option.rules![c] === false).sort().join('|');
        agrees = claimed === [...faults].sort().join('|');
      }
    }
    out.push({ key: q.key, item: q.group, question: q.question, customer: option.label, technician, agrees });
  }
  return out;
}
