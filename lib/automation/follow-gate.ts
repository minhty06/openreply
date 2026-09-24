/**
 * Follow-gate escalation.
 *
 * The gate asks someone to follow before it sends the link they asked for, and
 * verifies that with Instagram's follow-status API. That API is the problem: it
 * lags a fresh follow by seconds, and it reports an unknown status for a
 * rate-limit, an expired token and a genuinely unrecognised user alike. A gate
 * that treats every unconfirmed tap as a lie therefore accuses honest people,
 * and — before this module — did so on a loop, silently, forever.
 *
 * So every tap gets an answer straight away, and a refusal never accuses. The
 * first miss explains the lag and asks for one more tap, and the next one gives
 * up and sends the link. There is deliberately no silent wait-and-look-again:
 * a minute of nothing after tapping a button reads as broken, and people left.
 *
 * The cost of that generosity is bounded and worth naming: someone determined
 * to game it gets the link after two taps per ask, which one real follow would
 * have given them on the first.
 */

import { prisma } from "@/lib/db/client";
import { FOLLOW_PROMPT_RETRY } from "@/lib/campaigns/defaults";

/** Confirmed misses after which the gate gives up and sends the link. */
export const FOLLOW_GATE_GRACE_AFTER = 2;

export type FollowGateDecision =
  | { action: "prompt"; message: string }
  | { action: "grant" };

/**
 * Record one confirmed miss and return the running total.
 *
 * `increment` can double-count when BullMQ retries a job, because on the Meta
 * path there is no delivery claim to dedupe against (see `sendPostbackOnce`).
 * That is accepted rather than fixed: over-counting only brings the grace
 * grant forward, so the failure mode is being too generous to one person,
 * never trapping them. An exactly-once counter here would be more fragile and
 * strictly less kind.
 */
export async function recordFollowGateMiss({
  automationId,
  workspaceId,
  userId,
}: {
  automationId: string;
  workspaceId: string;
  userId: string;
}): Promise<{ attempts: number; grantedAt: Date | null }> {
  const row = await prisma.followGateAttempt.upsert({
    where: { automationId_userId: { automationId, userId } },
    create: {
      automationId,
      workspaceId,
      userId,
      attempts: 1,
      askedAt: new Date(),
    },
    update: { attempts: { increment: 1 } },
    select: { attempts: true, grantedAt: true },
  });
  return { attempts: row.attempts, grantedAt: row.grantedAt };
}

/**
 * Record that a campaign asked this person to follow while Instagram
 * explicitly said they were not following yet.
 *
 * This is the denominator half of the followers-gained metric. Only a
 * confirmed `false` is ever recorded: an unknown status could be someone who
 * already follows, and crediting a campaign for them would inflate the number
 * with people it never won.
 *
 * It also starts a fresh round of misses. The count used to live for the life
 * of the campaign, so anyone asked a second time (a new comment, a second tap
 * on the opening DM) arrived already one miss down, and their first honest
 * "i'm following" skipped the lag nudge and went straight to the grace note.
 */
export async function recordFollowGateAsk({
  automationId,
  workspaceId,
  userId,
}: {
  automationId: string;
  workspaceId: string;
  userId: string;
}): Promise<void> {
  const now = new Date();
  await prisma.followGateAttempt.upsert({
    where: { automationId_userId: { automationId, userId } },
    create: {
      automationId,
      workspaceId,
      userId,
      askedAt: now,
      lastPromptAt: now,
    },
    // Keep the original askedAt: the first ask is when this campaign started
    // working on them, and a later re-ask should not restart the clock.
    // grantedAt is kept too, so the grace note is still only ever said once.
    update: { lastPromptAt: now, attempts: 0 },
  });
}

/**
 * Record that someone this campaign asked has now been confirmed following.
 *
 * `updateMany` rather than `update` so this is a no-op for anyone with no ask
 * on record — people who already followed before they ever commented must not
 * be counted as gained. The `followedAt: null` guard keeps the first
 * confirmation, so the metric reflects when they actually followed rather than
 * the last time they tapped.
 */
export async function recordFollowGateConversion({
  automationId,
  userId,
}: {
  automationId: string;
  userId: string;
}): Promise<void> {
  await prisma.followGateAttempt.updateMany({
    where: {
      automationId,
      userId,
      askedAt: { not: null },
      followedAt: null,
    },
    data: { followedAt: new Date() },
  });
}

/** Stamp the moment the gate gave someone the link on good faith. */
export async function markFollowGateGranted({
  automationId,
  userId,
}: {
  automationId: string;
  userId: string;
}): Promise<void> {
  await prisma.followGateAttempt.update({
    where: { automationId_userId: { automationId, userId } },
    data: { grantedAt: new Date() },
  });
}

/** Note that a prompt went out, so the record shows asking as well as missing. */
export async function markFollowGatePrompted({
  automationId,
  userId,
}: {
  automationId: string;
  userId: string;
}): Promise<void> {
  await prisma.followGateAttempt.update({
    where: { automationId_userId: { automationId, userId } },
    data: { lastPromptAt: new Date() },
  });
}

/**
 * Map a confirmed-miss count onto what to do about it.
 *
 * The miss gets the lag explanation rather than the campaign's own prompt:
 * that text is already sitting in their inbox from the first ask, and
 * repeating it verbatim reads like the gate did not register the tap at all.
 * The next one gives up, so nobody is asked more than twice in total.
 */
export function decideFollowGateAction(attempts: number): FollowGateDecision {
  if (attempts >= FOLLOW_GATE_GRACE_AFTER) return { action: "grant" };
  return { action: "prompt", message: FOLLOW_PROMPT_RETRY };
}
