import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  auth,
  buildTestApp,
  createActor,
  createMandate,
  transition,
  type Actor
} from "./helpers.js";

describe("mandates", () => {
  let app: FastifyInstance;
  let principal: Actor;
  let outsider: Actor;

  beforeAll(async () => {
    app = await buildTestApp();
    principal = await createActor(app);
    outsider = await createActor(app);
  });
  afterAll(async () => {
    await app.close();
  });

  it("creates a mandate as draft and returns the encrypted package to the principal", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mandates",
      headers: auth(principal),
      payload: {
        publicDomain: "security",
        complexityBand: "high",
        mandateCommitment: "commit-mandate-1",
        covenantCommitment: "commit-covenant-1",
        encryptedPackage: {
          ciphertext: Buffer.from("secret").toString("base64"),
          nonce: Buffer.from("nonce").toString("base64")
        },
        rewardBand: "band-3"
      }
    });
    expect(res.statusCode).toBe(201);
    const { mandate } = res.json();
    expect(mandate.state).toBe("draft");
    expect(mandate.viewerRole).toBe("principal");
    expect(mandate.encryptedPackage).toBeDefined();
  });

  it("hides drafts from outsiders (404, not 403)", async () => {
    const id = await createMandate(app, principal);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/mandates/${id}`,
      headers: auth(outsider)
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("lists only public summaries and never leaks ciphertext or principal identity", async () => {
    const id = await createMandate(app, principal);
    await transition(app, principal, id, "open_bidding");

    const res = await app.inject({ method: "GET", url: "/api/v1/mandates" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBeGreaterThanOrEqual(1);
    for (const item of body.items) {
      expect(item.encryptedPackage).toBeUndefined();
      expect(item.principalKey).toBeUndefined();
      expect(item.mandateCommitment).toBeDefined();
    }
    expect(JSON.stringify(body)).not.toContain(principal.publicKey);
  });

  it("excludes drafts from public discovery but shows them under mine=true", async () => {
    const id = await createMandate(app, principal);

    const publicList = await app.inject({ method: "GET", url: "/api/v1/mandates" });
    const publicIds = publicList.json().items.map((m: { id: string }) => m.id);
    expect(publicIds).not.toContain(id);

    const mine = await app.inject({
      method: "GET",
      url: "/api/v1/mandates?mine=true",
      headers: auth(principal)
    });
    const mineIds = mine.json().items.map((m: { id: string }) => m.id);
    expect(mineIds).toContain(id);

    const unauthenticated = await app.inject({
      method: "GET",
      url: "/api/v1/mandates?mine=true"
    });
    expect(unauthenticated.statusCode).toBe(401);
  });

  it("filters by domain and state", async () => {
    const id = await createMandate(app, principal, { publicDomain: "ai-evaluation" });
    await transition(app, principal, id, "open_bidding");

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/mandates?domain=ai-evaluation&state=open_for_bids"
    });
    const ids = res.json().items.map((m: { id: string }) => m.id);
    expect(ids).toContain(id);
    for (const item of res.json().items) {
      expect(item.publicDomain).toBe("ai-evaluation");
      expect(item.state).toBe("open_for_bids");
    }
  });

  it("enforces the legal transition table", async () => {
    const id = await createMandate(app, principal);

    // close_bidding from draft is illegal
    expect(await transition(app, principal, id, "close_bidding")).toBe(409);
    // open then close is legal
    expect(await transition(app, principal, id, "open_bidding")).toBe(200);
    expect(await transition(app, principal, id, "open_bidding")).toBe(409);
    expect(await transition(app, principal, id, "close_bidding")).toBe(200);
    // cancel from bidding_closed is legal
    expect(await transition(app, principal, id, "cancel")).toBe(200);
    // nothing after cancelled
    expect(await transition(app, principal, id, "open_bidding")).toBe(409);
  });

  it("blocks non-principals from state changes", async () => {
    const id = await createMandate(app, principal);
    await transition(app, principal, id, "open_bidding");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/mandates/${id}/state`,
      headers: auth(outsider),
      payload: { action: "cancel" }
    });
    expect(res.statusCode).toBe(403);
  });

  it("hides the encrypted package from outsiders on public detail", async () => {
    const id = await createMandate(app, principal);
    await transition(app, principal, id, "open_bidding");

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/mandates/${id}`,
      headers: auth(outsider)
    });
    expect(res.statusCode).toBe(200);
    const { mandate } = res.json();
    expect(mandate.encryptedPackage).toBeUndefined();
    expect(mandate.principalKey).toBeUndefined();
    expect(mandate.viewerRole).toBeNull();
  });

  it("hides invitation-only mandates from public discovery and detail", async () => {
    const id = await createMandate(app, principal, { discoveryMode: "invitation" });
    await transition(app, principal, id, "open_bidding");

    const list = await app.inject({ method: "GET", url: "/api/v1/mandates" });
    const ids = list.json().items.map((m: { id: string }) => m.id);
    expect(ids).not.toContain(id);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/mandates/${id}`,
      headers: auth(outsider)
    });
    expect(detail.statusCode).toBe(404);
  });
});
