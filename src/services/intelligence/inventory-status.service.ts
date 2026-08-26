import {
  inventoryConfig,
  type ExpiryStatus,
  type MovementStatus,
  type StockStatus,
} from "../../config/inventory";

/**
 * Backend-derived statuses. Thresholds live in src/config/inventory.ts and are
 * NOT hardcoded in controllers or React components.
 */

const MS_PER_DAY = 86_400_000;

export function daysBetween(from: Date, to: Date): number {
  const fromStart = new Date(from);
  fromStart.setHours(0, 0, 0, 0);
  const toStart = new Date(to);
  toStart.setHours(0, 0, 0, 0);
  return Math.round((toStart.getTime() - fromStart.getTime()) / MS_PER_DAY);
}

export function expiryStatus(expiryDate: Date, today: Date = new Date()): ExpiryStatus {
  const days = daysBetween(today, expiryDate);
  if (days < 0) return "EXPIRED";
  if (days <= inventoryConfig.expiry.warning30Days) return "EXPIRING_30_DAYS";
  if (days <= inventoryConfig.expiry.warning60Days) return "EXPIRING_60_DAYS";
  if (days <= inventoryConfig.expiry.warning90Days) return "EXPIRING_90_DAYS";
  return "HEALTHY";
}

export function stockStatus(
  availableUnits: number,
  lowStockThreshold: number = inventoryConfig.stock.defaultLowStockUnits,
): StockStatus {
  if (availableUnits <= 0) return "OUT_OF_STOCK";
  if (availableUnits <= lowStockThreshold) return "LOW_STOCK";
  return "HEALTHY";
}

export interface MovementClassificationInput {
  /** Units sold in the analysis window. */
  soldUnits: number;
  /** Units sold in the analysis window, excluding zero. */
  averageDailySales: number;
  /** Total units available on hand. */
  availableUnits: number;
  /** Days since the last outbound sale, null when never sold. */
  daysSinceLastSale: number | null;
  /** Whether enough sales history exists to classify. */
  hasEnoughData: boolean;
  /** Whether the item is flagged as dead stock. */
  isDeadStock: boolean;
}

/**
 * Classifies a medicine into FAST_MOVING / NORMAL / SLOW_MOVING / DEAD_STOCK.
 * Falls back to INSUFFICIENT_DATA when there is no meaningful sales history.
 * Classification is based on OUTBOUND SALES only — purchases/adjustments do
 * not count.
 */
export function movementStatus(input: MovementClassificationInput): MovementStatus {
  if (input.isDeadStock) return "DEAD_STOCK";
  if (!input.hasEnoughData) return "INSUFFICIENT_DATA";

  const { slowMovingThresholdPerDay, fastMovingThresholdPerDay } = inventoryConfig.movement;
  if (input.averageDailySales <= 0) return "SLOW_MOVING";
  if (input.averageDailySales >= fastMovingThresholdPerDay) return "FAST_MOVING";
  if (input.averageDailySales < slowMovingThresholdPerDay) return "SLOW_MOVING";
  return "NORMAL";
}

export function movementStatusForProduct(params: {
  averageDailySales: number;
  daysSinceLastSale: number | null;
  availableUnits: number;
  soldUnitsInWindow: number;
}): MovementStatus {
  const { averageDailySales, daysSinceLastSale, soldUnitsInWindow } = params;
  const isDeadStock =
    daysSinceLastSale !== null &&
    daysSinceLastSale >= inventoryConfig.deadStockInactiveDays;
  const hasEnoughData =
    soldUnitsInWindow >= inventoryConfig.movement.minUnitsForClassification;
  return movementStatus({
    soldUnits: soldUnitsInWindow,
    averageDailySales,
    availableUnits: params.availableUnits,
    daysSinceLastSale,
    hasEnoughData,
    isDeadStock,
  });
}
