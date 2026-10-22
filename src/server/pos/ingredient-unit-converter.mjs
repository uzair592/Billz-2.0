import { apiError } from "./business-date.mjs";

/**
 * Normalizes unit strings and converts an extra quantity to base units.
 *
 * Supported units:
 * - Weight: 'g', 'gram', 'grams' -> base 'gram'
 *           'kg', 'kilogram', 'kilograms' -> 1000 * base 'gram'
 * - Count:  'pc', 'pcs', 'piece', 'pieces', 'number', 'unit', 'units' -> count
 * - Volume: 'ml', 'millilitre', 'milliliter' -> base 'millilitre'
 *           'l', 'litre', 'liter' -> 1000 * base 'millilitre'
 *
 * Contract:
 * 1. If extra.unit is specified:
 *    - Convert based on the specified unit and item definition.
 *    - If unit is incompatible or unsupported, reject with INVALID_EXTRA_UNIT.
 * 2. If extra.unit is NOT specified:
 *    - If def.base_unit === 'gram':
 *        If def.sell_unit === 'number' and def.base_units_per_sell_unit > 0:
 *          User entered piece count -> qty * def.base_units_per_sell_unit grams.
 *        Else:
 *          User entered grams (UI prompt 'Amount (g)') -> qty grams (1:1).
 *    - If def.base_unit === 'piece':
 *        User entered pieces -> qty pieces (1:1).
 *    - If def.base_unit === 'millilitre':
 *        User entered ml -> qty ml (1:1).
 */
export function resolveExtraBaseUnitsPerItem(extra, def) {
  const qty = Number(extra.quantity ?? extra.qty);
  if (!Number.isFinite(qty) || qty <= 0) {
    throw apiError("Extra ingredient quantity must be positive.", "INVALID_EXTRA_QUANTITY", 400);
  }

  const rawUnit = extra.unit ? String(extra.unit).trim().toLowerCase() : null;
  const baseUnit = String(def.base_unit || "").toLowerCase();
  const sellUnit = String(def.sell_unit || "").toLowerCase();
  const baseUnitsPerSell = Number(def.base_units_per_sell_unit) || 1;

  if (rawUnit) {
    // Weight units
    if (["g", "gram", "grams"].includes(rawUnit)) {
      if (baseUnit !== "gram") {
        throw apiError(`Cannot use weight unit '${rawUnit}' for item '${def.name}' with base unit '${baseUnit}'.`, "INVALID_EXTRA_UNIT", 400);
      }
      return qty;
    }
    if (["kg", "kilogram", "kilograms"].includes(rawUnit)) {
      if (baseUnit !== "gram") {
        throw apiError(`Cannot use weight unit '${rawUnit}' for item '${def.name}' with base unit '${baseUnit}'.`, "INVALID_EXTRA_UNIT", 400);
      }
      return qty * 1000;
    }

    // Count units
    if (["pc", "pcs", "piece", "pieces", "number", "unit", "units"].includes(rawUnit)) {
      if (baseUnit === "piece") {
        return qty;
      }
      if (baseUnit === "gram") {
        if ((sellUnit === "number" || sellUnit === "piece") && baseUnitsPerSell > 0) {
          return qty * baseUnitsPerSell;
        }
        throw apiError(`Cannot convert count unit '${rawUnit}' to weight for '${def.name}' without pieces configuration.`, "INVALID_EXTRA_UNIT", 400);
      }
      throw apiError(`Cannot use count unit '${rawUnit}' for item '${def.name}' with base unit '${baseUnit}'.`, "INVALID_EXTRA_UNIT", 400);
    }

    // Volume units
    if (["ml", "millilitre", "milliliter"].includes(rawUnit)) {
      if (baseUnit !== "millilitre") {
        throw apiError(`Cannot use volume unit '${rawUnit}' for item '${def.name}' with base unit '${baseUnit}'.`, "INVALID_EXTRA_UNIT", 400);
      }
      return qty;
    }
    if (["l", "litre", "liter"].includes(rawUnit)) {
      if (baseUnit !== "millilitre") {
        throw apiError(`Cannot use volume unit '${rawUnit}' for item '${def.name}' with base unit '${baseUnit}'.`, "INVALID_EXTRA_UNIT", 400);
      }
      return qty * 1000;
    }

    throw apiError(`Unsupported unit '${rawUnit}' for extra '${def.name}'.`, "INVALID_EXTRA_UNIT", 400);
  }

  // Unit not specified (UI default / legacy fallback)
  if (baseUnit === "gram") {
    if ((sellUnit === "number" || sellUnit === "piece") && baseUnitsPerSell > 0) {
      return qty * baseUnitsPerSell;
    }
    // E.g. Chicken (base_unit=gram, sell_unit=kg, conv=1000) or Cheese (base_unit=gram, sell_unit=kg)
    // The UI enters grams ("Amount (g)"), so 50 means 50 grams!
    return qty;
  }
  if (baseUnit === "piece") {
    return qty;
  }
  if (baseUnit === "millilitre") {
    return qty;
  }

  return qty;
}

export function formatExtraDisplay(name, quantityBaseUnits, def) {
  const baseUnit = String(def?.base_unit || "").toLowerCase();
  const sellUnit = String(def?.sell_unit || "").toLowerCase();
  const conversion = Number(def?.base_units_per_sell_unit) || 1;

  if (baseUnit === "piece") {
    return { name, quantity: Number(quantityBaseUnits), unit: "pcs" };
  }
  if (baseUnit === "gram") {
    if ((sellUnit === "number" || sellUnit === "piece") && conversion > 0) {
      const pcs = Number(quantityBaseUnits) / conversion;
      return { name, quantity: Math.round(pcs * 100) / 100, unit: "pcs" };
    }
    return { name, quantity: Number(quantityBaseUnits), unit: "g" };
  }
  return { name, quantity: Number(quantityBaseUnits), unit: baseUnit || "" };
}
