import { AppError } from "../domain/errors";

/**
 * Canonical unit configuration.
 *
 * All stock on Batch.quantity is stored in a single canonical BASE unit
 * (e.g. "tablet"). Packaging levels describe how many base units make up one
 * unit of each higher level:
 *
 *   Dolo 650 -> baseUnit "tablet", levels: [box(factor 100), strip(factor 10)]
 *
 *   → 1 box = 100 tablets, 1 strip = 10 tablets.
 *
 * The BASE unit always has factor 1. `saleUnit` is the unit normally sold and
 * `saleUnitFactor` is its factor (used by the POS/Sales module).
 *
 * Quantities are always integers; floating-point arithmetic is never used.
 */

export interface UnitLevel {
  name: string;
  factor: number;
  label?: string;
}

export interface UnitConfig {
  baseUnit: string;
  baseUnitLabel?: string;
  saleUnit: string;
  saleUnitFactor: number;
  /** Levels sorted descending by factor (biggest pack first). */
  levels: UnitLevel[];
}

/** Normalizes raw JSON (from Product.unitConfig) into a valid UnitConfig. */
export function parseUnitConfig(raw: unknown): UnitConfig {
  if (!raw || typeof raw !== "object") return defaultUnitConfig();
  const cfg = raw as Record<string, unknown>;

  const baseUnit =
    typeof cfg.baseUnit === "string" && cfg.baseUnit.trim()
      ? cfg.baseUnit.trim()
      : "unit";

  let levels: UnitLevel[] = [];
  if (Array.isArray(cfg.levels)) {
    levels = cfg.levels
      .filter((l): l is UnitLevel => !!l && typeof l === "object")
      .map(l => {
        const lv = l as unknown as Record<string, unknown>;
        const factor = Number(lv.factor);
        return {
          name: typeof lv.name === "string" ? lv.name : "unit",
          factor: Number.isFinite(factor) && factor >= 1 ? Math.floor(factor) : 1,
          label: typeof lv.label === "string" ? lv.label : undefined,
        };
      })
      .filter(l => l.factor > 1);
  }

  const saleUnit =
    typeof cfg.saleUnit === "string" && cfg.saleUnit.trim()
      ? cfg.saleUnit.trim()
      : levels[0]?.name ?? baseUnit;
  const saleUnitFactor = Math.max(
    1,
    Math.floor(
      Number(levels.find(l => l.name === saleUnit)?.factor ?? cfg.saleUnitFactor ?? 1) || 1,
    ),
  );

  // Ensure we never mutate the parsed factor for the base unit.
  levels = levels.filter(l => l.factor > 1).sort((a, b) => b.factor - a.factor);

  return {
    baseUnit,
    baseUnitLabel:
      typeof cfg.baseUnitLabel === "string" ? cfg.baseUnitLabel : undefined,
    saleUnit,
    saleUnitFactor,
    levels,
  };
}

export function defaultUnitConfig(): UnitConfig {
  return {
    baseUnit: "unit",
    saleUnit: "unit",
    saleUnitFactor: 1,
    levels: [],
  };
}

export interface UnitPart {
  level: string; // level name or base unit name
  quantity: number;
}

/**
 * Converts human-entered parts (e.g. 2 boxes, 3 strips, 4 tablets) into base
 * units. `parts` should already be ordered largest → smallest by the caller.
 * Integer-only throughout.
 */
export function toBaseUnits(config: UnitConfig, parts: UnitPart[]): number {
  let total = 0;
  for (const part of parts) {
    if (!Number.isInteger(part.quantity)) {
      throw new AppError(
        `Quantity for "${part.level}" must be a whole number.`,
        400,
        "VALIDATION",
      );
    }
    if (part.quantity < 0) {
      throw new AppError(
        `Quantity for "${part.level}" cannot be negative.`,
        400,
        "VALIDATION",
      );
    }
    const factor =
      part.level === config.baseUnit ? 1 : levelFactor(config, part.level);
    total += part.quantity * factor;
  }
  return total;
}

export function levelFactor(config: UnitConfig, levelName: string): number {
  if (levelName === config.baseUnit) return 1;
  const level = config.levels.find(l => l.name === levelName);
  if (!level) {
    throw new AppError(
      `Unknown unit "${levelName}". Known units: ${[
        config.baseUnit,
        ...config.levels.map(l => l.name),
      ].join(", ")}.`,
      400,
      "VALIDATION",
    );
  }
  return level.factor;
}

export interface UnitBreakdown {
  /** Largest-pack breakdown, e.g. [{name:"box",qty:7},{name:"strip",qty:6}] */
  levels: { name: string; label: string; quantity: number; factor: number }[];
  /** Remaining base units not covered by any level. */
  remainder: number;
}

/** Breaks a base-unit quantity into pack levels (largest first) + remainder. */
export function fromBaseUnits(config: UnitConfig, baseUnits: number): UnitBreakdown {
  let remaining = Math.floor(baseUnits);
  const levels: UnitBreakdown["levels"] = [];

  for (const level of config.levels) {
    if (remaining <= 0) break;
    const quantity = Math.floor(remaining / level.factor);
    remaining = remaining % level.factor;
    if (quantity > 0) {
      levels.push({
        name: level.name,
        label: level.label ?? level.name,
        quantity,
        factor: level.factor,
      });
    }
  }

  return { levels, remainder: remaining };
}

/** Simple English pluralizer for pack labels (box → boxes, strip → strips). */
function pluralize(word: string): string {
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(x|s|ss|sh|ch|z)$/i.test(word)) return `${word}es`;
  return `${word}s`;
}

/** "7 boxes, 6 strips, 4 tablets" style human-readable quantity. */
export function formatBaseUnits(config: UnitConfig, baseUnits: number): string {
  const { levels, remainder } = fromBaseUnits(config, baseUnits);
  const parts: string[] = [];
  for (const level of levels) {
    const label = level.label ?? level.name;
    parts.push(`${level.quantity} ${level.quantity === 1 ? label : pluralize(label)}`);
  }
  if (remainder > 0) {
    const label = config.baseUnitLabel ?? config.baseUnit;
    parts.push(`${remainder} ${remainder === 1 ? label : pluralize(label)}`);
  }
  if (parts.length === 0) return `0 ${pluralize(config.baseUnitLabel ?? config.baseUnit)}`;
  return parts.join(", ");
}

/**
 * Formats a quantity at the sale-unit granularity (rounded down), used by the
 * POS/billing surface, e.g. quantity 235 → "23 strips" for a strip seller.
 */
export function formatSaleUnits(config: UnitConfig, baseUnits: number): string {
  const saleUnits = Math.floor(baseUnits / config.saleUnitFactor);
  const remainder = baseUnits % config.saleUnitFactor;
  const label = config.saleUnit;
  if (saleUnits > 0 && remainder > 0) {
    const baseLabel = config.baseUnitLabel ?? config.baseUnit;
    return `${saleUnits} ${saleUnits === 1 ? label : pluralize(label)} + ${remainder} ${remainder === 1 ? baseLabel : pluralize(baseLabel)}`;
  }
  if (saleUnits > 0) return `${saleUnits} ${saleUnits === 1 ? label : pluralize(label)}`;
  const baseLabel = config.baseUnitLabel ?? config.baseUnit;
  return `${remainder} ${remainder === 1 ? baseLabel : pluralize(baseLabel)}`;
}
