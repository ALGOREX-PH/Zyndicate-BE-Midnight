import { z } from "zod";
import { commitmentSchema } from "../mandates/schemas.js";

export const settleBodySchema = z.object({
  /** Nullifier consumed by settlement — guarantees exactly-once payout. */
  settlementNullifier: commitmentSchema,
  /** Optional commitment to the settled amount. Never the amount itself. */
  amountCommitment: commitmentSchema.optional()
});

export type SettleBody = z.infer<typeof settleBodySchema>;
