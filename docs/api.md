# Zyndicate API Reference

Coordination service for the Zyndicate exchange. Every application route is served under `/api/v1`; health and documentation routes sit at the root. A live OpenAPI document is generated from the same zod schemas that validate requests and is served at `/docs/json`, with Swagger UI at `/docs`.

- **Base URL (local):** `http://localhost:4000`
- **Content type:** `application/json` on every request with a body
- **Authentication:** `Authorization: Bearer <jwt>`
- **Body limit:** 2 MB

Everything the server accepts is either a public Class A field, an opaque client-encrypted blob, a commitment/digest/nullifier, or role metadata. Do not send plaintext budgets, bid amounts, evaluation notes, or deliverable contents to any endpoint on this service: it has no keys and no way to protect them.

## Field conventions

| Field kind | Shape |
| --- | --- |
| Public key | 64 lowercase hex characters (32-byte ed25519 key). Mixed case is accepted and lowercased |
| Signature | 128 hex characters (64-byte ed25519 signature) |
| Commitment, nullifier, digest | Opaque string, 8 to 256 characters |
| Encrypted payload | `{ "ciphertext": base64, "nonce": base64 }`; ciphertext up to ~1.5 MB, nonce up to 256 characters |
| Timestamps | Epoch milliseconds, except `expiresAt` from `/auth/challenge`, which is ISO-8601 |
| Deadlines on input | Epoch milliseconds or an ISO-8601 datetime string; stored as epoch milliseconds |
| Identifiers | Prefixed and URL-safe: `man_`, `bid_`, `msg_`, `art_`, `sub_`, `evl_`, `dsp_`, `rcp_`, `crd_` |

---

## Authentication flow

Zyndicate has no passwords. An identity is an ed25519 key pair whose private half never leaves the participant's device. Authenticating is proving possession of that key; the first successful proof also registers the identity.

### 1. Request a challenge

```http
POST /api/v1/auth/challenge
Content-Type: application/json

{ "publicKey": "85ef9b03e9498efb13e05348d1410d4184150117caa2a48aa63fa7e00a6affee" }
```

```json
{
  "nonce": "3449cccde0fb821cb653c11c9b456d2688f42ea7a528e6c81df798f7fe8877b0",
  "expiresAt": "2026-07-29T01:52:27.763Z"
}
```

The nonce is 32 random bytes, valid for five minutes, single-use, and bound to the public key that asked for it. Expired challenges are swept whenever a new one is issued.

### 2. Sign the challenge

Sign the **UTF-8 bytes** of the message `zyndicate:auth:<nonce>` with the ed25519 private key. The domain-separating prefix means a signature harvested from this flow cannot be replayed as a signature over anything else.

```js
import { ed25519 } from "@noble/curves/ed25519";

const message = Buffer.from(`zyndicate:auth:${nonce}`, "utf8");
const signature = Buffer.from(ed25519.sign(message, privateKey)).toString("hex");
```

### 3. Verify and receive a session token

```http
POST /api/v1/auth/verify
Content-Type: application/json

{
  "publicKey": "85ef9b03...affee",
  "nonce": "3449cccd...77b0",
  "signature": "a1b2c3...(128 hex chars)"
}
```

```json
{
  "token": "eyJhbGciOiJIUzI1NiJ9...",
  "identity": {
    "publicKey": "85ef9b03...affee",
    "displayName": null,
    "roleHints": [],
    "createdAt": 1785289647774
  }
}
```

The token is an HS256 JWT with issuer `zyndicate`, subject set to the public key, and a 24 hour expiry. Send it as `Authorization: Bearer <token>` on every authenticated call.

Failure modes are deliberately indistinguishable from one another: an unknown, expired, or already-consumed nonce and a bad signature all return `401 UNAUTHORIZED`.

Both auth routes share a tighter rate limit (`RATE_LIMIT_AUTH_MAX`, default 10 per minute) than the rest of the API.

### 4. Use the session

```http
GET /api/v1/me
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9...
```

Routes marked *optional auth* (`GET /mandates`, `GET /mandates/:id`) respond to anonymous callers with Class A data only, and widen the response when a valid token identifies a participant. An invalid or expired token on those routes is treated as anonymous rather than rejected.

---

## Errors

Every error, from a zod validation failure to a rate limit, is returned in one envelope:

```json
{
  "error": {
    "code": "INVALID_STATE",
    "message": "Action 'settle' is not legal from state 'submitted'",
    "details": {
      "action": "settle",
      "from": "submitted",
      "allowedFrom": ["accepted"]
    }
  }
}
```

