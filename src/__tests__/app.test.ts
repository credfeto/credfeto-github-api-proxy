import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { forwardToGitHub } from "../proxy.js";

// Prevent any real network calls — tests must not hit api.github.com
vi.mock("../proxy.js", () => ({
  forwardToGitHub: vi.fn((_req, res) => {
    res.status(200).json({ proxied: true });
  }),
}));

const PAIR_1 = { proxyToken: "fake-proxy-token", githubPat: "ghp_real" };
const PAIR_2 = { proxyToken: "fake-proxy-token-2", githubPat: "ghp_real_2" };
const CREDENTIALS = [PAIR_1, PAIR_2];

describe("App integration", () => {
  const app = createApp(CREDENTIALS);

  // ── Auth checks ─────────────────────────────────────────────────────────

  it("returns 401 when no token is provided", async () => {
    const res = await request(app).get("/repos/alice/myrepo/issues");
    expect(res.status).toBe(401);
  });

  it("returns 401 when an unrecognised token is provided", async () => {
    const res = await request(app)
      .get("/repos/alice/myrepo/issues")
      .set("Authorization", "Bearer wrong");
    expect(res.status).toBe(401);
  });

  it("accepts a request authenticated with the second credential pair", async () => {
    const res = await request(app)
      .get("/repos/alice/myrepo/issues")
      .set("Authorization", `Bearer ${PAIR_2.proxyToken}`);
    expect(res.status).toBe(200);
    expect(res.body.proxied).toBe(true);
  });

  // ── REST blocklist ───────────────────────────────────────────────────────

  it("blocks POST to git/commits", async () => {
    const res = await request(app)
      .post("/repos/alice/myrepo/git/commits")
      .set("Authorization", `Bearer ${PAIR_1.proxyToken}`)
      .send({ message: "test" });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/blocked/i);
  });

  it("blocks POST to git/blobs", async () => {
    const res = await request(app)
      .post("/repos/alice/myrepo/git/blobs")
      .set("Authorization", `Bearer ${PAIR_1.proxyToken}`)
      .send({ content: "hello" });
    expect(res.status).toBe(403);
  });

  it("blocks PUT to contents (file update)", async () => {
    const res = await request(app)
      .put("/repos/alice/myrepo/contents/README.md")
      .set("Authorization", `Bearer ${PAIR_1.proxyToken}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("blocks PATCH to git/refs (advance branch)", async () => {
    const res = await request(app)
      .patch("/repos/alice/myrepo/git/refs/heads/main")
      .set("Authorization", `Bearer ${PAIR_1.proxyToken}`)
      .send({ sha: "abc" });
    expect(res.status).toBe(403);
  });

  // ── GraphQL blocklist ────────────────────────────────────────────────────

  it("blocks createCommitOnBranch GraphQL mutation", async () => {
    const res = await request(app)
      .post("/graphql")
      .set("Authorization", `Bearer ${PAIR_1.proxyToken}`)
      .send({ query: `mutation { createCommitOnBranch(input:{}) { clientMutationId } }` });
    expect(res.status).toBe(403);
    expect(res.body.reason).toMatch(/createCommitOnBranch/);
  });

  it("blocks deleteRef GraphQL mutation", async () => {
    const res = await request(app)
      .post("/graphql")
      .set("Authorization", `Bearer ${PAIR_1.proxyToken}`)
      .send({ query: `mutation { deleteRef(input:{}) { clientMutationId } }` });
    expect(res.status).toBe(403);
  });

  // ── Allowed operations ───────────────────────────────────────────────────

  it("forwards GET /repos/:owner/:repo/issues to GitHub", async () => {
    const res = await request(app)
      .get("/repos/alice/myrepo/issues")
      .set("Authorization", `Bearer ${PAIR_1.proxyToken}`);
    expect(res.status).toBe(200);
    expect(res.body.proxied).toBe(true);
  });

  it("forwards POST /repos/:owner/:repo/issues (create issue)", async () => {
    const res = await request(app)
      .post("/repos/alice/myrepo/issues")
      .set("Authorization", `Bearer ${PAIR_1.proxyToken}`)
      .send({ title: "Bug report" });
    expect(res.status).toBe(200);
    expect(res.body.proxied).toBe(true);
  });

  it("forwards GET /repos/:owner/:repo/actions/runs", async () => {
    const res = await request(app)
      .get("/repos/alice/myrepo/actions/runs")
      .set("Authorization", `Bearer ${PAIR_1.proxyToken}`);
    expect(res.status).toBe(200);
    expect(res.body.proxied).toBe(true);
  });

  it("forwards createIssue GraphQL mutation", async () => {
    const res = await request(app)
      .post("/graphql")
      .set("Authorization", `Bearer ${PAIR_1.proxyToken}`)
      .send({
        query: `mutation { createIssue(input:{repositoryId:"R_x",title:"T"}) { issue { number } } }`,
      });
    expect(res.status).toBe(200);
    expect(res.body.proxied).toBe(true);
  });

  it("forwards viewer GraphQL query", async () => {
    const res = await request(app)
      .post("/graphql")
      .set("Authorization", `Bearer ${PAIR_1.proxyToken}`)
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
      .set("Authorization", `Bearer ${PAIR_1.proxyToken}`);
    expect(res.status).toBe(200);
    expect(res.body.proxied).toBe(true);
  });

  it("forwards GET /api/v3/repos/:o/:r/issues identically to /repos/...", async () => {
    const res = await request(app)
      .get("/api/v3/repos/alice/myrepo/issues")
      .set("Authorization", `Bearer ${PAIR_1.proxyToken}`);
    expect(res.status).toBe(200);
    expect(res.body.proxied).toBe(true);
  });

  it("blocks POST /api/v3/repos/:o/:r/git/commits (blocklist still fires)", async () => {
    const res = await request(app)
      .post("/api/v3/repos/alice/myrepo/git/commits")
      .set("Authorization", `Bearer ${PAIR_1.proxyToken}`)
      .send({ message: "test" });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/blocked/i);
  });

  it("blocks PUT /api/v3/repos/:o/:r/contents/* (blocklist still fires)", async () => {
    const res = await request(app)
      .put("/api/v3/repos/alice/myrepo/contents/README.md")
      .set("Authorization", `Bearer ${PAIR_1.proxyToken}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("returns 401 for /api/v3/* with no token (auth still fires)", async () => {
    const res = await request(app).get("/api/v3/repos/alice/myrepo/issues");
    expect(res.status).toBe(401);
  });

  it("returns 401 for /api/v3/* with an unrecognised token (auth still fires)", async () => {
    const res = await request(app)
      .get("/api/v3/repos/alice/myrepo/issues")
      .set("Authorization", "Bearer nope");
    expect(res.status).toBe(401);
  });

  // ── /api/graphql path handling (Enterprise GraphQL path) ─────────────────
  // gh CLI sends GraphQL to /api/graphql when GH_HOST is a non-github.com
  // host. It must be rewritten to /graphql and pass through the same auth,
  // blocklist, and forward pipeline as a direct POST /graphql call.

  it("forwards allowed GraphQL query via /api/graphql", async () => {
    const res = await request(app)
      .post("/api/graphql")
      .set("Authorization", `Bearer ${PAIR_1.proxyToken}`)
      .send({ query: `query { viewer { login } }` });
    expect(res.status).toBe(200);
    expect(res.body.proxied).toBe(true);
  });

  it("blocks createCommitOnBranch mutation via /api/graphql", async () => {
    const res = await request(app)
      .post("/api/graphql")
      .set("Authorization", `Bearer ${PAIR_1.proxyToken}`)
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

// ── Logging ──────────────────────────────────────────────────────────────────

describe("Request logging", () => {
  const app = createApp(CREDENTIALS);
  let logSpy: MockInstance;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("logs method, path, and status for a successful GET", async () => {
    await request(app)
      .get("/repos/alice/myrepo/issues")
      .set("Authorization", `Bearer ${PAIR_1.proxyToken}`);
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/^GET \/repos\/alice\/myrepo\/issues -> 200$/));
  });

  it("logs 401 when no token is provided", async () => {
    await request(app).get("/repos/alice/myrepo/issues");
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/-> 401$/));
  });

  it("logs 403 for a blocked REST operation", async () => {
    await request(app)
      .post("/repos/alice/myrepo/git/commits")
      .set("Authorization", `Bearer ${PAIR_1.proxyToken}`)
      .send({ message: "test" });
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/-> 403$/));
  });

  it("logs GraphQL operation type for an anonymous query", async () => {
    await request(app)
      .post("/graphql")
      .set("Authorization", `Bearer ${PAIR_1.proxyToken}`)
      .send({ query: `query { viewer { login } }` });
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/POST \/graphql \(query\) -> 200/));
  });

  it("logs named GraphQL operation", async () => {
    await request(app)
      .post("/graphql")
      .set("Authorization", `Bearer ${PAIR_1.proxyToken}`)
      .send({ query: `query GetViewer { viewer { login } }` });
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/POST \/graphql \(query:GetViewer\) -> 200/));
  });

  it("logs GraphQL mutation with operation name", async () => {
    await request(app)
      .post("/graphql")
      .set("Authorization", `Bearer ${PAIR_1.proxyToken}`)
      .send({ query: `mutation CreateIssue($input: CreateIssueInput!) { createIssue(input: $input) { issue { number } } }` });
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/POST \/graphql \(mutation:CreateIssue\) -> 200/));
  });

  it("logs blocked GraphQL mutation with 403", async () => {
    await request(app)
      .post("/graphql")
      .set("Authorization", `Bearer ${PAIR_1.proxyToken}`)
      .send({ query: `mutation { createCommitOnBranch(input:{}) { clientMutationId } }` });
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/POST \/graphql \(mutation\) -> 403/));
  });
});

