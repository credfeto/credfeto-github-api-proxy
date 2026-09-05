// Rewrites absolute api.github.com URLs embedded in response bodies and headers
// so that a client following one of them lands back on this proxy instead of
// bypassing it and hitting real GitHub directly with credentials that are only
// valid against the proxy.
//
// html_url fields (github.com, the web UI) are untouched by construction: they
// never contain the api.github.com host this module matches on.

import { type JsonVisitor, parseJsonBody, walkJson } from "./json.js";

export const GITHUB_API_HOST = "api.github.com";

// Host-boundary aware: matches "https://api.github.com" only when the host
// name actually ends there, so "https://api.github.com.evil.com/..." (a
// different host that merely starts with the same characters) is left alone.
const API_GITHUB_URL_PATTERN = new RegExp(`https://${GITHUB_API_HOST.replace(/\./g, "\\.")}(?![\\w.-])`, "g");

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

const VIEWER_CAN_MERGE_AS_ADMIN_FIELD = "viewerCanMergeAsAdmin";

// A GraphQL response key is `viewerCanMergeAsAdmin` itself, or whatever alias
// the query gave it (`x: viewerCanMergeAsAdmin`) — aliasing renames the key
// in the response entirely, so masking by the literal field name alone would
// let an aliased request read the true value straight through.
function findViewerCanMergeAsAdminAliases(query: string): Set<string> {
  const aliases = new Set<string>([VIEWER_CAN_MERGE_AS_ADMIN_FIELD]);
  const aliasPattern = /(\w+)\s*:\s*viewerCanMergeAsAdmin\b/g;
  let m: RegExpExecArray | null;
  while ((m = aliasPattern.exec(query)) !== null) {
    aliases.add(m[1]);
  }
  return aliases;
}

function rewriteAndDenyAdminMergeVisitor(proxyOrigin: string, maskKeys: ReadonlySet<string>): JsonVisitor {
  return (value, key) => {
    if (key !== undefined && maskKeys.has(key) && value === true) {
      return [false, true];
    }
    if (typeof value !== "string") return undefined;
    const rewritten = rewriteIfPresent(value, proxyOrigin);
    return [rewritten, rewritten !== value];
  };
}

// Combines the URL-rewrite and admin-merge-deny visitors into a single
// parse/walk/stringify pass, since every proxied JSON response body needs
// both transforms applied and a GraphQL PR response commonly carries both an
// api.github.com URL and viewerCanMergeAsAdmin.
//
// graphQLQuery is the original request's GraphQL query text, or undefined for
// a REST response: that field only ever appears in GraphQL PR responses, so
// skipping the extra body scan for it on REST responses (the vast majority of
// traffic) avoids a second full Buffer.includes() pass on every response that
// doesn't mention api.github.com. Passing the query (rather than a plain
// boolean) lets the mask cover any alias the query gave the field.
export function rewriteJsonResponseBody(body: Buffer, proxyOrigin: string, graphQLQuery: string | undefined): Buffer {
  const mightRewriteUrls = body.includes(GITHUB_API_HOST);
  const maskKeys = graphQLQuery === undefined ? undefined : findViewerCanMergeAsAdminAliases(graphQLQuery);
  const mightDenyAdminMerge = maskKeys !== undefined && [...maskKeys].some((key) => body.includes(key));
  if (!mightRewriteUrls && !mightDenyAdminMerge) {
    return body;
  }

  const parsed = parseJsonBody(body.toString("utf8"));
  if (parsed === null || typeof parsed !== "object") {
    return body;
  }

  const [rewritten, changed] = walkJson(
    parsed,
    rewriteAndDenyAdminMergeVisitor(proxyOrigin, maskKeys ?? new Set([VIEWER_CAN_MERGE_AS_ADMIN_FIELD])),
  );
  if (!changed) return body;
  return Buffer.from(JSON.stringify(rewritten), "utf8");
}

// Cheap pre-check mirroring rewriteJsonResponseBody's: most header values
// (date, etag, x-ratelimit-*, ...) never contain the host, so skip the regex
// pass for them.
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
