import { describe, it, expect, vi, afterEach } from "vitest";
import request from "supertest";
import https from "https";
import type { IncomingMessage, ClientRequest } from "http";
import { EventEmitter } from "events";
import { createApp } from "../app.js";

// Real forwardToGitHub (not mocked) so the /meta transform runs end-to-end
// through the whole app pipeline (rewrite -> auth -> blocklist -> forward).
// https is mocked so no real network calls are made.

const PAIR = { proxyToken: "fake-proxy-token", githubPat: "ghp_real" };

/** Installs a one-shot spy on https.request returning the given /meta-shaped body. */
function mockMetaUpstream(body: string): void {
  vi.spyOn(https, "request").mockImplementationOnce((_options, callback) => {
    const fakeRes = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headers: { "content-type": "application/json" },
    }) as unknown as IncomingMessage;
    const fakeReq = Object.assign(new EventEmitter(), {
      setHeader: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    }) as unknown as ClientRequest;

    process.nextTick(() => {
      if (callback) {
        callback(fakeRes);
        process.nextTick(() => {
          fakeRes.emit("data", Buffer.from(body));
          fakeRes.emit("end");
        });
      }
    });

    return fakeReq;
  });
}

describe("GET /meta — installed_version injection (issue #47)", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns installed_version via the direct /meta path", async () => {
    const app = createApp([PAIR]);
    mockMetaUpstream('{"verifiable_password_authentication":true}');

    const res = await request(app)
      .get("/meta")
      .set("Authorization", `Bearer ${PAIR.proxyToken}`);

    expect(res.status).toBe(200);
    expect(res.body.installed_version).toBe("3.30.0");
  });

  it("returns installed_version via the Enterprise-shaped /api/v3/meta path", async () => {
    const app = createApp([PAIR]);
    mockMetaUpstream('{"verifiable_password_authentication":true}');

    const res = await request(app)
      .get("/api/v3/meta")
      .set("Authorization", `Bearer ${PAIR.proxyToken}`);

    expect(res.status).toBe(200);
    expect(res.body.installed_version).toBe("3.30.0");
  });
});
