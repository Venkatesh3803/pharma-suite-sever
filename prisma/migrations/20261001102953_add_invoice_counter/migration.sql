-- CreateTable
CREATE TABLE "InvoiceCounter" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceCounter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceCounter_organizationId_key" ON "InvoiceCounter"("organizationId");

-- CreateIndex
CREATE INDEX "InvoiceCounter_organizationId_idx" ON "InvoiceCounter"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceCounter_organizationId_year_key" ON "InvoiceCounter"("organizationId", "year");
