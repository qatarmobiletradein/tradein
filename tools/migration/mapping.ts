/**
 * Sheet → table mapping for the Google Sheets export produced by the 3.1
 * private function migrationExportSheet_ (03_Migrations.gs).
 *
 * IDs are preserved exactly (deterministic mapping: legacy id = new id),
 * so a printed voucher, note or invoice keeps its number. Sessions, OTP
 * codes and idempotency records are NOT migrated (3.1 refuses to export
 * them, and Apps Script sessions must not be valid in the new system).
 *
 * Each mapper returns either a row for the table or an error string; it
 * never guesses. Conversions are exact (money via shared/money.ts).
 */
import { centsToDecimal, fraction4ToDecimal, microToDecimal, toCents, toFraction4, toMicro } from '../../packages/shared/src/money.js';
import { normalizeEmail, normalizePhone, truthy } from '../../packages/shared/src/text.js';

export type Raw = Record<string, unknown>;
export type Mapped = { ok: true; row: Record<string, unknown>; extra?: { table: string; row: Record<string, unknown> }[] } | { ok: false; error: string };

const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v)).trim();
const n = (v: unknown): string | null => (s(v) === '' ? null : s(v));
const date = (v: unknown): Date | null => {
  const x = s(v);
  if (!x) return null;
  const d = new Date(x);
  if (Number.isNaN(d.getTime())) throw new Error(`"${x}" is not a date`);
  return d;
};
/** Staff sign in with their email (STAFF_SIGN_IN=password): a malformed one is reported, never stored or guessed. */
const staffEmail = (v: unknown): string | null => {
  const x = s(v);
  if (!x) return null;
  const e = normalizeEmail(x);
  if (!e) throw new Error(`Email "${x}" is not a valid address (staff sign in with it) — correct it in the sheet or clear it`);
  return e;
};
const money = (v: unknown): string | null => (s(v) === '' ? null : centsToDecimal(toCents(v)));
const moneyReq = (v: unknown): string => centsToDecimal(toCents(s(v) === '' ? 0 : v));
const rate = (v: unknown): string | null => (s(v) === '' ? null : microToDecimal(toMicro(v)));
const frac4 = (v: unknown): string | null => (s(v) === '' ? null : fraction4ToDecimal(toFraction4(v)));
const int = (v: unknown, d: number): number => (s(v) === '' || !Number.isFinite(Number(v)) ? d : Math.round(Number(v)));
const json = (v: unknown, d: unknown): string => {
  if (v && typeof v === 'object') return JSON.stringify(v);
  const x = s(v);
  if (!x) return JSON.stringify(d);
  try { return JSON.stringify(JSON.parse(x)); } catch { throw new Error('is not valid JSON'); }
};
const list = (v: unknown): string[] => s(v).split(',').map((x) => x.trim()).filter(Boolean);
const phone = (v: unknown): string => {
  const p = normalizePhone(v);
  if (!p) throw new Error(`phone "${s(v) ? '••••' + s(v).slice(-4) : ''}" is not a valid Qatar mobile number`);
  return p;
};
const digits15 = (v: unknown): string | null => {
  const d = s(v).replace(/\D/g, '');
  if (!d) return null;
  if (!/^\d{15}$/.test(d)) throw new Error('IMEI is not 15 digits');
  return d;
};

function wrap(fn: (r: Raw) => Record<string, unknown>, extra?: (r: Raw) => { table: string; row: Record<string, unknown> }[]) {
  return (r: Raw): Mapped => {
    try { return { ok: true, row: fn(r), extra: extra?.(r) }; } catch (e) { return { ok: false, error: (e as Error).message }; }
  };
}

export interface SheetSpec { sheet: string; table: string; key: string; idColumn: string; map: (r: Raw) => Mapped; transactional?: boolean }

