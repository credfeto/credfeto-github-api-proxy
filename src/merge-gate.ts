/**
 * Gates PR merges (REST `PUT .../pulls/:pull_number/merge` and GraphQL
 * `mergePullRequest`) on the PR's actual mergeability, independent of
 * whether the caller's underlying PAT has admin-bypass rights.
 *
 * GitHub honours an admin/owner PAT's merge request even when required
 * reviews/status checks are unmet (unless the target repo has
 * `enforce_admins` turned on), and this proxy has no visibility into which
 * repos have that setting. So it applies its own gate: allow exactly the
 * merge states a non-admin caller could merge (mirroring `gh`'s own
 * `isImmediatelyMergeable`), and reject everything else — including any
 * lookup failure or timeout (fail closed).
 *
 * `enablePullRequestAutoMerge` / `disablePullRequestAutoMerge` are
 * deliberately not intercepted: they schedule a merge for later rather than
 * merging immediately, so a PR that is not yet mergeable can still queue
 * itself to land once it goes green.
 */

import https from "https";
import type http from "http";
import type { Request, Response, NextFunction } from "express";
import { GITHUB_API_HOST } from "./rewrite-urls.js";

const REDACTED = "[REDACTED]";
const LOOKUP_TIMEOUT_MS = 10_000;

// Copied rather than imported from proxy.ts: app.test.ts mocks proxy.js with a
// factory that exports only forwardToGitHub, so any other import from it
// resolves undefined in every app test.
function redactAuthorization(headers: http.OutgoingHttpHeaders): http.OutgoingHttpHeaders {
  const redacted: http.OutgoingHttpHeaders = { ...headers };
  if (redacted.authorization !== undefined) redacted.authorization = REDACTED;
  return redacted;
}

/** Merge states a non-admin caller could merge through unassisted (matches gh's isImmediatelyMergeable). */
const ALLOWED_MERGE_STATES: ReadonlySet<string> = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);

export function isMergeStateAllowed(mergeStateStatus: string | null): boolean {
  return mergeStateStatus !== null && ALLOWED_MERGE_STATES.has(mergeStateStatus);
}

export interface RestMergeTarget {
  owner: string;
  repo: string;
  number: number;
}

const REST_MERGE_PATH = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/i;

/** Identifies a REST PR-merge request (`PUT /repos/:owner/:repo/pulls/:pull_number/merge`). */
export function extractRestMergeTarget(method: string, path: string): RestMergeTarget | null {
  if (method.toUpperCase() !== "PUT") return null;
  const match = REST_MERGE_PATH.exec(path);
  if (match === null) return null;
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

/** Identifies a GraphQL `mergePullRequest` mutation body. */
export function isGraphQLMergePullRequestMutation(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const { query } = body as Record<string, unknown>;
  if (typeof query !== "string") return false;
  const trimmed = query.trimStart();
  if (!trimmed.startsWith("mutation")) return false;
  return query.includes("mergePullRequest");
}

/** Extracts `variables.input.pullRequestId` from a GraphQL request body. */
export function extractGraphQLMergePullRequestId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const { variables } = body as Record<string, unknown>;
  if (!variables || typeof variables !== "object") return null;
  const input = (variables as Record<string, unknown>).input;
  if (!input || typeof input !== "object") return null;
  const pullRequestId = (input as Record<string, unknown>).pullRequestId;
  return typeof pullRequestId === "string" ? pullRequestId : null;
}

const MERGE_STATE_BY_NUMBER_QUERY =
  "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){mergeStateStatus}}}";
const MERGE_STATE_BY_ID_QUERY = "query($id:ID!){node(id:$id){... on PullRequest{mergeStateStatus}}}";

