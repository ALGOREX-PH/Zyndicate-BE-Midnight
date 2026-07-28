import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Zyndicate coordination-service schema.
 *
 * Privacy invariant: this database stores ONLY
 *  - Class A public mandate summaries,
 *  - client-side-encrypted ciphertext blobs (the server never holds keys),
 *  - commitments / digests / nullifier mirrors,
 *  - role metadata needed for access control.
 * No plaintext budgets, bid amounts, or deliverable contents ever land here.
 */

// ---------------------------------------------------------------------------
// Identities & auth
// ---------------------------------------------------------------------------

export const identities = sqliteTable("identities", {
  /** ed25519 public key, lowercase hex (64 chars). */
  publicKey: text("public_key").primaryKey(),
  displayName: text("display_name"),
  /** JSON array of self-declared role hints: principal | operator | evaluator. */
  roleHints: text("role_hints"),
  createdAt: integer("created_at").notNull()
});

export const authChallenges = sqliteTable("auth_challenges", {
  nonce: text("nonce").primaryKey(),
  publicKey: text("public_key").notNull(),
  expiresAt: integer("expires_at").notNull(),
  consumedAt: integer("consumed_at")
});

// ---------------------------------------------------------------------------
// Mandates
// ---------------------------------------------------------------------------

export const MANDATE_STATES = [
  "draft",
  "open_for_bids",
  "bidding_closed",
  "awarded",
  "in_execution",
  "submitted",
  "accepted",
  "settled",
  "disputed",
  "resolved",
  "cancelled"
] as const;
export type MandateState = (typeof MANDATE_STATES)[number];

export const DISCOVERY_MODES = ["open", "gated", "invitation"] as const;
export type DiscoveryMode = (typeof DISCOVERY_MODES)[number];

