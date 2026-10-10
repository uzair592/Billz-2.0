import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readLegacyApp, extractInlineScript, extractDeclaration } from "./helpers/legacy-source.mjs";

const source = extractInlineScript(await readLegacyApp());
const escaping = extractDeclaration(source, "function escapeHtmlForExport(str)", "function exportOrdersHistoryToExcel()");
const canary = '<img src=x onerror="globalThis.injected=true">';
const decodeAttribute = text => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

test("management menu treats descriptions and linked deal names as text", () => {
  const rows = [];
  const tbody = { innerHTML: "", appendChild: row => rows.push(row.innerHTML) };
  const context = vm.createContext({
    menuItems: [
      { id: 1, name: canary, category: "Burgers", price: 100 },
      { id: 2, name: "Deal", desc: canary, category: "Deals", price: 200, dealComponents: [{ itemId: 1, qty: 2 }] },
    ],
    managementMenuCategoryFilter: "All", managementMenuSearchQuery: "", categoryOffers: {},
    document: { getElementById: id => id === "management-menu-rows" ? tbody : {}, createElement: () => ({ style: {} }) },
    isDealMenuItem: item => item.category === "Deals", computeItemCostPrice: () => 0,
  });
  vm.runInContext(escaping + extractDeclaration(source, "function renderManagementMenuTable()", "function populateFormCategoryDropdown()") + "\nrenderManagementMenuTable();", context);
  assert.ok(rows.every(row => !row.includes("<img")), rows.join("\n"));
  assert.ok(rows[0].includes("2× &lt;img"));
  assert.ok(rows[0].includes("Consists: &lt;img"));
});

test("stock filters escape labels and preserve hostile keys as a single handler argument", () => {
  const key = "stock');globalThis.injected=true;//";
  const container = { innerHTML: "" };
  const context = vm.createContext({
    stockItemDefs: { [key]: { label: canary, icon: canary } },
    STOCK_GROUPS: { kitchen: { filterOptions: "options", filterBadge: "badge" } },
    selectedStockHistoryIngredientFilters: { kitchen: [] }, getStockItemGroup: () => "kitchen",
    document: { getElementById: id => id === "options" ? container : null },
    toggleStockHistoryIngredientFilter: (...args) => { context.argumentsReceived = args; },
  });
  vm.runInContext(escaping + extractDeclaration(source, "function renderStockHistoryIngredientFilterOptions(", "function toggleStockHistoryIngredientFilter(") + "\nrenderStockHistoryIngredientFilterOptions();", context);
  assert.ok(!container.innerHTML.includes("<img"));
  const handler = decodeAttribute(container.innerHTML.match(/onchange="([^"]+)"/)[1]);
  vm.runInContext(`(function(){${handler}\n}).call({checked:true});`, context);
  assert.equal(context.injected, undefined);
  assert.deepEqual(context.argumentsReceived, [key, true, "kitchen"]);
});

test("expense category options escape both labels and attribute values", () => {
  const select = { innerHTML: "", value: "", appendChild() {} };
  const context = vm.createContext({
    expenseFields: [{ key: `"><img src=x>`, label: canary }], lastValidExpenseField: null,
    document: { getElementById: () => select, createElement: () => ({ style: {} }) },
  });
  vm.runInContext(escaping + extractDeclaration(source, "function populateExpenseFieldSelect()", "function onExpenseFieldSelectChange()") + "\npopulateExpenseFieldSelect();", context);
  assert.ok(!select.innerHTML.includes("<img"), select.innerHTML);
  assert.ok(select.innerHTML.includes('value="&quot;&gt;&lt;img'));
});

test("removing a managed preference uses the same tenant namespace as reads and writes", () => {
  const data = new Map();
  const store = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  const context = vm.createContext({ window: { BILLZ_MANAGED: true, BILLZ_TENANT_ID: "a", localStorage: store, sessionStorage: store } });
  vm.runInContext(extractDeclaration(source, "const memoryStorageFallback =", "async function migrateOldLocalStorageDataIfNeeded()"), context);
  for (const session of [false, true]) {
    context.useSession = session;
    vm.runInContext('safeStorageSet("setting", "A", useSession); window.BILLZ_TENANT_ID="b"; safeStorageSet("setting", "B", useSession); window.BILLZ_TENANT_ID="a"; safeStorageRemove("setting", useSession);', context);
    assert.equal(vm.runInContext('safeStorageGet("setting", useSession)', context), null);
    context.window.BILLZ_TENANT_ID = "b";
    assert.equal(vm.runInContext('safeStorageGet("setting", useSession)', context), "B");
    context.window.BILLZ_TENANT_ID = "a";
  }
});

test("deal summaries remain plain text until inserted into HTML", () => {
  const context = vm.createContext({ menuItems: [{ id: 1, name: "Fish & Chips" }], dealBuilderComponents: [{ itemId: 1, qty: 2 }] });
  vm.runInContext(escaping + extractDeclaration(source, "function buildDealComponentsSummaryText()", "function syncDealDescriptionFromComponents()"), context);
  assert.equal(vm.runInContext("buildDealComponentsSummaryText()", context), "2× Fish & Chips");
});
