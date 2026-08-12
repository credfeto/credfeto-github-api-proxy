// Rewrites absolute api.github.com URLs embedded in response bodies and headers
// so that a client following one of them lands back on this proxy instead of
// bypassing it and hitting real GitHub directly with credentials that are only
// valid against the proxy.
//
// html_url fields (github.com, the web UI) are untouched by construction: they
// never contain the api.github.com host this module matches on.

import { MAX_JSON_WALK_DEPTH } from "./cache.js";
import { parseJsonBody } from "./json.js";

export const GITHUB_API_HOST = "api.github.com";

// Host-boundary aware: matches "https://api.github.com" only when the host
// name actually ends there, so "https://api.github.com.evil.com/..." (a
// different host that merely starts with the same characters) is left alone.
const API_GITHUB_URL_PATTERN = /https:\/\/api\.github\.com(?![\w.-])/g;

// Rewrites every occurrence of an absolute https://api.github.com URL found
// anywhere in `text` to `proxyOrigin`, preserving path/query. Handles both a
// string that is itself a single URL (JSON field values) and text with
// multiple URLs embedded in it (the Link header's
// `<url>; rel="next", <url>; rel="last"` format).
export function rewriteEmbeddedApiGithubUrls(text: string, proxyOrigin: string): string {
  // Replacer is a function, not the proxyOrigin string directly, so that a
  // proxyOrigin containing "$&"-style patterns (it is derived from the
  // client-controlled Host header) is never interpreted as a replacement token.
  return text.replace(API_GITHUB_URL_PATTERN, () => proxyOrigin);
}

function walkAndRewrite(value: unknown, proxyOrigin: string, changed: { value: boolean }, depth = 0): unknown {
  if (depth > MAX_JSON_WALK_DEPTH) return value;
  if (typeof value === "string") {
    const rewritten = rewriteEmbeddedApiGithubUrls(value, proxyOrigin);
    if (rewritten !== value) changed.value = true;
    return rewritten;
  }
  if (Array.isArray(value)) {
    return value.map((item) => walkAndRewrite(item, proxyOrigin, changed, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = walkAndRewrite(val, proxyOrigin, changed, depth + 1);
    }
    return result;
  }
  return value;
}

// Parses `body` as JSON, recursively rewrites every embedded api.github.com
// URL in its string values, and re-serialises. Malformed JSON is returned
// unchanged, and the original Buffer is returned as-is when nothing needed
// rewriting.
export function rewriteJsonBody(body: Buffer, proxyOrigin: string): Buffer {
  // Cheap pre-check: skip the parse/walk/stringify pass entirely for the
  // common case of a response with no api.github.com occurrence at all.
  if (!body.includes(GITHUB_API_HOST)) {
    return body;
  }

  const parsed = parseJsonBody(body.toString("utf8"));
  if (parsed === null || typeof parsed !== "object") {
    return body;
  }

  const changed = { value: false };
  const rewritten = walkAndRewrite(parsed, proxyOrigin, changed);
  if (!changed.value) return body;
  return Buffer.from(JSON.stringify(rewritten), "utf8");
}

// Cheap pre-check mirroring rewriteJsonBody's: most header values (date, etag,
// x-ratelimit-*, ...) never contain the host, so skip the regex pass for them.
function rewriteIfPresent(value: string, proxyOrigin: string): string {
  return value.includes(GITHUB_API_HOST) ? rewriteEmbeddedApiGithubUrls(value, proxyOrigin) : value;
}

// Rewrites embedded api.github.com URLs in every header value, including
// multi-value headers such as Link.
export function rewriteResponseHeaders(
  headers: Record<string, string | string[] | undefined>,
  proxyOrigin: string,
): Record<string, string | string[] | undefined> {
  const result: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      result[key] = rewriteIfPresent(value, proxyOrigin);
    } else if (Array.isArray(value)) {
      result[key] = value.map((v) => rewriteIfPresent(v, proxyOrigin));
    } else {
      result[key] = value;
    }
  }
  return result;
}
