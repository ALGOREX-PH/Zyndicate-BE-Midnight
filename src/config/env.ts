import { z } from "zod";

/**
 * Fallback signing secret for local development only. A production boot with
 * this value is refused — it would let anyone mint valid session tokens.
 */
export const DEV_JWT_SECRET = "zyndicate-dev-secret-do-not-use-in-production";

/**
 * A numeric env var that falls back to its default when the raw value is
 * absent, blank, or not a number at all (e.g. a stray "NaN" left behind in a
 * hosting dashboard) instead of crash-looping the process. A value that
 * parses as a number but fails a real constraint (negative, zero, non-integer)
 * still fails loudly — that is a genuine misconfiguration, not noise.
 */
function numericEnv(fallback: number) {
  return z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (trimmed === "") return undefined;
    return Number.isFinite(Number(trimmed)) ? trimmed : undefined;
  }, z.coerce.number().int().positive().default(fallback));
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: numericEnv(4000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  JWT_SECRET: z.string().min(16).default(DEV_JWT_SECRET),
  CORS_ORIGINS: z.string().default("http://localhost:5173"),
  DATABASE_PATH: z.string().default("./data/zyndicate.db"),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_WINDOW: z.string().default("1 minute"),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(10),
  TRIBUNAL_KEYS: z.string().default(""),
  /**
   * Trust `X-Forwarded-*` headers. Required behind a managed load balancer
   * (Render, Fly, a reverse proxy): without it every request carries the
   * proxy's IP, so rate limiting collapses into one shared bucket for all
   * callers. Defaults on in production, off elsewhere so local runs and tests
   * cannot be spoofed by a forged header.
   */
  TRUST_PROXY: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === undefined ? undefined : value === "true")
});

export type Env = z.infer<typeof envSchema> & {
  /** Resolved from TRUST_PROXY, defaulting to true in production. */
  trustProxy: boolean;
  corsOrigins: string[];
  tribunalKeys: string[];
};

/**
 * Parse and validate configuration. `overrides` take precedence over
 * process.env, which lets tests build isolated app instances.
 */
export function loadEnv(overrides: Partial<Record<string, string>> = {}): Env {
  const parsed = envSchema.parse({ ...process.env, ...overrides });
  if (parsed.NODE_ENV === "production" && parsed.JWT_SECRET === DEV_JWT_SECRET) {
    throw new Error(
      "JWT_SECRET must be set to a unique secret when NODE_ENV=production"
    );
  }
  return {
    ...parsed,
    trustProxy: parsed.TRUST_PROXY ?? parsed.NODE_ENV === "production",
    corsOrigins: parsed.CORS_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    tribunalKeys: parsed.TRIBUNAL_KEYS.split(",")
      .map((key) => key.trim().toLowerCase())
      .filter((key) => key.length > 0)
  };
}
