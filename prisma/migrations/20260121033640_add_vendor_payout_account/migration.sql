-- CreateTable
CREATE TABLE "VendorPayoutAccount" (
    "id" SERIAL NOT NULL,
    "vendorId" INTEGER NOT NULL,
    "contactId" TEXT NOT NULL,
    "fundAccountId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorPayoutAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VendorPayoutAccount_vendorId_key" ON "VendorPayoutAccount"("vendorId");

-- AddForeignKey
ALTER TABLE "VendorPayoutAccount" ADD CONSTRAINT "VendorPayoutAccount_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
