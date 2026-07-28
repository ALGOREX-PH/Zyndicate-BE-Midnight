/**
 * Structured API error. The error handler plugin serializes these into the
 * envelope: { error: { code, message, details? } }.
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown): ApiError =>
  new ApiError(400, "BAD_REQUEST", message, details);

export const unauthorized = (message = "Authentication required"): ApiError =>
  new ApiError(401, "UNAUTHORIZED", message);

export const forbidden = (message = "Not permitted"): ApiError =>
  new ApiError(403, "FORBIDDEN", message);

/**
 * 404 discipline: confidential resources return NOT_FOUND for
 * non-participants so their existence is not leaked.
 */
export const notFound = (message = "Resource not found"): ApiError =>
  new ApiError(404, "NOT_FOUND", message);

export const conflict = (code: string, message: string, details?: unknown): ApiError =>
  new ApiError(409, code, message, details);

export const invalidState = (message: string, details?: unknown): ApiError =>
  new ApiError(409, "INVALID_STATE", message, details);
