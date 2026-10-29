import { describe, it, expect } from "vitest";
import { checkRestBlock, checkGraphQLBlock, extractGraphQLMutations } from "../blocklist.js";

// ── REST blocklist ─────────────────────────────────────────────────────────

describe("checkRestBlock — Git Data API", () => {
  it("blocks POST /repos/:owner/:repo/git/blobs", () => {
    expect(checkRestBlock("POST", "/repos/alice/myrepo/git/blobs")).toMatchObject({ blocked: true });
  });

  it("blocks POST /repos/:owner/:repo/git/trees", () => {
    expect(checkRestBlock("POST", "/repos/alice/myrepo/git/trees")).toMatchObject({ blocked: true });
  });

  it("blocks POST /repos/:owner/:repo/git/commits", () => {
    expect(checkRestBlock("POST", "/repos/alice/myrepo/git/commits")).toMatchObject({ blocked: true });
  });

  it("blocks POST /repos/:owner/:repo/git/refs", () => {
    expect(checkRestBlock("POST", "/repos/alice/myrepo/git/refs")).toMatchObject({ blocked: true });
  });

  it("blocks PATCH /repos/:owner/:repo/git/refs/:ref", () => {
    expect(checkRestBlock("PATCH", "/repos/alice/myrepo/git/refs/heads/main")).toMatchObject({ blocked: true });
  });

  it("blocks DELETE /repos/:owner/:repo/git/refs/:ref", () => {
    expect(checkRestBlock("DELETE", "/repos/alice/myrepo/git/refs/heads/feature")).toMatchObject({ blocked: true });
  });

  it("allows GET /repos/:owner/:repo/git/commits/:sha (read)", () => {
    expect(checkRestBlock("GET", "/repos/alice/myrepo/git/commits/abc123")).toMatchObject({ blocked: false });
  });

  it("allows GET /repos/:owner/:repo/git/refs (list)", () => {
    expect(checkRestBlock("GET", "/repos/alice/myrepo/git/refs")).toMatchObject({ blocked: false });
  });
});

describe("checkRestBlock — Contents write API", () => {
  it("blocks PUT /repos/:owner/:repo/contents/:path (create/update file)", () => {
    expect(checkRestBlock("PUT", "/repos/alice/myrepo/contents/README.md")).toMatchObject({ blocked: true });
  });

  it("blocks DELETE /repos/:owner/:repo/contents/:path (delete file)", () => {
    expect(checkRestBlock("DELETE", "/repos/alice/myrepo/contents/src/index.ts")).toMatchObject({ blocked: true });
  });

  it("allows GET /repos/:owner/:repo/contents/:path (read file)", () => {
    expect(checkRestBlock("GET", "/repos/alice/myrepo/contents/README.md")).toMatchObject({ blocked: false });
  });
});

describe("checkRestBlock — git smart-HTTP push", () => {
  it("blocks POST /org/repo.git/git-receive-pack", () => {
    expect(checkRestBlock("POST", "/alice/myrepo.git/git-receive-pack")).toMatchObject({ blocked: true });
  });

  it("blocks GET /info/refs?service=git-receive-pack", () => {
    expect(checkRestBlock("GET", "/alice/myrepo.git/info/refs?service=git-receive-pack")).toMatchObject({ blocked: true });
  });

  it("allows GET /info/refs?service=git-upload-pack (fetch/clone is ok)", () => {
    expect(checkRestBlock("GET", "/alice/myrepo.git/info/refs?service=git-upload-pack")).toMatchObject({ blocked: false });
  });
});

