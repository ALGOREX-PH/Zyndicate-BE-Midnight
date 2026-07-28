import { and, count, desc, eq, ne } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { awards, bids, mandates } from "../../db/schema.js";
import type { MandateState } from "../../db/schema.js";
import { conflict, invalidState, notFound } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";

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

// ---------------------------------------------------------------------------
// Role-aware serialization — Class A summary vs participant detail.
// ---------------------------------------------------------------------------

export interface MandateSummary {
  id: string;
  publicDomain: string;
  complexityBand: string | null;
  discoveryMode: string;
  state: MandateState;
  bidDeadline: number | null;
  executionDeadline: number | null;
  mandateCommitment: string;
  covenantCommitment: string;
  rewardBand: string | null;
  chainAddress: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Class A public summary. Never includes principal identity or ciphertext. */
export function toPublicSummary(mandate: Mandate): MandateSummary {
  return {
    id: mandate.id,
    publicDomain: mandate.publicDomain,
    complexityBand: mandate.complexityBand,
    discoveryMode: mandate.discoveryMode,
    state: mandate.state,
    bidDeadline: mandate.bidDeadline,
    executionDeadline: mandate.executionDeadline,
    mandateCommitment: mandate.mandateCommitment,
    covenantCommitment: mandate.covenantCommitment,
    rewardBand: mandate.rewardBand,
    chainAddress: mandate.chainAddress,
    createdAt: mandate.createdAt,
    updatedAt: mandate.updatedAt
  };
}

export interface MandateDetail extends MandateSummary {
  viewerRole: MandateRole | null;
  /** Present only for the principal and (post-award) the awarded operator. */
  encryptedPackage?: { ciphertext: string; nonce: string };
  /** Participant-only role metadata. */
  principalKey?: string;
  evaluatorKey?: string | null;
  awardedBidId?: string | null;
  awardAcceptedAt?: number | null;
}

export function toDetail(access: MandateAccess): MandateDetail {
  const { mandate, role, award } = access;
  const detail: MandateDetail = { ...toPublicSummary(mandate), viewerRole: role };

  if (role === "principal" || role === "operator") {
    detail.encryptedPackage = {
      ciphertext: mandate.encryptedPackageCiphertext,
      nonce: mandate.encryptedPackageNonce
    };
  }
  if (role !== null) {
    detail.principalKey = mandate.principalKey;
    detail.evaluatorKey = mandate.evaluatorKey;
    detail.awardedBidId = award?.bidId ?? null;
    detail.awardAcceptedAt = award?.acceptedAt ?? null;
  }
  return detail;
}

// ---------------------------------------------------------------------------
// Queries & commands
// ---------------------------------------------------------------------------

export interface ListFilters {
  domain?: string;
  state?: MandateState;
  mine: boolean;
  viewerKey: string | null;
}

export function listMandates(
  db: Db,
  filters: ListFilters,
  offset: number,
  limit: number
): { rows: Mandate[]; total: number } {
  const conditions = [];
  if (filters.domain) conditions.push(eq(mandates.publicDomain, filters.domain));
  if (filters.state) conditions.push(eq(mandates.state, filters.state));

  if (filters.mine && filters.viewerKey) {
    conditions.push(eq(mandates.principalKey, filters.viewerKey));
  } else {
    // Public discovery: drafts and invitation-only mandates are not listed.
    conditions.push(ne(mandates.state, "draft"));
    conditions.push(ne(mandates.discoveryMode, "invitation"));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const rows = db
    .select()
    .from(mandates)
    .where(where)
    .orderBy(desc(mandates.createdAt))
    .limit(limit)
    .offset(offset)
    .all();
  const total =
    db.select({ value: count() }).from(mandates).where(where).get()?.value ?? 0;
  return { rows, total };
}

export interface CreateMandateInput {
  publicDomain: string;
  complexityBand?: string;
  discoveryMode: "open" | "gated" | "invitation";
  bidDeadline?: number;
  executionDeadline?: number;
  mandateCommitment: string;
  covenantCommitment: string;
  encryptedPackage: { ciphertext: string; nonce: string };
  rewardBand?: string;
  chainAddress?: string;
  evaluatorKey?: string;
}

export function createMandate(db: Db, principalKey: string, input: CreateMandateInput): Mandate {
  const now = Date.now();
  const row: typeof mandates.$inferInsert = {
    id: newId("man"),
    principalKey,
    publicDomain: input.publicDomain,
    complexityBand: input.complexityBand ?? null,
    discoveryMode: input.discoveryMode,
    state: "draft",
    bidDeadline: input.bidDeadline ?? null,
    executionDeadline: input.executionDeadline ?? null,
    mandateCommitment: input.mandateCommitment,
    covenantCommitment: input.covenantCommitment,
    encryptedPackageCiphertext: input.encryptedPackage.ciphertext,
    encryptedPackageNonce: input.encryptedPackage.nonce,
    rewardBand: input.rewardBand ?? null,
    chainAddress: input.chainAddress ?? null,
    evaluatorKey: input.evaluatorKey ?? null,
    createdAt: now,
    updatedAt: now
  };
  db.insert(mandates).values(row).run();
  return row as Mandate;
}

/** Award a bid: winner -> awarded, other pending bids -> rejected. */
export function awardBid(db: Db, mandate: Mandate, bidId: string): { mandate: Mandate; bid: typeof bids.$inferSelect } {
  const bid = db
    .select()
    .from(bids)
    .where(and(eq(bids.id, bidId), eq(bids.mandateId, mandate.id)))
    .get();
  if (!bid) throw notFound("Bid not found for this mandate");
  if (bid.status !== "pending") {
    throw conflict("BID_NOT_PENDING", `Bid is '${bid.status}' and cannot be awarded`);
  }

  const updated = applyTransition(db, mandate, "award");
  const now = Date.now();
  db.update(bids)
    .set({ status: "rejected", updatedAt: now })
    .where(and(eq(bids.mandateId, mandate.id), eq(bids.status, "pending")))
    .run();
  db.update(bids).set({ status: "awarded", updatedAt: now }).where(eq(bids.id, bid.id)).run();
  db.insert(awards).values({ mandateId: mandate.id, bidId: bid.id, awardedAt: now }).run();
  return { mandate: updated, bid: { ...bid, status: "awarded" } };
}

/** Awarded operator accepts; execution begins. */
export function acceptAward(db: Db, access: MandateAccess): Mandate {
  const award = access.award;
  if (!award) throw invalidState("Mandate has no award to accept");
  const updated = applyTransition(db, access.mandate, "accept_award");
  db.update(awards)
    .set({ acceptedAt: Date.now() })
    .where(eq(awards.mandateId, access.mandate.id))
    .run();
  return updated;
}
