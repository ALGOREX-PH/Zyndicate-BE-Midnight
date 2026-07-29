# Zyndicate - Coordination Service

**The sealed market for trusted digital work.**

Zyndicate is an exchange where **principals** publish **mandates**, confidential units of work, and **operators** (human cells or autonomous agents) answer them with **sealed bids**. A mandate carries a **covenant** that fixes the terms before bidding opens; the winning bid opens a **workroom** where encrypted messages and artifacts move between the parties; the operator commits a **submission**, an evaluator records an **attestation**, and the **vault** releases settlement exactly once, minting **proof receipts** that build each participant's **passport**. When the parties disagree, a **tribunal** rules on an evidence-capsule commitment. This repository is the coordination service behind that flow: a Fastify + TypeScript API that sequences mandate state, enforces role-based access, and mirrors commitments and nullifiers, deliberately without ever being able to read the work it coordinates.

**Status:** 56 tests passing across 10 files. `tsc --noEmit` clean. `eslint .` clean.

---

## The privacy contract of this service

This service is **not trusted with the content of the work**. That is a constraint enforced by the schema and the route handlers, not a promise in a policy document.

### What the server stores

| Stored | Examples |
| --- | --- |
| Class A public summaries | mandate id, `publicDomain`, `complexityBand`, `discoveryMode`, `state`, `bidDeadline`, `executionDeadline`, optional `rewardBand`, optional `chainAddress` |
| Opaque client-encrypted ciphertext + nonce blobs | the full mandate package, sealed bid bodies, workroom messages, workroom artifacts |
| Commitments, digests, nullifier mirrors | `mandateCommitment`, `covenantCommitment`, `bidCommitment`, `bidNullifier`, `submissionCommitment`, artifact `digest`, `evaluationCommitment`, `disputeCommitment`, `rulingCommitment`, `settlementNullifier`, `amountCommitment`, `receiptCommitment`, credential `commitment` |
| Role metadata needed for access control | `principalKey`, `operatorKey`, `evaluatorKey`, award and acceptance timestamps, mandate state |

### What the server must never receive or hold

- **No decryption keys.** Ciphertext columns are written and returned verbatim. Nothing in `src/` derives, escrows, or requests a key.
- **No plaintext budgets.** The budget lives inside the encrypted mandate package. The only budget-adjacent public field is `rewardBand`, a coarse optional band that the covenant may permit.
- **No plaintext bid amounts.** A bid arrives as a commitment, a nullifier, and a ciphertext blob. The principal decrypts client-side after the bid window closes.
- **No plaintext deliverables.** Artifacts and submissions carry a display name, a client-computed digest, and ciphertext. Evaluation notes never leave the client; only their commitment and a signed attestation blob are stored.

### How the boundary is held

- **Field-level visibility** (PRD section 13, classes A to F). Class A summaries are the only thing served to unauthenticated callers. Class B/C/E payloads exist here purely as ciphertext. Class D never arrives at all: private keys, bid-opening randomness, and local decision policy stay on the participant's device. Class F session material is never persisted.
- **Role-aware serialization.** `toPublicSummary` strips the principal identity and every ciphertext column. `toDetail` re-attaches `encryptedPackage` only for the principal and the awarded operator, and role metadata only for participants.
- **404-not-403 discipline.** Drafts, invitation-only mandates, workrooms, vaults, and other operators' bids answer `404 NOT_FOUND` to non-participants, so the API never confirms that a confidential object exists.
- **Sealed-bid asymmetry.** The principal can list every bid on their mandate; an operator can only ever retrieve their own row. Nothing in the listing exposes a competitor's blob.
- **Nullifier mirrors.** Duplicate bidding and double settlement are rejected by unique nullifier constraints, without the server learning which private object was consumed.
- **Log redaction.** Pino redacts `authorization`, `cookie`, and every `ciphertext` / `nonce` / `signature` / `token` / `encryptedBid` / `encryptedPackage` path, so opaque payloads never reach log aggregation as traffic metadata.

Losing this database leaks the shape of the market - how many mandates, in which domains, at what coarse complexity - and nothing about the work itself.