`details` is present only when it adds something machine-readable. Validation errors carry an array of `{ path, message }`:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [{ "path": "/publicKey", "message": "publicKey must be 32 bytes of hex" }]
  }
}
```

### Status codes

| Status | Codes | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR`, `BAD_REQUEST` | Request failed a zod schema, or a handler rejected the input |
| 401 | `UNAUTHORIZED` | Missing, malformed, or expired bearer token; unknown, expired, or consumed auth challenge; failed signature; `mine=true` without a session |
| 403 | `FORBIDDEN` | The caller is a known participant but lacks authority for this action: a non-principal changing state, awarding, or settling; a non-awarded operator accepting or submitting; the wrong evaluator; a non-party opening a dispute; a non-tribunal key ruling; a principal bidding on their own mandate |
| 404 | `NOT_FOUND` | The resource does not exist, **or** it is confidential and the caller is not a participant. Drafts, invitation-only mandates, workrooms, vaults, and other operators' bids all answer 404 rather than 403 |
| 409 | `INVALID_STATE` | The action is not a legal transition from the mandate's current state. `details` lists the states it would have been legal from |
| 409 | `BID_WINDOW_CLOSED` | The bid deadline has passed |
| 409 | `BID_NOT_PENDING` | The bid was already awarded, rejected, or withdrawn |
| 409 | `DUPLICATE_BID` | The operator already has a pending bid on this mandate |
| 409 | `DUPLICATE_NULLIFIER` | The bid nullifier or settlement nullifier has already been consumed |
| 409 | `DUPLICATE_COMMITMENT` | The bid commitment already exists |
| 409 | `ALREADY_SETTLED` | The mandate has already been settled |
| 409 | `SETTLEMENT_FROZEN` | A dispute is open on this mandate |
| 409 | `ALREADY_RULED` | The dispute already has a ruling |
| 429 | `RATE_LIMITED` | Global or auth-specific rate limit exceeded; the message states the retry delay |
| 500 | `INTERNAL_ERROR` | Unexpected failure. Details are logged, never returned |
| 503 | `NOT_READY` | `/readyz` only: the database did not answer |

**Reading 404 correctly.** A 404 is not proof that a resource is absent. It is the answer given to anyone who is not entitled to know. Clients should not retry or probe on 404 for confidential resources.

### Pagination

List endpoints that can grow without bound (`GET /mandates`, workroom messages, workroom artifacts) accept `page` and `pageSize` and return the same envelope:

```json
{
  "items": [],
  "page": 1,
  "pageSize": 20,
  "total": 0,
  "totalPages": 1
}
```

`page` defaults to 1 (minimum 1), `pageSize` defaults to 20 (maximum 100). `totalPages` is never below 1. Mandates are returned newest first; workroom messages and artifacts oldest first, so a workroom reads as a transcript.

Small, naturally bounded lists (`GET /mandates/:id/bids`, `GET /disputes`, `GET /me/receipts`) return `{ "items": [...] }` without pagination fields.

---

## Identity

### `POST /api/v1/auth/challenge`

Public. Body: `publicKey` (hex 64). Returns `200 { nonce, expiresAt }`. See the authentication flow above.

### `POST /api/v1/auth/verify`

Public. Body: `publicKey` (hex 64), `nonce` (16 to 128 characters), `signature` (hex 128). Returns `200 { token, identity }`. Errors: `401 UNAUTHORIZED`.

### `GET /api/v1/me`

Bearer. Returns the caller's identity.

```json
{
  "identity": {
    "publicKey": "85ef9b03...affee",
    "displayName": "Northwind Security",
    "roleHints": ["principal"],
    "createdAt": 1785289647774
  }
}
```

### `PUT /api/v1/me`

Bearer. Updates public profile metadata. Both fields are optional; omitting one leaves it untouched.

| Field | Type | Notes |
| --- | --- | --- |
| `displayName` | string (1 to 80) or `null` | `null` clears it |
| `roleHints` | array of `principal` \| `operator` \| `evaluator`, max 3 | Self-declared hints only; they grant no authority |

Returns `200 { identity }`. Role hints are advisory: every actual permission on a mandate is derived from `principalKey`, the awarded bid's `operatorKey`, and `evaluatorKey`.

### `GET /api/v1/me/receipts`

Bearer. Proof receipts held by the caller, newest first.

```json
{
  "items": [
    {
      "id": "rcp_9pQ2...",
      "mandateId": "man_cIsg4ALNl86D7b1x5OuOa",
      "holderKey": "85ef9b03...affee",
      "kind": "completion",
      "receiptCommitment": "0f3c...",
      "issuedAt": 1785289999000
    }
  ]
}
```

`kind` is `completion`, `payment`, or `evaluation`. The receipt is a commitment mirror; the opening stays with the holder.

---

## Passports

### `GET /api/v1/passports/:publicKey`

