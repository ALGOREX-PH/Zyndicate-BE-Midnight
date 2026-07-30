import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";

/**
 * A malformed numeric env var (a stray "PORT=NaN" in a hosting dashboard,
 * an empty value, etc.) must never crash the whole process. It happened once
 * on Render — the fallback must survive it, while a genuinely invalid number
 * (negative, zero, non-integer) still fails loudly.
 */
describe("numeric env fallback", () => {
  const base = { NODE_ENV: "test", JWT_SECRET: "test-secret-test-secret-test-secret" };

  it("falls back to the default when PORT is a non-numeric string", () => {
    expect(loadEnv({ ...base, PORT: "NaN" }).PORT).toBe(4000);
    expect(loadEnv({ ...base, PORT: "abc" }).PORT).toBe(4000);
  });

  it("falls back to the default when PORT is blank or absent", () => {
    expect(loadEnv({ ...base, PORT: "" }).PORT).toBe(4000);
    expect(loadEnv({ ...base }).PORT).toBe(4000);
  });

  it("uses a real numeric PORT when one is provided", () => {
    expect(loadEnv({ ...base, PORT: "10000" }).PORT).toBe(10000);
    expect(loadEnv({ ...base, PORT: " 8080 " }).PORT).toBe(8080);
  });

  it("still rejects a numeric-but-invalid PORT", () => {
    expect(() => loadEnv({ ...base, PORT: "-5" })).toThrow();
    expect(() => loadEnv({ ...base, PORT: "0" })).toThrow();
    expect(() => loadEnv({ ...base, PORT: "3.7" })).toThrow();
  });

  it("applies the same fallback to the rate limit vars", () => {
    expect(loadEnv({ ...base, RATE_LIMIT_MAX: "NaN" }).RATE_LIMIT_MAX).toBe(120);
    expect(loadEnv({ ...base, RATE_LIMIT_AUTH_MAX: "" }).RATE_LIMIT_AUTH_MAX).toBe(10);
  });
});
