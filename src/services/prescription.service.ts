import fs from "node:fs";
import path from "node:path";
import { config } from "../config/index.js";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../domain/errors.js";

export interface PrescriptionFile {
  originalname: string;
  filename: string;
  path: string;
  mimetype?: string;
  size?: number;
}

export async function uploadPrescription(params: {
  organizationId: string;
  branchId?: string;
  customerId: string;
  doctorName?: string;
  prescriptionDate?: string;
  notes?: string;
  uploadedById: string;
  file: PrescriptionFile;
}) {
  const { organizationId, branchId, customerId, uploadedById, file } = params;
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, organizationId },
  });
  if (!customer) throw new AppError("Customer not found.", 404, "NOT_FOUND");

  // Move file into secure upload dir (outside public).
  if (!fs.existsSync(config.uploadDir)) {
    fs.mkdirSync(config.uploadDir, { recursive: true });
  }
  const target = path.join(config.uploadDir, file.filename);
  if (file.path !== target) {
    fs.renameSync(file.path, target);
  }

  return prisma.prescription.create({
    data: {
      organizationId,
      branchId,
      customerId,
      doctorName: params.doctorName,
      prescriptionDate: params.prescriptionDate
        ? new Date(params.prescriptionDate)
        : new Date(),
      notes: params.notes,
      fileName: file.originalname,
      filePath: target,
      mimeType: file.mimetype,
      fileSize: file.size,
      uploadedById,
    },
    include: { customer: true },
  });
}

export async function listPrescriptions(params: {
  organizationId: string;
  customerId?: string;
  search?: string;
  status?: string;
  page: number;
  pageSize: number;
}) {
  const { organizationId } = params;
  const where = {
    organizationId,
    ...(params.customerId ? { customerId: params.customerId } : {}),
    ...(params.status && params.status !== "ALL"
      ? { status: params.status as never }
      : {}),
    ...(params.search
      ? {
          customer: {
            OR: [
              { name: { contains: params.search, mode: "insensitive" as const } },
              { phone: { contains: params.search, mode: "insensitive" as const } },
            ],
          },
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    prisma.prescription.findMany({
      where,
      include: { customer: true },
      orderBy: { createdAt: "desc" },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.prescription.count({ where }),
  ]);
  return { items, total };
}

export async function getPrescription(
  organizationId: string,
  id: string,
): Promise<{ prescription: unknown; absPath: string }> {
  const prescription = await prisma.prescription.findFirst({
    where: { id, organizationId },
    include: { customer: true },
  });
  if (!prescription) throw new AppError("Prescription not found.", 404, "NOT_FOUND");
  return {
    prescription,
    absPath: path.resolve(prescription.filePath),
  };
}

export async function updatePrescriptionStatus(
  organizationId: string,
  id: string,
  status: "ACTIVE" | "COMPLETED" | "CANCELLED",
) {
  const existing = await prisma.prescription.findFirst({
    where: { id, organizationId },
  });
  if (!existing) throw new AppError("Prescription not found.", 404, "NOT_FOUND");
  return prisma.prescription.update({ where: { id }, data: { status } });
}