-- CreateEnum
CREATE TYPE "QualityCheckType" AS ENUM ('RECEIPT_INSPECTION', 'STORAGE_CONDITION', 'EXPIRY_VERIFICATION', 'LABEL_VERIFICATION', 'ROUTINE_INSPECTION');

-- CreateEnum
CREATE TYPE "QualityControlStatus" AS ENUM ('PENDING', 'PASSED', 'FAILED', 'QUARANTINED', 'RELEASED', 'DISPOSED');

-- CreateTable
CREATE TABLE "QualityControlCheck" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "checkType" "QualityCheckType" NOT NULL,
    "status" "QualityControlStatus" NOT NULL DEFAULT 'PENDING',
    "condition" TEXT,
    "temperatureC" DECIMAL(5,2),
    "passedItems" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "failedItems" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "decisionNote" TEXT,
    "conductedById" TEXT,
    "performedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QualityControlCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QualityControlCheck_organizationId_idx" ON "QualityControlCheck"("organizationId");

-- CreateIndex
CREATE INDEX "QualityControlCheck_branchId_idx" ON "QualityControlCheck"("branchId");

-- CreateIndex
CREATE INDEX "QualityControlCheck_batchId_idx" ON "QualityControlCheck"("batchId");

-- CreateIndex
CREATE INDEX "QualityControlCheck_status_idx" ON "QualityControlCheck"("status");

-- CreateIndex
CREATE INDEX "QualityControlCheck_performedAt_idx" ON "QualityControlCheck"("performedAt");

-- AddForeignKey
ALTER TABLE "QualityControlCheck" ADD CONSTRAINT "QualityControlCheck_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QualityControlCheck" ADD CONSTRAINT "QualityControlCheck_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QualityControlCheck" ADD CONSTRAINT "QualityControlCheck_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QualityControlCheck" ADD CONSTRAINT "QualityControlCheck_conductedById_fkey" FOREIGN KEY ("conductedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
