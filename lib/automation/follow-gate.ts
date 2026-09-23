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
 * So refusals are handled in two stages. A tap that cannot be confirmed says
 * nothing at all and looks again a minute later, which is where the lag case
 * resolves without anyone being told off. Only the second look counts as a
 * miss, and after a few of those the gate stops asking and sends the link.
 *
 * The cost of that generosity is bounded and worth naming: someone determined
 * to game it gets exactly one link per campaign, having spent three taps and
 * several minutes to obtain what one real follow would have given them
 * immediately.
 */

import { prisma } from "@/lib/db/client";
import {
  FOLLOW_PROMPT_LAST_CALL,
  FOLLOW_PROMPT_RETRY,
} from "@/lib/campaigns/defaults";

/**
 * How long to wait before looking at follow status a second time. Comfortably
 * longer than Instagram's propagation lag, and far inside the 24-hour
 * messaging window, which the tap itself just refreshed. Deliberately not
 * configurable: it is a property of Instagram's API, not a campaign setting.
 */
export const FOLLOW_GATE_RECHECK_DELAY_MS = 60_000;

/** Confirmed misses after which the gate gives up and sends the link. */
export const FOLLOW_GATE_GRACE_AFTER = 3;

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
    create: { automationId, workspaceId, userId, attempts: 1 },
    update: { attempts: { increment: 1 } },
    select: { attempts: true, grantedAt: true },
  });
  return { attempts: row.attempts, grantedAt: row.grantedAt };
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
 * The first miss gets the lag explanation rather than the campaign's own
 * prompt: that text is already sitting in their inbox from the first ask, and
 * repeating it verbatim reads like the gate did not register the tap at all.
 */
export function decideFollowGateAction(attempts: number): FollowGateDecision {
  if (attempts >= FOLLOW_GATE_GRACE_AFTER) return { action: "grant" };
  if (attempts >= FOLLOW_GATE_GRACE_AFTER - 1)
    return { action: "prompt", message: FOLLOW_PROMPT_LAST_CALL };
  return { action: "prompt", message: FOLLOW_PROMPT_RETRY };
}