// ── Actions API forwarding (gh run view) ─────────────────────────────────────
// Regression coverage for issue #27: `gh run view --log-failed` and
// `gh run view --json jobs` were reported as returning HTTP 404.
// These tests confirm the proxy forwards both endpoints without blocking them
// and that the /api/v3/ prefix is stripped correctly before forwarding.

describe("Actions API forwarding (gh run view)", () => {
  const app = createApp(CREDENTIALS);
  const mockForward = vi.mocked(forwardToGitHub);

  beforeEach(() => {
    mockForward.mockClear();
  });

  it.each<{ label: string; url: string; expectedUrl: string }>([
    {
      label: "direct path",
      url: "/repos/alice/myrepo/actions/runs/12345/jobs?per_page=100",
      expectedUrl: "/repos/alice/myrepo/actions/runs/12345/jobs?per_page=100",
    },
    {
      label: "/api/v3 prefix",
      url: "/api/v3/repos/alice/myrepo/actions/runs/12345/jobs?per_page=100",
      expectedUrl: "/repos/alice/myrepo/actions/runs/12345/jobs?per_page=100",
    },
  ])("forwards GET /repos/…/actions/runs/:run_id/jobs via $label and preserves query string", async ({ url, expectedUrl }) => {
    const res = await request(app)
      .get(url)
      .set("Authorization", `Bearer ${PAIR_1.proxyToken}`);

    expect(res.status).toBe(200);
    expect(mockForward).toHaveBeenCalledOnce();
    const forwarded = mockForward.mock.calls[0][0];
    expect(forwarded.url).toBe(expectedUrl);
    expect(forwarded.method).toBe("GET");
  });

  it.each<{ label: string; url: string; expectedUrl: string }>([
    {
      label: "direct path",
      url: "/repos/alice/myrepo/actions/jobs/67890/logs",
      expectedUrl: "/repos/alice/myrepo/actions/jobs/67890/logs",
    },
    {
      label: "/api/v3 prefix",
      url: "/api/v3/repos/alice/myrepo/actions/jobs/67890/logs",
      expectedUrl: "/repos/alice/myrepo/actions/jobs/67890/logs",
    },
  ])("forwards GET /repos/…/actions/jobs/:job_id/logs via $label", async ({ url, expectedUrl }) => {
    const res = await request(app)
      .get(url)
      .set("Authorization", `Bearer ${PAIR_1.proxyToken}`);

    expect(res.status).toBe(200);
    expect(mockForward).toHaveBeenCalledOnce();
    const forwarded = mockForward.mock.calls[0][0];
    expect(forwarded.url).toBe(expectedUrl);
    expect(forwarded.method).toBe("GET");
  });
});

