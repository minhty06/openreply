/**
 * Data retention.
 *
 * Nothing here trims the database for storage's sake — the whole dataset is
 * ~16 MB. It exists because `WebhookEvent` is 89% of that and grows by ~400 rows
 * a day, and on a 1 GB single-box deployment the useful thing is to keep the
 * working set small enough that Postgres stays comfortable in its cache.
 *
 * The windows differ per table because what they cost to lose differs:
 *   - WebhookEvent is raw diagnostic exhaust. Once a comment has been processed
 *     the payload has no further use.
 *   - LinkClick and OperationalEvent back the dashboard's recent-activity views.
 *   - DmLog is kept far longer than either, for two reasons that have nothing to
 *     do with disk: it is the idempotency ledger (see DM_LOG_MIN_DAYS), and the
 *     shared campaign report pages compute lifetime totals from it with no date
 *     filter (lib/reports/data.ts).
 */

import { prisma } from "@/lib/db/client";

// A type alias rather than an interface on purpose: TypeScript only gives
// implicit index signatures to type aliases, and this is written straight into
// an OperationalEvent's Json `payload` by the purge cron.
export type RetentionDays = {
  webhookEvent: number;
  linkClick: number;
  operationalEvent: number;
  dmLog: number;
};

export const DEFAULT_RETENTION_DAYS: RetentionDays = {
  webhookEvent: 7,
  linkClick: 30,
  operationalEvent: 30,
  dmLog: 90,
};

/**
 * Hard floor for DmLog, regardless of configuration.
 *
 * DmLog is what tells the polling reconciler a comment has already been handled.
 * The reconciler looks back COMMENT_POLL_LOOKBACK_HOURS (default 72) — so
 * deleting a DmLog row younger than that window makes the next sweep treat the
 * comment as new and DM the person a second time. Four days keeps a margin over
 * the default lookback; raise this if you raise the lookback past ~96 hours.
 */
export const DM_LOG_MIN_DAYS = 4;

function readDays(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.warn(
      `[Retention] Ignoring ${name}="${raw}" (must be a positive integer), using ${fallback}`
    );
    return fallback;
  }
  return parsed;
}

/** The retention windows actually in effect, after env overrides and clamping. */
export function resolveRetentionDays(): RetentionDays {
  const dmLog = readDays("RETENTION_DM_LOG_DAYS", DEFAULT_RETENTION_DAYS.dmLog);

  if (dmLog < DM_LOG_MIN_DAYS) {
    console.warn(
      `[Retention] RETENTION_DM_LOG_DAYS=${dmLog} is below the ${DM_LOG_MIN_DAYS}-day floor ` +
        `that keeps the comment reconciler from re-sending DMs; using ${DM_LOG_MIN_DAYS}`
    );
  }

  return {
    webhookEvent: readDays(
      "RETENTION_WEBHOOK_EVENT_DAYS",
      DEFAULT_RETENTION_DAYS.webhookEvent
    ),
    linkClick: readDays(
      "RETENTION_LINK_CLICK_DAYS",
      DEFAULT_RETENTION_DAYS.linkClick
    ),
    operationalEvent: readDays(
      "RETENTION_OPERATIONAL_EVENT_DAYS",
      DEFAULT_RETENTION_DAYS.operationalEvent
    ),
    dmLog: Math.max(dmLog, DM_LOG_MIN_DAYS),
  };
}

export type PurgeCounts = Record<keyof RetentionDays, number>;

export interface PurgeResult {
  counts: PurgeCounts;
  retentionDays: RetentionDays;
  totalDeleted: number;
}

function cutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * Delete records past their retention window.
 *
 * Deletes oldest-cost-first and independently per table: one table's failure
 * does not roll back another's, because these are unrelated cleanups and a
 * partial pass is strictly better than none. The first run after enabling this
 * is by far the largest (~5,500 WebhookEvent rows); autovacuum reclaims the
 * space afterwards.
 */
export async function purgeExpiredRecords(
  now: Date = new Date()
): Promise<PurgeResult> {
  const retentionDays = resolveRetentionDays();

  const [webhookEvent, linkClick, operationalEvent, dmLog] = await Promise.all([
    prisma.webhookEvent.deleteMany({
      where: { createdAt: { lt: cutoff(now, retentionDays.webhookEvent) } },
    }),
    prisma.linkClick.deleteMany({
      where: { createdAt: { lt: cutoff(now, retentionDays.linkClick) } },
    }),
    prisma.operationalEvent.deleteMany({
      where: { createdAt: { lt: cutoff(now, retentionDays.operationalEvent) } },
    }),
    prisma.dmLog.deleteMany({
      where: { createdAt: { lt: cutoff(now, retentionDays.dmLog) } },
    }),
  ]);

  const counts: PurgeCounts = {
    webhookEvent: webhookEvent.count,
    linkClick: linkClick.count,
    operationalEvent: operationalEvent.count,
    dmLog: dmLog.count,
  };

  return {
    counts,
    retentionDays,
    totalDeleted: Object.values(counts).reduce((sum, n) => sum + n, 0),
  };
}
