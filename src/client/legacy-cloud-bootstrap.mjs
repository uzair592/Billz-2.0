import {
  createBrowserIndexedDbStorage,
  createBrowserOutbox,
  createLegacyCloudAdapter,
} from "./legacy-cloud-adapter.mjs";

const storage = createBrowserIndexedDbStorage();
const outbox = createBrowserOutbox({ storage });
const adapter = createLegacyCloudAdapter({ storage, outbox });

globalThis.BiteTechCloudSync = adapter;
globalThis.addEventListener("online", () => {
  adapter.flush().catch((error) => console.warn("Cloud order retry failed:", error));
});
adapter.flush().catch((error) => console.warn("Cloud order startup retry failed:", error));
