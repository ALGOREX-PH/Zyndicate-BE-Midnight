import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildApp } from "./app.js";

/**
 * Load `.env` before any configuration is read. Node's built-in loader keeps
 * the runtime dependency-free and never overwrites variables that are already
 * present in the process environment, so real deployment secrets always win.
 */
function loadDotEnv(): void {
  const path = resolve(process.cwd(), process.env.ENV_FILE ?? ".env");
  if (existsSync(path)) process.loadEnvFile(path);
}

async function main(): Promise<void> {
  loadDotEnv();
  const app = await buildApp();
  const port = app.env.PORT;

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ port, host: "0.0.0.0" });
    app.log.info(`Zyndicate coordination service listening on :${port}`);
  } catch (err) {
    app.log.error({ err }, "failed to start");
    process.exit(1);
  }
}

void main();
