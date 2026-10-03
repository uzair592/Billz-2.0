import pg from "pg";

const ADMIN_DATABASE_URL =
  process.env.TEST_DATABASE_ADMIN_URL
  ?? "postgresql://postgres:validation-only@127.0.0.1:55432/restaurant_pos_test";

async function checkDatabase() {
  const pool = new pg.Pool({ connectionString: ADMIN_DATABASE_URL, max: 1 });
  try {
    await pool.query("SELECT 1");
    console.log("Database connection successful");
    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error("Database connection failed:", error.message);
    console.error("Integration tests require a running PostgreSQL database.");
    console.error("Start it with: docker compose -f compose.test-database.yaml up -d");
    await pool.end();
    process.exit(1);
  }
}

checkDatabase();