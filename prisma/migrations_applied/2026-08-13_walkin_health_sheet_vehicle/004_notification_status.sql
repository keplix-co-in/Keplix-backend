-- AlterTable
ALTER TABLE "WalkInJob" ADD COLUMN     "notification_status" TEXT NOT NULL DEFAULT 'pending',
ADD COLUMN     "notified_at" TIMESTAMP(3);

