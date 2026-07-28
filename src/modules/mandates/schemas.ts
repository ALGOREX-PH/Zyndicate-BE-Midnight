import { z } from "zod";
import { DISCOVERY_MODES, MANDATE_STATES } from "../../db/schema.js";
import { paginationQuerySchema } from "../../lib/pagination.js";
import { publicKeySchema } from "../auth/schemas.js";

/** Opaque commitment / nullifier / digest mirrors. Never plaintext values. */
export const commitmentSchema = z.string().min(8).max(256);

/**
 * Client-side-encrypted payload. The server stores these blobs verbatim and
 * never holds the decryption keys (visibility classes B/C/E).
 */
export const encryptedPayloadSchema = z.object({
  ciphertext: z.base64().min(1).max(1_500_000),
  nonce: z.base64().min(1).max(256)
});

/** Deadlines accepted as epoch milliseconds or ISO-8601 strings. */
export const deadlineSchema = z
  .union([z.number().int().positive(), z.iso.datetime()])
  .transform((value) => (typeof value === "number" ? value : Date.parse(value)));

export const createMandateBodySchema = z.object({
  publicDomain: z.string().min(2).max(64),
  complexityBand: z.string().min(1).max(32).optional(),
  discoveryMode: z.enum(DISCOVERY_MODES).default("open"),
  bidDeadline: deadlineSchema.optional(),
  executionDeadline: deadlineSchema.optional(),
  mandateCommitment: commitmentSchema,
  covenantCommitment: commitmentSchema,
  encryptedPackage: encryptedPayloadSchema,
  rewardBand: z.string().min(1).max(64).optional(),
  chainAddress: z.string().min(1).max(128).optional(),
  evaluatorKey: publicKeySchema.optional()
});

export const listMandatesQuerySchema = paginationQuerySchema.extend({
  domain: z.string().min(1).max(64).optional(),
  state: z.enum(MANDATE_STATES).optional(),
  mine: z
    .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
    .transform((value) => value === true || value === "true" || value === "1")
    .optional()
});

export const mandateIdParamsSchema = z.object({
  id: z.string().min(1).max(64)
});

export const stateActionBodySchema = z.object({
  action: z.enum(["open_bidding", "close_bidding", "cancel"])
});

export const awardBodySchema = z.object({
  bidId: z.string().min(1).max(64)
});

export type CreateMandateBody = z.infer<typeof createMandateBodySchema>;
export type ListMandatesQuery = z.infer<typeof listMandatesQuerySchema>;
export type StateActionBody = z.infer<typeof stateActionBodySchema>;
