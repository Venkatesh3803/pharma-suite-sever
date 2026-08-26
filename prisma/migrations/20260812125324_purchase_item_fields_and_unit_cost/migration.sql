-- AlterEnum
ALTER TYPE "PurchaseStatus" ADD VALUE 'PARTIALLY_RECEIVED';

-- AlterTable
ALTER TABLE "PurchaseItem" ADD COLUMN     "expiryDate" TIMESTAMP(3),
ADD COLUMN     "sellingPrice" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "SaleItem" ADD COLUMN     "unitCost" DECIMAL(12,2);
