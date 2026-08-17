import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    webhookEvent: { deleteMany: vi.fn() },
    linkClick: { deleteMany: vi.fn() },
    operationalEvent: { deleteMany: vi.fn() },
    dmLog: { deleteMany: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({
  prisma: mockPrisma,
}));

const {
  purgeExpiredRecords,
  resolveRetentionDays,
  DEFAULT_RETENTION_DAYS,
  DM_LOG_MIN_DAYS,
} = await import("@/lib/ops/retention");

const RETENTION_ENV_VARS = [
  "RETENTION_WEBHOOK_EVENT_DAYS",
  "RETENTION_LINK_CLICK_DAYS",
  "RETENTION_OPERATIONAL_EVENT_DAYS",
  "RETENTION_DM_LOG_DAYS",
] as const;

/** 2026-08-17T12:00:00Z — fixed so cutoff arithmetic is exact. */
const NOW = new Date("2026-08-17T12:00:00.000Z");

function cutoffFor(table: keyof typeof mockPrisma): Date {
  const call = mockPrisma[table].deleteMany.mock.calls[0][0];
  return call.where.createdAt.lt;
}

function daysBefore(date: Date, from: Date = NOW): number {
  return Math.round((from.getTime() - date.getTime()) / 86_400_000);
}

describe("retention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const name of RETENTION_ENV_VARS) delete process.env[name];

    mockPrisma.webhookEvent.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.linkClick.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.operationalEvent.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.dmLog.deleteMany.mockResolvedValue({ count: 0 });
  });

  afterEach(() => {
    for (const name of RETENTION_ENV_VARS) delete process.env[name];
  });

  describe("resolveRetentionDays", () => {
    it("uses the documented defaults when nothing is configured", () => {
      expect(resolveRetentionDays()).toEqual(DEFAULT_RETENTION_DAYS);
    });

    it("keeps DmLog far longer than the churn tables by default", () => {
      const days = resolveRetentionDays();
      expect(days.dmLog).toBeGreaterThan(days.webhookEvent);
      expect(days.dmLog).toBeGreaterThan(days.linkClick);
    });

    it("honours valid env overrides", () => {
      process.env.RETENTION_WEBHOOK_EVENT_DAYS = "3";
      process.env.RETENTION_DM_LOG_DAYS = "180";

      const days = resolveRetentionDays();
      expect(days.webhookEvent).toBe(3);
      expect(days.dmLog).toBe(180);
      // Untouched vars keep their defaults.
      expect(days.linkClick).toBe(DEFAULT_RETENTION_DAYS.linkClick);
    });

    it.each(["0", "-5", "1.5", "banana", ""])(
      "falls back to the default for the invalid value %j",
      (value) => {
        process.env.RETENTION_WEBHOOK_EVENT_DAYS = value;
        expect(resolveRetentionDays().webhookEvent).toBe(
          DEFAULT_RETENTION_DAYS.webhookEvent
        );
      }
    );

    // The floor exists so a purge can never delete a DmLog row the comment
    // reconciler still needs, which would make it re-send a DM.
    it("clamps DmLog up to the floor when configured below it", () => {
      process.env.RETENTION_DM_LOG_DAYS = "1";
      expect(resolveRetentionDays().dmLog).toBe(DM_LOG_MIN_DAYS);
    });

    it("keeps the floor above the reconciler's 72-hour lookback", () => {
      expect(DM_LOG_MIN_DAYS * 24).toBeGreaterThan(72);
    });
  });

  describe("purgeExpiredRecords", () => {
    it("deletes each table at its own cutoff", async () => {
      await purgeExpiredRecords(NOW);

      expect(daysBefore(cutoffFor("webhookEvent"))).toBe(7);
      expect(daysBefore(cutoffFor("linkClick"))).toBe(30);
      expect(daysBefore(cutoffFor("operationalEvent"))).toBe(30);
      expect(daysBefore(cutoffFor("dmLog"))).toBe(90);
    });

    it("only ever deletes rows strictly older than the cutoff", async () => {
      await purgeExpiredRecords(NOW);

      for (const table of [
        "webhookEvent",
        "linkClick",
        "operationalEvent",
        "dmLog",
      ] as const) {
        const where = mockPrisma[table].deleteMany.mock.calls[0][0].where;
        expect(Object.keys(where)).toEqual(["createdAt"]);
        expect(where.createdAt).toHaveProperty("lt");
        expect(where.createdAt.lt.getTime()).toBeLessThan(NOW.getTime());
      }
    });

    it("reports per-table counts and their total", async () => {
      mockPrisma.webhookEvent.deleteMany.mockResolvedValue({ count: 5503 });
      mockPrisma.linkClick.deleteMany.mockResolvedValue({ count: 12 });
      mockPrisma.operationalEvent.deleteMany.mockResolvedValue({ count: 4 });
      mockPrisma.dmLog.deleteMany.mockResolvedValue({ count: 1 });

      const result = await purgeExpiredRecords(NOW);

      expect(result.counts).toEqual({
        webhookEvent: 5503,
        linkClick: 12,
        operationalEvent: 4,
        dmLog: 1,
      });
      expect(result.totalDeleted).toBe(5520);
      expect(result.retentionDays).toEqual(DEFAULT_RETENTION_DAYS);
    });

    it("reports a zero total when nothing is expired", async () => {
      const result = await purgeExpiredRecords(NOW);

      expect(result.totalDeleted).toBe(0);
      expect(mockPrisma.dmLog.deleteMany).toHaveBeenCalledOnce();
    });

    it("applies the DmLog floor to the actual delete, not just the report", async () => {
      process.env.RETENTION_DM_LOG_DAYS = "1";

      const result = await purgeExpiredRecords(NOW);

      expect(daysBefore(cutoffFor("dmLog"))).toBe(DM_LOG_MIN_DAYS);
      expect(result.retentionDays.dmLog).toBe(DM_LOG_MIN_DAYS);
    });
  });
});
