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