/** Insert order respects foreign keys; the transactional group is applied in ONE transaction (deferred FKs). */
export const SHEETS: SheetSpec[] = [
  { sheet: 'Vendors', table: 'vendors', key: 'VendorID', idColumn: 'id', map: wrap((r) => ({
    id: s(r.VendorID), name: s(r.Name), code: s(r.Code).toUpperCase(), logo_url: n(r.LogoURL),
    default_commission_rate: rate(r.DefaultCommissionRate) ?? '0.050000', status: s(r.Status).toUpperCase() === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE',
    contact_name: n(r.ContactName), contact_phone: n(r.ContactPhone), contact_email: n(r.ContactEmail), settlement_terms: n(r.SettlementTerms),
    notes: n(r.Notes), created_at: date(r.CreatedDate) ?? new Date(), updated_at: date(r.UpdatedDate) ?? new Date(),
  })) },
  { sheet: 'Branches', table: 'branches', key: 'BranchID', idColumn: 'id', map: wrap((r) => ({
    id: s(r.BranchID), vendor_id: s(r.VendorID), name: s(r.Name), code: n(r.Code), address: n(r.Address), location: n(r.Location),
    contact_phone: n(r.ContactPhone), active: truthy(r.Active), display_order: int(r.DisplayOrder, 99), notes: n(r.Notes),
    created_at: date(r.CreatedDate) ?? new Date(), updated_at: date(r.UpdatedDate) ?? new Date(),
  })) },
  { sheet: 'Users', table: 'app_users', key: 'UserID', idColumn: 'id', map: wrap((r) => ({
    id: s(r.UserID), full_name: s(r.FullName), phone: phone(r.Phone), email: staffEmail(r.Email), role: n(r.Role)?.toUpperCase() ?? null,
    vendor_id: n(r.VendorID), branch_id: n(r.BranchID), status: s(r.Status).toUpperCase() || 'PENDING_APPROVAL', approved_by: n(r.ApprovedBy),
    approved_at: date(r.ApprovedDate), last_login_at: date(r.LastLogin), notes: n(r.Notes),
    created_at: date(r.CreatedDate) ?? new Date(), updated_at: date(r.UpdatedDate) ?? new Date(),
  })) },
  { sheet: 'Customers', table: 'customers', key: 'CustomerID', idColumn: 'id', map: wrap((r) => ({
    id: s(r.CustomerID), full_name: s(r.FullName), phone: phone(r.Phone), email: n(r.Email),
    status: s(r.Status).toUpperCase() === 'DISABLED' ? 'DISABLED' : 'ACTIVE', last_login_at: date(r.LastLogin), notes: n(r.Notes),
    created_at: date(r.CreatedDate) ?? new Date(), updated_at: date(r.UpdatedDate) ?? new Date(),
  })) },
  { sheet: 'Brands', table: 'brands', key: 'BrandID', idColumn: 'id', map: wrap((r) => ({
    id: s(r.BrandID), name: s(r.Name), slug: n(r.Slug), logo_url: n(r.LogoURL), active: truthy(r.Active), display_order: int(r.DisplayOrder, 99),
    created_at: date(r.CreatedDate) ?? new Date(), updated_at: date(r.UpdatedDate) ?? new Date(),
  })) },
  { sheet: 'Categories', table: 'categories', key: 'CategoryID', idColumn: 'id', map: wrap((r) => ({
    id: s(r.CategoryID), name: s(r.Name), slug: n(r.Slug), parent_category_id: n(r.ParentCategoryID), image_url: n(r.ImageURL),
    icon_url: n(r.IconURL), description: n(r.Description), active: truthy(r.Active), display_order: int(r.DisplayOrder, 99),
    created_at: date(r.CreatedDate) ?? new Date(), updated_at: date(r.UpdatedDate) ?? new Date(),
  })) },
  { sheet: 'Products', table: 'products', key: 'ProductID', idColumn: 'id', map: wrap((r) => ({
    id: s(r.ProductID), brand_id: s(r.BrandID), category_id: n(r.CategoryID), model: s(r.Model), model_code: n(r.ModelCode),
    device_type: n(r.DeviceType)?.toUpperCase() ?? null, release_year: s(r.ReleaseYear) ? int(r.ReleaseYear, 0) || null : null,
    main_image_url: n(r.MainImageURL), search_keywords: n(r.SearchKeywords), active: truthy(r.Active), display_order: int(r.DisplayOrder, 99),
    notes: n(r.Notes), created_at: date(r.CreatedDate) ?? new Date(), updated_at: date(r.UpdatedDate) ?? new Date(),
  })) },
  { sheet: 'Variants', table: 'product_variants', key: 'VariantID', idColumn: 'id', map: wrap((r) => ({
    id: s(r.VariantID), product_id: s(r.ProductID), storage: s(r.Storage), active: truthy(r.Active), display_order: int(r.DisplayOrder, 99),
    created_at: date(r.CreatedDate) ?? new Date(), updated_at: date(r.UpdatedDate) ?? new Date(),
  })) },
  { sheet: 'Colors', table: 'product_colors', key: 'ColorID', idColumn: 'id', map: wrap((r) => ({
    id: s(r.ColorID), product_id: s(r.ProductID), color: s(r.Color), image_url: n(r.ImageURL), active: truthy(r.Active),
    display_order: int(r.DisplayOrder, 99), created_at: date(r.CreatedDate) ?? new Date(), updated_at: date(r.UpdatedDate) ?? new Date(),
  })) },
  { sheet: 'GradeRules', table: 'grade_rules', key: 'GradeRuleID', idColumn: 'id', map: wrap((r) => ({
    id: s(r.GradeRuleID), grade_code: s(r.GradeCode).toUpperCase(), grade_name: s(r.GradeName), percentage_of_base: frac4(r.PercentageOfBase) ?? '0.0000',
    min_score: Number(r.MinScore) || 0, display_order: int(r.DisplayOrder, 99), is_terminal: truthy(r.IsTerminal), active: truthy(r.Active),
  })) },
  { sheet: 'InspectionRules', table: 'inspection_rules', key: 'RuleID', idColumn: 'id', map: wrap((r) => ({
    id: s(r.RuleID), code: s(r.Code).toUpperCase(), group_name: s(r.GroupName), question: s(r.Question), input_type: s(r.InputType).toUpperCase() || 'SWITCH',
    good_label: s(r.GoodLabel), bad_label: s(r.BadLabel), score_impact: Number(r.ScoreImpact) || 0, is_blocking: truthy(r.IsBlocking),
    display_order: int(r.DisplayOrder, 99), active: truthy(r.Active), notes: n(r.Notes),
  })) },
  { sheet: 'MasterPricing', table: 'master_prices', key: 'PriceID', idColumn: 'id', map: wrap((r) => ({
    id: s(r.PriceID), product_id: s(r.ProductID), variant_id: s(r.VariantID), base_price: moneyReq(r.BasePrice), currency: s(r.Currency) || 'QAR',
    effective_from: date(r.EffectiveFrom) ?? date(r.CreatedDate) ?? new Date(0), effective_to: date(r.EffectiveTo), active: truthy(r.Active),
    superseded_by: n(r.SupersededBy), created_by: n(r.CreatedBy), updated_by: n(r.UpdatedBy), notes: n(r.Notes),
  })) },
  { sheet: 'VendorPricing', table: 'vendor_prices', key: 'VendorPriceID', idColumn: 'id', map: wrap((r) => ({
    id: s(r.VendorPriceID), vendor_id: s(r.VendorID), product_id: s(r.ProductID), variant_id: s(r.VariantID), base_price: moneyReq(r.BasePrice),
    currency: s(r.Currency) || 'QAR', effective_from: date(r.EffectiveFrom) ?? date(r.CreatedDate) ?? new Date(0), effective_to: date(r.EffectiveTo),
    active: truthy(r.Active), superseded_by: n(r.SupersededBy), created_by: n(r.CreatedBy), updated_by: n(r.UpdatedBy), notes: n(r.Notes),
  })) },
  { sheet: 'CommissionRules', table: 'commission_rules', key: 'CommissionRuleID', idColumn: 'id', map: wrap((r) => ({
    id: s(r.CommissionRuleID), vendor_id: s(r.VendorID), brand_id: n(r.BrandID), category_id: n(r.CategoryID), product_id: n(r.ProductID),
    commission_type: s(r.CommissionType).toUpperCase() || 'PERCENTAGE', commission_value: rate(r.CommissionValue) ?? '0.000000',
    effective_from: date(r.EffectiveFrom) ?? date(r.CreatedDate) ?? new Date(0), effective_to: date(r.EffectiveTo), active: truthy(r.Active),
    superseded_by: n(r.SupersededBy), created_by: n(r.CreatedBy), notes: n(r.Notes),
  })) },
  { sheet: 'Settings', table: 'settings', key: 'Key', idColumn: 'key', map: wrap((r) => ({
    key: s(r.Key), value: s(r.Value), type: ['STRING', 'NUMBER', 'BOOLEAN', 'JSON'].includes(s(r.Type).toUpperCase()) ? s(r.Type).toUpperCase() : 'STRING',
    section: n(r.Section), description: n(r.Description), updated_by: n(r.UpdatedBy), updated_at: date(r.UpdatedDate) ?? new Date(),
  })) },

  /* ---- the transactional group: one transaction, deferred foreign keys ---- */
  { sheet: 'TradeIns', table: 'trade_ins', key: 'TradeInID', idColumn: 'id', transactional: true, map: wrap((r) => ({
    id: s(r.TradeInID), customer_id: s(r.CustomerID), vendor_id: s(r.VendorID), branch_id: s(r.BranchID), product_id: s(r.ProductID),
    variant_id: s(r.VariantID), color_id: n(r.ColorID), brand_snapshot: n(r.BrandSnapshot), category_snapshot: n(r.CategorySnapshot),
    model_snapshot: n(r.ModelSnapshot), storage_snapshot: n(r.StorageSnapshot), color_snapshot: n(r.ColorSnapshot), imei: digits15(r.IMEI),
    serial_number: n(r.SerialNumber), customer_name: n(r.CustomerName), customer_phone: n(r.CustomerPhone),
    condition_answers: json(r.ConditionAnswers, {}), estimated_score: n(r.EstimatedScore), estimated_grade: n(r.EstimatedGrade),
    estimated_value: money(r.EstimatedValue), base_price_snapshot: money(r.BasePriceSnapshot), price_effective_date: date(r.PriceEffectiveDate),
    pricing_source: n(r.PricingSource), pricing_rule_id: n(r.PricingRuleID), condition_score: n(r.ConditionScore), grade_code: n(r.GradeCode),
    grade_percentage_snapshot: frac4(r.GradePercentageSnapshot), calculated_grade_value: money(r.CalculatedGradeValue),
    grade_override_from: n(r.GradeOverrideFrom), grade_override_to: n(r.GradeOverrideTo), grade_override_reason: n(r.GradeOverrideReason),
    grade_override_by: n(r.GradeOverrideBy), grade_override_at: date(r.GradeOverrideDate), manual_adjustment: moneyReq(r.ManualAdjustment),
    manual_adjustment_reason: n(r.ManualAdjustmentReason), manual_adjustment_by: n(r.ManualAdjustmentBy), final_customer_value: money(r.FinalCustomerValue),
    price_variance: money(r.PriceVariance), price_variance_pct: n(r.PriceVariancePct), commission_rule_id: n(r.CommissionRuleID),
    commission_type_snapshot: n(r.CommissionTypeSnapshot), commission_rate_snapshot: rate(r.CommissionRateSnapshot),
    commission_value: money(r.CommissionValue), total_settlement: money(r.TotalSettlement), currency: s(r.Currency) || 'QAR',
    status: s(r.Status), device_received: truthy(r.DeviceReceived), device_received_by: n(r.DeviceReceivedBy), device_received_at: date(r.DeviceReceivedDate),
    device_returned_by: n(r.DeviceReturnedBy), device_returned_at: date(r.DeviceReturnedDate), return_reason: n(r.ReturnReason),
    collected_at: date(r.CollectedDate), collected_by: n(r.CollectedBy), inspection_id: n(r.InspectionID), voucher_id: n(r.VoucherID),
    collection_batch_id: n(r.CollectionBatchID), settlement_id: n(r.SettlementID), technician: n(r.Technician), accepted_at: date(r.AcceptedDate),
    declined_at: date(r.DeclinedDate), decline_reason: n(r.DeclineReason), legacy_drive_folder_id: n(r.DriveFolderID), notes: n(r.Notes),
    operation_id: n(r.OperationID), created_at: date(r.CreatedDate) ?? new Date(), updated_at: date(r.UpdatedDate) ?? new Date(),
  })) },
  { sheet: 'Inspections', table: 'inspections', key: 'InspectionID', idColumn: 'id', transactional: true, map: wrap((r) => ({
    id: s(r.InspectionID), trade_in_id: s(r.TradeInID), technician: n(r.Technician), started_at: date(r.StartedAt), completed_at: date(r.CompletedAt),
    scanned_imei: digits15(r.ScannedIMEI), imei_match: truthy(r.IMEIMatch), answers: json(r.Answers, {}),
    battery_health: s(r.BatteryHealth) === '' ? null : int(r.BatteryHealth, 0), activation_lock: truthy(r.ActivationLock),
    condition_score: n(r.ConditionScore), grade_code: n(r.GradeCode), blocked_reason: n(r.BlockedReason), rules_version: n(r.RulesVersion),
    technician_notes: n(r.TechnicianNotes), status: s(r.Status).toUpperCase() === 'COMPLETED' ? 'COMPLETED' : 'IN_PROGRESS',
    created_at: date(r.CreatedDate) ?? new Date(), updated_at: date(r.UpdatedDate) ?? new Date(),
  }), (r) => {
    // PhotoFileIDs + PhotoMeta → one inspection_photos row per Drive file. The object path points at
    // where the FILE migration will place it (legacy_file_map); until then the photo is not viewable.
    const ids = list(r.PhotoFileIDs);
    let meta: { fileId?: string; category?: string; label?: string; uploadedBy?: string; uploadedAt?: string }[] = [];
    try { meta = JSON.parse(s(r.PhotoMeta) || '[]'); } catch { meta = []; }
    return ids.map((fid) => {
      const m = meta.find((x) => x.fileId === fid) ?? {};
      const cat = s(m.category).toUpperCase();
      return { table: 'inspection_photos', row: {
        inspection_id: s(r.InspectionID), trade_in_id: s(r.TradeInID), object_path: `legacy/${s(r.TradeInID)}/${fid}`,
        category: ['FRONT', 'BACK', 'SCREEN', 'IMEI', 'DAMAGE', 'ACCESSORIES', 'OTHER'].includes(cat) ? cat : 'OTHER', label: n(m.label),
        mime_type: 'image/jpeg', size_bytes: 1, uploaded_by: n(m.uploadedBy), uploaded_at: m.uploadedAt ? new Date(m.uploadedAt) : new Date(),
        legacy_drive_file_id: fid,
      } };
    });
  }) },
  { sheet: 'Vouchers', table: 'vouchers', key: 'VoucherID', idColumn: 'id', transactional: true, map: wrap((r) => ({
    id: s(r.VoucherID), trade_in_id: s(r.TradeInID), customer_id: n(r.CustomerID), vendor_id: s(r.VendorID), branch_id: s(r.BranchID),
    voucher_number: s(r.VoucherNumber), customer_value: moneyReq(r.CustomerValue), commission_type_snapshot: n(r.CommissionTypeSnapshot),
    commission_rate_snapshot: rate(r.CommissionRateSnapshot), commission_value: moneyReq(r.CommissionValue), total_settlement: moneyReq(r.TotalSettlement),
    currency: s(r.Currency) || 'QAR', issued_by: n(r.IssuedBy), issued_at: date(r.IssuedDate) ?? new Date(), status: s(r.Status).toUpperCase() || 'ISSUED',
    voided_by: n(r.VoidedBy), voided_at: date(r.VoidedDate), void_reason: n(r.VoidReason), replaced_by_voucher_id: n(r.ReplacedByVoucherID),
    replaces_voucher_id: n(r.ReplacesVoucherID), notes: n(r.Notes), operation_id: n(r.OperationID),
  })) },
  { sheet: 'Collections', table: 'collections', key: 'BatchID', idColumn: 'id', transactional: true, map: wrap((r) => ({
    id: s(r.BatchID), vendor_id: s(r.VendorID), branch_id: n(r.BranchID), trade_in_ids: list(r.TradeInIDs), device_count: int(r.DeviceCount, 0),
    expected_device_count: int(r.ExpectedDeviceCount, int(r.DeviceCount, 0)), collected_device_count: int(r.CollectedDeviceCount, 0),
    missing_device_count: int(r.MissingDeviceCount, 0), exception_device_count: int(r.ExceptionDeviceCount, 0),
    customer_value_total: moneyReq(r.CustomerValueTotal), commission_total: moneyReq(r.CommissionTotal), settlement_total: moneyReq(r.SettlementTotal),
    expected_amount: moneyReq(r.ExpectedAmount || r.SettlementTotal), actual_amount: moneyReq(r.ActualAmount), currency: s(r.Currency) || 'QAR',
    status: s(r.CollectionStatus).toUpperCase() || 'READY_FOR_COLLECTION', created_by: n(r.CreatedBy), created_at: date(r.CreatedDate) ?? new Date(),
    collected_by: n(r.CollectedBy), collected_at: date(r.CollectedDate), closed_at: date(r.ClosedDate), cancelled_by: n(r.CancelledBy),
    cancelled_at: date(r.CancelledDate), cancel_reason: n(r.CancelReason), notes: n(r.Notes), operation_id: n(r.OperationID),
  })) },
  { sheet: 'CollectionItems', table: 'collection_items', key: 'ItemID', idColumn: 'id', transactional: true, map: wrap((r) => ({
    id: s(r.ItemID), batch_id: s(r.BatchID), trade_in_id: s(r.TradeInID), vendor_id: s(r.VendorID), branch_id: n(r.BranchID),
    device_snapshot: n(r.DeviceSnapshot), imei: n(r.IMEI), grade_code: n(r.GradeCode), customer_value: moneyReq(r.CustomerValue),
    commission_value: moneyReq(r.CommissionValue), settlement_value: moneyReq(r.SettlementValue), currency: s(r.Currency) || 'QAR',
    item_status: s(r.ItemStatus).toUpperCase() || 'PENDING', collected_by: n(r.CollectedBy), collected_at: date(r.CollectedDate),
    exception_reason: n(r.ExceptionReason), notes: n(r.Notes), created_at: date(r.CreatedDate) ?? new Date(), updated_at: date(r.UpdatedDate) ?? new Date(),
  })) },
  { sheet: 'Settlements', table: 'settlements', key: 'SettlementID', idColumn: 'id', transactional: true, map: wrap((r) => ({
    id: s(r.SettlementID), vendor_id: s(r.VendorID), period_from: date(r.PeriodFrom) ?? new Date(0), period_to: date(r.PeriodTo) ?? new Date(0),
    trade_in_count: int(r.TradeInCount, 0), customer_value_total: moneyReq(r.CustomerValueTotal), commission_total: moneyReq(r.CommissionTotal),
    settlement_total: moneyReq(r.SettlementTotal), currency: s(r.Currency) || 'QAR', status: s(r.Status).toUpperCase() || 'DRAFT',
    collection_batch_ids: list(r.CollectionBatchIDs), created_by: n(r.CreatedBy), created_at: date(r.CreatedDate) ?? new Date(),
    submitted_at: date(r.SubmittedDate), approved_by: n(r.ApprovedBy), approved_at: date(r.ApprovedDate), paid_at: date(r.PaidDate),
    payment_reference: n(r.PaymentReference), cancelled_by: n(r.CancelledBy), cancelled_at: date(r.CancelledDate), cancel_reason: n(r.CancelReason),
    notes: n(r.Notes), operation_id: n(r.OperationID), updated_at: date(r.UpdatedDate) ?? new Date(),
  })) },

  /* ---- after the transactions ---- */
  { sheet: 'Notifications', table: 'notifications', key: 'NotificationID', idColumn: 'id', map: wrap((r) => ({
    id: s(r.NotificationID), audience_type: s(r.AudienceType).toUpperCase(), audience_id: n(r.AudienceID), branch_id: n(r.BranchID),
    kind: s(r.Kind) || 'INFO', title: s(r.Title) || '(no title)', message: s(r.Message) || '', entity_type: n(r.EntityType), entity_id: n(r.EntityID),
    created_by: s(r.CreatedBy) || 'system', created_at: date(r.CreatedDate) ?? new Date(),
  }), (r) => list(r.ReadBy).map((pid) => ({ table: 'notification_reads', row: { notification_id: s(r.NotificationID), principal_id: pid } }))) },
  { sheet: 'AuditLog', table: 'audit_logs', key: 'LogID', idColumn: 'legacy_log_id', map: wrap((r) => {
    const j = (v: unknown) => { const x = s(v); if (!x) return null; try { return JSON.stringify(JSON.parse(x)); } catch { return JSON.stringify(x); } };
    return {
      legacy_log_id: s(r.LogID), occurred_at: date(r.Timestamp) ?? new Date(0), actor_id: n(r.ActorID), actor_name: n(r.ActorName),
      actor_role: n(r.ActorRole), vendor_id: n(r.VendorID), action: s(r.Action) || 'UNKNOWN', object_type: n(r.ObjectType), object_id: n(r.ObjectID),
      old_value: j(r.OldValue), new_value: j(r.NewValue), details: j(r.Details), ip_address: n(r.IPAddress),
    };
  }) },
];

