/**
 * The grading engine (11_GradeRules.gs + 15_Inspections.gs computeGrade_).
 *
 * Pure functions. The rules are passed in, loaded from the database by the
 * caller, so the technician screen, the customer estimate and the final
 * offer all run the same code against the same rows — the 3.1 guarantee
 * that "there is no second engine and no second ladder".
 */
import { BATTERY_BANDS, INPUT_TYPE, INSPECTION_BLOCKS } from './constants.js';
import { truthy } from '../../shared/src/text.js';
import { applyFraction4, type Cents } from '../../shared/src/money.js';

export interface GradeRule {
  gradeRuleId: string;
  code: string;
  name: string;
  /** percentage_of_base in basis points of 1 (0.7 → 7000). */
  percentageBp: number;
  minScore: number;
  order: number;
  terminal: boolean;
}

export interface InspectionRule {
  ruleId: string;
  code: string;
  group: string;
  question: string;
  input: 'SWITCH' | 'PERCENTAGE' | 'LOCK';
  good: string;
  bad: string;
  impact: number;
  blocking: boolean;
  order: number;
}

export interface Fault { code: string; question: string; detail: string; blocking?: boolean }

export interface GradeResult {
  score: number;
  gradeCode: string;
  blocked: boolean;
  blockedReason: string;
  faults: Fault[];
  missing: string[];
  complete: boolean;
}

export interface GradeContext {
  batteryHealth?: number | string | null;
  imeiMatch?: boolean;
  imeiRequired?: boolean;
}

/** Ordered best → worst, as getGradeRules_ returns them. */
export const sortGrades = (rules: GradeRule[]): GradeRule[] => [...rules].sort((a, b) => a.order - b.order);
export const sortInspectionRules = (rules: InspectionRule[]): InspectionRule[] =>
  [...rules].sort((a, b) => a.order - b.order);

/** Which battery band a reading falls into (batteryBandFor_). */
export function batteryBandFor(health: number): (typeof BATTERY_BANDS)[number] {
  const h = Math.max(0, Math.min(100, Number(health) || 0));
  for (const band of BATTERY_BANDS) if (h >= band.minHealth) return band;
  return BATTERY_BANDS[BATTERY_BANDS.length - 1]!;
}

/** Score → grade code: the first rule (best first) whose minScore the score reaches. */
export function gradeForScore(score: number, ladder: GradeRule[]): string {
  let s = Number(score);
  if (!Number.isFinite(s)) s = 0;
  s = Math.max(0, Math.min(100, s));
  const rules = sortGrades(ladder);
  for (const r of rules) if (s >= r.minScore) return r.code;
  const bottom = rules[rules.length - 1];
  return bottom ? bottom.code : 'R';
}

export const bottomGrade = (ladder: GradeRule[]): GradeRule | null => {
  const r = sortGrades(ladder);
  return r.length ? r[r.length - 1]! : null;
};
export const topGrade = (ladder: GradeRule[]): GradeRule | null => sortGrades(ladder)[0] ?? null;

/**
 * computeGrade_ — ported line for line. Note the ORDER of the battery
 * checks: emptiness is tested BEFORE converting, so an unanswered battery
 * question is "missing", never "0% health".
 */
export function computeGrade(
  answers: Record<string, unknown> | null | undefined,
  context: GradeContext,
  inspectionRules: InspectionRule[],
  ladder: GradeRule[],
): GradeResult {
  const rules = sortInspectionRules(inspectionRules);
  const a = answers ?? {};
  let score = 100;
  const faults: Fault[] = [];
  const missing: string[] = [];
  let blocked = false;
  let blockedReason = '';

  if (context.imeiRequired && context.imeiMatch === false) {
    blocked = true;
    blockedReason = INSPECTION_BLOCKS.IMEI_MISMATCH!;
  }

  for (const rule of rules) {
    const given = a[rule.code];

    if (rule.input === INPUT_TYPE.PERCENTAGE) {
      const raw = context.batteryHealth;
      if (raw === undefined || raw === null || raw === '') { missing.push(rule.code); continue; }
      const health = Number(raw);
      if (!Number.isFinite(health)) { missing.push(rule.code); continue; }
      const band = batteryBandFor(health);
      const deduction = Math.round(rule.impact * band.fraction);
      if (deduction > 0) {
        score -= deduction;
        faults.push({ code: rule.code, question: rule.question, detail: `${health}% — ${band.label}` });
      }
      continue;
    }

    if (given === undefined || given === null || given === '') { missing.push(rule.code); continue; }
    if (truthy(given)) continue;

    if (rule.blocking) {
      blocked = true;
      if (!blockedReason) blockedReason = INSPECTION_BLOCKS[rule.code] ?? `${rule.question}: ${rule.bad}`;
      faults.push({ code: rule.code, question: rule.question, detail: rule.bad, blocking: true });
      continue;
    }

    score -= rule.impact;
    faults.push({ code: rule.code, question: rule.question, detail: rule.bad });
  }

  score = Math.max(0, Math.min(100, score));

  let gradeCode: string;
  if (blocked) {
    const terminal = bottomGrade(ladder);
    gradeCode = terminal ? terminal.code : 'R';
    score = 0;
  } else {
    gradeCode = gradeForScore(score, ladder);
  }

  return { score, gradeCode, blocked, blockedReason, faults, missing, complete: missing.length === 0 };
}