describe("checkRestBlock — no-PR merge endpoints", () => {
  it("blocks POST /repos/:owner/:repo/merges (merge a branch, no PR)", () => {
    expect(checkRestBlock("POST", "/repos/alice/myrepo/merges")).toMatchObject({ blocked: true });
  });

  it("blocks POST /repos/:owner/:repo/merge-upstream (sync fork)", () => {
    expect(checkRestBlock("POST", "/repos/alice/myrepo/merge-upstream")).toMatchObject({ blocked: true });
  });

  it("allows PUT /repos/:owner/:repo/pulls/:pull_number/merge (goes through the merge gate instead)", () => {
    expect(checkRestBlock("PUT", "/repos/alice/myrepo/pulls/7/merge")).toMatchObject({ blocked: false });
  });
});

describe("checkRestBlock — pull request branch update", () => {
  it("blocks PUT /repos/:owner/:repo/pulls/:pull_number/update-branch", () => {
    expect(checkRestBlock("PUT", "/repos/alice/myrepo/pulls/7/update-branch")).toMatchObject({
      blocked: true,
      reason: expect.stringMatching(/update-branch/),
    });
  });

  it("blocks update-branch with a trailing slash", () => {
    expect(checkRestBlock("PUT", "/repos/alice/myrepo/pulls/7/update-branch/")).toMatchObject({ blocked: true });
  });

  it("blocks update-branch with a query string", () => {
    expect(checkRestBlock("PUT", "/repos/alice/myrepo/pulls/7/update-branch?expected_head_sha=abc")).toMatchObject({
      blocked: true,
    });
  });

  it("blocks update-branch regardless of path or method case", () => {
    expect(checkRestBlock("put", "/Repos/Alice/MyRepo/PULLS/7/Update-Branch")).toMatchObject({ blocked: true });
  });

  it("allows GET on the update-branch path (not a write)", () => {
    expect(checkRestBlock("GET", "/repos/alice/myrepo/pulls/7/update-branch")).toMatchObject({ blocked: false });
  });

  it("allows PUT /repos/:owner/:repo/pulls/:pull_number/reviews/:id/dismissals", () => {
    expect(checkRestBlock("PUT", "/repos/alice/myrepo/pulls/7/reviews/1/dismissals")).toMatchObject({ blocked: false });
  });

  it("allows PUT on a path that only starts with update-branch", () => {
    expect(checkRestBlock("PUT", "/repos/alice/myrepo/pulls/7/update-branches")).toMatchObject({ blocked: false });
  });

  it("allows GET /repos/:owner/:repo/pulls/:pull_number", () => {
    expect(checkRestBlock("GET", "/repos/alice/myrepo/pulls/7")).toMatchObject({ blocked: false });
  });
});

describe("checkRestBlock — allowed operations", () => {
  it("allows GET /repos/:owner/:repo/issues", () => {
    expect(checkRestBlock("GET", "/repos/alice/myrepo/issues")).toMatchObject({ blocked: false });
  });

  it("allows POST /repos/:owner/:repo/issues (create issue)", () => {
    expect(checkRestBlock("POST", "/repos/alice/myrepo/issues")).toMatchObject({ blocked: false });
  });

  it("allows POST /repos/:owner/:repo/issues/:id/comments (issue comment)", () => {
    expect(checkRestBlock("POST", "/repos/alice/myrepo/issues/42/comments")).toMatchObject({ blocked: false });
  });

  it("allows GET /repos/:owner/:repo/pulls", () => {
    expect(checkRestBlock("GET", "/repos/alice/myrepo/pulls")).toMatchObject({ blocked: false });
  });

  it("allows POST /repos/:owner/:repo/pulls (create PR)", () => {
    expect(checkRestBlock("POST", "/repos/alice/myrepo/pulls")).toMatchObject({ blocked: false });
  });

  it("allows PATCH /repos/:owner/:repo/pulls/:id (update PR)", () => {
    expect(checkRestBlock("PATCH", "/repos/alice/myrepo/pulls/7")).toMatchObject({ blocked: false });
  });

  it("allows GET /repos/:owner/:repo/actions/runs (CI results)", () => {
    expect(checkRestBlock("GET", "/repos/alice/myrepo/actions/runs")).toMatchObject({ blocked: false });
  });

  it("allows GET /repos/:owner/:repo/actions/workflows (workflow list)", () => {
    expect(checkRestBlock("GET", "/repos/alice/myrepo/actions/workflows")).toMatchObject({ blocked: false });
  });

  it("allows POST /repos/:owner/:repo/actions/workflows/:id/dispatches (trigger workflow)", () => {
    expect(checkRestBlock("POST", "/repos/alice/myrepo/actions/workflows/12/dispatches")).toMatchObject({ blocked: false });
  });

  it("allows GET /notifications", () => {
    expect(checkRestBlock("GET", "/notifications")).toMatchObject({ blocked: false });
  });

  it("allows GET /user", () => {
    expect(checkRestBlock("GET", "/user")).toMatchObject({ blocked: false });
  });
});

