import { z } from "zod";

/**
 * Fallback signing secret for local development only. A production boot with
 * this value is refused — it would let anyone mint valid session tokens.
 */
export const DEV_JWT_SECRET = "zyndicate-dev-secret-do-not-use-in-production";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  JWT_SECRET: z.string().min(16).default(DEV_JWT_SECRET),
  CORS_ORIGINS: z.string().default("http://localhost:5173"),
  DATABASE_PATH: z.string().default("./data/zyndicate.db"),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_WINDOW: z.string().default("1 minute"),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(10),
  TRIBUNAL_KEYS: z.string().default("")
});

export type Env = z.infer<typeof envSchema> & {
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
    corsOrigins: parsed.CORS_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    tribunalKeys: parsed.TRIBUNAL_KEYS.split(",")
      .map((key) => key.trim().toLowerCase())
      .filter((key) => key.length > 0)
  };
}
