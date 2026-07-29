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

Public listings exclude `draft` and `invitation` mandates entirely. `mine=true` requires a session and returns the caller's own mandates including drafts; without a token it is `401 UNAUTHORIZED`. Public listings are served from a 5-second in-memory cache that is cleared on any mandate write.

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
