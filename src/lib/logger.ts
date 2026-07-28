import type { LoggerOptions } from "pino";

/**
 * Pino options with redaction enabled. The coordination service must never
 * write ciphertext, signatures, or bearer tokens to its logs — even though
 * ciphertext is opaque to the server, logging it would leak traffic metadata
 * and blob sizes into log aggregation systems.
 */
export function buildLoggerOptions(level: string): LoggerOptions {
  return {
    level,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "*.ciphertext",
        "*.nonce",
        "*.signature",
        "*.token",
        "*.encryptedBid",
        "*.encryptedPackage",
        "ciphertext",
        "signature",
        "token"
      ],
      censor: "[REDACTED]"
    }
  };
}
