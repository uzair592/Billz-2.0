import { createCloudSessionClient } from "./cloud-session.mjs";
import {
  createBrowserIndexedDbStorage,
  createBrowserOutbox,
  createLegacyCloudAdapter,
} from "./legacy-cloud-adapter.mjs";

const storage = createBrowserIndexedDbStorage();
const session = createCloudSessionClient({ storage });
const outbox = createBrowserOutbox({ storage });
const adapter = createLegacyCloudAdapter({ storage, outbox, session });

globalThis.BiteTechCloudSession = session;
globalThis.BiteTechCloudSync = adapter;
globalThis.addEventListener("online", () => {
  adapter.flush().catch((error) => console.warn("Cloud order retry failed:", error));
});
adapter.flush().catch((error) => console.warn("Cloud order startup retry failed:", error));