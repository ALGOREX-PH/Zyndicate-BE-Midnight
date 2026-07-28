import { and, asc, count, eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { submissions, workroomArtifacts, workroomMessages } from "../../db/schema.js";
import { notFound } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import type { MandateAccess, MandateRole } from "../mandates/service.js";
import { applyTransition } from "../mandates/service.js";
import type { Mandate } from "../mandates/service.js";
import type { PostArtifactBody, SubmissionBody } from "./schemas.js";

export type WorkroomMessage = typeof workroomMessages.$inferSelect;
export type WorkroomArtifact = typeof workroomArtifacts.$inferSelect;
export type Submission = typeof submissions.$inferSelect;

/**
 * A workroom exists once a mandate is awarded. Access is limited to the
 * participants (principal + awarded operator + evaluator); everyone else
 * receives 404 so the workroom's existence is never confirmed.
 */
export function requireWorkroom(access: MandateAccess | null): MandateAccess {
  if (!access || access.role === null || !access.award) {
    throw notFound("Workroom not found");
  }
  return access;
}

export interface WorkroomMeta {
  mandateId: string;
  state: string;
  createdAt: number;
  members: { publicKey: string; role: MandateRole }[];
}

export function workroomMeta(access: MandateAccess): WorkroomMeta {
  const members: WorkroomMeta["members"] = [
    { publicKey: access.mandate.principalKey, role: "principal" }
  ];
  if (access.awardedOperatorKey) {
    members.push({ publicKey: access.awardedOperatorKey, role: "operator" });
  }
  if (access.mandate.evaluatorKey) {
    members.push({ publicKey: access.mandate.evaluatorKey, role: "evaluator" });
  }
  return {
    mandateId: access.mandate.id,
    state: access.mandate.state,
    createdAt: access.award!.awardedAt,
    members
  };
}

export function postMessage(
  db: Db,
  mandateId: string,
  senderKey: string,
  ciphertext: string,
  nonce: string
): WorkroomMessage {
  const row: typeof workroomMessages.$inferInsert = {
    id: newId("msg"),
    mandateId,
    senderKey,
    ciphertext,
    nonce,
    createdAt: Date.now()
  };
  db.insert(workroomMessages).values(row).run();
  return row as WorkroomMessage;
}

export function listMessages(
  db: Db,
  mandateId: string,
  offset: number,
  limit: number
): { rows: WorkroomMessage[]; total: number } {
  const rows = db
    .select()
    .from(workroomMessages)
    .where(eq(workroomMessages.mandateId, mandateId))
    .orderBy(asc(workroomMessages.createdAt))
    .limit(limit)
    .offset(offset)
    .all();
  const total =
    db
      .select({ value: count() })
      .from(workroomMessages)
      .where(eq(workroomMessages.mandateId, mandateId))
      .get()?.value ?? 0;
  return { rows, total };
}

export function addArtifact(
  db: Db,
  mandateId: string,
  uploaderKey: string,
  body: PostArtifactBody
): WorkroomArtifact {
  const row: typeof workroomArtifacts.$inferInsert = {
    id: newId("art"),
    mandateId,
    uploaderKey,
    name: body.name,
    digest: body.digest,
    version: body.version,
    ciphertext: body.ciphertext,
    nonce: body.nonce,
    createdAt: Date.now()
  };
  db.insert(workroomArtifacts).values(row).run();
  return row as WorkroomArtifact;
}

export function listArtifacts(
  db: Db,
  mandateId: string,
  offset: number,
  limit: number
): { rows: WorkroomArtifact[]; total: number } {
  const rows = db
    .select()
    .from(workroomArtifacts)
    .where(eq(workroomArtifacts.mandateId, mandateId))
    .orderBy(asc(workroomArtifacts.createdAt))
    .limit(limit)
    .offset(offset)
    .all();
  const total =
    db
      .select({ value: count() })
      .from(workroomArtifacts)
      .where(eq(workroomArtifacts.mandateId, mandateId))
      .get()?.value ?? 0;
  return { rows, total };
}

/** Commit a submission: anchors an artifact digest and advances the mandate. */
export function createSubmission(
  db: Db,
  mandate: Mandate,
  body: SubmissionBody
): { submission: Submission; mandate: Mandate } {
  const artifact = db
    .select()
    .from(workroomArtifacts)
    .where(
      and(eq(workroomArtifacts.id, body.artifactId), eq(workroomArtifacts.mandateId, mandate.id))
    )
    .get();
  if (!artifact) throw notFound("Artifact not found in this workroom");

  const updated = applyTransition(db, mandate, "submit");
  const row: typeof submissions.$inferInsert = {
    id: newId("sub"),
    mandateId: mandate.id,
    artifactId: artifact.id,
    submissionCommitment: body.submissionCommitment,
    digest: body.digest,
    submittedAt: Date.now()
  };
  db.insert(submissions).values(row).run();
  return { submission: row as Submission, mandate: updated };
}