function parseMergeStateStatus(body: Buffer): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const data = (parsed as Record<string, unknown>).data;
  if (!data || typeof data !== "object") return null;

  const repository = (data as Record<string, unknown>).repository;
  if (repository && typeof repository === "object") {
    const pullRequest = (repository as Record<string, unknown>).pullRequest;
    if (pullRequest && typeof pullRequest === "object") {
      const status = (pullRequest as Record<string, unknown>).mergeStateStatus;
      if (typeof status === "string") return status;
    }
  }

  const node = (data as Record<string, unknown>).node;
  if (node && typeof node === "object") {
    const status = (node as Record<string, unknown>).mergeStateStatus;
    if (typeof status === "string") return status;
  }

  return null;
}

/** Looks up a PR's `mergeStateStatus` via GraphQL using the caller's real PAT. Resolves null (fail closed) on any failure. */
function fetchMergeStateStatus(
  query: string,
  variables: Record<string, unknown>,
  authorization: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    const requestBody = JSON.stringify({ query, variables });
    const headers: http.OutgoingHttpHeaders = {
      authorization,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(requestBody),
      "user-agent": "github-api-proxy/1.0",
    };

    const req = https.request(
      {
        hostname: GITHUB_API_HOST,
        path: "/graphql",
        method: "POST",
        headers,
        timeout: LOOKUP_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const statusCode = res.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            console.error(
              "Merge gate: lookup returned non-2xx status",
              JSON.stringify({ statusCode, headers: redactAuthorization(headers) }),
            );
            resolve(null);
            return;
          }
          resolve(parseMergeStateStatus(Buffer.concat(chunks)));
        });
      },
    );

    req.on("timeout", () => {
      req.destroy();
      console.error("Merge gate: lookup timed out", JSON.stringify({ headers: redactAuthorization(headers) }));
      resolve(null);
    });
    req.on("error", (err: Error) => {
      console.error(
        "Merge gate: lookup failed",
        JSON.stringify({ error: err.message, headers: redactAuthorization(headers) }),
      );
      resolve(null);
    });

    req.write(requestBody);
    req.end();
  });
}

function denyMerge(res: Response, reason: string, extra?: { method: string; path: string }): void {
  res.status(403).json({
    message: "Operation blocked by proxy policy",
    reason,
    ...(extra ?? {}),
  });
}

function mergeStateDenialReason(mergeStateStatus: string | null): string {
  return `PR merge is not cleanly mergeable (mergeStateStatus: ${mergeStateStatus ?? "unknown"}); admin-bypass merges are blocked`;
}

/** Express middleware gating REST `PUT .../pulls/:pull_number/merge` requests. */
export function createRestMergeGate(): (req: Request, res: Response, next: NextFunction) => void {
  return function restMergeGate(req: Request, res: Response, next: NextFunction): void {
    const target = extractRestMergeTarget(req.method, req.path);
    if (target === null) {
      next();
      return;
    }

    const authorization = req.headers.authorization as string;
    void fetchMergeStateStatus(
      MERGE_STATE_BY_NUMBER_QUERY,
      { owner: target.owner, repo: target.repo, number: target.number },
      authorization,
    ).then((mergeStateStatus) => {
      if (!isMergeStateAllowed(mergeStateStatus)) {
        denyMerge(res, mergeStateDenialReason(mergeStateStatus), { method: req.method, path: req.path });
        return;
      }
      next();
    });
  };
}

/** Express middleware gating GraphQL `mergePullRequest` mutations. */
export function createGraphQLMergeGate(): (req: Request, res: Response, next: NextFunction) => void {
  return function graphqlMergeGate(req: Request, res: Response, next: NextFunction): void {
    if (!isGraphQLMergePullRequestMutation(req.body)) {
      next();
      return;
    }

    const pullRequestId = extractGraphQLMergePullRequestId(req.body);
    if (pullRequestId === null) {
      denyMerge(res, "Could not determine target pull request for mergePullRequest mutation; failing closed");
      return;
    }

    const authorization = req.headers.authorization as string;
    void fetchMergeStateStatus(MERGE_STATE_BY_ID_QUERY, { id: pullRequestId }, authorization).then(
      (mergeStateStatus) => {
        if (!isMergeStateAllowed(mergeStateStatus)) {
          denyMerge(res, mergeStateDenialReason(mergeStateStatus));
          return;
        }
        next();
      },
    );
  };
}
