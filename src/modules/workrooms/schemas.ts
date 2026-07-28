import { z } from "zod";
import { paginationQuerySchema } from "../../lib/pagination.js";
import { commitmentSchema, encryptedPayloadSchema } from "../mandates/schemas.js";

export const workroomParamsSchema = z.object({
  mandateId: z.string().min(1).max(64)
});

export const postMessageBodySchema = encryptedPayloadSchema;

export const listMessagesQuerySchema = paginationQuerySchema;

export const postArtifactBodySchema = z.object({
  name: z.string().min(1).max(200),
  /** Digest of the plaintext artifact (computed client-side). */
  digest: commitmentSchema,
  version: z.number().int().min(1).max(10_000).default(1),
  ciphertext: encryptedPayloadSchema.shape.ciphertext,
  nonce: encryptedPayloadSchema.shape.nonce
});

export const submissionBodySchema = z.object({
  artifactId: z.string().min(1).max(64),
  submissionCommitment: commitmentSchema,
  digest: commitmentSchema
});

export type PostArtifactBody = z.infer<typeof postArtifactBodySchema>;
export type SubmissionBody = z.infer<typeof submissionBodySchema>;
