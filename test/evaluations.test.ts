import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  auth,
  buildTestApp,
  createActor,
  createMandate,
  evaluate,
  runToSubmitted,
  type Actor
} from "./helpers.js";

describe("evaluations", () => {
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

  it("lets the designated evaluator accept (state -> accepted)", async () => {
    const id = await createMandate(app, principal, { evaluatorKey: evaluator.publicKey });
    await runToSubmitted(app, principal, operator, id);

    // Principal is not the evaluator here.
    expect(await evaluate(app, principal, id, "accept")).toBe(403);
    // Outsider is refused.
    expect(await evaluate(app, outsider, id, "accept")).toBe(403);

    expect(await evaluate(app, evaluator, id, "accept")).toBe(201);
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/mandates/${id}`,
      headers: auth(principal)
    });
    expect(detail.json().mandate.state).toBe("accepted");
  });

  it("revise sends the mandate back to in_execution", async () => {
    const id = await createMandate(app, principal, { evaluatorKey: evaluator.publicKey });
    await runToSubmitted(app, principal, operator, id);

    expect(await evaluate(app, evaluator, id, "revise")).toBe(201);
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/mandates/${id}`,
      headers: auth(principal)
    });
    expect(detail.json().mandate.state).toBe("in_execution");
  });

  it("reject records the verdict without a state change", async () => {
    const id = await createMandate(app, principal, { evaluatorKey: evaluator.publicKey });
    await runToSubmitted(app, principal, operator, id);

    expect(await evaluate(app, evaluator, id, "reject")).toBe(201);
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/mandates/${id}`,
      headers: auth(principal)
    });
    expect(detail.json().mandate.state).toBe("submitted");
  });

  it("falls back to principal-led evaluation when no evaluator is designated", async () => {
    const id = await createMandate(app, principal);
    await runToSubmitted(app, principal, operator, id);

    expect(await evaluate(app, operator, id, "accept")).toBe(403);
    expect(await evaluate(app, principal, id, "accept")).toBe(201);
  });

  it("rejects evaluations when the mandate is not submitted", async () => {
    const id = await createMandate(app, principal, { evaluatorKey: evaluator.publicKey });
    expect(await evaluate(app, evaluator, id, "accept")).toBe(409);
  });
});
