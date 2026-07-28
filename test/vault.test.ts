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

describe("vault settlement", () => {
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

  async function acceptedMandate(): Promise<string> {
    const id = await createMandate(app, principal, { evaluatorKey: evaluator.publicKey });
    await runToSubmitted(app, principal, operator, id);
    await evaluate(app, evaluator, id, "accept");
    return id;
  }

  it("settles exactly once and auto-issues receipts", async () => {
    const id = await acceptedMandate();

    const res = await settle(app, principal, id);
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.state).toBe("settled");
    const kinds = body.receipts.map((r: { kind: string; holderKey: string }) => [
      r.kind,
      r.holderKey
    ]);
    expect(kinds).toContainEqual(["completion", operator.publicKey]);
    expect(kinds).toContainEqual(["payment", principal.publicKey]);

    // Receipts are visible to their holders.
    const operatorReceipts = await app.inject({
      method: "GET",
      url: "/api/v1/me/receipts",
      headers: auth(operator)
    });
    const receiptKinds = operatorReceipts
      .json()
      .items.filter((r: { mandateId: string }) => r.mandateId === id)
      .map((r: { kind: string }) => r.kind);
    expect(receiptKinds).toContain("completion");
  });

  it("rejects a second settlement with 409", async () => {
    const id = await acceptedMandate();
    expect((await settle(app, principal, id)).statusCode).toBe(201);

    const double = await settle(app, principal, id);
    expect(double.statusCode).toBe(409);
  });

  it("rejects a reused settlement nullifier across mandates", async () => {
    const idA = await acceptedMandate();
    const idB = await acceptedMandate();
    const nullifier = commitment("settlement-nullifier");

    expect((await settle(app, principal, idA, nullifier)).statusCode).toBe(201);
    const reuse = await settle(app, principal, idB, nullifier);
    expect(reuse.statusCode).toBe(409);
    expect(JSON.parse(reuse.body).error.code).toBe("DUPLICATE_NULLIFIER");
  });

  it("only the principal may settle; settle requires accepted state", async () => {
    const id = await acceptedMandate();
    expect((await settle(app, operator, id)).statusCode).toBe(403);

    const early = await createMandate(app, principal);
    await runToSubmitted(app, principal, operator, early);
    // still 'submitted', not accepted
    expect((await settle(app, principal, early)).statusCode).toBe(409);
  });

  it("freezes settlement while a dispute is open", async () => {
    const id = await acceptedMandate();

    const dispute = await app.inject({
      method: "POST",
      url: `/api/v1/mandates/${id}/disputes`,
      headers: auth(operator),
      payload: { disputeCommitment: commitment("evidence-capsule") }
    });
    expect(dispute.statusCode).toBe(201);

    const frozen = await settle(app, principal, id);
    expect(frozen.statusCode).toBe(409);
    const code = JSON.parse(frozen.body).error.code;
    expect(["SETTLEMENT_FROZEN", "INVALID_STATE"]).toContain(code);
  });

  it("exposes vault status to parties only", async () => {
    const id = await acceptedMandate();
    await settle(app, principal, id);

    const partyView = await app.inject({
      method: "GET",
      url: `/api/v1/vault/${id}`,
      headers: auth(operator)
    });
    expect(partyView.statusCode).toBe(200);
    expect(partyView.json().vault.settlement).not.toBeNull();
    expect(partyView.json().vault.state).toBe("settled");

    const outsiderView = await app.inject({
      method: "GET",
      url: `/api/v1/vault/${id}`,
      headers: auth(outsider)
    });
    expect(outsiderView.statusCode).toBe(404);
  });
});
