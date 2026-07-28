import type { FastifyInstance } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError
} from "fastify-type-provider-zod";
import { ApiError } from "../lib/errors.js";

interface ErrorEnvelope {
  error: { code: string; message: string; details?: unknown };
}

function envelope(code: string, message: string, details?: unknown): ErrorEnvelope {
  const body: ErrorEnvelope = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  return body;
}

/** Structured error envelope: { error: { code, message, details? } }. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, request, reply) => {
    if (err instanceof ApiError) {
      return reply
        .status(err.statusCode)
        .send(envelope(err.code, err.message, err.details));
    }

    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send(
        envelope(
          "VALIDATION_ERROR",
          "Request validation failed",
          err.validation.map((issue) => ({
            path: issue.instancePath,
            message: issue.message
          }))
        )
      );
    }

    if (isResponseSerializationError(err)) {
      request.log.error({ err }, "response serialization failed");
      return reply
        .status(500)
        .send(envelope("INTERNAL_ERROR", "Response serialization failed"));
    }

    const known = err as { statusCode?: unknown; code?: unknown; message?: unknown };
    const statusCode =
      typeof known.statusCode === "number" && known.statusCode >= 400
        ? known.statusCode
        : 500;

    if (statusCode >= 500) {
      request.log.error({ err }, "unhandled error");
      return reply.status(500).send(envelope("INTERNAL_ERROR", "Internal server error"));
    }

    const code =
      statusCode === 429
        ? "RATE_LIMITED"
        : statusCode === 401
          ? "UNAUTHORIZED"
          : statusCode === 404
            ? "NOT_FOUND"
            : typeof known.code === "string"
              ? known.code
              : "REQUEST_ERROR";
    const message = typeof known.message === "string" ? known.message : "Request error";
    return reply.status(statusCode).send(envelope(code, message));
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send(envelope("NOT_FOUND", "Route not found"));
  });
}
