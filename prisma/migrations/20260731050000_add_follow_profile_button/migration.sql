-- Optional profile-link button on the follow-gate prompt.
ALTER TABLE "Automation" ADD COLUMN "followProfileButtonEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Automation" ADD COLUMN "followProfileButtonLabel" TEXT;
