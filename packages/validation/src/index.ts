/**
 * Request validation. Every action's parameters are parsed with a schema
 * before any service runs: types, lengths and formats are checked here;
 * business rules stay in the services. Unknown keys are STRIPPED (the 3.1
 * client sometimes sends extra fields), never trusted.
 */
import { z } from 'zod';

export const id = z.string().trim().min(1).max(64);
export const optId = z.string().trim().max(64).optional();
export const text = (max: number) => z.string().trim().max(max);
export const optText = (max: number) => z.string().trim().max(max).optional();
export const phone = z.string().trim().max(32);
export const flag = z.union([z.boolean(), z.literal('true'), z.literal('false'), z.literal('TRUE'), z.literal('FALSE'), z.literal(''), z.number()]).optional();
export const money = z.union([z.number().finite(), z.string().trim().max(32)]);
export const ymd = z.string().trim().max(40).optional();
export const limit = z.union([z.number(), z.string()]).optional().transform((v) => (v === undefined || v === '' ? undefined : Number(v)));
const answersRecord = z.record(z.string().max(40), z.union([z.string().max(40), z.boolean(), z.number(), z.null()])).optional();

export const empty = z.object({}).passthrough().transform(() => ({}));

export const S = {
  tradeInId: z.object({ tradeInId: id }),
  estimate: z.object({ variantId: id, vendorId: optId, conditionAnswers: answersRecord }),
  submitTradeIn: z.object({
    vendorId: id, branchId: id, variantId: id, colorId: optId, imei: optText(32), serialNumber: optText(64),
    conditionAnswers: answersRecord, notes: optText(1000),
  }),
  decline: z.object({ tradeInId: id, reason: optText(500) }),
  receive: z.object({ tradeInId: id, notes: optText(1000) }),
  returnDevice: z.object({ tradeInId: id, stage: optText(20), reason: optText(500), notes: optText(1000) }),
  checkImei: z.object({ tradeInId: id, scannedImei: text(32) }),
  saveInspection: z.object({
    tradeInId: id, answers: answersRecord,
    batteryHealth: z.union([z.number(), z.string().max(8), z.null()]).optional(), notes: optText(2000),
  }),
  uploadPhotos: z.object({
    tradeInId: id,
    photos: z.array(z.object({ category: optText(20), label: optText(120), dataUrl: z.string().max(7_000_000) })).max(8),
  }),
  viewPhoto: z.object({ tradeInId: id, fileId: text(120) }),
  issueVoucher: z.object({ tradeInId: id, notes: optText(500) }),
  voidVoucher: z.object({ voucherId: id, reason: optText(500), reissue: flag }),
  vouchers: z.object({ status: optText(20), branchId: optId, from: ymd, to: ymd, search: optText(100), limit }),
  vendorQueue: z.object({ status: optText(40), branchId: optId, search: optText(100), limit }),
  adminTradeIns: z.object({
    vendorId: optId, branchId: optId, status: optText(40), grade: optText(8), brand: optText(80), model: optText(120),
    from: ymd, to: ymd, search: optText(100), limit,
  }),
  overridePrice: z.object({ tradeInId: id, manualAdjustment: money, manualAdjustmentReason: optText(500), reason: optText(500) }),
  overrideGrade: z.object({ tradeInId: id, gradeCode: text(8), reason: optText(500) }),
  createBatch: z.object({ vendorId: optId, branchId: optId, tradeInIds: z.array(id).max(500).optional(), notes: optText(1000) }),
  updateBatch: z.object({
    batchId: id, action: optText(20), reason: optText(500), notes: optText(1000),
    items: z.array(z.object({ tradeInId: id, status: optText(20), reason: optText(500) })).max(1000).optional(),
  }),
  collections: z.object({ batchId: optId, status: optText(40), vendorId: optId, branchId: optId, from: ymd, to: ymd, limit }),
  settlements: z.object({ settlementId: optId, preview: flag, vendorId: optId, from: ymd, to: ymd, status: optText(20), limit }),
  createSettlement: z.object({ vendorId: id, from: text(40), to: text(40), notes: optText(1000) }),
  advanceSettlement: z.object({
    settlementId: id, action: optText(20), toStatus: optText(20), reason: optText(500), paymentReference: optText(120),
  }),
  notifyList: z.object({ unreadOnly: flag, limit }),
  notifyMark: z.object({ notificationId: id }),
  authStart: z.object({ phone }),
  authVerify: z.object({ phone, code: text(12) }),
  authRegister: z.object({
    phone, fullName: optText(120), accountType: optText(20), email: optText(200), notes: optText(500), code: optText(12),
  }),
  authRefresh: z.object({ refreshToken: text(4096) }),
  // Staff email + password (STAFF_SIGN_IN=password). Passwords are length-bounded here and checked by the service.
  staffLogin: z.object({ email: text(254), password: z.string().min(1).max(256) }),
  staffResetStart: z.object({ email: text(254) }),
  staffResetFinish: z.object({ email: text(254), code: text(12), password: z.string().min(1).max(256) }),
} as const;

export { z };
