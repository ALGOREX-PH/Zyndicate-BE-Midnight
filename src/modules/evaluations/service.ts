import type { Db } from "../../db/client.js";
import { evaluations } from "../../db/schema.js";
import { forbidden, invalidState } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { applyTransition } from "../mandates/service.js";
import type { Mandate, MandateAccess } from "../mandates/service.js";
import type { EvaluationBody } from "./schemas.js";

export type Evaluation = typeof evaluations.$inferSelect;

/**
 * Per covenant: if the mandate designates an evaluator, only that evaluator
 * may record evaluations; otherwise evaluation is principal-led.
 */
export function assertEvaluatorAuthority(access: MandateAccess, viewerKey: string): void {
  const { mandate } = access;
  if (mandate.evaluatorKey) {
    if (viewerKey !== mandate.evaluatorKey) {
      throw forbidden("Only the designated evaluator may evaluate this mandate");
    }
    return;
  }
  if (viewerKey !== mandate.principalKey) {
    throw forbidden("Evaluation is principal-led for this mandate");
  }
}

/**
 * Record an evaluation for a submitted mandate.
 * accept -> accepted, revise -> in_execution, reject -> recorded without a
 * state change (the parties may open a dispute or the covenant may allow
 * another evaluation round).
 */
export function recordEvaluation(
  db: Db,
  mandate: Mandate,
  evaluatorKey: string,
  body: EvaluationBody
): { evaluation: Evaluation; mandate: Mandate } {
  if (mandate.state !== "submitted") {
    throw invalidState(
      `Evaluations require state 'submitted' (current '${mandate.state}')`
    );
  }

  let updated = mandate;
  if (body.verdict === "accept") {
    updated = applyTransition(db, mandate, "evaluation_accept");
  } else if (body.verdict === "revise") {
    updated = applyTransition(db, mandate, "evaluation_revise");
  }

  const row: typeof evaluations.$inferInsert = {
    id: newId("evl"),
    mandateId: mandate.id,
    evaluatorKey,
    verdict: body.verdict,
    evaluationCommitment: body.evaluationCommitment,
    attestation: body.attestation,
    createdAt: Date.now()
  };
  db.insert(evaluations).values(row).run();
  return { evaluation: row as Evaluation, mandate: updated };
}
