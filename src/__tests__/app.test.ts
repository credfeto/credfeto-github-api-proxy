import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";

// Prevent any real network calls — tests must not hit api.github.com
vi.mock("../proxy.js", () => ({
  forwardToGitHub: vi.fn((_req, res) => {
    res.status(200).json({ proxied: true });
  }),
}));

const CONFIG = { proxyToken: "fake-proxy-token", githubPat: "ghp_real" };

describe("App integration", () => {
  const app = createApp(CONFIG);

  // ── Auth checks ─────────────────────────────────────────────────────────

  it("returns 401 when no token is provided", async () => {
    const res = await request(app).get("/repos/alice/myrepo/issues");
    expect(res.status).toBe(401);
  });

  it("returns 403 when wrong token is provided", async () => {
    const res = await request(app)
      .get("/repos/alice/myrepo/issues")
      .set("Authorization", "Bearer wrong");
    expect(res.status).toBe(403);
  });

  // ── REST blocklist ───────────────────────────────────────────────────────

  it("blocks POST to git/commits", async () => {
    const res = await request(app)
      .post("/repos/alice/myrepo/git/commits")
      .set("Authorization", `Bearer ${CONFIG.proxyToken}`)
      .send({ message: "test" });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/blocked/i);
  });

  it("blocks POST to git/blobs", async () => {
    const res = await request(app)
      .post("/repos/alice/myrepo/git/blobs")
      .set("Authorization", `Bearer ${CONFIG.proxyToken}`)
      .send({ content: "hello" });
    expect(res.status).toBe(403);
  });

  it("blocks PUT to contents (file update)", async () => {
    const res = await request(app)
      .put("/repos/alice/myrepo/contents/README.md")
      .set("Authorization", `Bearer ${CONFIG.proxyToken}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("blocks PATCH to git/refs (advance branch)", async () => {
    const res = await request(app)
      .patch("/repos/alice/myrepo/git/refs/heads/main")
      .set("Authorization", `Bearer ${CONFIG.proxyToken}`)
      .send({ sha: "abc" });
    expect(res.status).toBe(403);
  });

  // ── GraphQL blocklist ────────────────────────────────────────────────────

  it("blocks createCommitOnBranch GraphQL mutation", async () => {
    const res = await request(app)
      .post("/graphql")
      .set("Authorization", `Bearer ${CONFIG.proxyToken}`)
      .send({ query: `mutation { createCommitOnBranch(input:{}) { clientMutationId } }` });
    expect(res.status).toBe(403);
    expect(res.body.reason).toMatch(/createCommitOnBranch/);
  });

  it("blocks deleteRef GraphQL mutation", async () => {
    const res = await request(app)
      .post("/graphql")
      .set("Authorization", `Bearer ${CONFIG.proxyToken}`)
      .send({ query: `mutation { deleteRef(input:{}) { clientMutationId } }` });
    expect(res.status).toBe(403);
  });

  // ── Allowed operations ───────────────────────────────────────────────────

  it("forwards GET /repos/:owner/:repo/issues to GitHub", async () => {
    const res = await request(app)
      .get("/repos/alice/myrepo/issues")
      .set("Authorization", `Bearer ${CONFIG.proxyToken}`);
    expect(res.status).toBe(200);
    expect(res.body.proxied).toBe(true);
  });

  it("forwards POST /repos/:owner/:repo/issues (create issue)", async () => {
    const res = await request(app)
      .post("/repos/alice/myrepo/issues")
      .set("Authorization", `Bearer ${CONFIG.proxyToken}`)
      .send({ title: "Bug report" });
    expect(res.status).toBe(200);
    expect(res.body.proxied).toBe(true);
  });

  it("forwards GET /repos/:owner/:repo/actions/runs", async () => {
    const res = await request(app)
      .get("/repos/alice/myrepo/actions/runs")
      .set("Authorization", `Bearer ${CONFIG.proxyToken}`);
    expect(res.status).toBe(200);
    expect(res.body.proxied).toBe(true);
  });

  it("forwards createIssue GraphQL mutation", async () => {
    const res = await request(app)
      .post("/graphql")
      .set("Authorization", `Bearer ${CONFIG.proxyToken}`)
      .send({
        query: `mutation { createIssue(input:{repositoryId:"R_x",title:"T"}) { issue { number } } }`,
      });
    expect(res.status).toBe(200);
    expect(res.body.proxied).toBe(true);
  });

  it("forwards viewer GraphQL query", async () => {
    const res = await request(app)
      .post("/graphql")
      .set("Authorization", `Bearer ${CONFIG.proxyToken}`)
      .send({ query: `query { viewer { login } }` });
    expect(res.status).toBe(200);
    expect(res.body.proxied).toBe(true);
  });

  // ── /api/v3 prefix handling ──────────────────────────────────────────────
  // gh CLI prepends `/api/v3/` to every REST call when GH_HOST is a non-
  // github.com host (Enterprise URL convention). Both shapes must reach the
  // same auth, the same blocklist, and the same forward target.

  it("forwards GET /api/v3/user identically to /user", async () => {
    const res = await request(app)
      .get("/api/v3/user")
      .set("Authorization", `Bearer ${CONFIG.proxyToken}`);
    expect(res.status).toBe(200);
    expect(res.body.proxied).toBe(true);
  });

  it("forwards GET /api/v3/repos/:o/:r/issues identically to /repos/...", async () => {
    const res = await request(app)
      .get("/api/v3/repos/alice/myrepo/issues")
      .set("Authorization", `Bearer ${CONFIG.proxyToken}`);
    expect(res.status).toBe(200);
    expect(res.body.proxied).toBe(true);
  });

  it("blocks POST /api/v3/repos/:o/:r/git/commits (blocklist still fires)", async () => {
    const res = await request(app)
      .post("/api/v3/repos/alice/myrepo/git/commits")
      .set("Authorization", `Bearer ${CONFIG.proxyToken}`)
      .send({ message: "test" });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/blocked/i);
  });

  it("blocks PUT /api/v3/repos/:o/:r/contents/* (blocklist still fires)", async () => {
    const res = await request(app)
      .put("/api/v3/repos/alice/myrepo/contents/README.md")
      .set("Authorization", `Bearer ${CONFIG.proxyToken}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("returns 401 for /api/v3/* with no token (auth still fires)", async () => {
    const res = await request(app).get("/api/v3/repos/alice/myrepo/issues");
    expect(res.status).toBe(401);
  });

  it("returns 403 for /api/v3/* with a wrong token (auth still fires)", async () => {
    const res = await request(app)
      .get("/api/v3/repos/alice/myrepo/issues")
      .set("Authorization", "Bearer nope");
    expect(res.status).toBe(403);
  });

  // ── /api/graphql path handling (Enterprise GraphQL path) ─────────────────
  // gh CLI sends GraphQL to /api/graphql when GH_HOST is a non-github.com
  // host. It must be rewritten to /graphql and pass through the same auth,
  // blocklist, and forward pipeline as a direct POST /graphql call.

  it("forwards allowed GraphQL query via /api/graphql", async () => {
    const res = await request(app)
      .post("/api/graphql")
      .set("Authorization", `Bearer ${CONFIG.proxyToken}`)
      .send({ query: `query { viewer { login } }` });
    expect(res.status).toBe(200);
    expect(res.body.proxied).toBe(true);
  });

  it("blocks createCommitOnBranch mutation via /api/graphql", async () => {
    const res = await request(app)
      .post("/api/graphql")
      .set("Authorization", `Bearer ${CONFIG.proxyToken}`)
      .send({ query: `mutation { createCommitOnBranch(input:{}) { clientMutationId } }` });
    expect(res.status).toBe(403);
    expect(res.body.reason).toMatch(/createCommitOnBranch/);
  });

  it("returns 401 for /api/graphql with no token (auth still fires)", async () => {
    const res = await request(app)
      .post("/api/graphql")
      .send({ query: `query { viewer { login } }` });
    expect(res.status).toBe(401);
  });
});
