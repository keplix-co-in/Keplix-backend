-- AlterTable
ALTER TABLE "UserProfile" ADD COLUMN     "id_proof_back" TEXT,
ADD COLUMN     "id_proof_front" TEXT,
ADD COLUMN     "profile_picture" TEXT;

-- CreateTable
CREATE TABLE "PhoneOTP" (
    "id" SERIAL NOT NULL,
    "phone_number" TEXT NOT NULL,
    "otp" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PhoneOTP_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PhoneOTP_phone_number_key" ON "PhoneOTP"("phone_number");
