import type http from "http";

export const REDACTED = "[REDACTED]";

export const PROXY_USER_AGENT = "github-api-proxy/1.0";

// Redacts the Authorization header before it is ever written to diagnostic/error logs.
export function redactAuthorization(headers: http.OutgoingHttpHeaders): http.OutgoingHttpHeaders {
  const redacted: http.OutgoingHttpHeaders = { ...headers };
  if (redacted.authorization !== undefined) redacted.authorization = REDACTED;
  return redacted;
}
