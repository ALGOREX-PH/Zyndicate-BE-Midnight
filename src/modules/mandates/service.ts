import { and, count, desc, eq, ne } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { awards, bids, mandates } from "../../db/schema.js";
import type { MandateState } from "../../db/schema.js";
import { invalidState } from "../../lib/errors.js";

export type Mandate = typeof mandates.$inferSelect;
export type Award = typeof awards.$inferSelect;

// ---------------------------------------------------------------------------
// State machine — the single source of truth for legal mandate transitions.
// ---------------------------------------------------------------------------

export type MandateAction =
  | "open_bidding"
  | "close_bidding"
  | "cancel"
  | "award"
  | "accept_award"
  | "submit"
  | "evaluation_accept"
  | "evaluation_revise"
  | "settle"
  | "dispute"
  | "resolve";

export const TRANSITIONS: Record<MandateAction, { from: MandateState[]; to: MandateState }> = {
  open_bidding: { from: ["draft"], to: "open_for_bids" },
  close_bidding: { from: ["open_for_bids"], to: "bidding_closed" },
  cancel: { from: ["draft", "open_for_bids", "bidding_closed"], to: "cancelled" },
  award: { from: ["open_for_bids", "bidding_closed"], to: "awarded" },
  accept_award: { from: ["awarded"], to: "in_execution" },
  submit: { from: ["in_execution"], to: "submitted" },
  evaluation_accept: { from: ["submitted"], to: "accepted" },
  evaluation_revise: { from: ["submitted"], to: "in_execution" },
  settle: { from: ["accepted"], to: "settled" },
  dispute: { from: ["awarded", "in_execution", "submitted", "accepted"], to: "disputed" },
  resolve: { from: ["disputed"], to: "resolved" }
};

/** Apply a transition or throw 409 INVALID_STATE. Returns the updated row. */
export function applyTransition(db: Db, mandate: Mandate, action: MandateAction): Mandate {
  const transition = TRANSITIONS[action];
  if (!transition.from.includes(mandate.state)) {
    throw invalidState(
      `Action '${action}' is not legal from state '${mandate.state}'`,
      { action, from: mandate.state, allowedFrom: transition.from }
    );
  }
  const updated = { ...mandate, state: transition.to, updatedAt: Date.now() };
  db.update(mandates)
    .set({ state: transition.to, updatedAt: updated.updatedAt })
    .where(eq(mandates.id, mandate.id))
    .run();
  return updated;
}

// ---------------------------------------------------------------------------
// Access resolution
// ---------------------------------------------------------------------------

export type MandateRole = "principal" | "operator" | "evaluator";

export interface MandateAccess {
  mandate: Mandate;
  award: Award | null;
  awardedOperatorKey: string | null;
  /** Viewer's role on this mandate, or null for outsiders. */
  role: MandateRole | null;
}

export function getMandate(db: Db, id: string): Mandate | null {
  return db.select().from(mandates).where(eq(mandates.id, id)).get() ?? null;
}

export function getAward(db: Db, mandateId: string): Award | null {
  return db.select().from(awards).where(eq(awards.mandateId, mandateId)).get() ?? null;
}

export function getMandateAccess(
  db: Db,
  mandateId: string,
  viewerKey: string | null
): MandateAccess | null {
  const mandate = getMandate(db, mandateId);
  if (!mandate) return null;

  const award = getAward(db, mandateId);
  let awardedOperatorKey: string | null = null;
  if (award) {
    const winning = db.select().from(bids).where(eq(bids.id, award.bidId)).get();
    awardedOperatorKey = winning?.operatorKey ?? null;
  }

  let role: MandateRole | null = null;
  if (viewerKey) {
    if (viewerKey === mandate.principalKey) role = "principal";
    else if (awardedOperatorKey && viewerKey === awardedOperatorKey) role = "operator";
    else if (mandate.evaluatorKey && viewerKey === mandate.evaluatorKey) role = "evaluator";
  }

  return { mandate, award, awardedOperatorKey, role };
}

/** Participants of a workroom: principal + awarded operator + evaluator. */
export function isParticipant(access: MandateAccess): boolean {
  return access.role !== null;
}
