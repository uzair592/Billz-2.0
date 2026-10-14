import { LEGACY_SNAPSHOT_KEYS } from "./legacy-catalog-snapshot.mjs";

const DRAFT_KEYS = ["pos_menu", "pos_categories", "pos_subcategories", "pos_category_offers"];
export function catalogFingerprint(snapshot) {
  return JSON.stringify(DRAFT_KEYS.map(key => snapshot[key] ?? null));
}

export async function refreshSharedCatalog({ storage, restaurantId, fetchImpl = globalThis.fetch, force = false }) {
  const response = await fetchImpl("/api/pos/catalog", { credentials: "same-origin", cache: "no-store", headers: { "x-restaurant-id": restaurantId } });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || "Could not refresh the shared menu."), { status: response.status });
  const account = await storage.get("pos_cloud_session_v1");
  if (account?.restaurantId && account.restaurantId !== restaurantId) throw new Error("Restaurant changed while the catalog was loading. Refresh the page.");
  if (!data.snapshot) return { status: "not_published" };
  const context = await storage.get("pos_cloud_context_v1");
  const baseline = await storage.get("pos_catalog_baseline");
  if (!force && context?.restaurantId === restaurantId && baseline) {
    const local = Object.fromEntries(await Promise.all(DRAFT_KEYS.map(async key => [key, await storage.get(key)])));
    if (catalogFingerprint(local) !== baseline) return { status: "local_draft", revision: data.revision };
  }
  const records = Object.fromEntries(LEGACY_SNAPSHOT_KEYS.filter(key => key in data.snapshot).map(key => [key, data.snapshot[key]]));
  records.pos_cloud_context_v1 = { version: 1, restaurantId, revision: data.revision, mappings: data.mappings };
  records.pos_catalog_baseline = catalogFingerprint(data.snapshot);
  const current = await storage.get("pos_cloud_session_v1");
  if (current?.restaurantId && current.restaurantId !== restaurantId) throw new Error("Restaurant changed while the catalog was loading. Refresh the page.");
  // Catalog and UUID mappings become visible together in one IndexedDB transaction.
  await storage.setMany(records);
  return { status: "refreshed", revision: data.revision };
}
