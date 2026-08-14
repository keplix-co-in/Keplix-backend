-- CreateEnum
CREATE TYPE "HealthStatus" AS ENUM ('GOOD', 'ATTENTION', 'REPLACE');

-- CreateEnum
CREATE TYPE "WalkInJobStatus" AS ENUM ('open', 'in_progress', 'completed', 'cancelled');

-- AlterTable
ALTER TABLE "PlatformSettings" ADD COLUMN     "healthSheetRequiredFrom" TIMESTAMP(3),
ADD COLUMN     "isHealthSheetRequired" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Vehicle" (
    "id" SERIAL NOT NULL,
    "registration" TEXT NOT NULL,
    "make" TEXT,
    "model" TEXT,
    "year" INTEGER,
    "fuel_type" TEXT,
    "colour" TEXT,
    "odometer_km" INTEGER,
    "ownerUserId" INTEGER,
    "owner_phone" TEXT,
    "owner_name" TEXT,
    "createdByVendorId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalkInJob" (
    "id" SERIAL NOT NULL,
    "vendorId" INTEGER NOT NULL,
    "vehicleId" INTEGER,
    "customer_name" TEXT NOT NULL,
    "customer_phone" TEXT NOT NULL,
    "claimedByUserId" INTEGER,
    "description" TEXT,
    "status" "WalkInJobStatus" NOT NULL DEFAULT 'open',
    "amount_collected" DECIMAL(10,2),
    "payment_mode" TEXT,
    "commission_rate" DOUBLE PRECISION,
    "commission_amount" DECIMAL(10,2),
    "settlement_status" TEXT NOT NULL DEFAULT 'not_applicable',
    "settled_at" TIMESTAMP(3),
    "public_token" TEXT NOT NULL,
    "token_expires_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalkInJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HealthComponent" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HealthComponent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HealthSheet" (
    "id" SERIAL NOT NULL,
    "bookingId" INTEGER,
    "walkInJobId" INTEGER,
    "vendorId" INTEGER NOT NULL,
    "vehicleId" INTEGER,
    "odometer_km" INTEGER,
    "overall_notes" TEXT,
    "public_token" TEXT NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HealthSheet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HealthSheetItem" (
    "id" SERIAL NOT NULL,
    "healthSheetId" INTEGER NOT NULL,
    "componentId" INTEGER NOT NULL,
    "status" "HealthStatus" NOT NULL,
    "notes" TEXT,
    "photos" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "HealthSheetItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhoneIdentity" (
    "id" SERIAL NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "userId" INTEGER,
    "verified_at" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PhoneIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Vehicle_ownerUserId_idx" ON "Vehicle"("ownerUserId");

-- CreateIndex
CREATE INDEX "Vehicle_owner_phone_idx" ON "Vehicle"("owner_phone");

-- CreateIndex
CREATE INDEX "Vehicle_registration_idx" ON "Vehicle"("registration");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_registration_createdByVendorId_key" ON "Vehicle"("registration", "createdByVendorId");

-- CreateIndex
CREATE UNIQUE INDEX "WalkInJob_public_token_key" ON "WalkInJob"("public_token");

-- CreateIndex
CREATE INDEX "WalkInJob_vendorId_status_idx" ON "WalkInJob"("vendorId", "status");

-- CreateIndex
CREATE INDEX "WalkInJob_customer_phone_idx" ON "WalkInJob"("customer_phone");

-- CreateIndex
CREATE INDEX "WalkInJob_claimedByUserId_idx" ON "WalkInJob"("claimedByUserId");

-- CreateIndex
CREATE INDEX "WalkInJob_createdAt_idx" ON "WalkInJob"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "HealthComponent_key_key" ON "HealthComponent"("key");

-- CreateIndex
CREATE INDEX "HealthComponent_is_active_idx" ON "HealthComponent"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "HealthSheet_bookingId_key" ON "HealthSheet"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "HealthSheet_walkInJobId_key" ON "HealthSheet"("walkInJobId");

-- CreateIndex
CREATE UNIQUE INDEX "HealthSheet_public_token_key" ON "HealthSheet"("public_token");

-- CreateIndex
CREATE INDEX "HealthSheet_vendorId_idx" ON "HealthSheet"("vendorId");

-- CreateIndex
CREATE INDEX "HealthSheet_vehicleId_idx" ON "HealthSheet"("vehicleId");

-- CreateIndex
CREATE INDEX "HealthSheetItem_status_idx" ON "HealthSheetItem"("status");

-- CreateIndex
CREATE UNIQUE INDEX "HealthSheetItem_healthSheetId_componentId_key" ON "HealthSheetItem"("healthSheetId", "componentId");

-- CreateIndex
CREATE UNIQUE INDEX "PhoneIdentity_phone_e164_key" ON "PhoneIdentity"("phone_e164");

-- CreateIndex
CREATE UNIQUE INDEX "PhoneIdentity_userId_key" ON "PhoneIdentity"("userId");

-- CreateIndex
CREATE INDEX "PhoneIdentity_userId_idx" ON "PhoneIdentity"("userId");

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_createdByVendorId_fkey" FOREIGN KEY ("createdByVendorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalkInJob" ADD CONSTRAINT "WalkInJob_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalkInJob" ADD CONSTRAINT "WalkInJob_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalkInJob" ADD CONSTRAINT "WalkInJob_claimedByUserId_fkey" FOREIGN KEY ("claimedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthSheet" ADD CONSTRAINT "HealthSheet_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthSheet" ADD CONSTRAINT "HealthSheet_walkInJobId_fkey" FOREIGN KEY ("walkInJobId") REFERENCES "WalkInJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthSheet" ADD CONSTRAINT "HealthSheet_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthSheetItem" ADD CONSTRAINT "HealthSheetItem_healthSheetId_fkey" FOREIGN KEY ("healthSheetId") REFERENCES "HealthSheet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthSheetItem" ADD CONSTRAINT "HealthSheetItem_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "HealthComponent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneIdentity" ADD CONSTRAINT "PhoneIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