/** gradeValue_: base × percentage, never below zero, always from the BASE. */
export function gradeValue(baseCents: Cents, gradeCode: string, ladder: GradeRule[]):
  { ok: true; value: Cents; rule: GradeRule } | { ok: false; message: string } {
  if (!Number.isFinite(baseCents) || baseCents < 0) return { ok: false, message: 'This device has no base price yet.' };
  const want = String(gradeCode ?? '').toUpperCase();
  const rule = ladder.find((r) => r.code === want);
  if (!rule) return { ok: false, message: `Unknown grade "${gradeCode}".` };
  return { ok: true, value: applyFraction4(baseCents, rule.percentageBp), rule };
}

/** The whole ladder priced out (gradeLadderFor_). */
export function gradeLadderFor(baseCents: Cents, ladder: GradeRule[]) {
  return sortGrades(ladder).map((r) => ({
    code: r.code, name: r.name, percentageBp: r.percentageBp,
    percentLabel: `${(r.percentageBp / 100).toFixed(0)}%`,
    value: applyFraction4(baseCents, r.percentageBp),
    minScore: r.minScore, terminal: r.terminal,
  }));
}

/** internalValidateGradeLadder_ — the four ladder invariants. */
export function validateGradeLadder(ladder: GradeRule[]): { ok: boolean; problems: string[] } {
  const rules = sortGrades(ladder);
  const problems: string[] = [];
  if (!rules.length) return { ok: false, problems: ['No grades are configured.'] };
  const top = rules[0]!;
  if (top.percentageBp !== 10000) {
    problems.push(`The best grade (${top.code}) is ${(top.percentageBp / 100).toFixed(1)}%, but it must be exactly 100% — it is what "base price" means.`);
  }
  const terminal = rules.filter((r) => r.terminal);
  if (!terminal.length) problems.push('No terminal grade is defined, so a worthless device cannot be recorded.');
  for (const r of terminal) {
    if (r.percentageBp !== 0) problems.push(`Terminal grade ${r.code} is ${(r.percentageBp / 100).toFixed(1)}%, but a terminal grade must be 0%.`);
  }
  for (const r of rules) {
    if (r.percentageBp < 0 || r.percentageBp > 10000) problems.push(`Grade ${r.code} is outside 0% to 100%.`);
    if (r.minScore < 0 || r.minScore > 100) problems.push(`Grade ${r.code} has a minimum score of ${r.minScore}, which is outside 0 to 100.`);
  }
  for (let i = 1; i < rules.length; i++) {
    const cur = rules[i]!; const prev = rules[i - 1]!;
    if (cur.percentageBp > prev.percentageBp) {
      problems.push(`Grade ${cur.code} (${(cur.percentageBp / 100).toFixed(0)}%) pays more than ${prev.code} (${(prev.percentageBp / 100).toFixed(0)}%), which rewards worse condition.`);
    }
    if (cur.minScore > prev.minScore) problems.push(`Grade ${cur.code} needs a higher score than ${prev.code}, so it can never be reached.`);
  }
  return { ok: problems.length === 0, problems };
}

/** validateLadderShape_ — applied to a PROPOSED ladder before saving a grade. */
export function validateLadderShape(ladder: GradeRule[]): { ok: boolean; problems: string[] } {
  const rules = sortGrades(ladder);
  const problems: string[] = [];
  if (!rules.length) return { ok: false, problems: ['at least one grade must stay active'] };
  if (rules[0]!.percentageBp !== 10000) problems.push('the best grade must be exactly 100%');
  if (!rules.some((r) => r.terminal)) problems.push('a terminal grade worth 0% must remain');
  for (let i = 1; i < rules.length; i++) {
    if (rules[i]!.percentageBp > rules[i - 1]!.percentageBp) problems.push(`${rules[i]!.code} would pay more than ${rules[i - 1]!.code}`);
  }
  return { ok: problems.length === 0, problems };
}

/** What a technician's browser receives: no impacts, no blocking flags (technicianRuleView_). */
export function technicianRuleView(rules: InspectionRule[]) {
  return sortInspectionRules(rules).map((r) => ({
    code: r.code, group: r.group, question: r.question, input: r.input, good: r.good, bad: r.bad,
  }));
}
