import { provisionIntegrationDatabase, createControlPool, seedPlan } from "../helpers/postgres.mjs";
export default async function setup() {
  await provisionIntegrationDatabase();
  const pool = await createControlPool();
  try { await seedPlan(pool, { code: "GROWTH", provider: "manual" }); }
  finally { await pool.end(); }
}
