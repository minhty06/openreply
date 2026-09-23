CREATE TABLE "FollowGateAttempt" (
  "automationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "firstAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastAttemptAt" TIMESTAMP(3) NOT NULL,
  "lastPromptAt" TIMESTAMP(3),
  "grantedAt" TIMESTAMP(3),
  CONSTRAINT "FollowGateAttempt_pkey" PRIMARY KEY ("automationId", "userId"),
  CONSTRAINT "FollowGateAttempt_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FollowGateAttempt_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "FollowGateAttempt_workspaceId_idx" ON "FollowGateAttempt"("workspaceId");
CREATE INDEX "FollowGateAttempt_lastAttemptAt_idx" ON "FollowGateAttempt"("lastAttemptAt");