// ── GraphQL blocklist ──────────────────────────────────────────────────────

describe("extractGraphQLMutations", () => {
  it("returns empty for a query", () => {
    expect(extractGraphQLMutations({ query: "query { viewer { login } }" })).toEqual([]);
  });

  it("returns empty for shorthand query (no operation keyword)", () => {
    expect(extractGraphQLMutations({ query: "{ viewer { login } }" })).toEqual([]);
  });

  it("returns mutation field names for a blocked mutation", () => {
    const q = `mutation { createCommitOnBranch(input: {}) { clientMutationId } }`;
    expect(extractGraphQLMutations({ query: q })).toContain("createCommitOnBranch");
  });

  it("returns multiple names when multiple mutations are present", () => {
    const q = `mutation DoStuff { createRef(input:{}) { ref { name } } updateRef(input:{}) { ref { name } } }`;
    const names = extractGraphQLMutations({ query: q });
    expect(names).toContain("createRef");
    expect(names).toContain("updateRef");
  });

  it("returns mergeBranch for a mergeBranch mutation", () => {
    const q = `mutation { mergeBranch(input:{}) { mergeCommit { oid } } }`;
    expect(extractGraphQLMutations({ query: q })).toContain("mergeBranch");
  });

  it("does not let a leading GraphQL comment hide a blocked mutation", () => {
    const q = `# just a helpful comment\nmutation { createCommitOnBranch(input: {}) { clientMutationId } }`;
    expect(extractGraphQLMutations({ query: q })).toContain("createCommitOnBranch");
  });

  it("does not let multiple leading comment lines hide a blocked mutation", () => {
    const q = `# one\n  # two\n\nmutation { mergeBranch(input:{}) { mergeCommit { oid } } }`;
    expect(extractGraphQLMutations({ query: q })).toContain("mergeBranch");
  });

  it("still returns empty for a query preceded by a leading comment", () => {
    const q = `# a comment\nquery { viewer { login } }`;
    expect(extractGraphQLMutations({ query: q })).toEqual([]);
  });

  it("does not let a leading query operation hide a blocked mutation selected via operationName", () => {
    const q = `query Noop { viewer { login } }\nmutation DoIt { createRef(input:{}) { ref { name } } }`;
    expect(extractGraphQLMutations({ query: q, operationName: "DoIt" })).toContain("createRef");
  });

  it("returns empty for a document with no mutation operation at all, even with other operations present", () => {
    const q = `query One { viewer { login } }\nquery Two { viewer { login } }`;
    expect(extractGraphQLMutations({ query: q, operationName: "Two" })).toEqual([]);
  });
});

