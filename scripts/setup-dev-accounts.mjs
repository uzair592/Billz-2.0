import { createDatabasePool } from "../src/server/database/pool.mjs";
import { bootstrapFirstRestaurant } from "../src/server/bootstrap-first-restaurant.mjs";
import { createPlatformAdminRepository } from "../src/server/auth/platform-admin-repository.mjs";
import { createPlatformAdminService } from "../src/server/auth/platform-admin-service.mjs";

const pool = createDatabasePool({
  ...process.env,
  DATABASE_URL: process.env.CONTROL_DATABASE_URL || process.env.DATABASE_URL,
});

async function main() {
  const pepper = process.env.PASSWORD_PEPPER || "test-pepper-for-development-only";

  console.log("1. Bootstrapping platform admin (admin / SuperAdminPass123!)...");
  try {
    const adminRepo = createPlatformAdminRepository(pool);
    const adminService = createPlatformAdminService({ repository: adminRepo, passwordPepper: pepper });
    await adminService.bootstrapAdmin({
      username: "admin",
      password: "SuperAdminPass123!",
      displayName: "Lead Super Admin",
    });
    console.log("Platform admin ready.");
  } catch (err) {
    console.log("Admin setup:", err.message);
  }

  console.log("2. Bootstrapping restaurant (owner / RestaurantOwner123!)...");
  try {
    const result = await bootstrapFirstRestaurant({
      pool,
      input: {
        restaurantName: "Tasty Bites POS",
        slug: "tasty-bites",
        timezone: "Asia/Karachi",
        currencyCode: "PKR",
        branchName: "Main Branch",
        branchCode: "main",
        ownerEmail: "owner@tastybites.com",
        ownerUsername: "owner",
        ownerDisplayName: "Restaurant Owner",
        ownerPassword: "RestaurantOwner123!",
        subscriptionPlan: "GROWTH",
        subscriptionStatus: "active",
        pepper,
      },
      logger: console,
      interactive: false,
    });
    console.log("Restaurant & owner bootstrapped successfully:", result);
  } catch (err) {
    console.log("Restaurant setup error:", err.message);
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error("Setup error:", err);
  process.exit(1);
});
