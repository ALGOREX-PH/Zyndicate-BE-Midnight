import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import type { FastifyInstance } from "fastify";
import { auth, buildTestApp, createActor, hex } from "./helpers.js";

describe("auth", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it("issues a challenge and verifies an ed25519 signature", async () => {
    const actor = await createActor(app);
    expect(actor.token).toBeTruthy();

    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: auth(actor) });
    expect(me.statusCode).toBe(200);
    expect(me.json().identity.publicKey).toBe(actor.publicKey);
  });

  it("rejects a bad signature", async () => {
    const privateKey = ed25519.utils.randomPrivateKey();
    const publicKey = hex(ed25519.getPublicKey(privateKey));
    const challenge = await app.inject({
      method: "POST",
      url: "/api/v1/auth/challenge",
      payload: { publicKey }
    });
    const { nonce } = challenge.json();

    const wrongKey = ed25519.utils.randomPrivateKey();
    const signature = hex(
      ed25519.sign(Buffer.from(`zyndicate:auth:${nonce}`, "utf8"), wrongKey)
    );
    const verify = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify",
      payload: { publicKey, nonce, signature }
    });
    expect(verify.statusCode).toBe(401);
    expect(verify.json().error.code).toBe("UNAUTHORIZED");
  });

  it("rejects a consumed nonce (no replay)", async () => {
    const privateKey = ed25519.utils.randomPrivateKey();
    const publicKey = hex(ed25519.getPublicKey(privateKey));
    const challenge = await app.inject({
      method: "POST",
      url: "/api/v1/auth/challenge",
      payload: { publicKey }
    });
    const { nonce } = challenge.json();
    const signature = hex(
      ed25519.sign(Buffer.from(`zyndicate:auth:${nonce}`, "utf8"), privateKey)
    );

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify",
      payload: { publicKey, nonce, signature }
    });
    expect(first.statusCode).toBe(200);

    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify",
      payload: { publicKey, nonce, signature }
    });
    expect(replay.statusCode).toBe(401);
  });

  it("rejects an unknown nonce and malformed keys", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify",
      payload: { publicKey: "a".repeat(64), nonce: "no-such-nonce-1234", signature: "b".repeat(128) }
    });
    expect(res.statusCode).toBe(401);

    const malformed = await app.inject({
      method: "POST",
      url: "/api/v1/auth/challenge",
      payload: { publicKey: "not-hex" }
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("requires a bearer token for /me and updates the display name", async () => {
    const anon = await app.inject({ method: "GET", url: "/api/v1/me" });
    expect(anon.statusCode).toBe(401);

    const actor = await createActor(app);
    const update = await app.inject({
      method: "PUT",
      url: "/api/v1/me",
      headers: auth(actor),
      payload: { displayName: "Cipher Cell", roleHints: ["operator"] }
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().identity.displayName).toBe("Cipher Cell");
    expect(update.json().identity.roleHints).toEqual(["operator"]);
  });

  it("rate-limits the challenge endpoint", async () => {
    const tightApp = await buildTestApp({ RATE_LIMIT_AUTH_MAX: "2" });
    try {
      const publicKey = hex(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()));
      const codes: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const res = await tightApp.inject({
          method: "POST",
          url: "/api/v1/auth/challenge",
          payload: { publicKey }
        });
        codes.push(res.statusCode);
      }
      expect(codes[0]).toBe(200);
      expect(codes[1]).toBe(200);
      expect(codes[2]).toBe(429);
    } finally {
      await tightApp.close();
    }
  });
});