export const EXCLUDED_SHEETS = ['Sessions', 'OtpCodes', 'Idempotency'];

/** Counter scopes and widths, to continue the legacy sequences after import. */
export const COUNTER_SOURCES: { scope: string; table: string; prefix: string; column?: string }[] = [
  { scope: 'USR', table: 'app_users', prefix: 'USR-' }, { scope: 'CUS', table: 'customers', prefix: 'CUS-' },
  { scope: 'VND', table: 'vendors', prefix: 'VND-' }, { scope: 'BR', table: 'branches', prefix: 'BR-' },
  { scope: 'CMR', table: 'commission_rules', prefix: 'CMR-' }, { scope: 'BRD', table: 'brands', prefix: 'BRD-' },
  { scope: 'CAT', table: 'categories', prefix: 'CAT-' }, { scope: 'PRD', table: 'products', prefix: 'PRD-' },
  { scope: 'VAR', table: 'product_variants', prefix: 'VAR-' }, { scope: 'CLR', table: 'product_colors', prefix: 'CLR-' },
  { scope: 'GRD', table: 'grade_rules', prefix: 'GRD-' }, { scope: 'IRL', table: 'inspection_rules', prefix: 'IRL-' },
  { scope: 'MPR', table: 'master_prices', prefix: 'MPR-' }, { scope: 'VPR', table: 'vendor_prices', prefix: 'VPR-' },
  { scope: 'INS', table: 'inspections', prefix: 'INS-' }, { scope: 'VCH', table: 'vouchers', prefix: 'VCH-' },
  { scope: 'BAT', table: 'collections', prefix: 'BAT-' }, { scope: 'CLI', table: 'collection_items', prefix: 'CLI-' },
  { scope: 'STL', table: 'settlements', prefix: 'STL-' }, { scope: 'NTF', table: 'notifications', prefix: 'NTF-' },
];
