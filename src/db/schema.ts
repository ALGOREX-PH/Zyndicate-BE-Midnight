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
