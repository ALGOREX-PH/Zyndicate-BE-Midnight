import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { disputes, receipts, settlements } from "../../db/schema.js";
import type { ReceiptKind } from "../../db/schema.js";
import { sha256Hex } from "../../lib/crypto.js";
import { conflict } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { applyTransition } from "../mandates/service.js";
import type { Mandate, MandateAccess } from "../mandates/service.js";
import type { SettleBody } from "./schemas.js";

export type Settlement = typeof settlements.$inferSelect;
export type Receipt = typeof receipts.$inferSelect;

export function getSettlement(db: Db, mandateId: string): Settlement | null {
  return (
    db.select().from(settlements).where(eq(settlements.mandateId, mandateId)).get() ?? null
  );
}

export function hasOpenDispute(db: Db, mandateId: string): boolean {
  return (
    db
      .select({ id: disputes.id })
      .from(disputes)
      .where(and(eq(disputes.mandateId, mandateId), eq(disputes.status, "open")))
      .get() !== undefined
  );
}

function issueReceipt(
  db: Db,
  mandateId: string,
  holderKey: string,
  kind: ReceiptKind,
  settlementNullifier: string
): Receipt {
  const row: typeof receipts.$inferInsert = {
    id: newId("rcp"),
    mandateId,
    holderKey,
    kind,
    receiptCommitment: sha256Hex(
      `zyndicate:receipt:${kind}:${mandateId}:${holderKey}:${settlementNullifier}`
    ),
    issuedAt: Date.now()
  };
  db.insert(receipts).values(row).run();
  return row as Receipt;
}

/**
 * Settle exactly once:
 *  - frozen while a dispute is open (or the mandate is in `disputed` state),
 *  - duplicate settlement or nullifier reuse -> 409,
 *  - on success: state -> settled, completion receipt for the operator and
 *    payment receipt for the principal are auto-issued.
 */
export function settleMandate(
  db: Db,
  access: MandateAccess,
  body: SettleBody
): { settlement: Settlement; mandate: Mandate; issued: Receipt[] } {
  const mandate = access.mandate;

  if (mandate.state === "disputed" || hasOpenDispute(db, mandate.id)) {
    throw conflict(
      "SETTLEMENT_FROZEN",
      "Settlement is frozen while a dispute is open"
    );
  }
  if (getSettlement(db, mandate.id)) {
    throw conflict("ALREADY_SETTLED", "Mandate has already been settled");
  }
  const nullifierUsed = db
    .select({ mandateId: settlements.mandateId })
    .from(settlements)
    .where(eq(settlements.settlementNullifier, body.settlementNullifier))
    .get();
  if (nullifierUsed) {
    throw conflict("DUPLICATE_NULLIFIER", "Settlement nullifier has already been consumed");
  }

  const updated = applyTransition(db, mandate, "settle");

  const row: typeof settlements.$inferInsert = {
    mandateId: mandate.id,
    settlementNullifier: body.settlementNullifier,
    amountCommitment: body.amountCommitment ?? null,
    settledAt: Date.now()
  };
  db.insert(settlements).values(row).run();

  const issued: Receipt[] = [];
  if (access.awardedOperatorKey) {
    issued.push(
      issueReceipt(db, mandate.id, access.awardedOperatorKey, "completion", body.settlementNullifier)
    );
  }
  issued.push(
    issueReceipt(db, mandate.id, mandate.principalKey, "payment", body.settlementNullifier)
  );

  return { settlement: row as Settlement, mandate: updated, issued };
}

export interface VaultStatus {
  mandateId: string;
  state: string;
  disputeOpen: boolean;
  settlement: {
    settlementNullifier: string;
    amountCommitment: string | null;
    settledAt: number;
  } | null;
}

export function vaultStatus(db: Db, access: MandateAccess): VaultStatus {
  const settlement = getSettlement(db, access.mandate.id);
  return {
    mandateId: access.mandate.id,
    state: access.mandate.state,
    disputeOpen: hasOpenDispute(db, access.mandate.id),
    settlement: settlement
      ? {
          settlementNullifier: settlement.settlementNullifier,
          amountCommitment: settlement.amountCommitment,
          settledAt: settlement.settledAt
        }
      : null
  };
}