Public. The coarse passport, and nothing more: no counterparties, no mandate history, no raw counts.

```json
{
  "passport": {
    "publicKey": "7c1d...9a4b",
    "identityClass": "credentialed_operator",
    "domains": ["security", "data-analysis"],
    "completionBand": "established",
    "activeSince": 1785200000000
  }
}
```

| Field | Meaning |
| --- | --- |
| `identityClass` | `credentialed_operator` when at least one unrevoked credential exists, otherwise `registered` |
| `domains` | Sorted, de-duplicated domains of unrevoked credentials |
| `completionBand` | `none` (0), `emerging` (1 to 2), `established` (3 to 9), `high` (10 or more) completion receipts |
| `activeSince` | When the identity first authenticated |

Returns `404 NOT_FOUND` for a key that has never authenticated.

### `POST /api/v1/passports/credentials`

Bearer. Registers a credential commitment on the caller's own passport. The credential contents stay with the holder; the server stores only the commitment.

| Field | Type |
| --- | --- |
| `domain` | string, 2 to 64, for example `security` |
| `kind` | string, 2 to 64, for example `capability`, `institutional`, `certification` |
| `commitment` | commitment string |

Returns `201 { credential: { id, passportKey, domain, kind, commitment, revokedAt, issuedAt } }`.

---

## Mandates

### `GET /api/v1/mandates`

Optional auth. Discovery over Class A summaries.

| Query | Type | Default |
| --- | --- | --- |
| `page` | integer, min 1 | 1 |
| `pageSize` | integer, 1 to 100 | 20 |
| `domain` | string, 1 to 64 | any |
| `state` | one of the eleven mandate states | any |
| `mine` | boolean-ish (`true`, `false`, `1`, `0`) | false |

Public listings exclude `draft` and `invitation` mandates entirely. `mine=true` requires a session and is **party-scoped**: it returns every mandate the caller is a party to — commissioned as principal, bid on as operator, or designated on as evaluator — including drafts they own. Operators depend on this to reach the workrooms and vaults of mandates they are executing. Without a token it is `401 UNAUTHORIZED`. Public listings are served from a 5-second in-memory cache that is cleared on any mandate write.

```json
{
  "items": [
    {
      "id": "man_cIsg4ALNl86D7b1x5OuOa",
      "publicDomain": "security",
      "complexityBand": "high",
      "discoveryMode": "open",
      "state": "open_for_bids",
      "bidDeadline": 1785500000000,
      "executionDeadline": 1786000000000,
      "mandateCommitment": "9f2a...",
      "covenantCommitment": "41bd...",
      "rewardBand": "band-3",
      "chainAddress": null,
      "createdAt": 1785289700000,
      "updatedAt": 1785289800000
    }
  ],
  "page": 1,
  "pageSize": 20,
  "total": 1,
  "totalPages": 1
}
```

The summary never contains the principal's key or any ciphertext.

### `POST /api/v1/mandates`

Bearer. Creates a mandate in `draft`.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `publicDomain` | string, 2 to 64 | yes | Class A coarse domain |
| `complexityBand` | string, 1 to 32 | no | Class A band, never the budget |
| `discoveryMode` | `open` \| `gated` \| `invitation` | no, default `open` | `invitation` mandates are excluded from public listings |
| `bidDeadline` | epoch ms or ISO-8601 | no | Enforced when bids arrive |
| `executionDeadline` | epoch ms or ISO-8601 | no | Recorded, not enforced by the server |
| `mandateCommitment` | commitment | yes | Binds the full private mandate package |
| `covenantCommitment` | commitment | yes | Binds the covenant |
| `encryptedPackage` | `{ ciphertext, nonce }` | yes | Client-encrypted mandate package |
| `rewardBand` | string, 1 to 64 | no | Coarse band only, when the covenant permits |
| `chainAddress` | string, 1 to 128 | no | Optional on-chain contract mirror |
| `evaluatorKey` | hex 64 | no | Designated evaluator; omit for principal-led evaluation |

Returns `201 { mandate }` with the detail view for the creator.

### `GET /api/v1/mandates/:id`

Optional auth. Role-aware detail. Outsiders receive `404 NOT_FOUND` for `draft` and `invitation` mandates.

```json
{
  "mandate": {
    "id": "man_cIsg4ALNl86D7b1x5OuOa",
    "publicDomain": "security",
    "complexityBand": "high",
    "discoveryMode": "open",
    "state": "in_execution",
    "bidDeadline": 1785500000000,
    "executionDeadline": 1786000000000,
    "mandateCommitment": "9f2a...",
    "covenantCommitment": "41bd...",
    "rewardBand": "band-3",
    "chainAddress": null,
    "createdAt": 1785289700000,
    "updatedAt": 1785289900000,
    "viewerRole": "principal",
    "encryptedPackage": { "ciphertext": "base64...", "nonce": "base64..." },
    "principalKey": "85ef9b03...affee",
    "evaluatorKey": null,
    "awardedBidId": "bid_7Kd1...",
    "awardAcceptedAt": 1785289900000
  }
}
```

