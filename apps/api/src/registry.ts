/**
 * ACTION REGISTRY — the 3.1 registry (06_RBAC.gs), same action names,
 * same role lists, same idempotency targets. The compatibility endpoint
 * POST /v1/actions/:action and the REST routes both dispatch through it,
 * so a rule cannot apply to one entry point and not the other.
 *
 * Public actions (auth.*, public.*, customer.questions) are handled by
 * routes/auth.ts and routes/public.ts because they run without a principal.
 */
import { z } from 'zod';
import { ADMIN_ONLY, ANY_STAFF, ROLES, TECH_ANY, VENDOR_ANY, VENDOR_MGMT } from '../../../packages/domain/src/constants.js';
import { S, empty } from '../../../packages/validation/src/index.js';
import type { ActionDef } from './runner.js';
import * as tradeins from './services/tradeins.js';
import * as insp from './services/inspections.js';
import * as vouchers from './services/vouchers.js';
import * as collections from './services/collections.js';
import * as settlements from './services/settlements.js';
import * as notifications from './services/notifications.js';
import { authResume, meContext } from './services/auth.js';
import { EXTRA_ACTIONS } from './registry-more.js';

const CUSTOMER = [ROLES.CUSTOMER] as const;

export const REGISTRY: Record<string, ActionDef> = {
  /* ---- everybody signed in ------------------------------------------- */
  'me.context': { roles: '*', schema: empty, readOnly: true, run: (ctx) => meContext(ctx.db, ctx.p) },
  'auth.resume': { roles: '*', schema: empty, readOnly: true, run: async (ctx) => authResume(ctx.p) },
  'notify.list': { roles: '*', schema: S.notifyList, readOnly: true, run: (ctx, p) => notifications.listNotifications(ctx, p) },
  'notify.markRead': { roles: '*', schema: S.notifyMark, run: (ctx, p) => notifications.markRead(ctx, p) },
  'notify.markAllRead': { roles: '*', schema: empty, run: (ctx) => notifications.markAllRead(ctx) },

  /* ---- customer -------------------------------------------------------- */
  'customer.estimate': { roles: CUSTOMER, schema: S.estimate, run: (ctx, p) => tradeins.customerEstimate(ctx, p) },
  'customer.submitTradeIn': { roles: CUSTOMER, schema: S.submitTradeIn, idem: ['imei'], run: (ctx, p) => tradeins.createTradeIn(ctx, p) },
  'customer.myTradeIns': { roles: CUSTOMER, schema: empty, readOnly: true, run: (ctx) => tradeins.customerTradeIns(ctx) },
  'customer.tradeIn': { roles: CUSTOMER, schema: S.tradeInId, readOnly: true, run: (ctx, p) => tradeins.customerTradeIn(ctx, p) },
  'customer.acceptOffer': { roles: CUSTOMER, schema: S.tradeInId, idem: ['tradeInId'], run: (ctx, p) => tradeins.acceptOffer(ctx, p) },
  'customer.declineOffer': { roles: CUSTOMER, schema: S.decline, idem: ['tradeInId'], run: (ctx, p) => tradeins.declineOffer(ctx, p) },
  'customer.voucher': { roles: CUSTOMER, schema: S.tradeInId, readOnly: true, run: (ctx, p) => tradeins.customerVoucher(ctx, p) },

  /* ---- technician ------------------------------------------------------ */
  'tech.queues': { roles: TECH_ANY, schema: empty, readOnly: true, run: (ctx) => tradeins.technicianQueues(ctx) },
  'tech.openInspection': { roles: TECH_ANY, schema: S.tradeInId, run: (ctx, p) => insp.openInspection(ctx, p) },
  'tech.saveInspection': { roles: TECH_ANY, schema: S.saveInspection, run: (ctx, p) => insp.saveInspection(ctx, p) },
  'tech.summary': { roles: TECH_ANY, schema: S.tradeInId, readOnly: true, run: (ctx, p) => insp.inspectionSummary(ctx, p) },
  'tech.complete': { roles: TECH_ANY, schema: S.tradeInId, idem: ['tradeInId'], run: (ctx, p) => insp.completeInspection(ctx, p) },
  'tech.checkImei': { roles: TECH_ANY, schema: S.checkImei, run: (ctx, p) => insp.checkImei(ctx, p) },
  'tech.uploadPhotos': { roles: TECH_ANY, schema: S.uploadPhotos, run: (ctx, p) => insp.uploadPhotos(ctx, p) },
  'tech.viewPhoto': { roles: TECH_ANY, schema: S.viewPhoto, readOnly: true, run: (ctx, p) => insp.viewPhoto(ctx, p) },
  'tech.previewOffer': { roles: TECH_ANY, schema: S.tradeInId, readOnly: true, run: (ctx, p) => insp.previewOffer(ctx, p) },
  'tech.submitOffer': { roles: TECH_ANY, schema: S.tradeInId, idem: ['tradeInId'], run: (ctx, p) => insp.techSubmitOffer(ctx, p) },
  'tech.receiveDevice': { roles: TECH_ANY, schema: S.receive, idem: ['tradeInId'], run: (ctx, p) => tradeins.receiveDevice(ctx, p) },
  'tech.returnDevice': { roles: TECH_ANY, schema: S.returnDevice, idem: ['tradeInId', 'stage'], run: (ctx, p) => tradeins.returnDevice(ctx, p) },

  /* ---- partner --------------------------------------------------------- */
  'vendor.queue': { roles: VENDOR_ANY, schema: S.vendorQueue, readOnly: true, run: (ctx, p) => tradeins.vendorQueue(ctx, p) },
  'vendor.tradeIn': { roles: VENDOR_ANY, schema: S.tradeInId, readOnly: true, run: (ctx, p) => tradeins.vendorTradeIn(ctx, p) },
  'vendor.issueVoucher': { roles: VENDOR_ANY, schema: S.issueVoucher, idem: ['tradeInId'], run: (ctx, p) => vouchers.issueVoucher(ctx, p) },
  'vendor.voidVoucher': { roles: VENDOR_MGMT, schema: S.voidVoucher, idem: ['voucherId', 'reissue'], run: (ctx, p) => vouchers.voidOrReissue(ctx, p) },
  'vendor.vouchers': { roles: VENDOR_ANY, schema: S.vouchers, readOnly: true, run: (ctx, p) => vouchers.listVouchers(ctx, p) },
  'vendor.settlements': { roles: VENDOR_MGMT, schema: S.settlements, readOnly: true, run: (ctx, p) => settlements.settlementsAction(ctx, p) },

  /* ---- administrators: the money -------------------------------------- */
  'admin.tradeIns': { roles: ADMIN_ONLY, schema: S.adminTradeIns, readOnly: true, run: (ctx, p) => tradeins.adminTradeIns(ctx, p) },
  'admin.overridePrice': {
    roles: ADMIN_ONLY, schema: S.overridePrice, idem: ['tradeInId'],
    run: (ctx, p) => tradeins.adjustOffer(ctx, { tradeInId: p.tradeInId, manualAdjustment: p.manualAdjustment, reason: p.manualAdjustmentReason || p.reason }),
  },
  'admin.overrideGrade': { roles: ADMIN_ONLY, schema: S.overrideGrade, idem: ['tradeInId'], run: (ctx, p) => tradeins.overrideGrade(ctx, p) },
  'admin.collections': { roles: ADMIN_ONLY, schema: S.collections, readOnly: true, run: (ctx, p) => collections.adminCollections(ctx, p) },
  'admin.createBatch': { roles: ADMIN_ONLY, schema: S.createBatch, idem: ['vendorId', 'branchId'], run: (ctx, p) => collections.createBatch(ctx, p) },
  'admin.updateBatch': { roles: ADMIN_ONLY, schema: S.updateBatch, idem: ['batchId', 'action'], run: (ctx, p) => collections.updateBatch(ctx, p) },
  'admin.settlements': { roles: ADMIN_ONLY, schema: S.settlements, readOnly: true, run: (ctx, p) => settlements.settlementsAction(ctx, p) },
  'admin.createSettlement': { roles: ADMIN_ONLY, schema: S.createSettlement, idem: ['vendorId', 'from', 'to'], run: (ctx, p) => settlements.createSettlement(ctx, p) },
  'admin.advanceSettlement': {
    roles: ADMIN_ONLY, schema: S.advanceSettlement, idem: ['settlementId', 'action', 'toStatus'],
    run: (ctx, p) => settlements.advanceOrCancel(ctx, p),
  },

  ...EXTRA_ACTIONS,
};

/** Every non-public action name, for the self-check test (internalCheckRegistry_). */
export const ACTION_NAMES = Object.keys(REGISTRY);
export { ANY_STAFF, z };
