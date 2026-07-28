import { eq, lt } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { authChallenges, identities } from "../../db/schema.js";
import { generateNonce, verifyAuthSignature } from "../../lib/crypto.js";
import { unauthorized } from "../../lib/errors.js";

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export interface PublicIdentity {
  publicKey: string;
  displayName: string | null;
  roleHints: string[];
  createdAt: number;
}

export function toPublicIdentity(row: typeof identities.$inferSelect): PublicIdentity {
  return {
    publicKey: row.publicKey,
    displayName: row.displayName,
    roleHints: row.roleHints ? (JSON.parse(row.roleHints) as string[]) : [],
    createdAt: row.createdAt
  };
}

export function createChallenge(db: Db, publicKey: string): { nonce: string; expiresAt: number } {
  // Opportunistically clear expired challenges.
  db.delete(authChallenges).where(lt(authChallenges.expiresAt, Date.now())).run();

  const nonce = generateNonce();
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;
  db.insert(authChallenges).values({ nonce, publicKey, expiresAt }).run();
  return { nonce, expiresAt };
}

export function verifyChallenge(
  db: Db,
  publicKey: string,
  nonce: string,
  signature: string
): PublicIdentity {
  const challenge = db
    .select()
    .from(authChallenges)
    .where(eq(authChallenges.nonce, nonce))
    .get();

  if (
    !challenge ||
    challenge.publicKey !== publicKey ||
    challenge.consumedAt !== null ||
    challenge.expiresAt < Date.now()
  ) {
    throw unauthorized("Challenge is unknown, expired, or already consumed");
  }

  if (!verifyAuthSignature(publicKey, nonce, signature)) {
    throw unauthorized("Signature verification failed");
  }

  db.update(authChallenges)
    .set({ consumedAt: Date.now() })
    .where(eq(authChallenges.nonce, nonce))
    .run();

  const existing = db
    .select()
    .from(identities)
    .where(eq(identities.publicKey, publicKey))
    .get();
  if (existing) return toPublicIdentity(existing);

  const row = { publicKey, displayName: null, roleHints: null, createdAt: Date.now() };
  db.insert(identities).values(row).run();
  return toPublicIdentity(row as typeof identities.$inferSelect);
}

export function getIdentity(db: Db, publicKey: string): PublicIdentity | null {
  const row = db
    .select()
    .from(identities)
    .where(eq(identities.publicKey, publicKey))
    .get();
  return row ? toPublicIdentity(row) : null;
}

export function updateIdentity(
  db: Db,
  publicKey: string,
  update: { displayName?: string | null; roleHints?: string[] }
): PublicIdentity | null {
  const changes: Partial<typeof identities.$inferInsert> = {};
  if (update.displayName !== undefined) changes.displayName = update.displayName;
  if (update.roleHints !== undefined) changes.roleHints = JSON.stringify(update.roleHints);
  if (Object.keys(changes).length > 0) {
    db.update(identities).set(changes).where(eq(identities.publicKey, publicKey)).run();
  }
  return getIdentity(db, publicKey);
}
