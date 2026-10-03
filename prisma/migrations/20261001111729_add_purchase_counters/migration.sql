-- CreateTable
CREATE TABLE "PurchaseCounter" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptCounter" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceiptCounter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseCounter_organizationId_key" ON "PurchaseCounter"("organizationId");

-- CreateIndex
CREATE INDEX "PurchaseCounter_organizationId_idx" ON "PurchaseCounter"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseCounter_organizationId_year_key" ON "PurchaseCounter"("organizationId", "year");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptCounter_organizationId_key" ON "ReceiptCounter"("organizationId");

-- CreateIndex
CREATE INDEX "ReceiptCounter_organizationId_idx" ON "ReceiptCounter"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptCounter_organizationId_year_key" ON "ReceiptCounter"("organizationId", "year");
