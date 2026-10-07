import { pool } from "./database/pool.mjs";
import { createPlatformAdminRepository } from "./auth/platform-admin-repository.mjs";
import { createPlatformAdminService } from "./auth/platform-admin-service.mjs";

const username = process.argv[2];
const password = process.argv[3];
const displayName = process.argv[4] || "Super Administrator";

if (!username || !password) {
  console.error("Usage: node src/server/bootstrap-platform-admin.mjs <username> <password> [displayName]");
  process.exit(1);
}

const pepper = process.env.PASSWORD_PEPPER || "test-pepper-for-development-only";
const repository = createPlatformAdminRepository(pool);
const adminService = createPlatformAdminService({ repository, passwordPepper: pepper });

try {
  const result = await adminService.bootstrapAdmin({ username, password, displayName });
  if (result.created) {
    console.log(`Successfully created platform administrator: ${result.admin.username} (${result.admin.id})`);
  } else {
    console.log(`Platform administrator already exists: ${result.admin.username} (${result.admin.id})`);
  }
} catch (error) {
  console.error("Failed to bootstrap platform administrator:", error.message);
  process.exit(1);
} finally {
  await pool.end();
}
