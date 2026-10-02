import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createBusinessSettingsService } from "../src/server/pos/business-settings-service.mjs";
import { createMenuService } from "../src/server/pos/menu-service.mjs";

const restaurantId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";

function poolFor(handler) {
  const calls = [];
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text) || text.startsWith("SET LOCAL") || text.includes("set_config(")) {
        return { rows: [] };
      }
      return handler(text, values, calls);
    },
    release() {},
  };
  return { calls, async connect() { return client; } };
}

describe("server-backed POS services", () => {
  it("loads active menu data inside the authenticated restaurant transaction", async () => {
    const pool = poolFor((text) => {
      if (text.includes("FROM menu_categories")) {
        return { rows: [{ id: "cat-1", name: "Pizza", sort_order: 1 }] };
      }
      if (text.includes("FROM menu_subcategories")) {
        return { rows: [{ id: "sub-1", category_id: "cat-1", name: "Large", sort_order: 1 }] };
      }
      if (text.includes("FROM menu_items")) {
        return { rows: [{
          id: "item-1", item_number: 1, category_id: "cat-1",
          subcategory_id: "sub-1", name: "Large Pizza", description: null,
          item_type: "standard", price_minor: "120000", image_object_key: null,
          metadata: {},
        }] };
      }
      return { rows: [] };
    });
    const result = await createMenuService(pool).list({ restaurantId, userId });

    assert.equal(result.categories[0].name, "Pizza");
    assert.equal(result.items[0].priceMinor, 120000);
    const tenantCall = pool.calls.find((call) => call.text.includes("set_config('app.restaurant_id'"));
    assert.deepEqual(tenantCall.values, [restaurantId]);
  });

  it("updates only accepted business fields and returns authoritative values", async () => {
    let saved = {
      restaurant_id: restaurantId,
      default_branch_id: "branch-1",
      business_name: "Old Cafe",
      phone: "111",
      address: "Old address",
      slogan: null,
      logo_object_key: null,
      timezone: "Asia/Karachi",
      currency_code: "PKR",
    };
    const pool = poolFor((text, values) => {
      if (text.includes("FROM business_settings")) return { rows: [saved] };
      if (text.includes("UPDATE business_settings")) {
        saved = { ...saved, business_name: values[1], phone: values[2], address: values[3], slogan: values[4] };
      }
      if (text.includes("UPDATE restaurants")) {
        saved = { ...saved, timezone: values[4], currency_code: values[5] };
      }
      return { rows: [] };
    });
    const result = await createBusinessSettingsService(pool).update({
      restaurantId,
      userId,
      changes: { businessName: "New Cafe", phone: null, currencyCode: "USD" },
    });

    assert.equal(result.businessName, "New Cafe");
    assert.equal(result.phone, null);
    assert.equal(result.address, "Old address");
    assert.equal(result.currencyCode, "USD");
  });
});
