import { z } from "zod";
import { EVALUATION_VERDICTS } from "../../db/schema.js";
import { commitmentSchema } from "../mandates/schemas.js";

export const evaluationBodySchema = z.object({
  verdict: z.enum(EVALUATION_VERDICTS),
  evaluationCommitment: commitmentSchema,
  /** Signed attestation blob; opaque to the server. */
  attestation: z.string().min(8).max(10_000)
});

export type EvaluationBody = z.infer<typeof evaluationBodySchema>;