| Field | Who sees it |
| --- | --- |
| Summary fields, `viewerRole` | Everyone who can see the mandate at all |
| `encryptedPackage` | Principal and awarded operator only |
| `principalKey`, `evaluatorKey`, `awardedBidId`, `awardAcceptedAt` | Any participant (principal, awarded operator, evaluator) |

`viewerRole` is `principal`, `operator`, `evaluator`, or `null`.

### `POST /api/v1/mandates/:id/state`

Bearer, principal only. Body: `{ "action": "open_bidding" | "close_bidding" | "cancel" }`. Returns `200 { mandate }`.

Errors: `404` if the mandate does not exist or the caller is an outsider on a draft, `403 FORBIDDEN` for a non-principal on a visible mandate, `409 INVALID_STATE` for an illegal transition.

### `POST /api/v1/mandates/:id/award`

Bearer, principal only. Body: `{ "bidId": "bid_..." }`. Moves the mandate to `awarded`, marks the winning bid `awarded`, and marks every other pending bid on that mandate `rejected`. Legal from `open_for_bids` or `bidding_closed`.

Errors: `404 NOT_FOUND` if the bid does not belong to this mandate, `409 BID_NOT_PENDING`, `409 INVALID_STATE`, `403 FORBIDDEN`.

### `POST /api/v1/mandates/:id/accept`

Bearer, awarded operator only. No body. Moves `awarded` to `in_execution` and stamps `awardAcceptedAt`. Errors: `403 FORBIDDEN`, `409 INVALID_STATE`.

---

## Sealed bids

### `POST /api/v1/mandates/:id/bids`

Bearer. Submits a sealed bid. The server checks the seal, never the contents.

| Field | Type |
| --- | --- |
| `bidCommitment` | commitment, globally unique |
| `bidNullifier` | commitment, globally unique |
| `encryptedBid` | `{ ciphertext, nonce }` |

Returns `201 { bid }`:

```json
{
  "bid": {
    "id": "bid_7Kd1...",
    "mandateId": "man_cIsg...",
    "operatorKey": "7c1d...9a4b",
    "bidCommitment": "b1d0...",
    "bidNullifier": "n0ll...",
    "status": "pending",
    "createdAt": 1785289750000,
    "updatedAt": 1785289750000,
    "encryptedBid": { "ciphertext": "base64...", "nonce": "base64..." }
  }
}
```

`status` is `pending`, `withdrawn`, `awarded`, or `rejected`.

Errors: `403 FORBIDDEN` if the principal bids on their own mandate, `409 INVALID_STATE` if the mandate is not `open_for_bids`, `409 BID_WINDOW_CLOSED` past the deadline, `409 DUPLICATE_NULLIFIER` or `409 DUPLICATE_COMMITMENT` on reuse, `409 DUPLICATE_BID` if the operator already has a pending bid on this mandate (withdraw it first).

### `GET /api/v1/mandates/:id/bids`

Bearer. Returns `{ items: [...] }`. The principal receives every bid on the mandate; any other caller receives only their own rows. Ciphertext is included for the rows the caller is entitled to, and is decryptable only with keys the server does not have.

### `DELETE /api/v1/mandates/:id/bids/:bidId`

Bearer, bid owner only. Marks an own pending bid `withdrawn` and returns `200 { bid }`. A bid belonging to someone else returns `404 NOT_FOUND`, not `403`, so bid ids cannot be probed. A non-pending bid returns `409 BID_NOT_PENDING`.

---

## Workrooms

A workroom exists once a mandate is awarded. Its members are the principal, the awarded operator, and the designated evaluator if there is one. Every workroom route answers `404 NOT_FOUND` to anyone else, including before an award exists.

### `GET /api/v1/workrooms/:mandateId`

Bearer, participant only.

```json
{
  "workroom": {
    "mandateId": "man_cIsg...",
    "state": "in_execution",
    "createdAt": 1785289880000,
    "members": [
      { "publicKey": "85ef9b03...affee", "role": "principal" },
      { "publicKey": "7c1d...9a4b", "role": "operator" }
    ]
  }
}
```

`createdAt` is the award time: the moment the workroom came into being.

### `GET /api/v1/workrooms/:mandateId/messages`

Bearer, participant only. Accepts `page` and `pageSize`. Returns the paginated envelope, oldest first.

