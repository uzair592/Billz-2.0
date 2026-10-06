import { createServer } from "../../src/server/main.mjs";
import { runServer } from "../../src/server/main.mjs";

// Starts the server, then triggers a shutdown whose close()
// never resolves, forcing the grace-timeout force-exit. The
// process must exit non-zero because the shutdown was forced.
const port = Number(process.argv[2] ?? 0);

runServer({
  env: process.env,
  logger: { info() {}, warn() {}, error() {} },
  shutdownGraceMs: 500,
}).then((server) => {
  // Replace close() with one that never resolves so the
  // graceful path stalls and the force-exit timer fires.
  server.close = () => new Promise(() => {});
  // Trigger a graceful shutdown that will be forced.
  process.kill(process.pid, "SIGTERM");
});
