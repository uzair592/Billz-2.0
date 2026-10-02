import vm from "node:vm";
import {
  extractDeclaration,
  extractInlineScript,
  readLegacyApp,
} from "./legacy-source.mjs";

async function legacyScript() {
  return extractInlineScript(await readLegacyApp());
}

export async function loadLegacyMoneyEngine() {
  const source = await legacyScript();
  const declaration = extractDeclaration(
    source,
    "const MoneyEngine = Object.freeze(",
    "const ValidationEngine = Object.freeze(",
  );

  return vm.runInNewContext(`${declaration}\nMoneyEngine;`, Object.create(null));
}

export async function loadLegacyOrderStatusFunctions() {
  const source = await legacyScript();
  const getStatus = extractDeclaration(
    source,
    "function getOrderStatus(order)",
    "function isOrderRevenueCounted(order)",
  );
  const isRevenueCounted = extractDeclaration(
    source,
    "function isOrderRevenueCounted(order)",
    "// Breaks one order line",
  );

  return vm.runInNewContext(
    `${getStatus}\n${isRevenueCounted}\n({ getOrderStatus, isOrderRevenueCounted });`,
    Object.create(null),
  );
}
