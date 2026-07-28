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