```json
{
  "items": [
    {
      "id": "msg_3Ha8...",
      "mandateId": "man_cIsg...",
      "senderKey": "7c1d...9a4b",
      "ciphertext": "base64...",
      "nonce": "base64...",
      "createdAt": 1785289890000
    }
  ],
  "page": 1,
  "pageSize": 20,
  "total": 1,
  "totalPages": 1
}
```

### `POST /api/v1/workrooms/:mandateId/messages`

Bearer, participant only. Body: `{ "ciphertext": base64, "nonce": base64 }`. Returns `201 { message }`. Encrypt for the workroom members before sending; the server stores the blob verbatim and never inspects it.

### `GET /api/v1/workrooms/:mandateId/artifacts`

Bearer, participant only. Same pagination as messages, oldest first. Each item is `{ id, mandateId, uploaderKey, name, digest, version, ciphertext, nonce, createdAt }`.

### `POST /api/v1/workrooms/:mandateId/artifacts`

Bearer, participant only.

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string, 1 to 200 | Display name only. Contents live in the ciphertext |
| `digest` | commitment | Digest of the **plaintext**, computed client-side, for integrity checking |
| `version` | integer, 1 to 10000, default 1 | Client-managed version counter |
| `ciphertext` | base64 | Encrypted artifact |
| `nonce` | base64 | Encryption nonce |

Returns `201 { artifact }`.

### `POST /api/v1/mandates/:id/submissions`

Bearer, awarded operator only. Anchors a workroom artifact as the deliverable and moves the mandate from `in_execution` to `submitted`.

| Field | Type |
| --- | --- |
| `artifactId` | id of an artifact in this workroom |
| `submissionCommitment` | commitment binding the submission to the mandate |
| `digest` | digest of the submitted plaintext |

```json
{
  "submission": {
    "id": "sub_Qr4m...",
    "mandateId": "man_cIsg...",
    "artifactId": "art_8Zx2...",
    "submissionCommitment": "5cc1...",
    "digest": "d19f...",
    "submittedAt": 1785289950000
  },
  "state": "submitted"
}
```

Errors: `403 FORBIDDEN` for anyone but the awarded operator, `404 NOT_FOUND` if the artifact is not in this workroom, `409 INVALID_STATE` outside `in_execution`.

---

## Evaluations

### `POST /api/v1/mandates/:id/evaluations`

Bearer. Requires the mandate to be `submitted`. Authority follows the covenant: if the mandate designates an `evaluatorKey`, only that key may evaluate; otherwise evaluation is principal-led and only the principal may evaluate.

| Field | Type | Notes |
| --- | --- | --- |
| `verdict` | `accept` \| `reject` \| `revise` | Drives the state machine |
| `evaluationCommitment` | commitment | Binds the private evaluation notes, which never reach the server |
| `attestation` | string, 8 to 10000 | The evaluator's signed attestation blob, opaque to the server |

| Verdict | Resulting state |
| --- | --- |
| `accept` | `accepted` (settlement may now be released) |
| `revise` | `in_execution` (the operator iterates and submits again) |
| `reject` | unchanged; the attestation is recorded and the parties may dispute or run another round if the covenant allows |

```json
{
  "evaluation": {
    "id": "evl_2Nb7...",
    "mandateId": "man_cIsg...",
    "evaluatorKey": "85ef9b03...affee",
    "verdict": "accept",
    "evaluationCommitment": "7ab0...",
    "attestation": "base64-signed-attestation",
    "createdAt": 1785289960000
  },
  "state": "accepted"
}
```

Errors: `403 FORBIDDEN` for the wrong evaluator, `409 INVALID_STATE` if the mandate is not `submitted`.

---

## Vault

### `POST /api/v1/mandates/:id/settle`

Bearer, principal only. Legal from `accepted`. Consumes a settlement nullifier so the payout can happen exactly once, and auto-issues proof receipts.

| Field | Type | Notes |
| --- | --- | --- |
| `settlementNullifier` | commitment, globally unique | Guarantees exactly-once settlement |
| `amountCommitment` | commitment, optional | A commitment to the amount, never the amount |

```json
{
  "settlement": {
    "mandateId": "man_cIsg...",
    "settlementNullifier": "s3tt...",
    "amountCommitment": "amt0...",
    "settledAt": 1785289970000
  },
  "state": "settled",
  "receipts": [
    { "id": "rcp_9pQ2...", "mandateId": "man_cIsg...", "holderKey": "7c1d...9a4b", "kind": "completion", "receiptCommitment": "0f3c...", "issuedAt": 1785289970000 },
    { "id": "rcp_1aB3...", "mandateId": "man_cIsg...", "holderKey": "85ef9b03...affee", "kind": "payment", "receiptCommitment": "b77e...", "issuedAt": 1785289970000 }
  ]
}
```

