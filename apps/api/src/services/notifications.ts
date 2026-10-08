/**
 * Reading notifications (26_Notifications.gs). Scope comes from the
 * principal; there is no audience parameter a caller could widen. Read
 * state is per principal (one row per reader), so one person reading a
 * partner-wide notification does not clear it for colleagues.
 */
import { truthy } from '../../../../packages/shared/src/text.js';
import { fmtDateTime } from '../../../../packages/shared/src/time.js';
import type { Ctx } from '../context.js';
import { visibleNotificationsWhere } from '../lib/notify.js';
import { clampLimit } from './sql.js';

interface Row { id: string; kind: string; title: string; message: string; entity_type: string | null; entity_id: string | null; created_at: Date; read: boolean }

export async function listNotifications(ctx: Ctx, f: { unreadOnly?: unknown; limit?: number }) {
  const w = visibleNotificationsWhere(ctx.p, 2);
  const rows = (await ctx.db.query<Row>(
    `select n.id, n.kind, n.title, n.message, n.entity_type, n.entity_id, n.created_at,
            exists (select 1 from public.notification_reads r where r.notification_id = n.id and r.principal_id = $1) as read
       from public.notifications n where ${w.sql} order by n.created_at desc, n.id desc limit 2000`,
    [ctx.p.principalId, ...w.params])).rows;
  const unread = rows.filter((r) => !r.read);
  const shown = truthy(f.unreadOnly) ? unread : rows;
  return {
    ok: true, total: rows.length, unread: unread.length,
    notifications: shown.slice(0, clampLimit(f.limit, 50, 200)).map((n) => ({
      notificationId: n.id, kind: n.kind, title: n.title, message: n.message, entityType: n.entity_type ?? '',
      entityId: n.entity_id ?? '', read: n.read, date: fmtDateTime(n.created_at),
    })),
  };
}

/** A notification the caller cannot see is silently "nothing to mark" — ids cannot be probed. */
export async function markRead(ctx: Ctx, p: { notificationId: string }) {
  const w = visibleNotificationsWhere(ctx.p, 3);
  const r = await ctx.db.query(
    `insert into public.notification_reads (notification_id, principal_id)
     select n.id, $2 from public.notifications n where n.id = $1 and ${w.sql}
     on conflict do nothing`, [p.notificationId, ctx.p.principalId, ...w.params]);
  if (r.rowCount) return { ok: true, message: 'Marked as read.' };
  const exists = await ctx.db.query(`select 1 from public.notifications n where n.id = $1 and ${visibleNotificationsWhere(ctx.p, 2).sql}`,
    [p.notificationId, ...visibleNotificationsWhere(ctx.p, 2).params]);
  return { ok: true, message: exists.rowCount ? 'Already read.' : 'Nothing to mark.' };
}

export async function markAllRead(ctx: Ctx) {
  const w = visibleNotificationsWhere(ctx.p, 2);
  const r = await ctx.db.query(
    `insert into public.notification_reads (notification_id, principal_id)
     select n.id, $1 from public.notifications n where ${w.sql}
     on conflict do nothing`, [ctx.p.principalId, ...w.params]);
  return { ok: true, message: `${r.rowCount} notification(s) marked as read.`, marked: r.rowCount };
}
