import { createHash, randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";

export const AUTH_MESSAGE_PREFIX = "zyndicate:auth:";

const HEX_RE = /^[0-9a-fA-F]+$/;

export function isHex(value: string, bytes?: number): boolean {
  if (!HEX_RE.test(value)) return false;
  if (value.length % 2 !== 0) return false;
  return bytes === undefined || value.length === bytes * 2;
}

/** Random 32-byte hex nonce for auth challenges. */
export function generateNonce(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Verify an ed25519 signature over the UTF-8 auth message
 * `zyndicate:auth:<nonce>` against a hex-encoded public key.
 * Never throws — malformed input simply fails verification.
 */
export function verifyAuthSignature(
  publicKeyHex: string,
  nonce: string,
  signatureHex: string
): boolean {
  if (!isHex(publicKeyHex, 32) || !isHex(signatureHex, 64)) return false;
  try {
    const message = Buffer.from(`${AUTH_MESSAGE_PREFIX}${nonce}`, "utf8");
    return ed25519.verify(
      Buffer.from(signatureHex, "hex"),
      message,
      Buffer.from(publicKeyHex, "hex")
    );
  } catch {
    return false;
  }
}

/** SHA-256 hex digest, used for server-derived receipt commitments. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
