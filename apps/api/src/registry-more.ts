/**
 * Registry entries for every 3.1 action outside the vertical slice:
 * staff, customers, partners/branches, catalogue, pricing, grade and
 * inspection rules, imports, reports, dashboards, search, audit, settings.
 * Same names, same role lists, same idempotency targets as 06_RBAC.gs.
 */
import { z } from 'zod';
import { ADMIN_ONLY, ANY_STAFF, ROLES, VENDOR_ANY, VENDOR_MGMT } from '../../../packages/domain/src/constants.js';
import { empty, flag, id, limit, money, optId, optText, text, ymd } from '../../../packages/validation/src/index.js';
import type { ActionDef } from './runner.js';
import * as catalog from './services/catalog.js';
import * as insp from './services/inspections.js';
import * as misc from './services/misc.js';
import * as people from './services/people.js';
import * as pricing from './services/pricing.js';
import * as reports from './services/reports.js';
import { APP_VERSION, ROLES as R } from '../../../packages/domain/src/constants.js';

const loose = (shape: z.ZodRawShape) => z.object(shape);
const reportSchema = loose({
  reportType: optText(20), groupBy: optText(20), vendorId: optId, branchId: optId, status: optText(40), grade: optText(8),
  brand: optText(80), model: optText(120), from: ymd, to: ymd, billableOnly: flag, includeRows: flag, asCsv: flag,
});
const staffSchema = loose({
  mode: optText(20), userId: optId, phone: optText(32), fullName: optText(120), role: optText(30), vendorId: z.string().trim().max(64).optional(),
  branchId: z.string().trim().max(64).optional(), status: optText(30), email: optText(200), notes: optText(1000), reason: optText(500), decision: optText(20),
});
const importRows = z.array(z.record(z.string().max(40), z.union([z.string().max(300), z.number(), z.null()]))).max(5000);
const dataUrl = z.string().max(4_000_000);

