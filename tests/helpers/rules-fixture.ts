/** The 3.1 default ladder and inspection rules (the same values the reference-data migration seeds). */
import type { GradeRule, InspectionRule } from '../../packages/domain/src/grading.js';

export const LADDER: GradeRule[] = [
  { gradeRuleId: 'GRD-001', code: 'A', name: 'Excellent', percentageBp: 10000, minScore: 95, order: 1, terminal: false },
  { gradeRuleId: 'GRD-002', code: 'B', name: 'Good', percentageBp: 7000, minScore: 80, order: 2, terminal: false },
  { gradeRuleId: 'GRD-003', code: 'C', name: 'Fair', percentageBp: 5000, minScore: 60, order: 3, terminal: false },
  { gradeRuleId: 'GRD-004', code: 'D', name: 'Repairable', percentageBp: 3000, minScore: 35, order: 4, terminal: false },
  { gradeRuleId: 'GRD-005', code: 'R', name: 'Parts only', percentageBp: 0, minScore: 0, order: 5, terminal: true },
];

const r = (code: string, input: InspectionRule['input'], impact: number, blocking: boolean, order: number): InspectionRule =>
  ({ ruleId: '', code, group: '', question: code, input, good: 'good', bad: 'bad', impact, blocking, order });

export const RULES: InspectionRule[] = [
  r('ACTIVATION_LOCK', 'LOCK', 0, true, 1), r('SCREEN_WORKS', 'SWITCH', 25, false, 10), r('SCREEN_CRACK', 'SWITCH', 18, false, 11),
  r('SCREEN_SCRATCH', 'SWITCH', 7, false, 12), r('BODY_INTACT', 'SWITCH', 20, false, 20), r('BODY_DENT', 'SWITCH', 8, false, 21),
  r('BODY_SCRATCH', 'SWITCH', 5, false, 22), r('BACK_GLASS', 'SWITCH', 10, false, 23), r('DEVICE_POWERS_ON', 'SWITCH', 40, false, 29),
  r('CAMERA_WORKS', 'SWITCH', 8, false, 30), r('BIOMETRIC_WORKS', 'SWITCH', 6, false, 31), r('SPEAKER_WORKS', 'SWITCH', 5, false, 32),
  r('MIC_WORKS', 'SWITCH', 4, false, 33), r('BUTTONS_WORK', 'SWITCH', 4, false, 34), r('CHARGING_WORKS', 'SWITCH', 4, false, 35),
  r('WIFI_WORKS', 'SWITCH', 2, false, 36), r('BLUETOOTH_WORKS', 'SWITCH', 2, false, 37), r('BATTERY_HEALTH', 'PERCENTAGE', 12, false, 40),
];

export const allGood = (): Record<string, boolean> => Object.fromEntries(RULES.filter((x) => x.input !== 'PERCENTAGE').map((x) => [x.code, true]));
