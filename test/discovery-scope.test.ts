import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  auth,
  buildTestApp,
  createActor,
  createMandate,
  placeBid,
  transition,
  type Actor
} from "./helpers.js";

/**
 * `?mine=true` is party-scoped, not principal-scoped. The Vault and Workrooms
 * pages are built from this filter, so an operator that only saw mandates it
 * commissioned could never reach the workroom of a mandate it is executing.
 */
describe("discovery scope", () => {
  let app: FastifyInstance;
  let principal: Actor;
  let operator: Actor;
  let evaluator: Actor;
  let stranger: Actor;
  let mandateId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    principal = await createActor(app);
    operator = await createActor(app);
    evaluator = await createActor(app);
    stranger = await createActor(app);

    mandateId = await createMandate(app, principal, { evaluatorKey: evaluator.publicKey });
    await transition(app, principal, mandateId, "open_bidding");
    const bid = await placeBid(app, operator, mandateId);
    expect(bid.statusCode).toBe(201);
  });

  afterAll(async () => {
    await app.close();
  });

  const mine = async (actor: Actor): Promise<string[]> => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/mandates?mine=true&pageSize=50",
      headers: auth(actor)
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { items: Array<{ id: string }> }).items.map((m) => m.id);
  };

  it("lists the mandate for the principal that commissioned it", async () => {
    expect(await mine(principal)).toContain(mandateId);
  });

  it("lists the mandate for an operator that bid on it", async () => {
    expect(await mine(operator)).toContain(mandateId);
  });

  it("lists the mandate for the designated evaluator", async () => {
    expect(await mine(evaluator)).toContain(mandateId);
  });

  it("does not list the mandate for an unrelated identity", async () => {
    expect(await mine(stranger)).not.toContain(mandateId);
  });

  it("keeps public discovery free of drafts and invitation-only mandates", async () => {
    const draftId = await createMandate(app, principal);
    const invitedId = await createMandate(app, principal, { discoveryMode: "invitation" });
    await transition(app, principal, invitedId, "open_bidding");

    const res = await app.inject({ method: "GET", url: "/api/v1/mandates?pageSize=100" });
    expect(res.statusCode).toBe(200);
    const items = (res.json() as { items: Array<{ id: string; state: string }> }).items;
    const ids = items.map((m) => m.id);

    expect(ids).toContain(mandateId);
    expect(ids).not.toContain(draftId);
    expect(ids).not.toContain(invitedId);
    expect(items.every((m) => m.state !== "draft")).toBe(true);
  });

  it("does not leak the encrypted package into public summaries", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/mandates?pageSize=100" });
    const items = (res.json() as { items: Array<Record<string, unknown>> }).items;
    for (const item of items) {
      expect(item).not.toHaveProperty("encryptedPackage");
      expect(item).not.toHaveProperty("principalKey");
    }
  });
});
