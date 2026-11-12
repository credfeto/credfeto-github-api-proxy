import { describe, it, expect, afterEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { mockUpstream } from "./https-request-mock.js";

// Real forwardToGitHub (not mocked) so the scheme chosen for the proxy origin is
// observed end-to-end in the rewritten body and Link header. https is mocked so
// no real network calls are made.

const PAIR = { proxyToken: "fake-proxy-token", githubPat: "ghp_real" };
const RUN_PATH = "/repos/alice/myrepo/actions/runs/1";

function mockRunResponse(): void {
  mockUpstream({
    headers: { link: '<https://api.github.com/repos/alice/myrepo/actions/runs?page=2>; rel="next"' },
    body: '{"jobs_url":"https://api.github.com/repos/alice/myrepo/actions/runs/1/jobs"}',
  });
}

describe("public scheme used for api.github.com URL rewriting", () => {
  const original = process.env.PUBLIC_BASE_SCHEME;

  afterEach(() => {
    vi.restoreAllMocks();
    if (original === undefined) {
      delete process.env.PUBLIC_BASE_SCHEME;
    } else {
      process.env.PUBLIC_BASE_SCHEME = original;
    }
  });

  it("uses https from X-Forwarded-Proto sent by a trusted loopback hop", async () => {
    delete process.env.PUBLIC_BASE_SCHEME;
    const app = createApp([PAIR]);
    mockRunResponse();

    const res = await request(app)
      .get(RUN_PATH)
      .set("Authorization", `Bearer ${PAIR.proxyToken}`)
      .set("Host", "proxy.example.com")
      .set("X-Forwarded-Proto", "https");

    expect(res.status).toBe(200);
    expect(res.body.jobs_url).toBe("https://proxy.example.com/repos/alice/myrepo/actions/runs/1/jobs");
    expect(res.headers.link).toBe('<https://proxy.example.com/repos/alice/myrepo/actions/runs?page=2>; rel="next"');
  });

  it("falls back to http when no X-Forwarded-Proto header is sent", async () => {
    delete process.env.PUBLIC_BASE_SCHEME;
    const app = createApp([PAIR]);
    mockRunResponse();

    const res = await request(app)
      .get(RUN_PATH)
      .set("Authorization", `Bearer ${PAIR.proxyToken}`)
      .set("Host", "proxy.example.com");

    expect(res.status).toBe(200);
    expect(res.body.jobs_url).toBe("http://proxy.example.com/repos/alice/myrepo/actions/runs/1/jobs");
    expect(res.headers.link).toBe('<http://proxy.example.com/repos/alice/myrepo/actions/runs?page=2>; rel="next"');
  });

  it("uses PUBLIC_BASE_SCHEME when set, without consulting X-Forwarded-Proto", async () => {
    process.env.PUBLIC_BASE_SCHEME = "https";
    const app = createApp([PAIR]);
    mockRunResponse();

    const res = await request(app)
      .get(RUN_PATH)
      .set("Authorization", `Bearer ${PAIR.proxyToken}`)
      .set("Host", "proxy.example.com")
      .set("X-Forwarded-Proto", "http");

    expect(res.status).toBe(200);
    expect(res.body.jobs_url).toBe("https://proxy.example.com/repos/alice/myrepo/actions/runs/1/jobs");
    expect(res.headers.link).toBe('<https://proxy.example.com/repos/alice/myrepo/actions/runs?page=2>; rel="next"');
  });
});
