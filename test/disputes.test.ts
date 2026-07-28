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

describe("disputes", () => {
  let app: FastifyInstance;
  let principal: Actor;
  let operator: Actor;
  let evaluator: Actor;
  let outsider: Actor;

  beforeAll(async () => {
    app = await buildTestApp();
    principal = await createActor(app);
    operator = await createActor(app);
    evaluator = await createActor(app);
    outsider = await createActor(app);
  });
  afterAll(async () => {
    await app.close();
  });

  async function disputedMandate(): Promise<{ mandateId: string; disputeId: string }> {
    const mandateId = await createMandate(app, principal, {
      evaluatorKey: evaluator.publicKey
    });
    await runToSubmitted(app, principal, operator, mandateId);
    await evaluate(app, evaluator, mandateId, "accept");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/mandates/${mandateId}/disputes`,
      headers: auth(operator),
      payload: { disputeCommitment: commitment("evidence-capsule") }
    });
    expect(res.statusCode).toBe(201);
    return { mandateId, disputeId: res.json().dispute.id };
  }

  it("lets a party open a dispute; mandate state becomes disputed", async () => {
    const { mandateId } = await disputedMandate();
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/mandates/${mandateId}`,
      headers: auth(principal)
    });
    expect(detail.json().mandate.state).toBe("disputed");
  });

  it("blocks non-parties from opening disputes", async () => {
    const mandateId = await createMandate(app, principal, {
      evaluatorKey: evaluator.publicKey
    });
    await runToSubmitted(app, principal, operator, mandateId);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/mandates/${mandateId}/disputes`,
      headers: auth(outsider),
      payload: { disputeCommitment: commitment("bogus") }
    });
    expect(res.statusCode).toBe(403);

    // The evaluator is a participant but not a dispute party.
    const evaluatorTry = await app.inject({
      method: "POST",
      url: `/api/v1/mandates/${mandateId}/disputes`,
      headers: auth(evaluator),
      payload: { disputeCommitment: commitment("bogus") }
    });
    expect(evaluatorTry.statusCode).toBe(403);
  });

  it("evaluator rules the dispute and the mandate resolves", async () => {
    const { mandateId, disputeId } = await disputedMandate();

    const wrongRuler = await app.inject({
      method: "POST",
      url: `/api/v1/disputes/${disputeId}/ruling`,
      headers: auth(operator),
      payload: { rulingCommitment: commitment("ruling"), outcome: "release" }
    });
    expect(wrongRuler.statusCode).toBe(403);

    const ruling = await app.inject({
      method: "POST",
      url: `/api/v1/disputes/${disputeId}/ruling`,
      headers: auth(evaluator),
      payload: { rulingCommitment: commitment("ruling"), outcome: "release" }
    });
    expect(ruling.statusCode).toBe(200);
    expect(ruling.json().state).toBe("resolved");
    expect(ruling.json().dispute.status).toBe("ruled");
    expect(ruling.json().dispute.outcome).toBe("release");

    // Second ruling -> 409
    const again = await app.inject({
      method: "POST",
      url: `/api/v1/disputes/${disputeId}/ruling`,
      headers: auth(evaluator),
      payload: { rulingCommitment: commitment("ruling-2"), outcome: "refund" }
    });
    expect(again.statusCode).toBe(409);

    // Settlement remains blocked after resolution (state resolved, not accepted).
    expect((await settle(app, principal, mandateId)).statusCode).toBe(409);
  });

  it("supports a configured tribunal key as ruling authority", async () => {
    const tribunal = await createActor(app);
    const tribunalApp = await buildTestApp({ TRIBUNAL_KEYS: tribunal.publicKey });
    try {
      const p = await createActor(tribunalApp);
      const o = await createActor(tribunalApp);
      const t = await createActor(tribunalApp); // fresh token on this app
      const mandateId = await createMandate(tribunalApp, p);
      await runToSubmitted(tribunalApp, p, o, mandateId);
      await evaluate(tribunalApp, p, mandateId, "accept");
      const dispute = await tribunalApp.inject({
        method: "POST",
        url: `/api/v1/mandates/${mandateId}/disputes`,
        headers: auth(p),
        payload: { disputeCommitment: commitment("capsule") }
      });
      const disputeId = dispute.json().dispute.id;

      const ruling = await tribunalApp.inject({
        method: "POST",
        url: `/api/v1/disputes/${disputeId}/ruling`,
        headers: auth(t),
        payload: { rulingCommitment: commitment("ruling"), outcome: "refund" }
      });
      // `t` is not the tribunal key; expect 403.
      expect(ruling.statusCode).toBe(403);

      // Authenticate the actual tribunal key on this app instance.
      const tribunalActor = { ...tribunal, token: "" };
      const challenge = await tribunalApp.inject({
        method: "POST",
        url: "/api/v1/auth/challenge",
        payload: { publicKey: tribunal.publicKey }
      });
      const { nonce } = challenge.json();
      const { ed25519 } = await import("@noble/curves/ed25519");
      const signature = Buffer.from(
        ed25519.sign(Buffer.from(`zyndicate:auth:${nonce}`, "utf8"), tribunal.privateKey)
      ).toString("hex");
      const verify = await tribunalApp.inject({
        method: "POST",
        url: "/api/v1/auth/verify",
        payload: { publicKey: tribunal.publicKey, nonce, signature }
      });
      tribunalActor.token = verify.json().token;

      const tribunalRuling = await tribunalApp.inject({
        method: "POST",
        url: `/api/v1/disputes/${disputeId}/ruling`,
        headers: auth(tribunalActor),
        payload: { rulingCommitment: commitment("ruling"), outcome: "refund" }
      });
      expect(tribunalRuling.statusCode).toBe(200);
    } finally {
      await tribunalApp.close();
    }
  });

  it("lists only the caller's disputes", async () => {
    const { disputeId } = await disputedMandate();

    const mine = await app.inject({
      method: "GET",
      url: "/api/v1/disputes?mine=true",
      headers: auth(operator)
    });
    expect(mine.statusCode).toBe(200);
    const ids = mine.json().items.map((d: { id: string }) => d.id);
    expect(ids).toContain(disputeId);

    const foreign = await app.inject({
      method: "GET",
      url: "/api/v1/disputes",
      headers: auth(outsider)
    });
    expect(foreign.json().items).toHaveLength(0);
  });
});
