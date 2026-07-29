import { describe, expect, it } from "vitest";
import { originAllowed } from "../src/plugins/security.js";

/**
 * The wildcard exists so Vercel preview deployments can reach the API without
 * listing every generated URL. It must stay narrow: one label, no cross-domain
 * escape, no substring matches.
 */
describe("cors origin matching", () => {
  const allowlist = ["https://zyndicate.vercel.app", "https://*.vercel.app"];

  it("accepts an exact origin", () => {
    expect(originAllowed("https://zyndicate.vercel.app", allowlist)).toBe(true);
  });

  it("accepts a preview deployment via the wildcard", () => {
    expect(originAllowed("https://zyndicate-git-main-algorex.vercel.app", allowlist)).toBe(true);
  });

  it("rejects an unrelated origin", () => {
    expect(originAllowed("https://evil.example", allowlist)).toBe(false);
  });

  it("rejects a look-alike suffix domain", () => {
    expect(originAllowed("https://vercel.app.evil.com", allowlist)).toBe(false);
    expect(originAllowed("https://notvercel.app", allowlist)).toBe(false);
  });

  it("does not let the wildcard span dots into another domain", () => {
    expect(originAllowed("https://evil.com.vercel.app.evil.com", allowlist)).toBe(false);
    expect(originAllowed("https://a.b.vercel.app", allowlist)).toBe(false);
  });

  it("respects the scheme", () => {
    expect(originAllowed("http://zyndicate.vercel.app", allowlist)).toBe(false);
  });

  it("matches nothing when the allowlist is empty", () => {
    expect(originAllowed("https://zyndicate.vercel.app", [])).toBe(false);
  });

  it("treats a plain entry as exact, never as a prefix", () => {
    expect(originAllowed("https://zyndicate.vercel.app.evil.com", ["https://zyndicate.vercel.app"]))
      .toBe(false);
  });
});
