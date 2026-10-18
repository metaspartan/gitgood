export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "unavailable"
  | "conflict"
  | "payload_too_large"
  | "unprocessable"
  | "rate_limited"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  unavailable: 503,
  conflict: 409,
  payload_too_large: 413,
  unprocessable: 422,
  rate_limited: 429,
  internal: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

export const badRequest = (msg: string, details?: Record<string, unknown>): AppError =>
  new AppError("bad_request", msg, details);
export const unauthorized = (msg = "Authentication required"): AppError =>
  new AppError("unauthorized", msg);
export const tooManyAttempts = (retryAfterSeconds = 1): AppError =>
  new AppError("rate_limited", "Too many failed sign-in attempts. Try again shortly.", {
    retry_after_seconds: Math.max(1, Math.ceil(retryAfterSeconds)),
  });

export const invalidCredentials = (): AppError => unauthorized("Invalid credentials or inactive account");

export const forbidden = (msg = "You do not have access to this resource"): AppError =>
  new AppError("forbidden", msg);
export const notFound = (msg = "Not found"): AppError => new AppError("not_found", msg);
export const unavailable = (msg = "This service is temporarily unavailable"): AppError =>
  new AppError("unavailable", msg);
export const conflict = (msg: string): AppError => new AppError("conflict", msg);
export const payloadTooLarge = (msg = "Request body too large"): AppError =>
  new AppError("payload_too_large", msg);
export const unprocessable = (msg: string, details?: Record<string, unknown>): AppError =>
  new AppError("unprocessable", msg, details);

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

export function toErrorResponse(error: unknown): {
  status: number;
  code: ErrorCode;
  message: string;
  details?: Readonly<Record<string, unknown>>;
} {
  if (isAppError(error)) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    };
  }
  if (error instanceof Error && error.name === "RepositoryUnavailableError") {
    return {
      status: 503,
      code: "unavailable",
      message: "Repository data is not present on this server",
    };
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  return { status: 500, code: "internal", message };
}
