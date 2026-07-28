import { z } from "zod";
import { commitmentSchema, encryptedPayloadSchema } from "../mandates/schemas.js";

export const placeBidBodySchema = z.object({
  bidCommitment: commitmentSchema,
  bidNullifier: commitmentSchema,
  encryptedBid: encryptedPayloadSchema
});

export const bidParamsSchema = z.object({
  id: z.string().min(1).max(64),
  bidId: z.string().min(1).max(64)
});

export type PlaceBidBody = z.infer<typeof placeBidBodySchema>;
