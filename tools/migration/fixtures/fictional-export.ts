/**
 * A FICTIONAL Google Sheets export in exactly the shape 3.1's
 * migrationExportSheet_ returns ({ sheet, columns, total, offset, rows }).
 * Used by the tests and by `npm run make:fictional-export` for dry runs of
 * the migration tooling. Contains no real person, phone, device or partner.
 * `dirty` adds rows the importer must reject (duplicate phone, bad phone).
 */
import { randomInt } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

function luhnImei(prefix = '99'): string {
  let body = prefix;
  while (body.length < 14) body += String(randomInt(0, 10));
  let sum = 0;
  for (let i = 0; i < 14; i++) { let d = Number(body[i]); if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; } sum += d; }
  return body + String((10 - (sum % 10)) % 10);
}

const T0 = '2026-09-01T09:00:00.000Z';

export function writeFictionalExport(dir: string, opts: { dirty?: boolean; extraCustomers?: number } = {}): void {
  const IMEI_A = luhnImei(); const IMEI_B = luhnImei();
  const put = (sheet: string, rows: Record<string, unknown>[]) => writeFileSync(join(dir, `${sheet}.json`), JSON.stringify({ sheet, columns: Object.keys(rows[0] ?? {}), total: rows.length, offset: 0, rows }));
  put('Vendors', [{ VendorID: 'VND-050', Name: 'Fixture Partner', Code: 'FIX', LogoURL: '', DefaultCommissionRate: 0.05, Status: 'ACTIVE', CreatedDate: T0 }]);
  put('Branches', [{ BranchID: 'BR-0050', VendorID: 'VND-050', Name: 'Fixture Branch', Active: true, DisplayOrder: 1, CreatedDate: T0 }]);
  put('Users', [
    { UserID: 'USR-00050', FullName: 'Fixture Partner Admin', Phone: '55000500', Role: 'VENDOR_ADMIN', VendorID: 'VND-050', BranchID: '', Status: 'ACTIVE', CreatedDate: T0 },
    { UserID: 'USR-00051', FullName: 'Fixture Applicant', Phone: '+974 5500 0501', Role: '', VendorID: '', BranchID: '', Status: 'PENDING_APPROVAL', CreatedDate: T0 },
  ]);
  const customers = [{ CustomerID: 'CUS-00060', FullName: 'Fixture Customer', Phone: '55000600', Status: 'ACTIVE', CreatedDate: T0 }];
  if (opts.dirty) {
    customers.push({ CustomerID: 'CUS-00061', FullName: 'Same Phone', Phone: '0097455000600', Status: 'ACTIVE', CreatedDate: T0 });
    customers.push({ CustomerID: 'CUS-00062', FullName: 'Bad Phone', Phone: '12', Status: 'ACTIVE', CreatedDate: T0 });
  }
  // Volume for interruption/resume rehearsals: fictional names, fictional sequential numbers.
  for (let i = 0; i < (opts.extraCustomers ?? 0); i++) {
    customers.push({ CustomerID: `CUS-${String(10000 + i)}`, FullName: `Volume Customer ${i}`, Phone: `7${String(1000000 + i).padStart(7, '0')}`, Status: 'ACTIVE', CreatedDate: T0 });
  }
  put('Customers', customers);
  put('Brands', [{ BrandID: 'BRD-050', Name: 'Fixture Brand', Active: 'TRUE', DisplayOrder: 1 }]);
  put('Categories', [{ CategoryID: 'CAT-050', Name: 'Fixture Phones', Active: true }]);
  put('Products', [{ ProductID: 'PRD-00050', BrandID: 'BRD-050', CategoryID: 'CAT-050', Model: 'Fixture One', Active: true }]);
  put('Variants', [{ VariantID: 'VAR-000050', ProductID: 'PRD-00050', Storage: '128GB', Active: true }]);
  put('Colors', [{ ColorID: 'CLR-000050', ProductID: 'PRD-00050', Color: 'Black', Active: true }]);
  put('MasterPricing', [{ PriceID: 'MPR-000050', ProductID: 'PRD-00050', VariantID: 'VAR-000050', BasePrice: 1000, Currency: 'QAR', EffectiveFrom: '2026-01-01T00:00:00.000Z', EffectiveTo: '', Active: true }]);
  put('CommissionRules', [{ CommissionRuleID: 'CMR-00050', VendorID: 'VND-050', CommissionType: 'PERCENTAGE', CommissionValue: 0.05, EffectiveFrom: '2026-01-01T00:00:00.000Z', Active: true }]);
  const closed = {
    TradeInID: 'TI-FIX-000007', CustomerID: 'CUS-00060', VendorID: 'VND-050', BranchID: 'BR-0050', ProductID: 'PRD-00050', VariantID: 'VAR-000050', ColorID: 'CLR-000050',
    BrandSnapshot: 'Fixture Brand', ModelSnapshot: 'Fixture One', StorageSnapshot: '128GB', IMEI: IMEI_A, CustomerName: 'Fixture Customer', CustomerPhone: '+97455000600',
    ConditionAnswers: '{"POWER":"ON"}', EstimatedValue: 1000, EstimatedGrade: 'A', GradeCode: 'B', CalculatedGradeValue: 700, ManualAdjustment: 0, FinalCustomerValue: 700,
    PriceVariance: -300, PriceVariancePct: -30, CommissionTypeSnapshot: 'PERCENTAGE', CommissionRateSnapshot: 0.05, CommissionValue: 35, TotalSettlement: 735,
    Currency: 'QAR', Status: 'CLOSED', DeviceReceived: true, DeviceReceivedDate: T0, CollectedDate: '2026-09-02T09:00:00.000Z', InspectionID: 'INS-000050',
    VoucherID: 'VCH-000050', CollectionBatchID: 'BAT-00050', SettlementID: 'STL-00050', CreatedDate: T0, UpdatedDate: T0,
  };
  const pending = { ...closed, TradeInID: 'TI-FIX-000008', IMEI: IMEI_B, Status: 'PENDING_TECHNICIAN', GradeCode: '', CalculatedGradeValue: '', FinalCustomerValue: '', PriceVariance: '', PriceVariancePct: '',
    CommissionTypeSnapshot: '', CommissionRateSnapshot: '', CommissionValue: '', TotalSettlement: '', DeviceReceived: false, DeviceReceivedDate: '', CollectedDate: '',
    InspectionID: '', VoucherID: '', CollectionBatchID: '', SettlementID: '' };
  put('TradeIns', [closed, pending]);
  put('Inspections', [{ InspectionID: 'INS-000050', TradeInID: 'TI-FIX-000007', Technician: 'Fixture Tech', StartedAt: T0, CompletedAt: T0, ScannedIMEI: IMEI_A, IMEIMatch: true,
    Answers: '{"SCREEN_CRACK":true}', BatteryHealth: 90, ConditionScore: 85, GradeCode: 'B', PhotoFileIDs: 'drivefile0001', PhotoMeta: '[{"fileId":"drivefile0001","category":"FRONT","uploadedBy":"Fixture Tech"}]', Status: 'COMPLETED' }]);
  put('Vouchers', [{ VoucherID: 'VCH-000050', TradeInID: 'TI-FIX-000007', CustomerID: 'CUS-00060', VendorID: 'VND-050', BranchID: 'BR-0050', VoucherNumber: 'FIX-20260901-0001',
    CustomerValue: 700, CommissionValue: 35, TotalSettlement: 735, IssuedDate: T0, Status: 'ISSUED' }]);
  put('Collections', [{ BatchID: 'BAT-00050', VendorID: 'VND-050', BranchID: 'BR-0050', TradeInIDs: 'TI-FIX-000007', DeviceCount: 1, ExpectedDeviceCount: 1, CollectedDeviceCount: 1,
    CustomerValueTotal: 700, CommissionTotal: 35, SettlementTotal: 735, ExpectedAmount: 735, ActualAmount: 735, CollectionStatus: 'CLOSED', CreatedDate: T0, CollectedDate: '2026-09-02T09:00:00.000Z' }]);
  put('CollectionItems', [{ ItemID: 'CLI-0000050', BatchID: 'BAT-00050', TradeInID: 'TI-FIX-000007', VendorID: 'VND-050', BranchID: 'BR-0050', CustomerValue: 700, CommissionValue: 35,
    SettlementValue: 735, ItemStatus: 'COLLECTED', CollectedDate: '2026-09-02T09:00:00.000Z' }]);
  put('Settlements', [{ SettlementID: 'STL-00050', VendorID: 'VND-050', PeriodFrom: '2026-08-31T21:00:00.000Z', PeriodTo: '2026-09-30T20:59:59.999Z', TradeInCount: 1,
    CustomerValueTotal: 700, CommissionTotal: 35, SettlementTotal: 735, Status: 'PAID', CreatedDate: T0, ApprovedBy: 'USR-00001', ApprovedDate: T0, PaidDate: T0, PaymentReference: 'FIX-PAY-1' }]);
  put('Notifications', [{ NotificationID: 'NTF-0000050', AudienceType: 'VENDOR', AudienceID: 'VND-050', Kind: 'TRADEIN_NEW', Title: 'New', Message: 'x', EntityType: 'TRADEIN',
    EntityID: 'TI-FIX-000008', ReadBy: 'USR-00050', CreatedDate: T0, BranchID: '' }]);
  put('AuditLog', [{ LogID: 'LOG-00000050', Timestamp: T0, ActorID: 'USR-00050', ActorName: 'Fixture Partner Admin', ActorRole: 'VENDOR_ADMIN', VendorID: 'VND-050', Action: 'VOUCHER_ISSUED', ObjectType: 'VOUCHER', ObjectID: 'VCH-000050', OldValue: '', NewValue: '700', Details: '{"voucherNumber":"FIX-20260901-0001"}' }]);
  writeFileSync(join(dir, 'Sessions.json'), JSON.stringify({ sheet: 'Sessions', rows: [{ SessionID: 'SES-1', TokenHash: 'x' }] }));
}
