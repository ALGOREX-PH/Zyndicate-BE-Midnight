import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp } from "./helpers.js";

describe("health and metrics", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it("reports liveness", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("reports readiness with a database check", async () => {
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready" });
  });

  it("counts requests per module in /metrics", async () => {
    await app.inject({ method: "GET", url: "/api/v1/mandates" });
    await app.inject({ method: "GET", url: "/api/v1/mandates" });
    await app.inject({ method: "GET", url: "/api/v1/me" }); // 401 -> auth module

    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.requests).toBeGreaterThanOrEqual(3);
    expect(body.modules.mandates.requests).toBeGreaterThanOrEqual(2);
    expect(body.modules.auth.requests).toBeGreaterThanOrEqual(1);
    expect(typeof body.uptimeSeconds).toBe("number");
  });

  it("serves the OpenAPI docs", async () => {
    const res = await app.inject({ method: "GET", url: "/docs" });
    expect([200, 302]).toContain(res.statusCode);
  });

  it("returns the structured envelope for unknown routes", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });
});
