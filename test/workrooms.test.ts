import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  auth,
  buildTestApp,
  commitment,
  createActor,
  createMandate,
  encryptedPayload,
  runToExecution,
  type Actor
} from "./helpers.js";

describe("workrooms", () => {
  let app: FastifyInstance;
  let principal: Actor;
  let operator: Actor;
  let evaluator: Actor;
  let outsider: Actor;
  let mandateId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    principal = await createActor(app);
    operator = await createActor(app);
    evaluator = await createActor(app);
    outsider = await createActor(app);
    mandateId = await createMandate(app, principal, { evaluatorKey: evaluator.publicKey });
    await runToExecution(app, principal, operator, mandateId);
  });
  afterAll(async () => {
    await app.close();
  });

  it("returns workroom meta with members to participants", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/workrooms/${mandateId}`,
      headers: auth(principal)
    });
    expect(res.statusCode).toBe(200);
    const { workroom } = res.json();
    const roles = Object.fromEntries(
      workroom.members.map((m: { publicKey: string; role: string }) => [m.role, m.publicKey])
    );
    expect(roles.principal).toBe(principal.publicKey);
    expect(roles.operator).toBe(operator.publicKey);
    expect(roles.evaluator).toBe(evaluator.publicKey);
  });

  it("gives outsiders 404 (never 403) on every workroom surface", async () => {
    for (const url of [
      `/api/v1/workrooms/${mandateId}`,
      `/api/v1/workrooms/${mandateId}/messages`,
      `/api/v1/workrooms/${mandateId}/artifacts`
    ]) {
      const res = await app.inject({ method: "GET", url, headers: auth(outsider) });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("NOT_FOUND");
    }
    const post = await app.inject({
      method: "POST",
      url: `/api/v1/workrooms/${mandateId}/messages`,
      headers: auth(outsider),
      payload: encryptedPayload("intrusion")
    });
    expect(post.statusCode).toBe(404);
  });

  it("has no workroom before award", async () => {
    const draftMandate = await createMandate(app, principal);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/workrooms/${draftMandate}`,
      headers: auth(principal)
    });
    expect(res.statusCode).toBe(404);
  });

  it("exchanges encrypted messages between participants", async () => {
    for (const actor of [principal, operator, evaluator]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/workrooms/${mandateId}/messages`,
        headers: auth(actor),
        payload: encryptedPayload(`msg-${actor.publicKey.slice(0, 6)}`)
      });
      expect(res.statusCode).toBe(201);
    }

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/workrooms/${mandateId}/messages?page=1&pageSize=2`,
      headers: auth(operator)
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(2);
    expect(list.json().total).toBeGreaterThanOrEqual(3);
    for (const message of list.json().items) {
      expect(message.ciphertext).toBeDefined();
      expect(message.senderKey).toBeDefined();
    }
  });

  it("uploads versioned artifacts and commits a submission", async () => {
    const artifact = await app.inject({
      method: "POST",
      url: `/api/v1/workrooms/${mandateId}/artifacts`,
      headers: auth(operator),
      payload: {
        name: "findings-v1.enc",
        digest: commitment("digest"),
        version: 1,
        ...encryptedPayload("artifact-1")
      }
    });
    expect(artifact.statusCode).toBe(201);
    const artifactId = artifact.json().artifact.id;

    // Only the awarded operator can submit.
    const wrongSubmitter = await app.inject({
      method: "POST",
      url: `/api/v1/mandates/${mandateId}/submissions`,
      headers: auth(principal),
      payload: {
        artifactId,
        submissionCommitment: commitment("submission"),
        digest: commitment("digest")
      }
    });
    expect(wrongSubmitter.statusCode).toBe(403);

    const submission = await app.inject({
      method: "POST",
      url: `/api/v1/mandates/${mandateId}/submissions`,
      headers: auth(operator),
      payload: {
        artifactId,
        submissionCommitment: commitment("submission"),
        digest: commitment("digest")
      }
    });
    expect(submission.statusCode).toBe(201);
    expect(submission.json().state).toBe("submitted");

    // Submitting again from state submitted is illegal.
    const again = await app.inject({
      method: "POST",
      url: `/api/v1/mandates/${mandateId}/submissions`,
      headers: auth(operator),
      payload: {
        artifactId,
        submissionCommitment: commitment("submission-2"),
        digest: commitment("digest-2")
      }
    });
    expect(again.statusCode).toBe(409);
  });

  it("rejects a submission referencing a foreign artifact", async () => {
    const otherMandate = await createMandate(app, principal);
    const otherOperator = await createActor(app);
    await runToExecution(app, principal, otherOperator, otherMandate);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/mandates/${otherMandate}/submissions`,
      headers: auth(otherOperator),
      payload: {
        artifactId: "art_does-not-exist",
        submissionCommitment: commitment("submission"),
        digest: commitment("digest")
      }
    });
    expect(res.statusCode).toBe(404);
  });
});
