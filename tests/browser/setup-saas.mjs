import { provisionIntegrationDatabase, createControlPool, seedPlan } from "../helpers/postgres.mjs";
export default async function setup() {
  await provisionIntegrationDatabase();
  const pool = await createControlPool();
  try { await seedPlan(pool, { code: "GROWTH", provider: "manual" }); }
  finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) await setup();
