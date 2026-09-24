/**
 * Comment reconciliation — ad copies of a boosted post.
 *
 * Comments left on an ad carry the ad's own media id, so the sweep has to look
 * at those media too or a webhook Meta never delivers is lost for good.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: { $queryRaw: vi.fn() },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import {
  adMediaFor,
  commentsRepliedToBy,
  sweepWindowStart,
} from "../lib/polling/comment-reconciler";

const POST = "18023946917554990";
const AD = "17899788633163100";

describe("adMediaFor", () => {
  beforeEach(() => {
    mockPrisma.$queryRaw.mockReset();
  });

  it("returns the ad media ids seen for the post", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{ mediaId: AD }]);
    await expect(adMediaFor(POST)).resolves.toEqual([AD]);
  });

  it("never returns the post itself, so it is not swept twice", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{ mediaId: AD }, { mediaId: POST }]);
    await expect(adMediaFor(POST)).resolves.toEqual([AD]);
  });

  it("drops rows without a media id", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{ mediaId: null }, { mediaId: AD }]);
    await expect(adMediaFor(POST)).resolves.toEqual([AD]);
  });

  it("returns nothing when the post was never boosted", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([]);
    await expect(adMediaFor(POST)).resolves.toEqual([]);
  });

  it("swallows a query failure, leaving the post itself still swept", async () => {
    mockPrisma.$queryRaw.mockRejectedValue(new Error("connection lost"));
    await expect(adMediaFor(POST)).resolves.toEqual([]);
  });
});

describe("sweepWindowStart", () => {
  const lookbackStart = Date.parse("2026-09-21T01:00:00Z");

  it("ignores comments left before a new campaign existed", () => {
    const created = new Date("2026-09-24T01:06:21Z");
    expect(sweepWindowStart(created, lookbackStart)).toBe(created.getTime());
  });

  it("keeps the lookback window for a campaign older than it", () => {
    const created = new Date("2026-08-01T00:00:00Z");
    expect(sweepWindowStart(created, lookbackStart)).toBe(lookbackStart);
  });
});

describe("commentsRepliedToBy", () => {
  const OWNER = "17841459358872008";

  // Shape Instagram actually returns: the owner's reply appears as its own item
  // with parent_id, and the nested replies edge carries no `from`. Reading only
  // the nested edge found no replies, so the sweep answered comments that had
  // already been answered, sending a second public reply and a second DM.
  it("sees an owner reply listed as its own item", () => {
    const replied = commentsRepliedToBy(
      [
        {
          id: "reply",
          text: "@mhdion sent!",
          timestamp: "2026-09-24T01:55:34+0000",
          from: { id: OWNER },
          parent_id: "comment",
        },
        {
          id: "comment",
          text: "bus",
          timestamp: "2026-09-24T01:55:20+0000",
          from: { id: "commenter" },
          replies: { data: [{ id: "reply" }] },
        },
      ],
      OWNER
    );
    expect(replied.has("comment")).toBe(true);
  });

  it("still reads nested reply authors, which Zernio provides", () => {
    const replied = commentsRepliedToBy(
      [
        {
          id: "comment",
          text: "bus",
          timestamp: "2026-09-24T01:55:20+0000",
          from: { id: "commenter" },
          replies: { data: [{ id: "reply", from: { id: OWNER } }] },
        },
      ],
      OWNER
    );
    expect(replied.has("comment")).toBe(true);
  });

  it("ignores replies from anyone but the owner", () => {
    const replied = commentsRepliedToBy(
      [
        {
          id: "reply",
          text: "me too",
          timestamp: "2026-09-24T01:56:00+0000",
          from: { id: "someone-else" },
          parent_id: "comment",
        },
      ],
      OWNER
    );
    expect(replied.size).toBe(0);
  });
});