describe("checkGraphQLBlock", () => {
  it("blocks createCommitOnBranch", () => {
    const body = { query: `mutation { createCommitOnBranch(input:{}) { clientMutationId } }` };
    expect(checkGraphQLBlock(body)).toMatchObject({ blocked: true });
  });

  it("blocks createRef", () => {
    const body = { query: `mutation { createRef(input:{}) { ref { name } } }` };
    expect(checkGraphQLBlock(body)).toMatchObject({ blocked: true });
  });

  it("blocks updateRef", () => {
    const body = { query: `mutation { updateRef(input:{}) { ref { name } } }` };
    expect(checkGraphQLBlock(body)).toMatchObject({ blocked: true });
  });

  it("blocks deleteRef", () => {
    const body = { query: `mutation { deleteRef(input:{}) { clientMutationId } }` };
    expect(checkGraphQLBlock(body)).toMatchObject({ blocked: true });
  });

  it("blocks mergeBranch", () => {
    const body = { query: `mutation { mergeBranch(input:{}) { mergeCommit { oid } } }` };
    expect(checkGraphQLBlock(body)).toMatchObject({
      blocked: true,
      reason: expect.stringMatching(/mergeBranch/),
    });
  });

  it("allows createIssue mutation", () => {
    const body = { query: `mutation { createIssue(input:{repositoryId:"x",title:"y"}) { issue { number } } }` };
    expect(checkGraphQLBlock(body)).toMatchObject({ blocked: false });
  });

  it("allows addComment mutation", () => {
    const body = { query: `mutation { addComment(input:{subjectId:"x",body:"hi"}) { commentEdge { node { id } } } }` };
    expect(checkGraphQLBlock(body)).toMatchObject({ blocked: false });
  });

  it("allows mergePullRequest mutation (handled by the merge gate instead)", () => {
    const body = { query: `mutation { mergePullRequest(input:{pullRequestId:"PR_x"}) { pullRequest { merged } } }` };
    expect(checkGraphQLBlock(body)).toMatchObject({ blocked: false });
  });

  it("allows viewer query", () => {
    const body = { query: `query { viewer { login } }` };
    expect(checkGraphQLBlock(body)).toMatchObject({ blocked: false });
  });

  it("allows repository query", () => {
    const body = {
      query: `query GetPR($owner:String!,$name:String!,$num:Int!) {
        repository(owner:$owner,name:$name) {
          pullRequest(number:$num) { title state }
        }
      }`,
    };
    expect(checkGraphQLBlock(body)).toMatchObject({ blocked: false });
  });

  it("returns not-blocked for non-object body", () => {
    expect(checkGraphQLBlock(null)).toMatchObject({ blocked: false });
    expect(checkGraphQLBlock("string")).toMatchObject({ blocked: false });
  });

  it("fails closed for a top-level array body instead of silently allowing it through (batched-request bypass)", () => {
    const body = [{ query: `mutation { mergePullRequest(input:{pullRequestId:"PR_x"}) { pullRequest { merged } } }` }];
    expect(checkGraphQLBlock(body)).toMatchObject({ blocked: true });
  });
});

