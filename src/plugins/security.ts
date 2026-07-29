import type { FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { Env } from "../config/env.js";

/**
 * Match an origin against one allowlist entry. A single leading `*` wildcard
 * in the host is supported so Vercel preview deployments
 * (`https://*.vercel.app`) can be allowed without opening CORS to everyone.
 * Anything else must match exactly.
 */
export function originAllowed(origin: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern === origin) return true;
    if (!pattern.includes("*")) return false;
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace("*", "[^.]+");
    return new RegExp(`^${escaped}$`).test(origin);
  });
}

/** Helmet defaults, CORS allowlist from env, and a global rate limit. */
export async function registerSecurity(app: FastifyInstance, env: Env): Promise<void> {
  await app.register(helmet);

  await app.register(cors, {
    // Same-origin and non-browser callers send no Origin header; only a
    // browser origin that is not on the allowlist is rejected.
    origin: (origin, callback) => {
      if (!origin || originAllowed(origin, env.corsOrigins)) return callback(null, true);
      callback(null, false);
    },
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
