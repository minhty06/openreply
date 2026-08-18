import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { purgeExpiredRecords } from "@/lib/ops/retention";

/**
 * Deletes records past their retention window (see lib/ops/retention.ts).
 *
 * Scheduled on the worker host rather than a Vercel cron, so it can run daily
 * without the free plan's once-a-day-per-cron ceiling mattering.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET || process.env.NEXTAUTH_SECRET;

  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const result = await purgeExpiredRecords();

  // Only log when something was actually deleted — a daily "deleted 0 rows" row
  // would itself become the noise this job exists to remove. Same convention as
  // the comment sweep in lib/polling/comment-reconciler.ts.
  if (result.totalDeleted > 0) {
    await prisma.operationalEvent
      .create({
        data: {
          source: "SYSTEM",
          level: "INFO",
          message: `Retention purge: ${result.totalDeleted} rows deleted`,
          payload: {
            counts: result.counts,
            retentionDays: result.retentionDays,
          },
        },
      })
      .catch(() => {});
  }

  return NextResponse.json({ success: true, data: result });
}
