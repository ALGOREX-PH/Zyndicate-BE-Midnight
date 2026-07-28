import { and, eq, or } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { bids } from "../../db/schema.js";
import { conflict, forbidden, invalidState, notFound } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import type { Mandate, MandateAccess } from "../mandates/service.js";
import type { PlaceBidBody } from "./schemas.js";

export type Bid = typeof bids.$inferSelect;

export interface BidView {
  id: string;
  mandateId: string;
  operatorKey: string;
  bidCommitment: string;
  bidNullifier: string;
  status: Bid["status"];
  createdAt: number;
  updatedAt: number;
  /** Sealed bid ciphertext — included only for the principal and the owner. */
  encryptedBid?: { ciphertext: string; nonce: string };
}

export function toBidView(bid: Bid, includeCiphertext: boolean): BidView {
  const view: BidView = {
    id: bid.id,
    mandateId: bid.mandateId,
    operatorKey: bid.operatorKey,
    bidCommitment: bid.bidCommitment,
    bidNullifier: bid.bidNullifier,
    status: bid.status,
    createdAt: bid.createdAt,
    updatedAt: bid.updatedAt
  };
  if (includeCiphertext) {
    view.encryptedBid = {
      ciphertext: bid.encryptedBidCiphertext,
      nonce: bid.encryptedBidNonce
    };
  }
  return view;
}

export function placeBid(
  db: Db,
  mandate: Mandate,
  operatorKey: string,
  body: PlaceBidBody
): Bid {
  if (mandate.principalKey === operatorKey) {
    throw forbidden("Principals cannot bid on their own mandates");
  }
  if (mandate.state !== "open_for_bids") {
    throw invalidState(`Mandate is not open for bids (state '${mandate.state}')`);
  }
  if (mandate.bidDeadline !== null && Date.now() > mandate.bidDeadline) {
    throw conflict("BID_WINDOW_CLOSED", "The bid deadline has passed");
  }

  const duplicate = db
    .select({ id: bids.id, bidNullifier: bids.bidNullifier })
    .from(bids)
    .where(
      or(eq(bids.bidNullifier, body.bidNullifier), eq(bids.bidCommitment, body.bidCommitment))
    )
    .get();
  if (duplicate) {
    const code =
      duplicate.bidNullifier === body.bidNullifier
        ? "DUPLICATE_NULLIFIER"
        : "DUPLICATE_COMMITMENT";
    throw conflict(code, "A bid with this nullifier or commitment already exists");
  }

  const existingPending = db
    .select({ id: bids.id })
    .from(bids)
    .where(
      and(
        eq(bids.mandateId, mandate.id),
        eq(bids.operatorKey, operatorKey),
        eq(bids.status, "pending")
      )
    )
    .get();
  if (existingPending) {
    throw conflict(
      "DUPLICATE_BID",
      "Operator already has a pending sealed bid on this mandate; withdraw it first"
    );
  }

  const now = Date.now();
  const row: typeof bids.$inferInsert = {
    id: newId("bid"),
    mandateId: mandate.id,
    operatorKey,
    bidCommitment: body.bidCommitment,
    bidNullifier: body.bidNullifier,
    encryptedBidCiphertext: body.encryptedBid.ciphertext,
    encryptedBidNonce: body.encryptedBid.nonce,
    status: "pending",
    createdAt: now,
    updatedAt: now
  };
  db.insert(bids).values(row).run();
  return row as Bid;
}

/**
 * Sealed-bid visibility: the principal sees every bid (ciphertext included,
 * decryptable only client-side); an operator sees only their own bid.
 */
export function listBidsFor(db: Db, access: MandateAccess, viewerKey: string): BidView[] {
  if (viewerKey === access.mandate.principalKey) {
    const rows = db.select().from(bids).where(eq(bids.mandateId, access.mandate.id)).all();
    return rows.map((bid) => toBidView(bid, true));
  }
  const rows = db
    .select()
    .from(bids)
    .where(and(eq(bids.mandateId, access.mandate.id), eq(bids.operatorKey, viewerKey)))
    .all();
  return rows.map((bid) => toBidView(bid, true));
}

export function withdrawBid(db: Db, mandateId: string, bidId: string, viewerKey: string): Bid {
  const bid = db
    .select()
    .from(bids)
    .where(and(eq(bids.id, bidId), eq(bids.mandateId, mandateId)))
    .get();
  // 404 discipline: outsiders cannot distinguish "no such bid" from "not yours".
  if (!bid || bid.operatorKey !== viewerKey) throw notFound("Bid not found");
  if (bid.status !== "pending") {
    throw conflict("BID_NOT_PENDING", `Bid is '${bid.status}' and cannot be withdrawn`);
  }
  const updatedAt = Date.now();
  db.update(bids).set({ status: "withdrawn", updatedAt }).where(eq(bids.id, bid.id)).run();
  return { ...bid, status: "withdrawn", updatedAt };
}
