import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  db: Db;
  sqlite: Database.Database;
}

const DDL = `
CREATE TABLE IF NOT EXISTS identities (
  public_key TEXT PRIMARY KEY,
  display_name TEXT,
  role_hints TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_challenges (
  nonce TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE TABLE IF NOT EXISTS mandates (
  id TEXT PRIMARY KEY,
  principal_key TEXT NOT NULL REFERENCES identities(public_key),
  public_domain TEXT NOT NULL,
  complexity_band TEXT,
  discovery_mode TEXT NOT NULL DEFAULT 'open',
  state TEXT NOT NULL DEFAULT 'draft',
  bid_deadline INTEGER,
  execution_deadline INTEGER,
  mandate_commitment TEXT NOT NULL,
  covenant_commitment TEXT NOT NULL,
  encrypted_package_ciphertext TEXT NOT NULL,
  encrypted_package_nonce TEXT NOT NULL,
  reward_band TEXT,
  chain_address TEXT,
  evaluator_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mandates_state ON mandates(state);
CREATE INDEX IF NOT EXISTS idx_mandates_domain ON mandates(public_domain);
CREATE INDEX IF NOT EXISTS idx_mandates_principal ON mandates(principal_key);

CREATE TABLE IF NOT EXISTS bids (
  id TEXT PRIMARY KEY,
  mandate_id TEXT NOT NULL REFERENCES mandates(id),
  operator_key TEXT NOT NULL REFERENCES identities(public_key),
  bid_commitment TEXT NOT NULL UNIQUE,
  bid_nullifier TEXT NOT NULL UNIQUE,
  encrypted_bid_ciphertext TEXT NOT NULL,
  encrypted_bid_nonce TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bids_mandate ON bids(mandate_id);
CREATE INDEX IF NOT EXISTS idx_bids_operator ON bids(operator_key);

CREATE TABLE IF NOT EXISTS awards (
  mandate_id TEXT PRIMARY KEY REFERENCES mandates(id),
  bid_id TEXT NOT NULL REFERENCES bids(id),
  awarded_at INTEGER NOT NULL,
  accepted_at INTEGER
);

CREATE TABLE IF NOT EXISTS workroom_messages (
  id TEXT PRIMARY KEY,
  mandate_id TEXT NOT NULL REFERENCES mandates(id),
  sender_key TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workroom_messages_mandate ON workroom_messages(mandate_id);

CREATE TABLE IF NOT EXISTS workroom_artifacts (
  id TEXT PRIMARY KEY,
  mandate_id TEXT NOT NULL REFERENCES mandates(id),
  uploader_key TEXT NOT NULL,
  name TEXT NOT NULL,
  digest TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workroom_artifacts_mandate ON workroom_artifacts(mandate_id);

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  mandate_id TEXT NOT NULL REFERENCES mandates(id),
  artifact_id TEXT NOT NULL REFERENCES workroom_artifacts(id),
  submission_commitment TEXT NOT NULL,
  digest TEXT NOT NULL,
  submitted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_submissions_mandate ON submissions(mandate_id);

CREATE TABLE IF NOT EXISTS evaluations (
  id TEXT PRIMARY KEY,
  mandate_id TEXT NOT NULL REFERENCES mandates(id),
  evaluator_key TEXT NOT NULL,
  verdict TEXT NOT NULL,
  evaluation_commitment TEXT NOT NULL,
  attestation TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evaluations_mandate ON evaluations(mandate_id);

CREATE TABLE IF NOT EXISTS settlements (
  mandate_id TEXT PRIMARY KEY REFERENCES mandates(id),
  settlement_nullifier TEXT NOT NULL UNIQUE,
  amount_commitment TEXT,
  settled_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY,
  mandate_id TEXT NOT NULL REFERENCES mandates(id),
  opened_by TEXT NOT NULL,
  dispute_commitment TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  ruling_commitment TEXT,
  outcome TEXT,
  ruled_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_disputes_mandate ON disputes(mandate_id);

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  mandate_id TEXT NOT NULL REFERENCES mandates(id),
  holder_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  receipt_commitment TEXT NOT NULL,
  issued_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_receipts_holder ON receipts(holder_key);

CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  passport_key TEXT NOT NULL REFERENCES identities(public_key),
  domain TEXT NOT NULL,
  kind TEXT NOT NULL,
  commitment TEXT NOT NULL,
  revoked_at INTEGER,
  issued_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credentials_passport ON credentials(passport_key);
`;

/**
 * Open (or create) the SQLite database, enable WAL, and apply idempotent
 * migrations on boot.
 */
export function createDb(databasePath: string): DbHandle {
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }
  const sqlite = new Database(databasePath);
  if (databasePath !== ":memory:") {
    sqlite.pragma("journal_mode = WAL");
  }
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(DDL);
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}
