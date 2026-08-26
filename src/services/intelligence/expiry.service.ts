import { prisma } from "../../lib/prisma";

export type ExpiryBucket = "EXPIRED" | "0-30" | "31-60" | "61-90" | "91-180" | "180+";

export interface ExpiryBucketSummary {
    bucket: ExpiryBucket;
    batchCount: number;
    productCount: number;
    quantity: number;
    inventoryValue: number; // selling price * quantity
    range: string;
    severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
}

function bucketFor(expiry: Date, today: Date): ExpiryBucket {
    const diffDays = Math.ceil((expiry.getTime() - today.getTime()) / 86400000);
    if (diffDays < 0) return "EXPIRED";
    if (diffDays <= 30) return "0-30";
    if (diffDays <= 60) return "31-60";
    if (diffDays <= 90) return "61-90";
    if (diffDays <= 180) return "91-180";
    return "180+";
}

const SEVERITY: Record<ExpiryBucket, ExpiryBucketSummary["severity"]> = {
    EXPIRED: "CRITICAL",
    "0-30": "CRITICAL",
    "31-60": "HIGH",
    "61-90": "MEDIUM",
    "91-180": "LOW",
    "180+": "INFO"
};

const RANGES: Record<ExpiryBucket, string> = {
    EXPIRED: "Already expired",
    "0-30": "Expires within 30 days",
    "31-60": "31–60 days",
    "61-90": "61–90 days",
    "91-180": "91–180 days",
    "180+": "180+ days"
};

export async function buildExpiryOverview(params: { organizationId: string; branchId?: string }) {
    const { organizationId, branchId } = params;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const batches = await prisma.batch.findMany({
        where: {
            organizationId,
            ...(branchId ? { branchId } : {}),
            quantity: { gt: 0 }
        },
        include: { product: true }
    });

    const buckets = new Map<ExpiryBucket, ExpiryBucketSummary>();
    (Object.keys(SEVERITY) as ExpiryBucket[]).forEach(bucket => {
        buckets.set(bucket, {
            bucket,
            batchCount: 0,
            productCount: 0,
            quantity: 0,
            inventoryValue: 0,
            range: RANGES[bucket],
            severity: SEVERITY[bucket]
        });
    });

    for (const batch of batches) {
        const bucket = bucketFor(batch.expiryDate, today);
        const record = buckets.get(bucket)!;
        record.batchCount += 1;
        record.quantity += batch.quantity;
        record.inventoryValue += Number(batch.sellingPrice) * batch.quantity;
        // unique product count per bucket
    }
    // recompute unique product counts
    const productBuckets = new Set<string>();
    for (const bucket of Object.keys(SEVERITY) as ExpiryBucket[]) {
        buckets.get(bucket)!.productCount = 0;
    }
    const seen = new Set<string>();
    for (const batch of batches) {
        const bucket = bucketFor(batch.expiryDate, today);
        const key = `${bucket}:${batch.productId}`;
        if (!seen.has(key)) {
            seen.add(key);
            buckets.get(bucket)!.productCount += 1;
        }
        productBuckets.add(bucket);
    }
    void productBuckets;

    return Array.from(buckets.values());
}

export async function listExpiringItems(params: { organizationId: string; branchId?: string; days: number; page?: number; pageSize?: number }) {
    const { organizationId, branchId, days } = params;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const horizon = new Date(today);
    horizon.setDate(horizon.getDate() + days);

    const where = {
        organizationId,
        ...(branchId ? { branchId } : {}),
        quantity: { gt: 0 },
        expiryDate: { lte: horizon }
    };

    const [items, total] = await Promise.all([
        prisma.batch.findMany({
            where,
            include: { product: true, branch: true },
            orderBy: { expiryDate: "asc" },
            skip: ((params.page ?? 1) - 1) * (params.pageSize ?? 20),
            take: params.pageSize ?? 20
        }),
        prisma.batch.count({ where })
    ]);

    return {
        items: items.map(b => ({
            id: b.id,
            batchNumber: b.batchNumber,
            expiryDate: b.expiryDate,
            quantity: b.quantity,
            mrp: Number(b.mrp),
            sellingPrice: Number(b.sellingPrice),
            inventoryValue: Number(b.sellingPrice) * b.quantity,
            daysToExpiry: Math.ceil((b.expiryDate.getTime() - today.getTime()) / 86400000),
            product: {
                id: b.product.id,
                brand: b.product.brand,
                genericName: b.product.genericName,
                strength: b.product.strength,
                packSize: b.product.packSize
            },
            branch: {
                id: b.branch.id,
                name: b.branch.name
            }
        })),
        total
    };
}
