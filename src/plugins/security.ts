import type { FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { Env } from "../config/env.js";

/** Helmet defaults, CORS allowlist from env, and a global rate limit. */
export async function registerSecurity(app: FastifyInstance, env: Env): Promise<void> {
  await app.register(helmet);

  await app.register(cors, {
    origin: env.corsOrigins,
    credentials: true
  });

  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    // The built error flows through our error handler, which wraps it into
    // the { error: { code, message } } envelope with code RATE_LIMITED.
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      code: "RATE_LIMITED",
      message: `Rate limit exceeded, retry in ${context.after}`
    })
  });
}