// ── createPullRequest headRepositoryId transform ──────────────────────────────

const CREATE_PR_MUTATION = `mutation CreatePullRequest($input: CreatePullRequestInput!) {
  createPullRequest(input: $input) { pullRequest { number url } }
}`;

describe("createPullRequest headRepositoryId transform", () => {
  const app = createApp(CREDENTIALS);
  const mockForward = vi.mocked(forwardToGitHub);

  beforeEach(() => {
    mockForward.mockClear();
  });

  it.each<{ label: string; input: Record<string, unknown> }>([
    {
      label: "absent",
      input: { repositoryId: "R_base123", baseRefName: "main", headRefName: "feature/my-branch", title: "My PR", draft: true },
    },
    {
      label: "null",
      input: { repositoryId: "R_base456", headRepositoryId: null, baseRefName: "main", headRefName: "feature/foo", title: "PR" },
    },
  ])("injects headRepositoryId when $label in createPullRequest input", async ({ input }) => {
    await request(app)
      .post("/graphql")
      .set("Authorization", `Bearer ${PAIR_1.proxyToken}`)
      .send({ query: CREATE_PR_MUTATION, variables: { input } });

    expect(mockForward).toHaveBeenCalledOnce();
    const forwarded = mockForward.mock.calls[0][0].body as { variables: { input: { headRepositoryId: string } } };
    expect(forwarded.variables.input.headRepositoryId).toBe(input.repositoryId as string);
  });

  it("does not overwrite an existing headRepositoryId", async () => {
    await request(app)
      .post("/graphql")
      .set("Authorization", `Bearer ${PAIR_1.proxyToken}`)
      .send({
        query: CREATE_PR_MUTATION,
        variables: {
          input: {
            repositoryId: "R_base",
            headRepositoryId: "R_fork",
            baseRefName: "main",
            headRefName: "feature/fork-branch",
            title: "Fork PR",
          },
        },
      });

    expect(mockForward).toHaveBeenCalledOnce();
    const forwarded = mockForward.mock.calls[0][0].body as { variables: { input: { headRepositoryId: string } } };
    expect(forwarded.variables.input.headRepositoryId).toBe("R_fork");
  });

  it("applies transform via /api/graphql path as well", async () => {
    await request(app)
      .post("/api/graphql")
      .set("Authorization", `Bearer ${PAIR_1.proxyToken}`)
      .send({
        query: CREATE_PR_MUTATION,
        variables: {
          input: {
            repositoryId: "R_base789",
            baseRefName: "main",
            headRefName: "feature/bar",
            title: "Bar PR",
          },
        },
      });

    expect(mockForward).toHaveBeenCalledOnce();
    const forwarded = mockForward.mock.calls[0][0].body as { variables: { input: { headRepositoryId: string } } };
    expect(forwarded.variables.input.headRepositoryId).toBe("R_base789");
  });

  it("does not transform non-createPullRequest mutations", async () => {
    const body = {
      query: `mutation CreateIssue($input: CreateIssueInput!) { createIssue(input: $input) { issue { number } } }`,
      variables: { input: { repositoryId: "R_x", title: "Bug" } },
    };
    await request(app)
      .post("/graphql")
      .set("Authorization", `Bearer ${PAIR_1.proxyToken}`)
      .send(body);

    expect(mockForward).toHaveBeenCalledOnce();
    const forwarded = mockForward.mock.calls[0][0].body as { variables: { input: { headRepositoryId?: string } } };
    expect(forwarded.variables.input.headRepositoryId).toBeUndefined();
  });
});
