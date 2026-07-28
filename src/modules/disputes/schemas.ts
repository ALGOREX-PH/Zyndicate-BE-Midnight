import { z } from "zod";
import { DISPUTE_OUTCOMES } from "../../db/schema.js";
import { commitmentSchema } from "../mandates/schemas.js";

export const openDisputeBodySchema = z.object({
  /** Commitment to the evidence capsule backing the dispute. */
  disputeCommitment: commitmentSchema
});

export const disputeParamsSchema = z.object({
  id: z.string().min(1).max(64)
});

export const rulingBodySchema = z.object({
  rulingCommitment: commitmentSchema,
  outcome: z.enum(DISPUTE_OUTCOMES)
});

export const listDisputesQuerySchema = z.object({
  mine: z
    .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
    .transform((value) => value === true || value === "true" || value === "1")
    .optional()
});

export type OpenDisputeBody = z.infer<typeof openDisputeBodySchema>;
export type RulingBody = z.infer<typeof rulingBodySchema>;