The awarded operator receives a `completion` receipt (which is what advances their passport's completion band) and the principal a `payment` receipt.

Errors: `403 FORBIDDEN` for a non-principal, `409 SETTLEMENT_FROZEN` while a dispute is open, `409 ALREADY_SETTLED`, `409 DUPLICATE_NULLIFIER` on nullifier reuse, `409 INVALID_STATE` outside `accepted`.

### `GET /api/v1/vault/:mandateId`

Bearer, mandate party only. Non-parties receive `404 NOT_FOUND`.

```json
{
  "vault": {
    "mandateId": "man_cIsg...",
    "state": "settled",
    "disputeOpen": false,
    "settlement": {
      "settlementNullifier": "s3tt...",
      "amountCommitment": "amt0...",
      "settledAt": 1785289970000
    }
  }
}
```

`settlement` is `null` before settlement.

---

## Disputes

### `POST /api/v1/mandates/:id/disputes`

Bearer, principal or awarded operator only. Legal from `awarded`, `in_execution`, `submitted`, or `accepted`. Moves the mandate to `disputed`, which freezes settlement.

Body: `{ "disputeCommitment": "..." }`, a commitment to the evidence capsule. The capsule itself stays with the parties.

```json
{
  "dispute": {
    "id": "dsp_5Tg9...",
    "mandateId": "man_cIsg...",
    "openedBy": "7c1d...9a4b",
    "disputeCommitment": "ev1d...",
    "status": "open",
    "rulingCommitment": null,
    "outcome": null,
    "ruledAt": null,
    "createdAt": 1785289980000
  },
  "state": "disputed"
}
```

Errors: `403 FORBIDDEN` for evaluators and outsiders, `409 INVALID_STATE` from a state where a dispute is not possible.

### `POST /api/v1/disputes/:id/ruling`

Bearer, tribunal only. The tribunal is the mandate's designated evaluator, or any key listed in the `TRIBUNAL_KEYS` allowlist. Moves the mandate from `disputed` to `resolved`.

| Field | Type |
| --- | --- |
| `rulingCommitment` | commitment to the ruling |
| `outcome` | `release` \| `refund` |

Returns `200 { dispute, state }` with `status: "ruled"`, the outcome, and `ruledAt` set.

Errors: `404 NOT_FOUND` for an unknown dispute, `403 FORBIDDEN` without tribunal authority, `409 ALREADY_RULED`, `409 INVALID_STATE`.

### `GET /api/v1/disputes`

Bearer. Returns `{ items: [...] }` scoped to the caller: disputes they opened, or that belong to a mandate where they are the principal, the awarded operator, or the evaluator. There is no unscoped listing.

---

## Health and operations

| Route | Response |
| --- | --- |
| `GET /healthz` | `200 { "status": "ok" }` |
| `GET /readyz` | `200 { "status": "ready" }`, or `503 { "error": { "code": "NOT_READY", ... } }` if the database does not answer `SELECT 1` |
| `GET /metrics` | `200 { startedAt, uptimeSeconds, requests, errors, modules: { <module>: { requests, errors } } }` |
| `GET /docs` | Swagger UI |
| `GET /docs/json` | OpenAPI 3 document generated from the zod schemas |

`errors` counts responses with status 500 or above. Module buckets are derived from the request path: `health`, `auth` (including `/me`), `mandates`, `bids`, `workrooms`, `evaluations`, `vault`, `disputes`, `passports`, or `other`.

---

## End-to-end lifecycle

A complete mandate, from creation to settlement, against a locally running service. Two actors: a principal and an operator. This mandate designates no evaluator, so evaluation is principal-led. Responses below are trimmed to the fields that matter at each step.

Requires `curl`, `jq`, and `node` (for ed25519 signing, which curl cannot do).

### Setup

```bash
BASE=http://localhost:4000/api/v1
```

Save this signing helper as `sign.mjs` in a directory where `@noble/curves` resolves (the repo root works):

```js
// node sign.mjs <privateKeyHex> <nonce>
import { ed25519 } from "@noble/curves/ed25519";
const [priv, nonce] = process.argv.slice(2);
const msg = Buffer.from(`zyndicate:auth:${nonce}`, "utf8");
process.stdout.write(Buffer.from(ed25519.sign(msg, Buffer.from(priv, "hex"))).toString("hex"));
```

Generate a key pair per actor:

```bash
node -e 'import("@noble/curves/ed25519").then(({ed25519})=>{const k=ed25519.utils.randomPrivateKey();console.log("PRIV="+Buffer.from(k).toString("hex"));console.log("PUB="+Buffer.from(ed25519.getPublicKey(k)).toString("hex"));})'
```

Export the results as `P_PRIV` / `P_PUB` for the principal and `O_PRIV` / `O_PUB` for the operator.

### 1. Both actors authenticate

```bash
NONCE=$(curl -s -X POST $BASE/auth/challenge \
  -H 'content-type: application/json' \
  -d "{\"publicKey\":\"$P_PUB\"}" | jq -r .nonce)

SIG=$(node sign.mjs "$P_PRIV" "$NONCE")

P_TOKEN=$(curl -s -X POST $BASE/auth/verify \
  -H 'content-type: application/json' \
  -d "{\"publicKey\":\"$P_PUB\",\"nonce\":\"$NONCE\",\"signature\":\"$SIG\"}" | jq -r .token)
```

Repeat with `O_PUB` / `O_PRIV` to obtain `O_TOKEN`.

### 2. Principal creates the mandate

The encrypted package is produced client-side. Commitments are computed client-side too; the values below stand in for real ones.

```bash
MANDATE=$(curl -s -X POST $BASE/mandates \
  -H "authorization: Bearer $P_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "publicDomain": "security",
    "complexityBand": "high",
    "discoveryMode": "open",
    "bidDeadline": "2026-08-05T00:00:00.000Z",
    "mandateCommitment": "9f2a4c81be07d5aa",
    "covenantCommitment": "41bd0e77c3a91b6d",
    "encryptedPackage": { "ciphertext": "T25seSB0aGUgcHJpbmNpcGFsIGNhbiByZWFkIHRoaXM=", "nonce": "bm9uY2UtMDAx" },
    "rewardBand": "band-3"
  }' | jq -r .mandate.id)
```

```json
{ "mandate": { "id": "man_iXv2vi6kpaOzShtYI6QoA", "state": "draft", "viewerRole": "principal", "...": "..." } }
```

### 3. Principal opens bidding

```bash
curl -s -X POST $BASE/mandates/$MANDATE/state \
  -H "authorization: Bearer $P_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"action":"open_bidding"}'
```

```json
{ "mandate": { "state": "open_for_bids", "...": "..." } }
```

The mandate is now discoverable. An anonymous caller sees the Class A summary and nothing else:

```bash
curl -s "$BASE/mandates?domain=security&pageSize=3" | jq '.total, .items[0].state'
curl -s $BASE/mandates/$MANDATE | jq '.mandate.viewerRole, .mandate.encryptedPackage'
```

```
1
"open_for_bids"
null
null
```

`viewerRole` is `null` and `encryptedPackage` is absent for outsiders.

### 4. Operator submits a sealed bid

```bash
BID=$(curl -s -X POST $BASE/mandates/$MANDATE/bids \
  -H "authorization: Bearer $O_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "bidCommitment": "b1d0c0mm17m3n7",
    "bidNullifier": "n0ll1f13r0001",
    "encryptedBid": { "ciphertext": "U2VhbGVkIGJpZCBib2R5", "nonce": "bm9uY2UtMDAy" }
  }' | jq -r .bid.id)
```

```json
{ "bid": { "id": "bid_qAhkmqFyMyo-xoZatSBfY", "status": "pending", "...": "..." } }
```

A second pending bid from the same operator returns `409 DUPLICATE_BID`; reusing the nullifier returns `409 DUPLICATE_NULLIFIER`.

### 5. Principal reviews and awards

```bash
curl -s $BASE/mandates/$MANDATE/bids -H "authorization: Bearer $P_TOKEN" | jq '.items | length'

curl -s -X POST $BASE/mandates/$MANDATE/award \
  -H "authorization: Bearer $P_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"bidId\":\"$BID\"}"
```

```json
{ "mandate": { "state": "awarded", "awardedBidId": "bid_qAhkmqFyMyo-xoZatSBfY", "...": "..." } }
```

Bid ciphertexts are decrypted in the principal's client; the server only ever moved sealed blobs.

### 6. Operator accepts; the workroom opens

```bash
curl -s -X POST $BASE/mandates/$MANDATE/accept -H "authorization: Bearer $O_TOKEN"
curl -s $BASE/workrooms/$MANDATE -H "authorization: Bearer $O_TOKEN"
```

```json
{ "mandate": { "state": "in_execution", "...": "..." } }
```

```json
{
  "workroom": {
    "mandateId": "man_iXv2vi6kpaOzShtYI6QoA",
    "state": "in_execution",
    "createdAt": 1785290309000,
    "members": [
      { "publicKey": "49e15bee...4203", "role": "principal" },
      { "publicKey": "0aef0424...1062", "role": "operator" }
    ]
  }
}
```

Any non-member calling the same route receives `404 NOT_FOUND`.

### 7. Execution: encrypted messages and artifacts

```bash
curl -s -X POST $BASE/workrooms/$MANDATE/messages \
  -H "authorization: Bearer $O_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"ciphertext":"RW5jcnlwdGVkIHN0YXR1cyB1cGRhdGU=","nonce":"bm9uY2UtMDAz"}'

ARTIFACT=$(curl -s -X POST $BASE/workrooms/$MANDATE/artifacts \
  -H "authorization: Bearer $O_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "name": "audit-report.pdf.enc",
    "digest": "d19f7c0aa3b25e41",
    "version": 1,
    "ciphertext": "RW5jcnlwdGVkIGRlbGl2ZXJhYmxl",
    "nonce": "bm9uY2UtMDA0"
  }' | jq -r .artifact.id)
```

### 8. Operator commits the submission

```bash
curl -s -X POST $BASE/mandates/$MANDATE/submissions \
  -H "authorization: Bearer $O_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"artifactId\":\"$ARTIFACT\",\"submissionCommitment\":\"5cc1a20f9e33\",\"digest\":\"d19f7c0aa3b25e41\"}"
```

```json
{ "submission": { "id": "sub_Qr4m...", "artifactId": "art_jCd3EvmWZgHpdQQYy3mip", "...": "..." }, "state": "submitted" }
```

### 9. Evaluation

No evaluator was designated, so the principal evaluates.

```bash
curl -s -X POST $BASE/mandates/$MANDATE/evaluations \
  -H "authorization: Bearer $P_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "verdict": "accept",
    "evaluationCommitment": "7ab04f1c9d20",
    "attestation": "c2lnbmVkLWF0dGVzdGF0aW9uLWJsb2I="
  }'
```

```json
{ "evaluation": { "verdict": "accept", "...": "..." }, "state": "accepted" }
```

A `revise` verdict would return the mandate to `in_execution` for another round instead.

### 10. Settlement

```bash
curl -s -X POST $BASE/mandates/$MANDATE/settle \
  -H "authorization: Bearer $P_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"settlementNullifier":"s3tt13m3nt0001","amountCommitment":"amt0c0mm17"}'
```

```json
{
  "settlement": { "mandateId": "man_iXv2...", "settlementNullifier": "s3tt13m3nt0001", "amountCommitment": "amt0c0mm17", "settledAt": 1785290309850 },
  "state": "settled",
  "receipts": [
    { "id": "rcp_W0hv...", "kind": "completion", "holderKey": "0aef0424...1062", "...": "..." },
    { "id": "rcp_1aB3...", "kind": "payment", "holderKey": "49e15bee...4203", "...": "..." }
  ]
}
```

Calling settle again returns `409 ALREADY_SETTLED`, and a reused nullifier returns `409 DUPLICATE_NULLIFIER`. The amount itself was never sent to the server.

### 11. Receipts and reputation

```bash
curl -s $BASE/me/receipts -H "authorization: Bearer $O_TOKEN" | jq '.items[0].kind'
curl -s $BASE/passports/$O_PUB | jq
```

```
"completion"
```

```json
{
  "passport": {
    "publicKey": "0aef0424...1062",
    "identityClass": "registered",
    "domains": [],
    "completionBand": "emerging",
    "activeSince": 1785290309802
  }
}
```

The completion receipt advanced the operator's band from `none` to `emerging`. Registering a credential commitment adds the domain and promotes `identityClass`:

```bash
curl -s -X POST $BASE/passports/credentials \
  -H "authorization: Bearer $O_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"domain":"security","kind":"capability","commitment":"c0mm17m3nt2024"}'

curl -s $BASE/passports/$O_PUB | jq '.passport.identityClass, .passport.domains'
```

```
"credentialed_operator"
[ "security" ]
```

The passport shows a band and a domain list. It never shows who the counterparty was, what the mandate contained, or what was paid.

### Dispute variant

Instead of settling, either party may open a dispute from `awarded`, `in_execution`, `submitted`, or `accepted`:

```bash
DISPUTE=$(curl -s -X POST $BASE/mandates/$MANDATE/disputes \
  -H "authorization: Bearer $O_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"disputeCommitment":"ev1d3nc3caps013"}' | jq -r .dispute.id)
```

The mandate moves to `disputed` and settlement returns `409 SETTLEMENT_FROZEN`. The tribunal (the designated evaluator, or a key in `TRIBUNAL_KEYS`) rules:

```bash
curl -s -X POST $BASE/disputes/$DISPUTE/ruling \
  -H "authorization: Bearer $T_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"rulingCommitment":"r0l1ngc0mm17","outcome":"release"}'
```

```json
{ "dispute": { "status": "ruled", "outcome": "release", "ruledAt": 1785290400000, "...": "..." }, "state": "resolved" }
```

The tribunal ruled on a commitment to an evidence capsule it received out of band. The coordination service recorded that a ruling happened, and never saw what it was about.
