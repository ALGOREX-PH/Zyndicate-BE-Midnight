import { z } from "zod";

/** ed25519 public key: 32 bytes hex. */
export const publicKeySchema = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, "publicKey must be 32 bytes of hex")
  .transform((value) => value.toLowerCase());

/** ed25519 signature: 64 bytes hex. */
export const signatureSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{128}$/, "signature must be 64 bytes of hex");

export const challengeBodySchema = z.object({
  publicKey: publicKeySchema
});

export const verifyBodySchema = z.object({
  publicKey: publicKeySchema,
  nonce: z.string().min(16).max(128),
  signature: signatureSchema
});

export const roleHintSchema = z.enum(["principal", "operator", "evaluator"]);

export const updateMeBodySchema = z.object({
  displayName: z.string().min(1).max(80).nullable().optional(),
  roleHints: z.array(roleHintSchema).max(3).optional()
});

export type ChallengeBody = z.infer<typeof challengeBodySchema>;
export type VerifyBody = z.infer<typeof verifyBodySchema>;
export type UpdateMeBody = z.infer<typeof updateMeBodySchema>;