export const EXTRA_ACTIONS: Record<string, ActionDef> = {
  /* ---- customer / staff self ------------------------------------------- */
  'customer.updateProfile': { roles: [ROLES.CUSTOMER], schema: loose({ fullName: optText(120), email: optText(200) }), run: (ctx, p) => people.updateOwnProfile(ctx, p) },
  'search.global': { roles: ANY_STAFF, schema: loose({ query: optText(100) }), readOnly: true, run: (ctx, p) => misc.globalSearch(ctx, p) },

  /* ---- partner management ---------------------------------------------- */
  'vendor.dashboard': { roles: VENDOR_ANY, schema: empty, readOnly: true, run: (ctx) => reports.vendorDashboard(ctx) },
  'vendor.branches': { roles: VENDOR_MGMT, schema: loose({ vendorId: optId }), readOnly: true, run: (ctx, p) => people.vendorBranches(ctx, p) },
  'vendor.saveBranch': {
    roles: VENDOR_MGMT, schema: loose({ vendorId: optId, branchId: optId, name: optText(120), code: optText(20), address: optText(300), location: optText(300), phone: optText(32), active: flag, displayOrder: z.union([z.number(), z.string().max(6)]).optional(), notes: optText(1000) }),
    run: (ctx, p) => people.vendorSaveBranch(ctx, p),
  },
  'vendor.staff': { roles: VENDOR_MGMT, schema: loose({ status: optText(30), role: optText(30), vendorId: optId, search: optText(100) }), readOnly: true, run: (ctx, p) => people.listStaff(ctx, p) },
  'vendor.saveStaff': { roles: VENDOR_MGMT, schema: staffSchema, idem: ['mode', 'userId', 'phone'], run: (ctx, p) => people.saveStaffByMode(ctx, p) },
  'vendor.reports': { roles: VENDOR_MGMT, schema: reportSchema, readOnly: true, run: (ctx, p) => reports.buildReport(ctx, p) },

  /* ---- administrators: operations -------------------------------------- */
  'admin.dashboard': { roles: ADMIN_ONLY, schema: loose({ vendorId: optId, branchId: optId, status: optText(40), grade: optText(8), brand: optText(80), model: optText(120), from: ymd, to: ymd }), readOnly: true, run: (ctx, p) => reports.platformDashboard(ctx, p) },
  'admin.tradeIn': { roles: ADMIN_ONLY, schema: loose({ tradeInId: id }), readOnly: true, run: (ctx, p) => misc.adminTradeIn(ctx, p) },

  /* ---- partners and branches -------------------------------------------- */
  'admin.vendors': { roles: ADMIN_ONLY, schema: empty, readOnly: true, run: (ctx) => people.adminVendors(ctx) },
  'admin.saveVendor': {
    roles: ADMIN_ONLY, schema: loose({ vendorId: optId, name: optText(120), code: optText(10), logoUrl: optText(500), commissionRate: z.union([z.number(), z.string().max(20)]).optional(), status: optText(20), contactName: optText(120), contactPhone: optText(32), contactEmail: optText(200), settlementTerms: optText(1000), notes: optText(1000) }),
    run: (ctx, p) => people.saveVendor(ctx, p),
  },
  'admin.uploadVendorLogo': { roles: ADMIN_ONLY, schema: loose({ vendorId: id, dataUrl }), run: (ctx, p) => catalog.uploadMedia(ctx, { kind: 'VENDOR', objectId: p.vendorId, dataUrl: p.dataUrl }) },
  'admin.branches': { roles: ADMIN_ONLY, schema: loose({ vendorId: optId }), readOnly: true, run: async (ctx, p) => ({ ok: true, branches: await people.listBranches(ctx, p.vendorId || null) }) },
  'admin.saveBranch': {
    roles: ADMIN_ONLY, schema: loose({ vendorId: id, branchId: optId, name: optText(120), code: optText(20), address: optText(300), location: optText(300), phone: optText(32), active: flag, displayOrder: z.union([z.number(), z.string().max(6)]).optional(), notes: optText(1000) }),
    run: (ctx, p) => people.saveBranch(ctx, p.vendorId, p),
  },
  'admin.commissionRules': { roles: ADMIN_ONLY, schema: loose({ vendorId: optId, includeHistory: flag }), readOnly: true, run: (ctx, p) => pricing.listCommissionRules(ctx, p) },
  'admin.saveCommissionRule': {
    roles: ADMIN_ONLY, schema: loose({ vendorId: id, brandId: optId, categoryId: optId, productId: optId, commissionType: optText(20), commissionValue: money, effectiveFrom: optText(40), effectiveTo: optText(40), notes: optText(500) }),
    run: (ctx, p) => pricing.saveCommissionRule(ctx, p),
  },
  'admin.cancelCommissionRule': { roles: ADMIN_ONLY, schema: loose({ commissionRuleId: id, reason: optText(500) }), run: (ctx, p) => pricing.cancelCommissionRule(ctx, p) },

  /* ---- catalogue ------------------------------------------------------- */
  'admin.brands': { roles: ADMIN_ONLY, schema: empty, readOnly: true, run: (ctx) => catalog.adminBrands(ctx) },
  'admin.saveBrand': {
    roles: ADMIN_ONLY, schema: loose({ brandId: optId, name: optText(120), slug: optText(120), active: flag, displayOrder: z.union([z.number(), z.string().max(6)]).optional(), logoUrl: optText(500), logoDataUrl: dataUrl.optional() }),
    run: async (ctx, p) => {
      const saved = await catalog.saveBrand(ctx, p);
      if (p.logoDataUrl) return catalog.uploadMedia(ctx, { kind: 'BRAND', objectId: saved.brandId, dataUrl: p.logoDataUrl });
      return saved;
    },
  },
  'admin.categories': { roles: ADMIN_ONLY, schema: empty, readOnly: true, run: (ctx) => catalog.adminCategories(ctx) },
  'admin.saveCategory': {
    roles: ADMIN_ONLY, schema: loose({ categoryId: optId, name: optText(120), slug: optText(120), parentCategoryId: z.string().trim().max(64).optional(), description: optText(1000), active: flag, displayOrder: z.union([z.number(), z.string().max(6)]).optional(), imageUrl: optText(500), iconUrl: optText(500) }),
    run: (ctx, p) => catalog.saveCategory(ctx, p),
  },
  'admin.products': { roles: ADMIN_ONLY, schema: loose({ brandId: optId, categoryId: optId, search: optText(100) }), readOnly: true, run: (ctx, p) => catalog.adminProducts(ctx, p) },
  'admin.product': { roles: ADMIN_ONLY, schema: loose({ productId: id }), readOnly: true, run: (ctx, p) => catalog.adminProduct(ctx, p) },
  'admin.saveProduct': {
    roles: ADMIN_ONLY, schema: loose({ productId: optId, brandId: optId, categoryId: z.string().trim().max(64).optional(), model: optText(120), modelCode: optText(60), deviceType: optText(20), releaseYear: z.union([z.number(), z.string().max(6)]).optional(), keywords: optText(500), active: flag, displayOrder: z.union([z.number(), z.string().max(6)]).optional(), notes: optText(1000), imageUrl: optText(500) }),
    run: (ctx, p) => catalog.saveProduct(ctx, p),
  },
  'admin.saveVariant': { roles: ADMIN_ONLY, schema: loose({ variantId: optId, productId: id, storage: optText(20), active: flag, displayOrder: z.union([z.number(), z.string().max(6)]).optional() }), run: (ctx, p) => catalog.saveVariant(ctx, p) },
  'admin.saveColor': { roles: ADMIN_ONLY, schema: loose({ colorId: optId, productId: id, color: optText(60), active: flag, displayOrder: z.union([z.number(), z.string().max(6)]).optional(), imageUrl: optText(500) }), run: (ctx, p) => catalog.saveColor(ctx, p) },
  'admin.uploadMedia': { roles: ADMIN_ONLY, schema: loose({ kind: optText(20), objectId: id, dataUrl }), run: (ctx, p) => catalog.uploadMedia(ctx, p) },

  /* ---- pricing and grading -------------------------------------------- */
  'admin.pricing': { roles: ADMIN_ONLY, schema: loose({ vendorId: optId, brandId: optId, categoryId: optId, productId: optId, search: optText(100), activeOnly: flag, status: optText(20) }), readOnly: true, run: (ctx, p) => pricing.pricingTable(ctx, p) },
  'admin.priceHistory': { roles: ADMIN_ONLY, schema: loose({ variantId: id, vendorId: optId }), readOnly: true, run: (ctx, p) => pricing.priceHistory(ctx, p) },
  'admin.setBasePrice': { roles: ADMIN_ONLY, schema: loose({ variantId: id, basePrice: money, effectiveFrom: optText(40), vendorId: optId, notes: optText(500) }), run: (ctx, p) => pricing.setBasePrice(ctx, p) },
  'admin.retirePrice': { roles: ADMIN_ONLY, schema: loose({ priceId: id, vendorId: optId, mode: optText(20), reason: optText(500) }), run: (ctx, p) => pricing.retireOrCancelPrice(ctx, p) },
  'admin.gradeRules': { roles: ADMIN_ONLY, schema: empty, readOnly: true, run: (ctx) => pricing.gradeRules(ctx) },
  'admin.saveGradeRule': { roles: ADMIN_ONLY, schema: loose({ gradeCode: text(8), gradeName: optText(60), percentage: money, minScore: z.union([z.number(), z.string().max(8)]), order: z.union([z.number(), z.string().max(6)]).optional(), terminal: flag, active: flag }), run: (ctx, p) => pricing.saveGradeRule(ctx, p) },
  'admin.inspectionRules': { roles: ADMIN_ONLY, schema: empty, readOnly: true, run: (ctx) => pricing.inspectionRulesAdmin(ctx, () => insp.listInspectionRules(ctx)) },
  'admin.saveInspectionRule': {
    roles: ADMIN_ONLY, schema: loose({ code: text(40), impact: z.union([z.number(), z.string().max(8)]), group: optText(40), question: optText(300), input: optText(20), good: optText(80), bad: optText(80), blocking: flag, order: z.union([z.number(), z.string().max(6)]).optional(), active: flag, notes: optText(500) }),
    run: (ctx, p) => insp.saveInspectionRule(ctx, p),
  },
  'admin.previewImport': { roles: ADMIN_ONLY, schema: loose({ rows: importRows }), readOnly: true, run: (ctx, p) => catalog.previewImport(ctx, p) },
  'admin.applyImport': { roles: ADMIN_ONLY, schema: loose({ rows: importRows }), run: (ctx, p) => catalog.applyImport(ctx, p) },

  /* ---- people ---------------------------------------------------------- */
  'admin.customers': { roles: ADMIN_ONLY, schema: loose({ status: optText(20), search: optText(100), limit }), readOnly: true, run: (ctx, p) => people.listCustomers(ctx, p) },
  'admin.customer': { roles: ADMIN_ONLY, schema: loose({ customerId: id, status: optText(20), reason: optText(500) }), run: (ctx, p) => people.adminCustomer(ctx, p) },
  'admin.staff': { roles: ADMIN_ONLY, schema: loose({ status: optText(30), role: optText(30), vendorId: optId, search: optText(100) }), readOnly: true, run: (ctx, p) => people.listStaff(ctx, p) },
  'admin.approveStaff': {
    roles: ADMIN_ONLY, schema: staffSchema, idem: ['userId'],
    run: (ctx, p) => (String(p.decision ?? '').toUpperCase() === 'REJECT' ? people.rejectStaff(ctx, p) : people.approveStaff(ctx, p)),
  },
  'admin.updateStaff': {
    roles: ADMIN_ONLY, schema: staffSchema, idem: ['mode', 'userId', 'phone'],
    run: (ctx, p) => (String(p.mode ?? '').toUpperCase() === 'CREATE' ? people.createStaff(ctx, p) : people.updateStaff(ctx, p)),
  },

  /* ---- reports, audit, settings ---------------------------------------- */
  'admin.reports': { roles: ADMIN_ONLY, schema: reportSchema, readOnly: true, run: (ctx, p) => reports.buildReport(ctx, p) },
  'admin.audit': { roles: ADMIN_ONLY, schema: loose({ vendorId: optId, action: optText(60), actorId: optId, role: optText(30), objectId: optText(64), from: ymd, to: ymd, limit }), readOnly: true, run: (ctx, p) => misc.queryAudit(ctx, p) },
  'admin.settings': {
    roles: ADMIN_ONLY, schema: empty, readOnly: true,
    run: async (ctx) => {
      const ladder = await pricing.gradeRules(ctx);
      const sa = (await ctx.db.query<{ n: number }>(`select count(*)::int as n from public.app_users where role = 'SUPER_ADMIN' and status = 'ACTIVE'`)).rows[0]!.n;
      return {
        ok: true, settings: await people.listSettings(ctx), version: APP_VERSION, versionLabel: APP_VERSION,
        health: {
          environment: ctx.deps.config.APP_ENV.toUpperCase(), devMode: ctx.deps.sms.name === 'test',
          devModeWarning: ctx.deps.sms.name === 'test' ? 'This environment uses the test SMS provider. It is refused in staging and production.' : '',
          smsProvider: ctx.deps.sms.name.toUpperCase(), smsReady: ctx.deps.sms.configured(),
          unpricedVariants: await pricing.countUnpricedVariants(ctx), gradeLadderValid: ladder.valid, activeSuperAdmins: sa,
        },
      };
    },
  },
  'admin.saveSetting': { roles: [R.SUPER_ADMIN], schema: loose({ key: text(60), value: z.union([z.string().max(2000), z.number(), z.boolean()]).optional() }), run: (ctx, p) => people.saveSetting(ctx, p) },
};
