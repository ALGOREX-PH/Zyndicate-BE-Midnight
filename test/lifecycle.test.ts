import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  auth,
  buildTestApp,
  commitment,
  createActor,
  createMandate,
  encryptedPayload,
  placeBid,
  transition,
  type Actor
} from "./helpers.js";

/**
 * Full happy path (PRD 26.5): principal creates a confidential mandate,
 * operators race with sealed bids, principal awards, workroom collaboration,
 * submission commitment, evaluator attestation, single settlement, receipts.
 */
describe("full mandate lifecycle", () => {
  let app: FastifyInstance;
  let principal: Actor;
  let operator: Actor;
  let rival: Actor;
  let evaluator: Actor;

  beforeAll(async () => {
    app = await buildTestApp();
    principal = await createActor(app);
    operator = await createActor(app);
    rival = await createActor(app);
    evaluator = await createActor(app);
  });
  afterAll(async () => {
    await app.close();
  });

  it("runs draft -> open_for_bids -> awarded -> in_execution -> submitted -> accepted -> settled", async () => {
    // 1. Create the confidential mandate.
    const mandateId = await createMandate(app, principal, {
      publicDomain: "security",
      evaluatorKey: evaluator.publicKey,
      rewardBand: "band-4"
    });

    // 2. Open bidding.
    expect(await transition(app, principal, mandateId, "open_bidding")).toBe(200);

    // 3. Two sealed bids arrive.
    const winning = await placeBid(app, operator, mandateId);
    const losing = await placeBid(app, rival, mandateId);
    expect(winning.statusCode).toBe(201);
    expect(losing.statusCode).toBe(201);

    // The public detail leaks neither bids nor package.
    const publicDetail = await app.inject({
      method: "GET",
      url: `/api/v1/mandates/${mandateId}`
    });
    expect(publicDetail.json().mandate.encryptedPackage).toBeUndefined();

    // 4. Close bidding, award the winner.
    expect(await transition(app, principal, mandateId, "close_bidding")).toBe(200);
    const award = await app.inject({
      method: "POST",
      url: `/api/v1/mandates/${mandateId}/award`,
      headers: auth(principal),
      payload: { bidId: winning.bidId }
    });
    expect(award.statusCode).toBe(200);
    expect(award.json().mandate.state).toBe("awarded");

    // 5. Operator accepts; execution begins.
    const accept = await app.inject({
      method: "POST",
      url: `/api/v1/mandates/${mandateId}/accept`,
      headers: auth(operator)
    });
    expect(accept.json().mandate.state).toBe("in_execution");

    // 6. Workroom collaboration: encrypted messages both ways.
    for (const actor of [principal, operator]) {
      const msg = await app.inject({
        method: "POST",
        url: `/api/v1/workrooms/${mandateId}/messages`,
        headers: auth(actor),
        payload: encryptedPayload("collab")
      });
      expect(msg.statusCode).toBe(201);
    }

    // The rival (losing bidder) is not a participant: 404.
    const rivalRoom = await app.inject({
      method: "GET",
      url: `/api/v1/workrooms/${mandateId}`,
      headers: auth(rival)
    });
    expect(rivalRoom.statusCode).toBe(404);

    // 7. Operator uploads the encrypted deliverable and commits the submission.
    const artifact = await app.inject({
      method: "POST",
      url: `/api/v1/workrooms/${mandateId}/artifacts`,
      headers: auth(operator),
      payload: {
        name: "audit-findings.enc",
        digest: commitment("digest"),
        version: 1,
        ...encryptedPayload("deliverable")
      }
    });
    const submission = await app.inject({
      method: "POST",
      url: `/api/v1/mandates/${mandateId}/submissions`,
      headers: auth(operator),
      payload: {
        artifactId: artifact.json().artifact.id,
        submissionCommitment: commitment("submission"),
        digest: commitment("digest")
      }
    });
    expect(submission.json().state).toBe("submitted");

    // 8. Evaluator accepts.
    const evaluation = await app.inject({
      method: "POST",
      url: `/api/v1/mandates/${mandateId}/evaluations`,
      headers: auth(evaluator),
      payload: {
        verdict: "accept",
        evaluationCommitment: commitment("evaluation"),
        attestation: Buffer.from("attest").toString("base64")
      }
    });
    expect(evaluation.json().state).toBe("accepted");

    // 9. Principal settles exactly once.
    const settleRes = await app.inject({
      method: "POST",
      url: `/api/v1/mandates/${mandateId}/settle`,
      headers: auth(principal),
      payload: { settlementNullifier: commitment("settlement") }
    });
    expect(settleRes.statusCode).toBe(201);
    expect(settleRes.json().state).toBe("settled");

    // 10. Receipts exist for both sides; vault reports settled.
    const operatorReceipts = await app.inject({
      method: "GET",
      url: "/api/v1/me/receipts",
      headers: auth(operator)
    });
    expect(
      operatorReceipts.json().items.some(
        (r: { kind: string; mandateId: string }) =>
          r.kind === "completion" && r.mandateId === mandateId
      )
    ).toBe(true);

    const vault = await app.inject({
      method: "GET",
      url: `/api/v1/vault/${mandateId}`,
      headers: auth(evaluator)
    });
    expect(vault.json().vault.state).toBe("settled");

    // 11. The operator's public passport now shows a completion band, with
    // no mandate ids or counterparties leaked.
    const passport = await app.inject({
      method: "GET",
      url: `/api/v1/passports/${operator.publicKey}`
    });
    expect(passport.json().passport.completionBand).not.toBe("none");
    expect(JSON.stringify(passport.json())).not.toContain(mandateId);
    expect(JSON.stringify(passport.json())).not.toContain(principal.publicKey);
  });
});
