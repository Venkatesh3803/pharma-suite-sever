import { prisma } from "../lib/prisma.js";
import { AppError } from "../domain/errors.js";
import type { AlertType, AlertSeverity } from "@prisma/client";

export async function listAlerts(params: {
  organizationId: string;
  branchId?: string;
  type?: string;
  severity?: string;
  status?: string;
  userId: string;
  page: number;
  pageSize: number;
}) {
  const { userId, organizationId } = params;
  const where = {
    organizationId,
    ...(params.branchId ? { branchId: params.branchId } : {}),
    ...(params.type ? { type: params.type as AlertType } : {}),
    ...(params.severity ? { severity: params.severity as AlertSeverity } : {}),
    ...(params.status && params.status !== "ALL"
      ? { status: params.status as never }
      : {}),
  };
  const [items, total] = await Promise.all([
    prisma.alert.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
      include: {
        readBy: { where: { userId }, select: { readAt: true } },
      },
    }),
    prisma.alert.count({ where }),
  ]);
  return {
    items: items.map(a => ({
      ...a,
      isRead: a.readBy.length > 0,
    })),
    total,
  };
}

export async function markAlertRead(
  organizationId: string,
  alertId: string,
  userId: string,
  read: boolean,
) {
  const alert = await prisma.alert.findFirst({
    where: { id: alertId, organizationId },
  });
  if (!alert) throw new AppError("Alert not found.", 404, "NOT_FOUND");
  if (read) {
    await prisma.alertRead.upsert({
      where: { alertId_userId: { alertId, userId } },
      create: { alertId, userId },
      update: {},
    });
    // keep status ACTIVE until dismissed, but record read
    return prisma.alert.findUnique({ where: { id: alertId } });
  }
  return prisma.alert.findUnique({ where: { id: alertId } });
}

export async function markAllRead(
  organizationId: string,
  userId: string,
  branchId?: string,
) {
  const where = {
    organizationId,
    ...(branchId ? { branchId } : {}),
    status: "ACTIVE" as const,
  };
  const alerts = await prisma.alert.findMany({
    where,
    select: { id: true },
  });
  await prisma.alertRead.createMany({
    data: alerts.map(a => ({ alertId: a.id, userId })),
    skipDuplicates: true,
  });
  return { updated: alerts.length };
}

export async function dismissAlert(
  organizationId: string,
  alertId: string,
) {
  const alert = await prisma.alert.findFirst({
    where: { id: alertId, organizationId },
  });
  if (!alert) throw new AppError("Alert not found.", 404, "NOT_FOUND");
  return prisma.alert.update({
    where: { id: alertId },
    data: { status: "DISMISSED" },
  });
}

export async function unreadAlertCount(organizationId: string, userId: string) {
  const count = await prisma.alert.count({
    where: {
      organizationId,
      status: "ACTIVE",
      readBy: { none: { userId } },
    },
  });
  return count;
}

export async function createAlert(
  organizationId: string,
  data: {
    type: AlertType;
    severity: AlertSeverity;
    title: string;
    message: string;
    branchId?: string;
    entityType?: string;
    entityId?: string;
    metadata?: Record<string, unknown>;
  },
) {
  return prisma.alert.create({
    data: {
      organizationId,
      branchId: data.branchId,
      type: data.type,
      severity: data.severity,
      title: data.title,
      message: data.message,
      entityType: data.entityType,
      entityId: data.entityId,
      metadata: (data.metadata ?? {}) as never,
    },
  });
}

/** Bulk-create alerts, skipping exact duplicates within a time window. */
export async function createAlertsBulk(
  organizationId: string,
  alerts: {
    type: AlertType;
    severity: AlertSeverity;
    title: string;
    message: string;
    branchId?: string;
    entityType?: string;
    entityId?: string;
    metadata?: Record<string, unknown>;
  }[],
) {
  const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const existing = await prisma.alert.findMany({
    where: {
      organizationId,
      createdAt: { gte: windowStart },
    },
    select: { title: true, entityId: true },
  });
  const existingKeys = new Set(existing.map(a => `${a.title}:${a.entityId ?? ""}`));

  const fresh = alerts.filter(a => {
    const key = `${a.title}:${a.entityId ?? ""}`;
    return !existingKeys.has(key);
  });

  if (fresh.length) {
    await prisma.alert.createMany({
      data: fresh.map(a => ({
        organizationId,
        branchId: a.branchId,
        type: a.type,
        severity: a.severity,
        title: a.title,
        message: a.message,
        entityType: a.entityType,
        entityId: a.entityId,
        metadata: (a.metadata ?? {}) as never,
      })),
    });
  }
  return { created: fresh.length };
}