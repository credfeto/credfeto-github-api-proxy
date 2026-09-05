import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import {
  isMergeStateAllowed,
  extractRestMergeTarget,
  isGraphQLMergePullRequestMutation,
  extractGraphQLMergePullRequestId,
  createRestMergeGate,
  createGraphQLMergeGate,
} from "../merge-gate.js";

function makeRes(): { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn>; _statusCode: number } {
  const res = {
    _statusCode: 0,
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  res.status.mockImplementation((code: number) => {
    res._statusCode = code;
    return res;
  });
  return res;
}

// ── isMergeStateAllowed ────────────────────────────────────────────────────

describe("isMergeStateAllowed", () => {
  it.each(["CLEAN", "HAS_HOOKS", "UNSTABLE"])("allows mergeStateStatus %s", (state) => {
    expect(isMergeStateAllowed(state)).toBe(true);
  });

  it.each(["BLOCKED", "BEHIND", "DIRTY", "DRAFT", "UNKNOWN"])("denies mergeStateStatus %s", (state) => {
    expect(isMergeStateAllowed(state)).toBe(false);
  });

  it("denies a null mergeStateStatus (lookup failure, fail closed)", () => {
    expect(isMergeStateAllowed(null)).toBe(false);
  });
});

// ── extractRestMergeTarget ─────────────────────────────────────────────────

describe("extractRestMergeTarget", () => {
  it("extracts owner/repo/number from a PUT merge path", () => {
    expect(extractRestMergeTarget("PUT", "/repos/alice/myrepo/pulls/42/merge")).toStrictEqual({
      owner: "alice",
      repo: "myrepo",
      number: 42,
    });
  });

  it("is case-insensitive on the method", () => {
    expect(extractRestMergeTarget("put", "/repos/alice/myrepo/pulls/42/merge")).toStrictEqual({
      owner: "alice",
      repo: "myrepo",
      number: 42,
    });
  });

  it("returns null for a non-PUT method", () => {
    expect(extractRestMergeTarget("GET", "/repos/alice/myrepo/pulls/42/merge")).toBeNull();
  });

  it("returns null for PUT to the PR itself (not the merge sub-resource)", () => {
    expect(extractRestMergeTarget("PUT", "/repos/alice/myrepo/pulls/42")).toBeNull();
  });

  it("returns null for an unrelated PUT path", () => {
    expect(extractRestMergeTarget("PUT", "/repos/alice/myrepo/contents/README.md")).toBeNull();
  });
});

// ── isGraphQLMergePullRequestMutation ──────────────────────────────────────

describe("isGraphQLMergePullRequestMutation", () => {
  it("returns true for a mergePullRequest mutation", () => {
    const body = { query: `mutation { mergePullRequest(input:{pullRequestId:"PR_x"}) { pullRequest { merged } } }` };
    expect(isGraphQLMergePullRequestMutation(body)).toBe(true);
  });

  it("returns false for enablePullRequestAutoMerge (schedules, doesn't merge immediately)", () => {
    const body = {
      query: `mutation { enablePullRequestAutoMerge(input:{pullRequestId:"PR_x"}) { pullRequest { autoMergeRequest { enabledAt } } } }`,
    };
    expect(isGraphQLMergePullRequestMutation(body)).toBe(false);
  });

  it("returns false for a query", () => {
    const body = { query: `query { viewer { login } }` };
    expect(isGraphQLMergePullRequestMutation(body)).toBe(false);
  });

  it("returns false for a non-object body", () => {
    expect(isGraphQLMergePullRequestMutation(null)).toBe(false);
    expect(isGraphQLMergePullRequestMutation("string")).toBe(false);
  });

  it("returns true for a mergePullRequest mutation preceded by a leading comment", () => {
    const body = {
      query: `# admin bypass attempt\nmutation { mergePullRequest(input:{pullRequestId:"PR_x"}) { pullRequest { merged } } }`,
    };
    expect(isGraphQLMergePullRequestMutation(body)).toBe(true);
  });

  it("returns true for a mergePullRequest mutation hidden behind a leading query operation and operationName", () => {
    const body = {
      query: `query Noop { viewer { login } }\nmutation DoIt { mergePullRequest(input:{pullRequestId:"PR_x"}) { pullRequest { merged } } }`,
      operationName: "DoIt",
    };
    expect(isGraphQLMergePullRequestMutation(body)).toBe(true);
  });
});

// ── extractGraphQLMergePullRequestId ───────────────────────────────────────

describe("extractGraphQLMergePullRequestId", () => {
  const MUTATION_VAR_INPUT = `mutation($input: MergePullRequestInput!) { mergePullRequest(input: $input) { pullRequest { merged } } }`;

  it("extracts pullRequestId from the variable actually bound to the input: argument", () => {
    const body = { query: MUTATION_VAR_INPUT, variables: { input: { pullRequestId: "PR_kwABC" } } };
    expect(extractGraphQLMergePullRequestId(body)).toBe("PR_kwABC");
  });

  it("extracts pullRequestId from an inline literal input: argument", () => {
    const body = { query: `mutation { mergePullRequest(input: {pullRequestId: "PR_kwABC"}) { pullRequest { merged } } }` };
    expect(extractGraphQLMergePullRequestId(body)).toBe("PR_kwABC");
  });

  it("does not trust a same-named variables.input the call's argument does not actually reference (confused-deputy bypass)", () => {
    // The mutation's `input:` argument is an inline literal targeting the real PR; `variables.input`
    // is a decoy that the query never references. Extraction must follow the actual argument, not
    // the conveniently-named-but-unused variables key, otherwise the merge gate would validate the
    // decoy's mergeability while GitHub executes the merge against the real, unvalidated PR.
    const body = {
      query: `mutation { mergePullRequest(input: {pullRequestId: "PR_REAL_TARGET"}) { clientMutationId } }`,
      variables: { input: { pullRequestId: "PR_DECOY_CLEAN" } },
    };
    expect(extractGraphQLMergePullRequestId(body)).toBe("PR_REAL_TARGET");
  });

  it("resolves via whichever variable name the input: argument actually references, not a literal 'input' key", () => {
    const body = {
      query: `mutation($x: MergePullRequestInput!) { mergePullRequest(input: $x) { pullRequest { merged } } }`,
      variables: { input: { pullRequestId: "PR_DECOY_CLEAN" }, x: { pullRequestId: "PR_REAL_TARGET" } },
    };
    expect(extractGraphQLMergePullRequestId(body)).toBe("PR_REAL_TARGET");
  });

  it("returns null (fail closed) when the referenced variable is missing", () => {
    expect(extractGraphQLMergePullRequestId({ query: MUTATION_VAR_INPUT, variables: {} })).toBeNull();
  });

  it("returns null (fail closed) when pullRequestId is missing from the referenced variable's input", () => {
    const body = { query: MUTATION_VAR_INPUT, variables: { input: { mergeMethod: "MERGE" } } };
    expect(extractGraphQLMergePullRequestId(body)).toBeNull();
  });

  it("returns null (fail closed) when pullRequestId is not a string", () => {
    const body = { query: MUTATION_VAR_INPUT, variables: { input: { pullRequestId: 123 } } };
    expect(extractGraphQLMergePullRequestId(body)).toBeNull();
  });

  it("returns null (fail closed) for a document with more than one mergePullRequest( call", () => {
    const body = {
      query: `mutation { a: mergePullRequest(input: {pullRequestId: "PR_a"}) { clientMutationId } b: mergePullRequest(input: {pullRequestId: "PR_b"}) { clientMutationId } }`,
    };
    expect(extractGraphQLMergePullRequestId(body)).toBeNull();
  });

  it("returns null (fail closed) when there is no query string at all", () => {
    expect(extractGraphQLMergePullRequestId({ variables: { input: { pullRequestId: "PR_kwABC" } } })).toBeNull();
  });

  it("returns null for a non-object body", () => {
    expect(extractGraphQLMergePullRequestId(null)).toBeNull();
  });

  it("does not let a decoy pullRequestId hidden in a #-comment shadow the real, later field (confused-deputy bypass)", () => {
    // GraphQL comments run from `#` to end-of-line and are insignificant to a real parser,
    // including the `}` inside one. A regex with no concept of comments would stop at that
    // `}` and extract the decoy, while GitHub's real parser ignores the comment entirely and
    // merges the real, unvalidated PR instead.
    const body = {
      query:
        'mutation {\n  mergePullRequest(input: {\n    clientMutationId: "x" # pullRequestId: "PR_DECOY_CLEAN" }\n    pullRequestId: "PR_REAL_TARGET"\n  }) {\n    pullRequest { merged }\n  }\n}',
    };
    expect(extractGraphQLMergePullRequestId(body)).toBe("PR_REAL_TARGET");
  });

  it("does not let a decoy pullRequestId hidden in a block string shadow the real, later field", () => {
    const body = {
      query:
        'mutation { mergePullRequest(input: { clientMutationId: """ pullRequestId: "PR_DECOY_CLEAN" } """ pullRequestId: "PR_REAL_TARGET" }) { clientMutationId } }',
    };
    expect(extractGraphQLMergePullRequestId(body)).toBe("PR_REAL_TARGET");
  });

  it("does not let a decoy pullRequestId hidden in a nested object shadow the real, top-level field", () => {
    const body = {
      query:
        'mutation { mergePullRequest(input: { clientMutationId: {fake: "x", pullRequestId: "PR_DECOY_CLEAN"}, pullRequestId: "PR_REAL_TARGET" }) { clientMutationId } }',
    };
    expect(extractGraphQLMergePullRequestId(body)).toBe("PR_REAL_TARGET");
  });
});

// ── missing Authorization header (fail closed) ─────────────────────────────

describe("createRestMergeGate — missing Authorization header", () => {
  it("fails closed instead of forwarding a merge request with no Authorization header", () => {
    const mw = createRestMergeGate();
    const req = { method: "PUT", path: "/repos/alice/myrepo/pulls/42/merge", headers: {} } as unknown as Request;
    const res = makeRes();
    const next = vi.fn();
    mw(req, res as unknown as Response, next as NextFunction);
    expect(res._statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("createGraphQLMergeGate — missing Authorization header", () => {
  it("fails closed instead of forwarding a mergePullRequest mutation with no Authorization header", () => {
    const mw = createGraphQLMergeGate();
    const req = {
      headers: {},
      body: { query: `mutation { mergePullRequest(input:{pullRequestId:"PR_x"}) { pullRequest { merged } } }` },
    } as unknown as Request;
    const res = makeRes();
    const next = vi.fn();
    mw(req, res as unknown as Response, next as NextFunction);
    expect(res._statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });
});
