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
