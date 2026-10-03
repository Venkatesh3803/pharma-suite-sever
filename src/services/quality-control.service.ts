import { prisma } from "../lib/prisma.js";
import { AppError } from "../domain/errors.js";
import type { QualityCheckType, QualityControlStatus } from "@prisma/client";

const PENDING_WINDOW_DAYS = 30;

export interface CreateQualityCheckParams {
  organizationId: string;
  branchId?: string;
  batchId: string;
  checkType: QualityCheckType;
  temperatureC?: string | null;
  condition?: string;
  passedItems?: string[];
  failedItems?: string[];
  notes?: string;
  decision?: string;
  conductedById?: string;
}

export async function listQualityChecks(params: {
  organizationId: string;
  branchId?: string;
  batchId?: string;
  status?: string;
  page: number;
  pageSize: number;
}) {
  const { organizationId } = params;
  const where = {
    organizationId,
    ...(params.branchId ? { branchId: params.branchId } : {}),
    ...(params.batchId ? { batchId: params.batchId } : {}),
    ...(params.status && params.status !== "ALL" ? { status: params.status as QualityControlStatus } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.qualityControlCheck.findMany({
      where,
      include: {
        batch: { include: { product: true } },
        branch: true,
        conductedBy: { select: { id: true, fullName: true } },
      },
      orderBy: { performedAt: "desc" },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.qualityControlCheck.count({ where }),
  ]);
  return { items, total };
}

export async function listPendingBatches(params: { organizationId: string; branchId?: string }) {
  const { organizationId } = params;
  const since = new Date(Date.now() - PENDING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const batches = await prisma.batch.findMany({
    where: {
      organizationId,
      quantity: { gt: 0 },
      receivedAt: { gte: since },
      ...(params.branchId ? { branchId: params.branchId } : {}),
      qualityChecks: { none: { status: { in: ["PASSED", "RELEASED"] } } },
    },
    include: {
      product: true,
      branch: true,
      supplier: { select: { id: true, name: true } },
    },
    orderBy: { receivedAt: "desc" },
    take: 50,
  });
  return batches;
}

export async function createQualityCheck(params: CreateQualityCheckParams) {
  const { organizationId, batchId, decision, conductedById } = params;
  const batch = await prisma.batch.findFirst({
    where: { id: batchId, organizationId },
    include: { product: true, branch: true },
  });
  if (!batch) throw new AppError("Batch not found.", 404, "NOT_FOUND");

  const decisionMap: Record<string, QualityControlStatus | undefined> = {
    PASSED: "PASSED",
    FAILED: "FAILED",
    QUARANTINE: "QUARANTINED",
    PENDING: "PENDING",
  };
  const status = decision ? decisionMap[decision.toUpperCase()] ?? "PENDING" : "PENDING";

  const check = await prisma.qualityControlCheck.create({
    data: {
      organizationId,
      branchId: params.branchId ?? batch.branchId,
      batchId,
      checkType: params.checkType,
      status,
      temperatureC: params.temperatureC ? Number(params.temperatureC) : undefined,
      condition: params.condition,
      passedItems: params.passedItems ?? [],
      failedItems: params.failedItems ?? [],
      notes: params.notes,
      conductedById,
    },
    include: { batch: { include: { product: true } } },
  });

  if (status === "FAILED" || status === "QUARANTINED") {
    await prisma.alert.create({
      data: {
        organizationId,
        branchId: check.branchId,
        type: "SYSTEM",
        severity: status === "QUARANTINED" ? "CRITICAL" : "HIGH",
        title: status === "QUARANTINED" ? "Batch quarantined" : "Quality check failed",
        message: `${batch.product.brand} (batch ${batch.batchNumber}) ${status === "QUARANTINED" ? "quarantined pending re-inspection" : "failed quality inspection"}.`,
        entityType: "quality-control",
        entityId: check.id,
      },
    });
  }

  return check;
}

export async function updateQualityCheckStatus(params: {
  organizationId: string;
  id: string;
  status: "PASSED" | "FAILED" | "RELEASED" | "DISPOSED";
  decisionNote?: string;
  conductedById?: string;
}) {
  const existing = await prisma.qualityControlCheck.findFirst({
    where: { id: params.id, organizationId: params.organizationId },
  });
  if (!existing) throw new AppError("Quality control check not found.", 404, "NOT_FOUND");

  return prisma.qualityControlCheck.update({
    where: { id: params.id },
    data: {
      status: params.status,
      decisionNote: params.decisionNote,
      conductedById: params.conductedById,
    },
  });
}
