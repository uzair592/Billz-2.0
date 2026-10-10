import { createDatabasePool } from "./database/pool.mjs";
import { createPlatformAdminRepository } from "./auth/platform-admin-repository.mjs";
import { createPlatformAdminService } from "./auth/platform-admin-service.mjs";

// Passwords are environment input, never command-line arguments or log output.
const username = process.env.BOOTSTRAP_ADMIN_USERNAME;
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
const pepper = process.env.PASSWORD_PEPPER;
if (!username || !password || password.length < 10 || !pepper || pepper.length < 16) {
  console.error("Set BOOTSTRAP_ADMIN_USERNAME, BOOTSTRAP_ADMIN_PASSWORD (10+ characters), and PASSWORD_PEPPER (16+ characters).");
  process.exit(1);
}
const pool = createDatabasePool({ ...process.env,
  DATABASE_URL: process.env.CONTROL_DATABASE_URL || process.env.DATABASE_URL });
try {
  const service = createPlatformAdminService({ repository: createPlatformAdminRepository(pool), passwordPepper: pepper });
  const result = await service.bootstrapAdmin({ username, password,
    displayName: process.env.BOOTSTRAP_ADMIN_DISPLAY_NAME || "Super Administrator" });
  console.log(result.created ? "Platform administrator created." : "Platform administrator already exists.");
} catch (error) {
  console.error("Administrator bootstrap failed:", error.message);
  process.exitCode = 1;
} finally { await pool.end(); }
