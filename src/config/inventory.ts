/**
 * Centralized inventory policy & thresholds.
 *
 * Everything that governs expiry risk, stock status, movement classification
 * and dead-stock detection lives here — NOT scattered across controllers or
 * UI components. Thresholds can later be moved to Organization.settings while
 * keeping this module as the single source of defaults.
 */

export const inventoryConfig = {
  /** Expiry risk windows (days before expiry date). */
  expiry: {
    warning30Days: 30,
    warning60Days: 60,
    warning90Days: 90,
  },

  /** Dead stock: days without an OUTBOUND SALE before stock is flagged. */
  deadStockInactiveDays: 60,

  /** Sales-velocity windows used for classification. */
  movement: {
    analysisDays: 30,
    /** Average daily sales below this -> SLOW_MOVING (when data exists). */
    slowMovingThresholdPerDay: 0.25,
    /** Average daily sales above this -> FAST_MOVING. */
    fastMovingThresholdPerDay: 3,
    /** Minimum sales history to classify instead of INSUFFICIENT_DATA. */
    minUnitsForClassification: 5,
  },

  /** Stock status thresholds (available base units). */
  stock: {
    defaultLowStockUnits: 15,
    /** Above this multiple of average daily demand the item is OVERSTOCKED. */
    overstockedDaysOfSupply: 60,
  },

  /** Reorder suggestion parameters. */
  reorder: {
    defaultLeadTimeDays: 7,
    defaultSafetyStock: 15,
    analysisDays: 30,
    /** Minimum average daily sales before a reorder suggestion is produced. */
    minDailySales: 0,
  },
} as const;

/** Returns org-level thresholds, falling back to centralized defaults. */
export function resolveLowStockThreshold(orgSettings: unknown): number {
  if (!orgSettings || typeof orgSettings !== "object") {
    return inventoryConfig.stock.defaultLowStockUnits;
  }
  const settings = orgSettings as Record<string, unknown>;
  const value = Number(settings.lowStockThreshold ?? settings.safetyStockDays ?? NaN);
  if (!Number.isFinite(value) || value <= 0) {
    return inventoryConfig.stock.defaultLowStockUnits;
  }
  return Math.round(value);
}

export type ExpiryStatus =
  | "EXPIRED"
  | "EXPIRING_30_DAYS"
  | "EXPIRING_60_DAYS"
  | "EXPIRING_90_DAYS"
  | "HEALTHY";

export type StockStatus =
  | "HEALTHY"
  | "LOW_STOCK"
  | "OUT_OF_STOCK"
  | "OVERSTOCKED";

export type MovementStatus =
  | "FAST_MOVING"
  | "NORMAL"
  | "SLOW_MOVING"
  | "DEAD_STOCK"
  | "INSUFFICIENT_DATA";
