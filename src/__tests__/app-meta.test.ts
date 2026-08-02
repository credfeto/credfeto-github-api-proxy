import { describe, it, expect, afterEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { mockUpstream } from "./https-request-mock.js";

// Real forwardToGitHub (not mocked) so the /meta transform runs end-to-end
// through the whole app pipeline (rewrite -> auth -> blocklist -> forward).
// https is mocked so no real network calls are made.

const PAIR = { proxyToken: "fake-proxy-token", githubPat: "ghp_real" };

describe("GET /meta — installed_version injection (issue #47)", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it.each(["/meta", "/api/v3/meta"])("returns installed_version via %s", async (path) => {
    const app = createApp([PAIR]);
    mockUpstream({ body: '{"verifiable_password_authentication":true}' });

    const res = await request(app)
      .get(path)
      .set("Authorization", `Bearer ${PAIR.proxyToken}`);

    expect(res.status).toBe(200);
    expect(res.body.installed_version).toBe("3.30.0");
  });
});
