/*
  Warnings:

  - A unique constraint covering the columns `[email]` on the table `EmailOTP` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "senderType" TEXT;

-- AlterTable
ALTER TABLE "VendorProfile" ADD COLUMN     "cover_image" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "EmailOTP_email_key" ON "EmailOTP"("email");
