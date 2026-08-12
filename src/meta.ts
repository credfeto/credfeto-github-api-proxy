/**
 * Transform applied to GitHub's /meta response before it reaches the client.
 *
 * When GH_HOST points at this proxy, gh CLI treats the host as GitHub
 * Enterprise Server and calls GET /api/v3/meta before running certain
 * subcommands (`gh workflow run`, `--search`-backed listings). It parses the
 * JSON field `installed_version` into a semantic version and fails with
 * "malformed version: " if the field is absent or empty — which is always
 * the case for real api.github.com/meta, since that field is GHES-only.
 */

import { parseJsonBody } from "./json.js";

// gh CLI only needs a syntactically valid, recent-enough semver here — it never talks
// to a real GHES instance through this proxy. Bump this if gh raises its minimum
// supported GHES version and starts rejecting 3.30.0.
const SYNTHETIC_INSTALLED_VERSION = "3.30.0";

export function injectInstalledVersion(body: Buffer): Buffer {
  const parsed = parseJsonBody(body.toString("utf8"));

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return body;
  }

  const meta = parsed as Record<string, unknown>;
  const existing = meta.installed_version;
  if (typeof existing === "string" && existing.length > 0) {
    return body;
  }

  meta.installed_version = SYNTHETIC_INSTALLED_VERSION;
  return Buffer.from(JSON.stringify(meta), "utf8");
}
