-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'SALE_RETURNED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SaleStatus" ADD VALUE 'PARTIAL_RETURN';
ALTER TYPE "SaleStatus" ADD VALUE 'RETURNED';

-- AlterTable
ALTER TABLE "SaleItem" ADD COLUMN     "returnedQty" INTEGER NOT NULL DEFAULT 0;
