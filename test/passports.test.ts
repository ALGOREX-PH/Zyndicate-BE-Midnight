import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  auth,
  buildTestApp,
  commitment,
  createActor,
  createMandate,
  evaluate,
  runToSubmitted,
  settle,
  type Actor
} from "./helpers.js";

describe("passports and receipts", () => {
  let app: FastifyInstance;
  let principal: Actor;
  let operator: Actor;

  beforeAll(async () => {
    app = await buildTestApp();
    principal = await createActor(app);
    operator = await createActor(app);
  });
  afterAll(async () => {
    await app.close();
  });

  it("registers credential commitments on the caller's passport", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/passports/credentials",
      headers: auth(operator),
      payload: {
        domain: "security",
        kind: "capability",
        commitment: commitment("credential")
      }
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().credential.passportKey).toBe(operator.publicKey);

    const anon = await app.inject({
      method: "POST",
      url: "/api/v1/passports/credentials",
      payload: { domain: "security", kind: "capability", commitment: commitment("x") }
    });
    expect(anon.statusCode).toBe(401);
  });

  it("serves a public coarse passport with no raw history", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/passports/${operator.publicKey}`
    });
    expect(res.statusCode).toBe(200);
    const { passport } = res.json();
    expect(passport.publicKey).toBe(operator.publicKey);
    expect(passport.identityClass).toBe("credentialed_operator");
    expect(passport.domains).toContain("security");
    expect(passport.completionBand).toBe("none");
    // Coarse only: no counts, no mandate ids, no counterparties.
    expect(JSON.stringify(passport)).not.toContain("man_");
    expect(passport.completions).toBeUndefined();

    const missing = await app.inject({
      method: "GET",
      url: `/api/v1/passports/${"f".repeat(64)}`
    });
    expect(missing.statusCode).toBe(404);
  });

  it("upgrades the completion band after a settled mandate", async () => {
    const id = await createMandate(app, principal);
    await runToSubmitted(app, principal, operator, id);
    await evaluate(app, principal, id, "accept");
    expect((await settle(app, principal, id)).statusCode).toBe(201);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/passports/${operator.publicKey}`
    });
    expect(res.json().passport.completionBand).toBe("emerging");
  });

  it("lists receipts for the holder only", async () => {
    const receipts = await app.inject({
      method: "GET",
      url: "/api/v1/me/receipts",
      headers: auth(operator)
    });
    expect(receipts.statusCode).toBe(200);
    for (const receipt of receipts.json().items) {
      expect(receipt.holderKey).toBe(operator.publicKey);
      expect(receipt.receiptCommitment).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
