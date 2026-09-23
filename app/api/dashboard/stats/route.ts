import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserId, getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import {
  calculateCtr,
  normalizeTopKeywords,
  summarizeDmStatuses,
} from "@/lib/tracking/analytics";

export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const userId = await getCurrentUserId();

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - 7);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const requestedInstagramAccountId =
    request.nextUrl.searchParams.get("instagramAccountId");
  const selectedAccountId =
    requestedInstagramAccountId && requestedInstagramAccountId !== "all"
      ? requestedInstagramAccountId
      : null;
  const accountFilter = selectedAccountId
    ? { instagramAccountId: selectedAccountId }
    : {};
  // FollowGateAttempt has no instagramAccountId of its own — it reaches the
  // account through the campaign that asked.
  const gateAccountFilter = selectedAccountId
    ? { automation: { instagramAccountId: selectedAccountId } }
    : {};

  const [
    workspace,
    instagramAccount,
    instagramAccounts,
    totalAutomations,
    activeAutomations,
    dmsSentToday,
    dmsSentWeek,
    dmsSentMonth,
    totalDMs,
    dmStatusCountsThisMonth,
    clicksThisMonth,
    totalClicks,
    topKeywordRows,
    followersGainedRows,
    followersGainedMonthRows,
    gatedAutomations,
    recentLogs,
    user,
    contactRows,
  ] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        name: true,
        dmsSentThisPeriod: true,
      },
    }),
    prisma.instagramAccount.findFirst({
      where: { workspaceId },
      orderBy: { connectedAt: "desc" },
      select: {
        id: true,
        username: true,
        instagramId: true,
        provider: true,
        tokenExpiresAt: true,
        webhookSubscribed: true,
      },
    }),
    prisma.instagramAccount.findMany({
      where: { workspaceId },
      orderBy: { connectedAt: "desc" },
      select: {
        id: true,
        username: true,
        instagramId: true,
        name: true,
        provider: true,
        tokenExpiresAt: true,
        webhookSubscribed: true,
      },
    }),
    prisma.automation.count({ where: { workspaceId, ...accountFilter } }),
    prisma.automation.count({
      where: { workspaceId, isActive: true, ...accountFilter },
    }),
    prisma.dmLog.count({
      where: {
        workspaceId,
        status: "SENT",
        createdAt: { gte: todayStart },
        ...accountFilter,
      },
    }),
    prisma.dmLog.count({
      where: {
        workspaceId,
        status: "SENT",
        createdAt: { gte: weekStart },
        ...accountFilter,
      },
    }),
    prisma.dmLog.count({
      where: {
        workspaceId,
        status: "SENT",
        createdAt: { gte: monthStart },
        ...accountFilter,
      },
    }),
    prisma.dmLog.count({
      where: { workspaceId, status: "SENT", ...accountFilter },
    }),
    prisma.dmLog.groupBy({
      by: ["status"],
      where: { workspaceId, createdAt: { gte: monthStart }, ...accountFilter },
      _count: { _all: true },
    }),
    prisma.linkClick.count({
      where: { workspaceId, createdAt: { gte: monthStart }, ...accountFilter },
    }),
    prisma.linkClick.count({ where: { workspaceId, ...accountFilter } }),
    prisma.dmLog.groupBy({
      by: ["matchedKeyword"],
      where: { workspaceId, matchedKeyword: { not: null }, ...accountFilter },
      _count: { _all: true },
    }),
    // Followers gained, per campaign. A row counts only when this campaign
    // asked someone Instagram had explicitly reported as not following, and
    // that person was later confirmed to be following. Instagram reports
    // follower counts per account and never says why anyone followed, so the
    // follow gate is the only place an individual follow can be attributed to
    // one campaign at all.
    prisma.followGateAttempt.groupBy({
      by: ["automationId"],
      where: {
        workspaceId,
        askedAt: { not: null },
        followedAt: { not: null },
        ...gateAccountFilter,
      },
      _count: { _all: true },
    }),
    prisma.followGateAttempt.groupBy({
      by: ["automationId"],
      where: {
        workspaceId,
        askedAt: { not: null },
        followedAt: { gte: monthStart },
        ...gateAccountFilter,
      },
      _count: { _all: true },
    }),
    // Which campaigns can be measured at all. A campaign without the follow
    // gate is reported as unmeasurable rather than as zero, because zero would
    // claim it gained nobody when the truth is that nothing was ever asked.
    prisma.automation.findMany({
      where: { workspaceId, requireFollow: true, ...accountFilter },
      select: { id: true, name: true },
    }),
    prisma.dmLog.findMany({
      where: { workspaceId, ...accountFilter },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: {
        automation: { select: { name: true } },
        instagramAccount: { select: { username: true } },
      },
    }),
    userId
      ? prisma.user.findUnique({
          where: { id: userId },
          select: { name: true, email: true },
        })
      : Promise.resolve(null),
    // Distinct people who have interacted, counted as "contacts".
    prisma.dmLog.findMany({
      where: { workspaceId, ...accountFilter },
      distinct: ["commenterId"],
      select: { commenterId: true },
    }),
  ]);

  const dailyDMs: { date: string; count: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const dayStart = new Date(todayStart);
    dayStart.setDate(dayStart.getDate() - i);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    const count = await prisma.dmLog.count({
      where: {
        workspaceId,
        status: "SENT",
        createdAt: { gte: dayStart, lt: dayEnd },
        ...accountFilter,
      },
    });

    dailyDMs.push({
      date: dayStart.toLocaleDateString("en-US", { weekday: "short" }),
      count,
    });
  }

  const monthlyStatusSummary = summarizeDmStatuses(
    dmStatusCountsThisMonth.map((row) => ({
      status: row.status,
      _count: row._count._all,
    }))
  );
  const topKeywords = normalizeTopKeywords(
    topKeywordRows.map((row) => ({
      matchedKeyword: row.matchedKeyword,
      _count: row._count._all,
    }))
  );

  const totalByAutomation = new Map(
    followersGainedRows.map((row) => [row.automationId, row._count._all])
  );
  const monthByAutomation = new Map(
    followersGainedMonthRows.map((row) => [row.automationId, row._count._all])
  );
  const followersGained = gatedAutomations
    .map((automation) => ({
      automationId: automation.id,
      name: automation.name,
      thisMonth: monthByAutomation.get(automation.id) ?? 0,
      total: totalByAutomation.get(automation.id) ?? 0,
    }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const followersGainedMonth = followersGained.reduce(
    (sum, row) => sum + row.thisMonth,
    0
  );

  const firstName =
    user?.name?.trim().split(/\s+/)[0] ||
    user?.email?.split("@")[0] ||
    null;

  return NextResponse.json({
    success: true,
    data: {
      userName: firstName,
      contactsCount: contactRows.length,
      workspace,
      instagramAccount,
      instagramAccounts,
      selectedInstagramAccountId: selectedAccountId,
      totalAutomations,
      activeAutomations,
      dmsSentToday,
      dmsSentWeek,
      dmsSentMonth,
      dmsSkippedMonth: monthlyStatusSummary.skipped,
      dmsFailedMonth: monthlyStatusSummary.failed,
      totalDMs,
      clicksThisMonth,
      totalClicks,
      ctrThisMonth: calculateCtr(clicksThisMonth, dmsSentMonth),
      topKeywords,
      followersGained,
      followersGainedMonth,
      dailyDMs,
      recentLogs,
    },
  });
}
