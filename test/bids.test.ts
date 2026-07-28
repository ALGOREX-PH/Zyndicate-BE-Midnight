import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  auth,
  buildTestApp,
  commitment,
  createActor,
  createMandate,
  placeBid,
  transition,
  type Actor
} from "./helpers.js";

describe("sealed bids", () => {
  let app: FastifyInstance;
  let principal: Actor;
  let operatorA: Actor;
  let operatorB: Actor;

  beforeAll(async () => {
    app = await buildTestApp();
    principal = await createActor(app);
    operatorA = await createActor(app);
    operatorB = await createActor(app);
  });
  afterAll(async () => {
    await app.close();
  });

  async function openMandate(): Promise<string> {
    const id = await createMandate(app, principal);
    await transition(app, principal, id, "open_bidding");
    return id;
  }

  it("accepts a sealed bid while bidding is open", async () => {
    const id = await openMandate();
    const bid = await placeBid(app, operatorA, id);
    expect(bid.statusCode).toBe(201);
    expect(bid.bidId).toBeTruthy();
  });

  it("rejects bids when the mandate is not open for bids", async () => {
    const id = await createMandate(app, principal);
    await transition(app, principal, id, "open_bidding");
    await transition(app, principal, id, "close_bidding");
    const bid = await placeBid(app, operatorA, id);
    expect(bid.statusCode).toBe(409);
  });

  it("rejects bids past the bid deadline", async () => {
    const id = await createMandate(app, principal, { bidDeadline: Date.now() - 60_000 });
    await transition(app, principal, id, "open_bidding");
    const bid = await placeBid(app, operatorA, id);
    expect(bid.statusCode).toBe(409);
    expect(JSON.parse(bid.body).error.code).toBe("BID_WINDOW_CLOSED");
  });

  it("rejects duplicate bid nullifiers with 409", async () => {
    const idA = await openMandate();
    const idB = await openMandate();
    const nullifier = commitment("shared-nullifier");

    const first = await placeBid(app, operatorA, idA, { nullifier });
    expect(first.statusCode).toBe(201);

    // Same nullifier, even from another operator on another mandate -> 409.
    const second = await placeBid(app, operatorB, idB, { nullifier });
    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.body).error.code).toBe("DUPLICATE_NULLIFIER");
  });

  it("rejects duplicate bid commitments with 409", async () => {
    const idA = await openMandate();
    const idB = await openMandate();
    const shared = commitment("shared-commitment");

    expect((await placeBid(app, operatorA, idA, { commitment: shared })).statusCode).toBe(201);
    const dup = await placeBid(app, operatorB, idB, { commitment: shared });
    expect(dup.statusCode).toBe(409);
    expect(JSON.parse(dup.body).error.code).toBe("DUPLICATE_COMMITMENT");
  });

  it("blocks principals from bidding on their own mandate", async () => {
    const id = await openMandate();
    const bid = await placeBid(app, principal, id);
    expect(bid.statusCode).toBe(403);
  });

  it("shows the principal all bids but an operator only their own", async () => {
    const id = await openMandate();
    await placeBid(app, operatorA, id);
    await placeBid(app, operatorB, id);

    const principalView = await app.inject({
      method: "GET",
      url: `/api/v1/mandates/${id}/bids`,
      headers: auth(principal)
    });
    expect(principalView.statusCode).toBe(200);
    expect(principalView.json().items).toHaveLength(2);
    for (const bid of principalView.json().items) {
      expect(bid.encryptedBid).toBeDefined();
    }

    const operatorView = await app.inject({
      method: "GET",
      url: `/api/v1/mandates/${id}/bids`,
      headers: auth(operatorA)
    });
    expect(operatorView.json().items).toHaveLength(1);
    expect(operatorView.json().items[0].operatorKey).toBe(operatorA.publicKey);

    const outsider = await createActor(app);
    const outsiderView = await app.inject({
      method: "GET",
      url: `/api/v1/mandates/${id}/bids`,
      headers: auth(outsider)
    });
    expect(outsiderView.json().items).toHaveLength(0);
  });

  it("withdraws an own pending bid; others get 404", async () => {
    const id = await openMandate();
    const bid = await placeBid(app, operatorA, id);

    const foreign = await app.inject({
      method: "DELETE",
      url: `/api/v1/mandates/${id}/bids/${bid.bidId}`,
      headers: auth(operatorB)
    });
    expect(foreign.statusCode).toBe(404);

    const withdraw = await app.inject({
      method: "DELETE",
      url: `/api/v1/mandates/${id}/bids/${bid.bidId}`,
      headers: auth(operatorA)
    });
    expect(withdraw.statusCode).toBe(200);
    expect(withdraw.json().bid.status).toBe("withdrawn");

    const again = await app.inject({
      method: "DELETE",
      url: `/api/v1/mandates/${id}/bids/${bid.bidId}`,
      headers: auth(operatorA)
    });
    expect(again.statusCode).toBe(409);
  });

  it("awards a bid and lets the operator accept", async () => {
    const id = await openMandate();
    const winner = await placeBid(app, operatorA, id);
    await placeBid(app, operatorB, id);

    const notPrincipal = await app.inject({
      method: "POST",
      url: `/api/v1/mandates/${id}/award`,
      headers: auth(operatorA),
      payload: { bidId: winner.bidId }
    });
    expect(notPrincipal.statusCode).toBe(403);

    const award = await app.inject({
      method: "POST",
      url: `/api/v1/mandates/${id}/award`,
      headers: auth(principal),
      payload: { bidId: winner.bidId }
    });
    expect(award.statusCode).toBe(200);
    expect(award.json().mandate.state).toBe("awarded");

    // losing bid is rejected
    const bids = await app.inject({
      method: "GET",
      url: `/api/v1/mandates/${id}/bids`,
      headers: auth(principal)
    });
    const statuses = Object.fromEntries(
      bids.json().items.map((b: { id: string; status: string }) => [b.id, b.status])
    );
    expect(statuses[winner.bidId!]).toBe("awarded");
    expect(Object.values(statuses)).toContain("rejected");

    const acceptWrong = await app.inject({
      method: "POST",
      url: `/api/v1/mandates/${id}/accept`,
      headers: auth(operatorB)
    });
    expect(acceptWrong.statusCode).toBe(403);

    const accept = await app.inject({
      method: "POST",
      url: `/api/v1/mandates/${id}/accept`,
      headers: auth(operatorA)
    });
    expect(accept.statusCode).toBe(200);
    expect(accept.json().mandate.state).toBe("in_execution");

    // awarded operator now sees the encrypted package
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/mandates/${id}`,
      headers: auth(operatorA)
    });
    expect(detail.json().mandate.encryptedPackage).toBeDefined();
    expect(detail.json().mandate.viewerRole).toBe("operator");
  });
});
