/**
 * The site header's bell icon. Polled from the client, not pushed — see the
 * new-features plan's "notifications = polling, not SSE" decision, since no
 * realtime push infrastructure exists anywhere in this app. Every write here
 * is called from the exact point the underlying state change already happens
 * (payment confirmed, order expired, etc.), never from a separate pass that
 * re-derives "what should the customer have been told."
 */

import { and, count, desc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import type { Database } from '../index.js';
import { notifications, type notificationType } from '../schema.js';

export type NotificationType = (typeof notificationType.enumValues)[number];

export interface NotificationRow {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  targetUrl: string | null;
  orderId: string | null;
  readAt: Date | null;
  createdAt: Date;
}

export interface CreateNotificationInput {
  playerProfileId: string;
  type: NotificationType;
  title: string;
  message: string;
  targetUrl?: string | null;
  orderId?: string | null;
}

export async function createNotification(db: Database, input: CreateNotificationInput): Promise<void> {
  await db.insert(notifications).values({
    playerProfileId: input.playerProfileId,
    type: input.type,
    title: input.title,
    message: input.message,
    targetUrl: input.targetUrl ?? null,
    orderId: input.orderId ?? null,
  });
}

/** What the bell polls for: unread count plus the most recent notifications, newest first. */
export async function listMyNotifications(
  db: Database,
  playerProfileId: string,
  limit = 20,
): Promise<{ unreadCount: number; items: NotificationRow[] }> {
  const [unread, items] = await Promise.all([
    db
      .select({ n: count() })
      .from(notifications)
      .where(and(eq(notifications.playerProfileId, playerProfileId), isNull(notifications.readAt))),
    db
      .select({
        id: notifications.id,
        type: notifications.type,
        title: notifications.title,
        message: notifications.message,
        targetUrl: notifications.targetUrl,
        orderId: notifications.orderId,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(eq(notifications.playerProfileId, playerProfileId))
      .orderBy(desc(notifications.createdAt))
      .limit(limit),
  ]);

  return { unreadCount: unread[0]?.n ?? 0, items };
}

/**
 * Marks either specific ids or everything unread as read. Always scoped to
 * the owning profile — a notification id alone is never authorization.
 */
export async function markNotificationsRead(
  db: Database,
  playerProfileId: string,
  ids: string[] | 'all',
): Promise<void> {
  if (ids !== 'all' && ids.length === 0) return;

  const conditions: SQL[] = [eq(notifications.playerProfileId, playerProfileId), isNull(notifications.readAt)];
  if (ids !== 'all') conditions.push(inArray(notifications.id, ids));

  await db.update(notifications).set({ readAt: new Date() }).where(and(...conditions));
}
