import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../domain/errors.js";

export interface UpdateOrganizationInput {
  name?: string;
  gstin?: string;
  address?: string;
  settings?: Prisma.InputJsonObject;
}

export async function getOrganization(organizationId: string) {
  const org = await prisma.organization.findFirst({
    where: { id: organizationId, isActive: true },
    include: {
      branches: { where: { isActive: true } },
      _count: {
        select: {
          users: { where: { deletedAt: null } },
        },
      },
    },
  });
  if (!org) throw new AppError("Organization not found.", 404, "NOT_FOUND");

  return {
    id: org.id,
    name: org.name,
    code: org.code,
    gstin: org.gstin,
    address: org.address,
    currency: org.currency,
    timezone: org.timezone,
    settings: org.settings,
    createdAt: org.createdAt,
    updatedAt: org.updatedAt,
    branches: org.branches,
    userCount: org._count.users,
  };
}

export async function updateOrganization(
  organizationId: string,
  actedById: string,
  input: UpdateOrganizationInput,
) {
  const existing = await prisma.organization.findUnique({
    where: { id: organizationId },
  });
  if (!existing) {
    throw new AppError("Organization not found.", 404, "NOT_FOUND");
  }

  const settings = input.settings
    ? {
        ...(existing.settings as Prisma.InputJsonObject),
        ...input.settings,
      }
    : undefined;

  const data = {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.gstin !== undefined ? { gstin: input.gstin || null } : {}),
    ...(input.address !== undefined ? { address: input.address || null } : {}),
    ...(settings !== undefined ? { settings } : {}),
  };

  const org = await prisma.organization.update({
    where: { id: organizationId },
    data,
  });

  await prisma.auditLog.create({
    data: {
      organizationId,
      userId: actedById,
      action: "ORGANIZATION_UPDATED",
      entityType: "Organization",
      entityId: org.id,
      metadata: { updated: Object.keys(data) },
    },
  });

  return getOrganization(organizationId);
}
