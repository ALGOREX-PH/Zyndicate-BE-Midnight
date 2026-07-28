import { z } from "zod";
import { publicKeySchema } from "../auth/schemas.js";
import { commitmentSchema } from "../mandates/schemas.js";

export const passportParamsSchema = z.object({
  publicKey: publicKeySchema
});

export const addCredentialBodySchema = z.object({
  domain: z.string().min(2).max(64),
  kind: z.string().min(2).max(64),
  /** Commitment to the full credential; contents remain with the holder. */
  commitment: commitmentSchema
});

export type AddCredentialBody = z.infer<typeof addCredentialBodySchema>;
