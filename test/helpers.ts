import { ed25519 } from "@noble/curves/ed25519";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

export interface Actor {
  publicKey: string;
  privateKey: Uint8Array;
  token: string;
}

export async function buildTestApp(
  extraEnv: Partial<Record<string, string>> = {}
): Promise<FastifyInstance> {
  return buildApp({
    env: {
      NODE_ENV: "test",
      DATABASE_PATH: ":memory:",
      LOG_LEVEL: "silent",
      JWT_SECRET: "test-secret-test-secret-test-secret",
      RATE_LIMIT_MAX: "100000",
      RATE_LIMIT_AUTH_MAX: "100000",
      ...extraEnv
    }
  });
}

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function b64(input: string): string {
  return Buffer.from(input, "utf8").toString("base64");
}

/** Random-ish commitment/nullifier strings for tests. */
export function commitment(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2)}${Math.random()
    .toString(36)
    .slice(2)}`;
}

export async function createActor(app: FastifyInstance): Promise<Actor> {
  const privateKey = ed25519.utils.randomPrivateKey();
  const publicKey = hex(ed25519.getPublicKey(privateKey));

  const challengeRes = await app.inject({
    method: "POST",
    url: "/api/v1/auth/challenge",
    payload: { publicKey }
  });
  if (challengeRes.statusCode !== 200) {
    throw new Error(`challenge failed: ${challengeRes.body}`);
  }
  const { nonce } = challengeRes.json() as { nonce: string };

  const signature = hex(
    ed25519.sign(Buffer.from(`zyndicate:auth:${nonce}`, "utf8"), privateKey)
  );
  const verifyRes = await app.inject({
    method: "POST",
    url: "/api/v1/auth/verify",
    payload: { publicKey, nonce, signature }
  });
  if (verifyRes.statusCode !== 200) {
    throw new Error(`verify failed: ${verifyRes.body}`);
  }
  const { token } = verifyRes.json() as { token: string };
  return { publicKey, privateKey, token };
}

export function auth(actor: Actor): Record<string, string> {
  return { authorization: `Bearer ${actor.token}` };
}

export const encryptedPayload = (label = "payload"): { ciphertext: string; nonce: string } => ({
  ciphertext: b64(`ciphertext:${label}`),
  nonce: b64(`nonce:${label}`)
});

export interface MandateOverrides {
  publicDomain?: string;
  discoveryMode?: "open" | "gated" | "invitation";
  bidDeadline?: number;
  evaluatorKey?: string;
  rewardBand?: string;
}

export async function createMandate(
  app: FastifyInstance,
  principal: Actor,
  overrides: MandateOverrides = {}
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/mandates",
    headers: auth(principal),
    payload: {
      publicDomain: "security",
      complexityBand: "high",
      discoveryMode: "open",
      mandateCommitment: commitment("mandate"),
      covenantCommitment: commitment("covenant"),
      encryptedPackage: encryptedPayload("mandate-package"),
      ...overrides
    }
  });
  if (res.statusCode !== 201) throw new Error(`createMandate failed: ${res.body}`);
  return (res.json() as { mandate: { id: string } }).mandate.id;
}

export async function transition(
  app: FastifyInstance,
  actor: Actor,
  mandateId: string,
  action: string
): Promise<number> {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/mandates/${mandateId}/state`,
    headers: auth(actor),
    payload: { action }
  });
  return res.statusCode;
}

export async function placeBid(
  app: FastifyInstance,
  operator: Actor,
  mandateId: string,
  labels: { commitment?: string; nullifier?: string } = {}
): Promise<{ statusCode: number; bidId?: string; body: string }> {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/mandates/${mandateId}/bids`,
    headers: auth(operator),
    payload: {
      bidCommitment: labels.commitment ?? commitment("bid"),
      bidNullifier: labels.nullifier ?? commitment("nullifier"),
      encryptedBid: encryptedPayload("sealed-bid")
    }
  });
  const bidId =
    res.statusCode === 201 ? (res.json() as { bid: { id: string } }).bid.id : undefined;
  return { statusCode: res.statusCode, bidId, body: res.body };
}

/**
 * Drive a mandate to `in_execution`: open bidding, operator bids, principal
 * awards, operator accepts. Returns the winning bid id.
 */
export async function runToExecution(
  app: FastifyInstance,
  principal: Actor,
  operator: Actor,
  mandateId: string
): Promise<string> {
  await transition(app, principal, mandateId, "open_bidding");
  const bid = await placeBid(app, operator, mandateId);
  if (!bid.bidId) throw new Error(`bid failed: ${bid.body}`);

  const awardRes = await app.inject({
    method: "POST",
    url: `/api/v1/mandates/${mandateId}/award`,
    headers: auth(principal),
    payload: { bidId: bid.bidId }
  });
  if (awardRes.statusCode !== 200) throw new Error(`award failed: ${awardRes.body}`);

  const acceptRes = await app.inject({
    method: "POST",
    url: `/api/v1/mandates/${mandateId}/accept`,
    headers: auth(operator)
  });
  if (acceptRes.statusCode !== 200) throw new Error(`accept failed: ${acceptRes.body}`);
  return bid.bidId;
}

/** Upload an artifact and commit it as a submission (state -> submitted). */
export async function runToSubmitted(
  app: FastifyInstance,
  principal: Actor,
  operator: Actor,
  mandateId: string
): Promise<{ bidId: string; artifactId: string; submissionId: string }> {
  const bidId = await runToExecution(app, principal, operator, mandateId);

  const artifactRes = await app.inject({
    method: "POST",
    url: `/api/v1/workrooms/${mandateId}/artifacts`,
    headers: auth(operator),
    payload: {
      name: "audit-report.pdf.enc",
      digest: commitment("digest"),
      version: 1,
      ...encryptedPayload("artifact")
    }
  });
  if (artifactRes.statusCode !== 201) {
    throw new Error(`artifact failed: ${artifactRes.body}`);
  }
  const artifactId = (artifactRes.json() as { artifact: { id: string } }).artifact.id;

  const submissionRes = await app.inject({
    method: "POST",
    url: `/api/v1/mandates/${mandateId}/submissions`,
    headers: auth(operator),
    payload: {
      artifactId,
      submissionCommitment: commitment("submission"),
      digest: commitment("digest")
    }
  });
  if (submissionRes.statusCode !== 201) {
    throw new Error(`submission failed: ${submissionRes.body}`);
  }
  const submissionId = (submissionRes.json() as { submission: { id: string } }).submission
    .id;
  return { bidId, artifactId, submissionId };
}

export async function evaluate(
  app: FastifyInstance,
  evaluator: Actor,
  mandateId: string,
  verdict: "accept" | "reject" | "revise"
): Promise<number> {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/mandates/${mandateId}/evaluations`,
    headers: auth(evaluator),
    payload: {
      verdict,
      evaluationCommitment: commitment("evaluation"),
      attestation: b64("signed-attestation-blob")
    }
  });
  return res.statusCode;
}

export async function settle(
  app: FastifyInstance,
  principal: Actor,
  mandateId: string,
  nullifier?: string
): Promise<{ statusCode: number; body: string }> {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/mandates/${mandateId}/settle`,
    headers: auth(principal),
    payload: { settlementNullifier: nullifier ?? commitment("settlement") }
  });
  return { statusCode: res.statusCode, body: res.body };
}
