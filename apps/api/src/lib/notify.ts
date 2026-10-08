/**
 * In-app notifications (26_Notifications.gs). Written in the request
 * transaction, so a notification exists exactly when the event it
 * describes committed.
 */
import type { Queryable } from '../../../../packages/database/src/db.js';
import type { Principal } from '../../../../packages/auth/src/index.js';
import { isPlatformAdmin } from '../../../../packages/auth/src/authz.js';
import { CURRENCY, NOTIFY } from '../../../../packages/domain/src/constants.js';
import { formatMoney, type Cents } from '../../../../packages/shared/src/money.js';
import { nextId } from './ids.js';

export type Audience = 'USER' | 'CUSTOMER' | 'VENDOR' | 'PLATFORM';

export interface NotificationInput {
  audienceType: Audience;
  audienceId?: string;
  branchId?: string;
  kind: string;
  title: string;
  message: string;
  entityType?: string;
  entityId?: string;
  createdBy?: string;
}

export async function notify(db: Queryable, n: NotificationInput): Promise<void> {
  const id = await nextId(db, 'NTF');
  await db.query(
    `insert into public.notifications (id, audience_type, audience_id, branch_id, kind, title, message, entity_type, entity_id, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, n.audienceType, n.audienceType === 'PLATFORM' ? null : (n.audienceId || null), n.branchId || null,
      n.kind, n.title, n.message, n.entityType || null, n.entityId || null, n.createdBy || 'system'],
  );
}

const money = (c: Cents) => `${formatMoney(c)} ${CURRENCY}`;

async function vendorName(db: Queryable, vendorId: string): Promise<string> {
  const r = await db.query<{ name: string }>('select name from public.vendors where id = $1', [vendorId]);
  return r.rows[0]?.name ?? vendorId;
}
async function branchName(db: Queryable, branchId: string): Promise<string> {
  const r = await db.query<{ name: string }>('select name from public.branches where id = $1', [branchId]);
  return r.rows[0]?.name ?? 'the branch';
}

export const emit = {
  async tradeInCreated(db: Queryable, tradeInId: string, vendorId: string, device: string, estimate: Cents, branchId: string) {
    await notify(db, { audienceType: 'VENDOR', audienceId: vendorId, branchId, kind: NOTIFY.TRADEIN_NEW,
      title: 'New trade-in request', message: `${device} — ${money(estimate)} estimated. The customer is bringing it in.`,
      entityType: 'TRADEIN', entityId: tradeInId });
    await notify(db, { audienceType: 'PLATFORM', kind: NOTIFY.TRADEIN_NEW, title: `New trade-in ${tradeInId}`,
      message: `${device} at ${await vendorName(db, vendorId)}.`, entityType: 'TRADEIN', entityId: tradeInId });
  },
  async inspectionDone(db: Queryable, tradeInId: string, customerId: string, vendorId: string, branchId: string, gradeCode: string) {
    await notify(db, { audienceType: 'CUSTOMER', audienceId: customerId, kind: NOTIFY.INSPECTION_DONE,
      title: 'Your device has been inspected', message: 'We are preparing your final trade-in value now.',
      entityType: 'TRADEIN', entityId: tradeInId });
    await notify(db, { audienceType: 'VENDOR', audienceId: vendorId, branchId, kind: NOTIFY.INSPECTION_DONE,
      title: 'Inspection completed', message: `${tradeInId} graded ${gradeCode}.`, entityType: 'TRADEIN', entityId: tradeInId });
  },
  async offerReady(db: Queryable, tradeInId: string, customerId: string, value: Cents) {
    await notify(db, { audienceType: 'CUSTOMER', audienceId: customerId, kind: NOTIFY.OFFER_READY,
      title: 'Your final offer is ready', message: `${money(value)} for your device. Accept or decline to continue.`,
      entityType: 'TRADEIN', entityId: tradeInId });
  },
  async voucherDue(db: Queryable, tradeInId: string, vendorId: string, branchId: string, value: Cents) {
    await notify(db, { audienceType: 'VENDOR', audienceId: vendorId, branchId, kind: NOTIFY.VOUCHER_READY,
      title: 'A voucher is waiting to be issued',
      message: `${tradeInId} — ${money(value)} at ${await branchName(db, branchId)}.`, entityType: 'TRADEIN', entityId: tradeInId });
  },
  async voucherIssued(db: Queryable, tradeInId: string, customerId: string, number: string, value: Cents) {
    await notify(db, { audienceType: 'CUSTOMER', audienceId: customerId, kind: NOTIFY.VOUCHER_READY,
      title: 'Your trade-in voucher is ready', message: `Voucher ${number} for ${money(value)}.`,
      entityType: 'TRADEIN', entityId: tradeInId });
  },
  async collectionReady(db: Queryable, batchId: string, vendorId: string, count: number, amount: Cents, branchId: string) {
    await notify(db, { audienceType: 'VENDOR', audienceId: vendorId, branchId, kind: NOTIFY.COLLECTION_READY,
      title: `Collection note ${batchId}`, message: `${count} device(s) are listed for collection.`,
      entityType: 'COLLECTION', entityId: batchId });
    await notify(db, { audienceType: 'PLATFORM', kind: NOTIFY.COLLECTION_READY, title: `Collection note ${batchId} raised`,
      message: `${count} device(s), ${money(amount)}.`, entityType: 'COLLECTION', entityId: batchId });
  },
  async collectionException(db: Queryable, batchId: string, unresolved: string[]) {
    await notify(db, { audienceType: 'PLATFORM', kind: NOTIFY.COLLECTION_EXCEPTION,
      title: `Devices unaccounted for on ${batchId}`,
      message: `${unresolved.length} device(s) were not collected: ${unresolved.slice(0, 5).join(', ')}.`,
      entityType: 'COLLECTION', entityId: batchId });
  },
  async settlementCreated(db: Queryable, settlementId: string, vendorId: string, count: number, total: Cents) {
    await notify(db, { audienceType: 'VENDOR', audienceId: vendorId, kind: NOTIFY.SETTLEMENT_CREATED,
      title: `Settlement ${settlementId}`,
      message: `${count} device(s), ${money(total)}. It is in draft until Qatar Mobile approves it.`,
      entityType: 'SETTLEMENT', entityId: settlementId });
  },
  async settlementPaid(db: Queryable, settlementId: string, vendorId: string, total: Cents) {
    await notify(db, { audienceType: 'VENDOR', audienceId: vendorId, kind: NOTIFY.SETTLEMENT_PAID,
      title: `Settlement ${settlementId} paid`, message: `${money(total)} has been paid.`,
      entityType: 'SETTLEMENT', entityId: settlementId });
  },
  async staffPending(db: Queryable, userId: string, name: string, vendorId: string) {
    await notify(db, { audienceType: vendorId ? 'VENDOR' : 'PLATFORM', audienceId: vendorId || '', kind: NOTIFY.STAFF_PENDING,
      title: 'Access request waiting',
      message: `${name} has asked for an account and cannot sign in until somebody gives them a role.`,
      entityType: 'USER', entityId: userId });
  },
};

/**
 * visibleNotifications_ as one SQL predicate over `n` (public.notifications).
 * Returns [sql, params] with params starting at $start.
 */
export function visibleNotificationsWhere(p: Principal, start = 1): { sql: string; params: unknown[] } {
  const $ = (i: number) => `$${start + i}`;
  if (p.principalType === 'CUSTOMER') {
    return { sql: `(n.audience_type = 'CUSTOMER' and n.audience_id = ${$(0)})`, params: [p.principalId] };
  }
  const technicianOnly = p.isPlatform && !isPlatformAdmin(p);
  const platformMaySee = technicianOnly ? `n.entity_type = 'TRADEIN'` : 'true';
  if (p.isPlatform) {
    return {
      sql: `((n.audience_type = 'USER' and n.audience_id = ${$(0)})
             or (n.audience_type in ('PLATFORM','VENDOR') and ${platformMaySee}))`,
      params: [p.principalId],
    };
  }
  if (!p.branchId) {
    return {
      sql: `((n.audience_type = 'USER' and n.audience_id = ${$(0)})
             or (n.audience_type = 'VENDOR' and n.audience_id = ${$(1)}))`,
      params: [p.principalId, p.vendorId],
    };
  }
  // Branch-bound: rows for their branch; legacy rows with no branch only when about one of their trade-ins.
  return {
    sql: `((n.audience_type = 'USER' and n.audience_id = ${$(0)})
           or (n.audience_type = 'VENDOR' and n.audience_id = ${$(1)} and (
                 n.branch_id = ${$(2)}
                 or (n.branch_id is null and n.entity_type = 'TRADEIN' and exists (
                       select 1 from public.trade_ins t where t.id = n.entity_id and t.branch_id = ${$(2)})))))`,
    params: [p.principalId, p.vendorId, p.branchId],
  };
}
