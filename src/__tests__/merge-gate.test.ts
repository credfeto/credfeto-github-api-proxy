import { describe, it, expect } from "vitest";
import {
  isMergeStateAllowed,
  extractRestMergeTarget,
  isGraphQLMergePullRequestMutation,
  extractGraphQLMergePullRequestId,
} from "../merge-gate.js";

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
});

// ── extractGraphQLMergePullRequestId ───────────────────────────────────────

describe("extractGraphQLMergePullRequestId", () => {
  it("extracts pullRequestId from variables.input", () => {
    const body = { variables: { input: { pullRequestId: "PR_kwABC" } } };
    expect(extractGraphQLMergePullRequestId(body)).toBe("PR_kwABC");
  });

  it("returns null when variables.input is missing", () => {
    expect(extractGraphQLMergePullRequestId({ variables: {} })).toBeNull();
  });

  it("returns null when pullRequestId is missing from input", () => {
    expect(extractGraphQLMergePullRequestId({ variables: { input: { mergeMethod: "MERGE" } } })).toBeNull();
  });

  it("returns null when pullRequestId is not a string", () => {
    expect(extractGraphQLMergePullRequestId({ variables: { input: { pullRequestId: 123 } } })).toBeNull();
  });

  it("returns null for a non-object body", () => {
    expect(extractGraphQLMergePullRequestId(null)).toBeNull();
  });
});
