import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma";
import { AppError } from "../domain/errors";
import { assertSeatLimit } from "./subscription.service";

export type UserRole = "SUPER_ADMIN" | "OWNER" | "MANAGER" | "PHARMACIST" | "STAFF";
export type UserStatus = "ACTIVE" | "INACTIVE" | "SUSPENDED";

export interface CreateUserInput {
  fullName: string;
  email: string;
  password: string;
  phone?: string;
  role: UserRole;
  branchId?: string;
}

export interface UpdateUserInput {
  fullName?: string;
  phone?: string;
  role?: UserRole;
  status?: UserStatus;
  branchId?: string | null;
  password?: string;
}

const publicUserSelect = {
  id: true,
  fullName: true,
  email: true,
  phone: true,
  role: true,
  status: true,
  branchId: true,
  lastLoginAt: true,
  createdAt: true,
  branch: { select: { id: true, name: true, code: true } },
} as const;

export async function listUsers(organizationId: string) {
  const where = { organizationId, deletedAt: null };
  const [items, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: publicUserSelect,
      orderBy: { createdAt: "asc" },
    }),
    prisma.user.count({ where }),
  ]);
  return { items, total };
}

export async function createUser(
  organizationId: string,
  actedById: string,
  input: CreateUserInput,
) {
  const email = input.email.toLowerCase().trim();

  const existing = await prisma.user.findUnique({
    where: { organizationId_email: { organizationId, email } },
  });
  if (existing) {
    throw new AppError(
      "A user with this email already exists in this workspace.",
      409,
      "DUPLICATE_RECORD",
    );
  }

  await assertSeatLimit(organizationId);

  const passwordHash = await bcrypt.hash(input.password, 12);
  const user = await prisma.user.create({
    data: {
      organizationId,
      fullName: input.fullName,
      email,
      passwordHash,
      phone: input.phone,
      role: input.role,
      branchId: input.branchId,
      status: "ACTIVE",
    },
    select: publicUserSelect,
  });

  await prisma.auditLog.create({
    data: {
      organizationId,
      branchId: input.branchId,
      userId: actedById,
      action: "USER_CREATED",
      entityType: "User",
      entityId: user.id,
      metadata: { email: user.email, role: user.role },
    },
  });

  return user;
}

export async function updateUser(
  organizationId: string,
  actedById: string,
  userId: string,
  input: UpdateUserInput,
) {
  const existing = await prisma.user.findFirst({
    where: { id: userId, organizationId, deletedAt: null },
  });
  if (!existing) {
    throw new AppError("User not found.", 404, "NOT_FOUND");
  }

  if (userId === actedById) {
    const restricted = input.role !== undefined || input.status !== undefined;
    if (restricted) {
      throw new AppError(
        "You cannot change your own role or status.",
        400,
        "VALIDATION",
      );
    }
  }

  const data: Record<string, unknown> = {};
  if (input.fullName !== undefined) data.fullName = input.fullName;
  if (input.phone !== undefined) data.phone = input.phone;
  if (input.role !== undefined) data.role = input.role;
  if (input.status !== undefined) data.status = input.status;
  if (input.branchId !== undefined) data.branchId = input.branchId || null;
  if (input.password) data.passwordHash = await bcrypt.hash(input.password, 12);

  const user = await prisma.user.update({
    where: { id: userId },
    data,
    select: publicUserSelect,
  });

  await prisma.auditLog.create({
    data: {
      organizationId,
      branchId: user.branchId ?? undefined,
      userId: actedById,
      action: "USER_UPDATED",
      entityType: "User",
      entityId: user.id,
      metadata: { updated: Object.keys(data) },
    },
  });

  return user;
}
