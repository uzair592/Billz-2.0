import { runServer } from "../../src/server/main.mjs";

// Starts the server, then triggers an unhandled rejection. The
// process must shut down orderly and exit non-zero.
const port = Number(process.argv[2] ?? 0);
runServer({
  env: process.env,
  logger: { info() {}, warn() {}, error() {} },
}).then(() => {
  // The server is running. Trigger an unhandled rejection on the
  // next tick so the process-level handler fires.
  setTimeout(() => {
    Promise.reject(new Error("deliberate unhandled rejection"));
  }, 100);
});
