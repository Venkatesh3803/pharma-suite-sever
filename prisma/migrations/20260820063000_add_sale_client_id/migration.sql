-- AlterTable
ALTER TABLE "Sale" ADD COLUMN "clientSaleId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Sale_clientSaleId_key" ON "Sale"("clientSaleId");