export const mandates = sqliteTable("mandates", {
  id: text("id").primaryKey(),
  principalKey: text("principal_key")
    .notNull()
    .references(() => identities.publicKey),
  /** Class A: coarse public domain, e.g. "security", "data-analysis". */
  publicDomain: text("public_domain").notNull(),
  /** Class A: coarse complexity band, never the budget. */
  complexityBand: text("complexity_band"),
  discoveryMode: text("discovery_mode").notNull().default("open"),
  state: text("state").$type<MandateState>().notNull().default("draft"),
  bidDeadline: integer("bid_deadline"),
  executionDeadline: integer("execution_deadline"),
  /** Commitment binding the full private mandate package. */
  mandateCommitment: text("mandate_commitment").notNull(),
  /** Commitment binding the covenant (immutable once bidding opens). */
  covenantCommitment: text("covenant_commitment").notNull(),
  /** Class B ciphertext: full mandate package, encrypted client-side. */
  encryptedPackageCiphertext: text("encrypted_package_ciphertext").notNull(),
  encryptedPackageNonce: text("encrypted_package_nonce").notNull(),
  /** Class A optional coarse reward band, when the covenant permits it. */
  rewardBand: text("reward_band"),
  /** Optional on-chain contract address mirror (Midnight). */
  chainAddress: text("chain_address"),
  /** Designated evaluator public key (role metadata; may be null = principal-led). */
  evaluatorKey: text("evaluator_key"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull()
});

// ---------------------------------------------------------------------------
// Sealed bids & awards
// ---------------------------------------------------------------------------

export const BID_STATUSES = ["pending", "withdrawn", "awarded", "rejected"] as const;
export type BidStatus = (typeof BID_STATUSES)[number];

export const bids = sqliteTable("bids", {
  id: text("id").primaryKey(),
  mandateId: text("mandate_id")
    .notNull()
    .references(() => mandates.id),
  operatorKey: text("operator_key")
    .notNull()
    .references(() => identities.publicKey),
  /** Commitment to the sealed bid contents. */
  bidCommitment: text("bid_commitment").notNull().unique(),
  /** Nullifier preventing duplicate/replayed bids by one operator. */
  bidNullifier: text("bid_nullifier").notNull().unique(),
  /** Class B ciphertext: sealed bid, readable only by the principal client-side. */
  encryptedBidCiphertext: text("encrypted_bid_ciphertext").notNull(),
  encryptedBidNonce: text("encrypted_bid_nonce").notNull(),
  status: text("status").$type<BidStatus>().notNull().default("pending"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull()
});

export const awards = sqliteTable("awards", {
  mandateId: text("mandate_id")
    .primaryKey()
    .references(() => mandates.id),
  bidId: text("bid_id")
    .notNull()
    .references(() => bids.id),
  awardedAt: integer("awarded_at").notNull(),
  /** Set when the awarded operator accepts and execution begins. */
  acceptedAt: integer("accepted_at")
});

// ---------------------------------------------------------------------------
// Workrooms
// ---------------------------------------------------------------------------

export const workroomMessages = sqliteTable("workroom_messages", {
  id: text("id").primaryKey(),
  mandateId: text("mandate_id")
    .notNull()
    .references(() => mandates.id),
  senderKey: text("sender_key").notNull(),
  /** Class B ciphertext: message body encrypted client-side for participants. */
  ciphertext: text("ciphertext").notNull(),
  nonce: text("nonce").notNull(),
  createdAt: integer("created_at").notNull()
});

export const workroomArtifacts = sqliteTable("workroom_artifacts", {
  id: text("id").primaryKey(),
  mandateId: text("mandate_id")
    .notNull()
    .references(() => mandates.id),
  uploaderKey: text("uploader_key").notNull(),
  /** Display name only; contents live in the ciphertext blob. */
  name: text("name").notNull(),
  /** Plain digest of the plaintext artifact for integrity checking. */
  digest: text("digest").notNull(),
  version: integer("version").notNull().default(1),
  /** Class B ciphertext: artifact contents encrypted client-side. */
  ciphertext: text("ciphertext").notNull(),
  nonce: text("nonce").notNull(),
  createdAt: integer("created_at").notNull()
});

// ---------------------------------------------------------------------------
// Submissions & evaluations
// ---------------------------------------------------------------------------

export const submissions = sqliteTable("submissions", {
  id: text("id").primaryKey(),
  mandateId: text("mandate_id")
    .notNull()
    .references(() => mandates.id),
  artifactId: text("artifact_id")
    .notNull()
    .references(() => workroomArtifacts.id),
  /** Commitment anchoring the submission to the mandate. */
  submissionCommitment: text("submission_commitment").notNull(),
  /** Digest of the submitted artifact plaintext. */
  digest: text("digest").notNull(),
  submittedAt: integer("submitted_at").notNull()
});

export const EVALUATION_VERDICTS = ["accept", "reject", "revise"] as const;
export type EvaluationVerdict = (typeof EVALUATION_VERDICTS)[number];

export const evaluations = sqliteTable("evaluations", {
  id: text("id").primaryKey(),
  mandateId: text("mandate_id")
    .notNull()
    .references(() => mandates.id),
  evaluatorKey: text("evaluator_key").notNull(),
  verdict: text("verdict").$type<EvaluationVerdict>().notNull(),
  /** Commitment to the private evaluation notes. */
  evaluationCommitment: text("evaluation_commitment").notNull(),
  /** Signed attestation blob from the evaluator (opaque to the server). */
  attestation: text("attestation").notNull(),
  createdAt: integer("created_at").notNull()
});

// ---------------------------------------------------------------------------
// Vault settlements & disputes
// ---------------------------------------------------------------------------

export const settlements = sqliteTable("settlements", {
  mandateId: text("mandate_id")
    .primaryKey()
    .references(() => mandates.id),
  /** Nullifier guaranteeing settlement happens exactly once. */
  settlementNullifier: text("settlement_nullifier").notNull().unique(),
  /** Optional commitment to the settled amount (never the amount itself). */
  amountCommitment: text("amount_commitment"),
  settledAt: integer("settled_at").notNull()
});

export const DISPUTE_STATUSES = ["open", "ruled"] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

export const DISPUTE_OUTCOMES = ["release", "refund"] as const;
export type DisputeOutcome = (typeof DISPUTE_OUTCOMES)[number];

export const disputes = sqliteTable("disputes", {
  id: text("id").primaryKey(),
  mandateId: text("mandate_id")
    .notNull()
    .references(() => mandates.id),
  openedBy: text("opened_by").notNull(),
  /** Commitment to the evidence capsule backing the dispute. */
  disputeCommitment: text("dispute_commitment").notNull(),
  status: text("status").$type<DisputeStatus>().notNull().default("open"),
  rulingCommitment: text("ruling_commitment"),
  outcome: text("outcome").$type<DisputeOutcome>(),
  ruledAt: integer("ruled_at"),
  createdAt: integer("created_at").notNull()
});

// ---------------------------------------------------------------------------
// Proof receipts & passport credentials
// ---------------------------------------------------------------------------

export const RECEIPT_KINDS = ["completion", "payment", "evaluation"] as const;
export type ReceiptKind = (typeof RECEIPT_KINDS)[number];

export const receipts = sqliteTable("receipts", {
  id: text("id").primaryKey(),
  mandateId: text("mandate_id")
    .notNull()
    .references(() => mandates.id),
  holderKey: text("holder_key").notNull(),
  kind: text("kind").$type<ReceiptKind>().notNull(),
  /** Commitment mirror; the receipt opening lives with the holder. */
  receiptCommitment: text("receipt_commitment").notNull(),
  issuedAt: integer("issued_at").notNull()
});

export const credentials = sqliteTable("credentials", {
  id: text("id").primaryKey(),
  passportKey: text("passport_key")
    .notNull()
    .references(() => identities.publicKey),
  /** Coarse public domain of the capability, e.g. "security". */
  domain: text("domain").notNull(),
  /** Credential kind, e.g. "capability", "institutional", "certification". */
  kind: text("kind").notNull(),
  /** Commitment to the full credential; contents stay with the holder. */
  commitment: text("commitment").notNull(),
  revokedAt: integer("revoked_at"),
  issuedAt: integer("issued_at").notNull()
});
