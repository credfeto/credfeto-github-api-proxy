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
import { extractGraphQLMutationNames, sendBlockedResponse } from "./blocklist.js";
import { PROXY_USER_AGENT, redactAuthorization } from "./http-headers.js";
import { parseJsonBody } from "./json.js";
import { GITHUB_API_HOST } from "./rewrite-urls.js";

/** Narrows to a plain object record, or undefined for anything else (including null). */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

const LOOKUP_TIMEOUT_MS = 10_000;

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
  return extractGraphQLMutationNames(body, ["mergePullRequest"]).includes("mergePullRequest");
}

/** Extracts `variables.input.pullRequestId` from a GraphQL request body. */
export function extractGraphQLMergePullRequestId(body: unknown): string | null {
  const variables = asRecord(asRecord(body)?.variables);
  const input = asRecord(variables?.input);
  const pullRequestId = input?.pullRequestId;
  return typeof pullRequestId === "string" ? pullRequestId : null;
}

const MERGE_STATE_BY_NUMBER_QUERY =
  "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){mergeStateStatus}}}";
const MERGE_STATE_BY_ID_QUERY = "query($id:ID!){node(id:$id){... on PullRequest{mergeStateStatus}}}";

function parseMergeStateStatus(body: Buffer): string | null {
  const parsed = asRecord(parseJsonBody(body.toString("utf8")));
  const data = asRecord(parsed?.data);
  const repository = asRecord(data?.repository);
  const pullRequest = asRecord(repository?.pullRequest);
  const node = asRecord(data?.node);
  const status = pullRequest?.mergeStateStatus ?? node?.mergeStateStatus;
  return typeof status === "string" ? status : null;
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
      "user-agent": PROXY_USER_AGENT,
    };

    const failClosed = (message: string, extra?: Record<string, unknown>): void => {
      console.error(message, JSON.stringify({ ...extra, headers: redactAuthorization(headers) }));
      resolve(null);
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
            failClosed("Merge gate: lookup returned non-2xx status", { statusCode });
            return;
          }
          resolve(parseMergeStateStatus(Buffer.concat(chunks)));
        });
      },
    );

    req.on("timeout", () => {
      req.destroy();
      failClosed("Merge gate: lookup timed out");
    });
    req.on("error", (err: Error) => {
      failClosed("Merge gate: lookup failed", { error: err.message });
    });

    req.write(requestBody);
    req.end();
  });
}

function mergeStateDenialReason(mergeStateStatus: string | null): string {
  return `PR merge is not cleanly mergeable (mergeStateStatus: ${mergeStateStatus ?? "unknown"}); admin-bypass merges are blocked`;
}

function applyMergeStateResult(res: Response, next: NextFunction, mergeStateStatus: string | null): void {
  if (!isMergeStateAllowed(mergeStateStatus)) {
    sendBlockedResponse(res, mergeStateDenialReason(mergeStateStatus));
    return;
  }
  next();
}

/** Looks up mergeStateStatus and applies the resulting allow/deny decision to the response. */
function gateOnMergeState(
  query: string,
  variables: Record<string, unknown>,
  authorization: string,
  res: Response,
  next: NextFunction,
): void {
  void fetchMergeStateStatus(query, variables, authorization).then((mergeStateStatus) =>
    applyMergeStateResult(res, next, mergeStateStatus),
  );
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
    gateOnMergeState(
      MERGE_STATE_BY_NUMBER_QUERY,
      { owner: target.owner, repo: target.repo, number: target.number },
      authorization,
      res,
      next,
    );
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
      sendBlockedResponse(res, "Could not determine target pull request for mergePullRequest mutation; failing closed");
      return;
    }

    const authorization = req.headers.authorization as string;
    gateOnMergeState(MERGE_STATE_BY_ID_QUERY, { id: pullRequestId }, authorization, res, next);
  };
}