describe("checkGraphQLBlock — updatePullRequestBranch", () => {
  const BLOCKED = { blocked: true, reason: expect.stringMatching(/updatePullRequestBranch/) };

  it("blocks a plain updatePullRequestBranch mutation", () => {
    const body = { query: `mutation { updatePullRequestBranch(input:{pullRequestId:"PR_x"}) { pullRequest { id } } }` };
    expect(checkGraphQLBlock(body)).toMatchObject(BLOCKED);
  });

  it.each(["REBASE", "MERGE"])("blocks updatePullRequestBranch with updateMethod %s", (method) => {
    const body = {
      query: `mutation { updatePullRequestBranch(input:{pullRequestId:"PR_x",updateMethod:${method}}) { pullRequest { id } } }`,
    };
    expect(checkGraphQLBlock(body)).toMatchObject(BLOCKED);
  });

  it("blocks updatePullRequestBranch with updateMethod passed as a variable", () => {
    const body = {
      query: `mutation Update($input: UpdatePullRequestBranchInput!) { updatePullRequestBranch(input: $input) { pullRequest { id } } }`,
      variables: { input: { pullRequestId: "PR_x", updateMethod: "REBASE" } },
    };
    expect(checkGraphQLBlock(body)).toMatchObject(BLOCKED);
  });

  it("blocks an aliased updatePullRequestBranch mutation", () => {
    const body = { query: `mutation { harmless: updatePullRequestBranch(input:{pullRequestId:"PR_x"}) { clientMutationId } }` };
    expect(checkGraphQLBlock(body)).toMatchObject(BLOCKED);
  });

  it("blocks updatePullRequestBranch alongside an allowed mutation in the same operation", () => {
    const body = {
      query: `mutation { addComment(input:{subjectId:"x",body:"hi"}) { clientMutationId } updatePullRequestBranch(input:{pullRequestId:"PR_x"}) { clientMutationId } }`,
    };
    expect(checkGraphQLBlock(body)).toMatchObject(BLOCKED);
  });

  it("blocks updatePullRequestBranch among several operations when operationName selects a different one", () => {
    const body = {
      query: `query Noop { viewer { login } }\nmutation Update { updatePullRequestBranch(input:{pullRequestId:"PR_x"}) { clientMutationId } }`,
      operationName: "Noop",
    };
    expect(checkGraphQLBlock(body)).toMatchObject(BLOCKED);
  });

  it("blocks updatePullRequestBranch reached through a fragment spread", () => {
    const body = {
      query: `mutation { ...Sneaky }\nfragment Sneaky on Mutation { updatePullRequestBranch(input:{pullRequestId:"PR_x"}) { clientMutationId } }`,
    };
    expect(checkGraphQLBlock(body)).toMatchObject(BLOCKED);
  });

  it("blocks updatePullRequestBranch reached through an inline fragment", () => {
    const body = {
      query: `mutation { ... on Mutation { updatePullRequestBranch(input:{pullRequestId:"PR_x"}) { clientMutationId } } }`,
    };
    expect(checkGraphQLBlock(body)).toMatchObject(BLOCKED);
  });

  it("blocks updatePullRequestBranch disguised with comments, commas and odd whitespace", () => {
    const body = {
      query: `# nothing to see\n,,mutation\t\n# still nothing\n{\r\n  ,updatePullRequestBranch # comment\n  (input:{pullRequestId:"PR_x"}),{ clientMutationId } }`,
    };
    expect(checkGraphQLBlock(body)).toMatchObject(BLOCKED);
  });

  it("fails closed for an unparseable document containing updatePullRequestBranch", () => {
    const body = { query: `mutation { updatePullRequestBranch(input:{pullRequestId:"PR_x"} { clientMutationId }` };
    expect(checkGraphQLBlock(body)).toMatchObject(BLOCKED);
  });

  it("allows a query that mentions updatePullRequestBranch only in a string argument", () => {
    const body = { query: `query { search(query:"updatePullRequestBranch", type:ISSUE, first:1) { issueCount } }` };
    expect(checkGraphQLBlock(body)).toMatchObject({ blocked: false });
  });

  it("allows a query that mentions updatePullRequestBranch only in a comment", () => {
    const body = { query: `# avoid updatePullRequestBranch, it pushes commits\nquery { viewer { login } }` };
    expect(checkGraphQLBlock(body)).toMatchObject({ blocked: false });
  });

  it("allows a mutation that mentions updatePullRequestBranch only in a string argument", () => {
    const body = {
      query: `mutation { addComment(input:{subjectId:"x",body:"please run updatePullRequestBranch"}) { clientMutationId } }`,
    };
    expect(checkGraphQLBlock(body)).toMatchObject({ blocked: false });
  });

  it("allows an unrelated pull request mutation", () => {
    const body = { query: `mutation { updatePullRequest(input:{pullRequestId:"PR_x",title:"t"}) { pullRequest { id } } }` };
    expect(checkGraphQLBlock(body)).toMatchObject({ blocked: false });
  });

  it("allows a pull request query", () => {
    const body = { query: `query { node(id:"PR_x") { ... on PullRequest { title mergeStateStatus } } }` };
    expect(checkGraphQLBlock(body)).toMatchObject({ blocked: false });
  });
});
