import { desc, eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { awards, bids, disputes, mandates } from "../../db/schema.js";
import { conflict, forbidden, notFound } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { applyTransition, getMandateAccess } from "../mandates/service.js";
import type { Mandate, MandateAccess } from "../mandates/service.js";
import type { OpenDisputeBody, RulingBody } from "./schemas.js";

export type Dispute = typeof disputes.$inferSelect;

/** A dispute may be opened by a mandate party: principal or awarded operator. */
export function openDispute(
  db: Db,
  access: MandateAccess,
  openedBy: string,
  body: OpenDisputeBody
): { dispute: Dispute; mandate: Mandate } {
  if (access.role !== "principal" && access.role !== "operator") {
    throw forbidden("Only the principal or the awarded operator may open a dispute");
  }
  const updated = applyTransition(db, access.mandate, "dispute");
  const row: typeof disputes.$inferInsert = {
    id: newId("dsp"),
    mandateId: access.mandate.id,
    openedBy,
    disputeCommitment: body.disputeCommitment,
    status: "open",
    rulingCommitment: null,
    outcome: null,
    ruledAt: null,
    createdAt: Date.now()
  };
  db.insert(disputes).values(row).run();
  return { dispute: row as Dispute, mandate: updated };
}

export function getDispute(db: Db, id: string): Dispute | null {
  return db.select().from(disputes).where(eq(disputes.id, id)).get() ?? null;
}

/**
 * Tribunal authority (MVP): the mandate's designated evaluator, or a key from
 * the configured tribunal allowlist.
 */
export function ruleDispute(
  db: Db,
  tribunalKeys: string[],
  disputeId: string,
  viewerKey: string,
  body: RulingBody
): { dispute: Dispute; mandate: Mandate } {
  const dispute = getDispute(db, disputeId);
  if (!dispute) throw notFound("Dispute not found");

  const access = getMandateAccess(db, dispute.mandateId, viewerKey);
  if (!access) throw notFound("Mandate not found");

  const isTribunal =
    (access.mandate.evaluatorKey !== null && viewerKey === access.mandate.evaluatorKey) ||
    tribunalKeys.includes(viewerKey);
  if (!isTribunal) {
    throw forbidden("Only the tribunal authority may rule on this dispute");
  }
  if (dispute.status !== "open") {
    throw conflict("ALREADY_RULED", "Dispute has already been ruled");
  }

  const updatedMandate = applyTransition(db, access.mandate, "resolve");
  const ruledAt = Date.now();
  db.update(disputes)
    .set({
      status: "ruled",
      rulingCommitment: body.rulingCommitment,
      outcome: body.outcome,
      ruledAt
    })
    .where(eq(disputes.id, dispute.id))
    .run();

  return {
    dispute: {
      ...dispute,
      status: "ruled",
      rulingCommitment: body.rulingCommitment,
      outcome: body.outcome,
      ruledAt
    },
    mandate: updatedMandate
  };
}

/** Disputes visible to a viewer: opener, principal, awarded operator, evaluator. */
export function listDisputesFor(db: Db, viewerKey: string): Dispute[] {
  const rows = db
    .select({
      dispute: disputes,
      principalKey: mandates.principalKey,
      evaluatorKey: mandates.evaluatorKey,
      operatorKey: bids.operatorKey
    })
    .from(disputes)
    .innerJoin(mandates, eq(disputes.mandateId, mandates.id))
    .leftJoin(awards, eq(awards.mandateId, mandates.id))
    .leftJoin(bids, eq(bids.id, awards.bidId))
    .orderBy(desc(disputes.createdAt))
    .all();

  return rows
    .filter(
      (row) =>
        row.dispute.openedBy === viewerKey ||
        row.principalKey === viewerKey ||
        row.evaluatorKey === viewerKey ||
        row.operatorKey === viewerKey
    )
    .map((row) => row.dispute);
}
