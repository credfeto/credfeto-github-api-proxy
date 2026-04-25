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

  it("allows createIssue mutation", () => {
    const body = { query: `mutation { createIssue(input:{repositoryId:"x",title:"y"}) { issue { number } } }` };
    expect(checkGraphQLBlock(body)).toMatchObject({ blocked: false });
  });

  it("allows addComment mutation", () => {
    const body = { query: `mutation { addComment(input:{subjectId:"x",body:"hi"}) { commentEdge { node { id } } } }` };
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
});
