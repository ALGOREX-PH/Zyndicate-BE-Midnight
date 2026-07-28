import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  JWT_SECRET: z
    .string()
    .min(16)
    .default("zyndicate-dev-secret-do-not-use-in-production"),
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
