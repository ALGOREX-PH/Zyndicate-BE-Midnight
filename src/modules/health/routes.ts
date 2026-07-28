import type { FastifyInstance } from "fastify";

/** Liveness, readiness (DB check), and JSON metrics. Registered at root. */
export function registerHealthRoutes(app: FastifyInstance): void {
  app.get("/healthz", { schema: { tags: ["health"], summary: "Liveness" } }, async () => ({
    status: "ok"
  }));

  app.get(
    "/readyz",
    { schema: { tags: ["health"], summary: "Readiness (database check)" } },
    async (_request, reply) => {
      try {
        app.sqlite.prepare("SELECT 1").get();
        return { status: "ready" };
      } catch (err) {
        app.log.error({ err }, "readiness check failed");
        return reply
          .status(503)
          .send({ error: { code: "NOT_READY", message: "Database unavailable" } });
      }
    }
  );

  app.get(
    "/metrics",
    { schema: { tags: ["health"], summary: "JSON request/error counters" } },
    async () => app.metrics.snapshot()
  );
}
