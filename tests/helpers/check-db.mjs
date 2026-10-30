import pg from "pg";

const ADMIN_DATABASE_URL =
  process.env.TEST_DATABASE_ADMIN_URL
  ?? "postgresql://postgres:postgres@127.0.0.1:5432/restaurant_pos_test";

async function checkDatabase() {
  const pool = new pg.Pool({ connectionString: ADMIN_DATABASE_URL, max: 1 });
  try {
    await pool.query("SELECT 1");
    console.log("Database connection successful");
    await pool.end();
    process.exit(0);
  } catch (error) {
    let host = "127.0.0.1";
    let port = "5432";
    try {
      const parsed = new URL(ADMIN_DATABASE_URL);
      host = parsed.hostname || host;
      port = parsed.port || port;
    } catch {}
    console.error(
      `Database prerequisite error: PostgreSQL is not reachable at ${host}:${port}.\n` +
      `PostgreSQL-dependent tests require a running database.\n` +
      `Configure TEST_DATABASE_ADMIN_URL (configured ports: 5432 local/CI, 55432 validation container).\n` +
      `Original error: ${error.message}`
    );
    await pool.end();
    process.exit(1);
  }
}

checkDatabase();