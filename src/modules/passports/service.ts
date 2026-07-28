import { and, count, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { credentials, identities, receipts } from "../../db/schema.js";
import { newId } from "../../lib/ids.js";
import type { AddCredentialBody } from "./schemas.js";

export type Credential = typeof credentials.$inferSelect;

/**
 * Public coarse passport (PRD 14.2): identity class, qualified domains, and a
 * completion band. Never raw history, counts, or counterparties.
 */
export interface PublicPassport {
  publicKey: string;
  identityClass: string;
  domains: string[];
  completionBand: "none" | "emerging" | "established" | "high";
  activeSince: number;
}

function completionBand(completions: number): PublicPassport["completionBand"] {
  if (completions >= 10) return "high";
  if (completions >= 3) return "established";
  if (completions >= 1) return "emerging";
  return "none";
}

export function getPublicPassport(db: Db, publicKey: string): PublicPassport | null {
  const identity = db
    .select()
    .from(identities)
    .where(eq(identities.publicKey, publicKey))
    .get();
  if (!identity) return null;

  const activeCredentials = db
    .select({ domain: credentials.domain })
    .from(credentials)
    .where(and(eq(credentials.passportKey, publicKey), isNull(credentials.revokedAt)))
    .all();
  const domains = [...new Set(activeCredentials.map((row) => row.domain))].sort();

  const completions =
    db
      .select({ value: count() })
      .from(receipts)
      .where(and(eq(receipts.holderKey, publicKey), eq(receipts.kind, "completion")))
      .get()?.value ?? 0;

  return {
    publicKey,
    identityClass: domains.length > 0 ? "credentialed_operator" : "registered",
    domains,
    completionBand: completionBand(completions),
    activeSince: identity.createdAt
  };
}

export function addCredential(db: Db, passportKey: string, body: AddCredentialBody): Credential {
  const row: typeof credentials.$inferInsert = {
    id: newId("crd"),
    passportKey,
    domain: body.domain,
    kind: body.kind,
    commitment: body.commitment,
    revokedAt: null,
    issuedAt: Date.now()
  };
  db.insert(credentials).values(row).run();
  return row as Credential;
}
