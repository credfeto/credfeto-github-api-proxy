import { describe, it, expect, vi, afterEach } from "vitest";
import type { Request, Response } from "express";
import type { IncomingMessage, ClientRequest } from "http";
import { EventEmitter } from "events";
import https from "https";
import { forwardToGitHub } from "../proxy.js";
import type { ResponseCache, CachedResponse, ETagEntry } from "../cache.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeRequest(opts: {
  method?: string;
  url?: string;
  path?: string;
  body?: unknown;
  isJson?: boolean;
  extraHeaders?: Record<string, string>;
}): Request {
  const method = opts.method ?? "GET";
  const url = opts.url ?? "/repos/alice/myrepo/issues";
  return {
    method,
    url,
    path: opts.path ?? url.split("?")[0],
    headers: { "user-agent": "test-agent/1.0", authorization: "token ghp_real", ...opts.extraHeaders },
    body: opts.body,
    is: (type: string) => (opts.isJson && type === "application/json" && opts.body !== undefined ? type : false),
    pipe: vi.fn(),
  } as unknown as Request;
}

type FakeResponse = Response & {
  _statusCode: number;
  _body: Buffer | undefined;
  locals: Record<string, unknown>;
};

function makeResponse(callerId = "test-caller"): FakeResponse {
  const res = {
    _statusCode: 0,
    _body: undefined as Buffer | undefined,
    headersSent: false,
    locals: { callerId } as Record<string, unknown>,
    writeHead: vi.fn((code: number) => { res._statusCode = code; res.headersSent = true; }),
    end: vi.fn((data?: Buffer | string) => {
      res._body = Buffer.isBuffer(data) ? data : data !== undefined ? Buffer.from(data as string) : Buffer.alloc(0);
    }),
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
  return res as unknown as FakeResponse;
}

/** Returns a promise that resolves the next time res.end is called. */
function awaitEnd(res: FakeResponse): Promise<void> {
  return new Promise<void>((resolve) => {
    (res.end as ReturnType<typeof vi.fn>).mockImplementationOnce((data?: Buffer | string) => {
      res._body = Buffer.isBuffer(data) ? data : data !== undefined ? Buffer.from(data as string) : Buffer.alloc(0);
      resolve();
    });
  });
}

type UpstreamSetup = { statusCode?: number; headers?: Record<string, string>; body?: string };

/**
 * Installs a one-shot spy on https.request. The fake response fires via
 * process.nextTick so the proxy has time to set up listeners or call pipe first.
 * Returns the request options that were passed to https.request.
 */
function mockUpstream(setup: UpstreamSetup = {}): { getOptions: () => https.RequestOptions | null } {
  let captured: https.RequestOptions | null = null;

  vi.spyOn(https, "request").mockImplementationOnce((options, callback) => {
    captured = options as https.RequestOptions;

    const fakeRes = Object.assign(new EventEmitter(), {
      statusCode: setup.statusCode ?? 200,
      headers: { "content-type": "application/json", ...setup.headers },
      // For non-buffered (pipe) path: call dest.end so the response completes
      pipe: vi.fn((dest: { end: (d?: Buffer) => void }) => {
        process.nextTick(() => {
          dest.end(setup.body !== undefined ? Buffer.from(setup.body) : undefined);
        });
      }),
    }) as unknown as IncomingMessage;

    const fakeReq = Object.assign(new EventEmitter(), {
      setHeader: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    }) as unknown as ClientRequest;

    // Fire the upstream response asynchronously
    process.nextTick(() => {
      if (callback) {
        callback(fakeRes);
        // Emit data/end after the proxy registers its listeners
        process.nextTick(() => {
          if (setup.body !== undefined) fakeRes.emit("data", Buffer.from(setup.body));
          fakeRes.emit("end");
        });
      }
    });

    return fakeReq;
  });

  return { getOptions: () => captured };
}

/** Build a mock ResponseCache from partial overrides. */
function makeCache(overrides: Partial<{
  getCachedResponse: (key: string) => CachedResponse | undefined;
  getETagEntry: (key: string) => ETagEntry | undefined;
  store: (key: string, response: CachedResponse, etag?: string) => void;
}> = {}): ResponseCache {
  return {
    getCachedResponse: vi.fn().mockReturnValue(undefined),
    getETagEntry: vi.fn().mockReturnValue(undefined),
    store: vi.fn(),
    ...overrides,
  } as unknown as ResponseCache;
}

// ── Tests: no-cache passthrough ───────────────────────────────────────────────

describe("forwardToGitHub — no ResponseCache", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("pipes the upstream response to the client when no cache is provided", async () => {
    const req = makeRequest({});
    const res = makeResponse();
    const upstream = mockUpstream({ statusCode: 200, body: '{"ok":true}' });
    const done = awaitEnd(res);
    forwardToGitHub(req, res as unknown as Response);
    await done;
    expect(upstream.getOptions()?.hostname).toBe("api.github.com");
    expect(res._statusCode).toBe(200);
  });

  it("targets uploads.github.com for /uploads/* paths", async () => {
    const req = makeRequest({ url: "/uploads/repos/alice/myrepo/releases/1" });
    const res = makeResponse();
    const upstream = mockUpstream({ statusCode: 200, body: "{}" });
    const done = awaitEnd(res);
    forwardToGitHub(req, res as unknown as Response);
    await done;
    expect(upstream.getOptions()?.hostname).toBe("uploads.github.com");
  });


  it("writes JSON body and ends request for application/json", async () => {
    const body = { query: "mutation { x }" };
    const req = makeRequest({ method: "POST", url: "/graphql", body, isJson: true });
    const res = makeResponse();
    const upstream = mockUpstream({ statusCode: 200, body: '{"data":null}' });
    const done = awaitEnd(res);
    forwardToGitHub(req, res as unknown as Response);
    await done;
    const fakeReq = upstream.getOptions();
    expect(fakeReq?.method).toBe("POST");
  });
});

// ── Tests: cache hit ──────────────────────────────────────────────────────────

describe("forwardToGitHub — cache hit", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("serves from cache without calling upstream", () => {
    const cachedBody = Buffer.from('{"cached":true}');
    const cache = makeCache({
      getCachedResponse: vi.fn().mockReturnValue({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: cachedBody,
      }),
    });
    const req = makeRequest({});
    const res = makeResponse();
    const requestSpy = vi.spyOn(https, "request");

    forwardToGitHub(req, res as unknown as Response, cache);

    expect(requestSpy).not.toHaveBeenCalled();
    expect(res._statusCode).toBe(200);
    expect(res._body).toStrictEqual(cachedBody);
  });

  it("serves cached GraphQL query response without calling upstream", () => {
    const cachedBody = Buffer.from('{"data":{"viewer":{"login":"alice"}}}');
    const cache = makeCache({
      getCachedResponse: vi.fn().mockReturnValue({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: cachedBody,
      }),
    });
    const req = makeRequest({ method: "POST", url: "/graphql", body: { query: "query { viewer { login } }" }, isJson: true });
    const res = makeResponse();
    const requestSpy = vi.spyOn(https, "request");

    forwardToGitHub(req, res as unknown as Response, cache);

    expect(requestSpy).not.toHaveBeenCalled();
    expect(res._body?.toString()).toContain("alice");
  });

  it("strips transfer-encoding from cached response headers", () => {
    const cachedBody = Buffer.from("hello");
    const cache = makeCache({
      getCachedResponse: vi.fn().mockReturnValue({
        statusCode: 200,
        headers: { "content-type": "text/plain", "transfer-encoding": "chunked" },
        body: cachedBody,
      }),
    });
    const req = makeRequest({});
    const res = makeResponse();

    forwardToGitHub(req, res as unknown as Response, cache);

    const writeHeadCall = (res.writeHead as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = writeHeadCall?.[1] as Record<string, unknown>;
    expect(headers?.["transfer-encoding"]).toBeUndefined();
    expect(headers?.["content-length"]).toBe(cachedBody.length);
  });
});

// ── Tests: ETag / conditional requests ───────────────────────────────────────

describe("forwardToGitHub — ETag: attaches If-None-Match", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("adds If-None-Match header when an ETag entry exists and cache is stale", () => {
    const etagEntry: ETagEntry = {
      etag: '"etag-v1"',
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from('{"original":true}'),
    };
    const cache = makeCache({
      getCachedResponse: vi.fn().mockReturnValue(undefined),
      getETagEntry: vi.fn().mockReturnValue(etagEntry),
    });
    const req = makeRequest({});
    const res = makeResponse();
    let capturedHeaders: Record<string, unknown> | undefined;
    vi.spyOn(https, "request").mockImplementationOnce((options) => {
      capturedHeaders = (options as https.RequestOptions).headers as Record<string, unknown>;
      return Object.assign(new EventEmitter(), { setHeader: vi.fn(), write: vi.fn(), end: vi.fn() }) as unknown as ClientRequest;
    });

    forwardToGitHub(req, res as unknown as Response, cache);

    expect(capturedHeaders?.["if-none-match"]).toBe('"etag-v1"');
  });

  it("does not add If-None-Match when no ETag entry is stored", () => {
    const cache = makeCache({
      getCachedResponse: vi.fn().mockReturnValue(undefined),
      getETagEntry: vi.fn().mockReturnValue(undefined),
    });
    const req = makeRequest({});
    const res = makeResponse();
    let capturedHeaders: Record<string, unknown> | undefined;
    vi.spyOn(https, "request").mockImplementationOnce((options) => {
      capturedHeaders = (options as https.RequestOptions).headers as Record<string, unknown>;
      return Object.assign(new EventEmitter(), { setHeader: vi.fn(), write: vi.fn(), end: vi.fn() }) as unknown as ClientRequest;
    });

    forwardToGitHub(req, res as unknown as Response, cache);

    expect(capturedHeaders?.["if-none-match"]).toBeUndefined();
  });
});

// ── Tests: 304 replay ─────────────────────────────────────────────────────────

describe("forwardToGitHub — 304 Not Modified replay", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("replays cached body as 200 when upstream returns 304", async () => {
    const originalBody = Buffer.from('{"original":true}');
    const etagEntry: ETagEntry = {
      etag: '"etag-v1"',
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: originalBody,
    };
    const cache = makeCache({
      getCachedResponse: vi.fn().mockReturnValue(undefined),
      getETagEntry: vi.fn().mockReturnValue(etagEntry),
    });
    const req = makeRequest({});
    const res = makeResponse();

    vi.spyOn(https, "request").mockImplementationOnce((_options, callback) => {
      const fakeRes = Object.assign(new EventEmitter(), { statusCode: 304, headers: {}, resume: vi.fn() }) as unknown as IncomingMessage;
      process.nextTick(() => { if (callback) callback(fakeRes); });
      return Object.assign(new EventEmitter(), { setHeader: vi.fn(), write: vi.fn(), end: vi.fn() }) as unknown as ClientRequest;
    });

    const done = awaitEnd(res);
    forwardToGitHub(req, res as unknown as Response, cache);
    await done;

    expect(res._statusCode).toBe(200);
    expect(res._body).toStrictEqual(originalBody);
  });

  it("replays the original status code (not hardcoded 200) when upstream returns 304", async () => {
    const originalBody = Buffer.from('{"accepted":true}');
    const etagEntry: ETagEntry = {
      etag: '"etag-v2"',
      statusCode: 202,
      headers: { "content-type": "application/json" },
      body: originalBody,
    };
    const cache = makeCache({
      getCachedResponse: vi.fn().mockReturnValue(undefined),
      getETagEntry: vi.fn().mockReturnValue(etagEntry),
    });
    const req = makeRequest({});
    const res = makeResponse();

    vi.spyOn(https, "request").mockImplementationOnce((_options, callback) => {
      const fakeRes = Object.assign(new EventEmitter(), { statusCode: 304, headers: {}, resume: vi.fn() }) as unknown as IncomingMessage;
      process.nextTick(() => { if (callback) callback(fakeRes); });
      return Object.assign(new EventEmitter(), { setHeader: vi.fn(), write: vi.fn(), end: vi.fn() }) as unknown as ClientRequest;
    });

    const done = awaitEnd(res);
    forwardToGitHub(req, res as unknown as Response, cache);
    await done;

    expect(res._statusCode).toBe(202);
    expect(res._body).toStrictEqual(originalBody);
  });

  it("strips transfer-encoding when replaying 304", async () => {
    const originalBody = Buffer.from("data");
    const etagEntry: ETagEntry = {
      etag: '"e"',
      statusCode: 200,
      headers: { "content-type": "text/plain", "transfer-encoding": "chunked" },
      body: originalBody,
    };
    const cache = makeCache({
      getCachedResponse: vi.fn().mockReturnValue(undefined),
      getETagEntry: vi.fn().mockReturnValue(etagEntry),
    });
    const req = makeRequest({});
    const res = makeResponse();

    vi.spyOn(https, "request").mockImplementationOnce((_options, callback) => {
      const fakeRes = Object.assign(new EventEmitter(), { statusCode: 304, headers: {}, resume: vi.fn() }) as unknown as IncomingMessage;
      process.nextTick(() => { if (callback) callback(fakeRes); });
      return Object.assign(new EventEmitter(), { setHeader: vi.fn(), write: vi.fn(), end: vi.fn() }) as unknown as ClientRequest;
    });

    const done = awaitEnd(res);
    forwardToGitHub(req, res as unknown as Response, cache);
    await done;

    const writeHeadCall = (res.writeHead as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = writeHeadCall?.[1] as Record<string, unknown>;
    expect(headers?.["transfer-encoding"]).toBeUndefined();
    expect(headers?.["content-length"]).toBe(originalBody.length);
  });
});

// ── Tests: response buffering and storage ─────────────────────────────────────

describe("forwardToGitHub — buffered caching", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("stores GET response in cache after receiving it from upstream", async () => {
    const cache = makeCache();
    const req = makeRequest({});
    const res = makeResponse();
    mockUpstream({ statusCode: 200, headers: { etag: '"new-etag"' }, body: '{"data":1}' });
    const done = awaitEnd(res);
    forwardToGitHub(req, res as unknown as Response, cache);
    await done;

    expect(cache.store as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
    const [, storedResponse, storedEtag] = (cache.store as ReturnType<typeof vi.fn>).mock.calls[0] as [string, CachedResponse, string];
    expect(storedResponse.statusCode).toBe(200);
    expect(storedResponse.body.toString()).toBe('{"data":1}');
    expect(storedEtag).toBe('"new-etag"');
  });

  it("stores GraphQL query response in cache", async () => {
    const cache = makeCache();
    const req = makeRequest({ method: "POST", url: "/graphql", body: { query: "query { viewer { login } }" }, isJson: true });
    const res = makeResponse();
    mockUpstream({ statusCode: 200, body: '{"data":{"viewer":{"login":"alice"}}}' });
    const done = awaitEnd(res);
    forwardToGitHub(req, res as unknown as Response, cache);
    await done;

    expect(cache.store as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
  });

  it("does not store ETag when upstream response has no ETag header", async () => {
    const cache = makeCache();
    const req = makeRequest({});
    const res = makeResponse();
    mockUpstream({ statusCode: 200, body: '{"data":1}' });
    const done = awaitEnd(res);
    forwardToGitHub(req, res as unknown as Response, cache);
    await done;

    const [, , storedEtag] = (cache.store as ReturnType<typeof vi.fn>).mock.calls[0] as [string, CachedResponse, string | undefined];
    expect(storedEtag).toBeUndefined();
  });

  it("strips transfer-encoding from the stored response headers", async () => {
    const cache = makeCache();
    const req = makeRequest({});
    const res = makeResponse();
    mockUpstream({ statusCode: 200, headers: { "transfer-encoding": "chunked" }, body: "data" });
    const done = awaitEnd(res);
    forwardToGitHub(req, res as unknown as Response, cache);
    await done;

    const [, storedResponse] = (cache.store as ReturnType<typeof vi.fn>).mock.calls[0] as [string, CachedResponse];
    expect(storedResponse.headers["transfer-encoding"]).toBeUndefined();
  });

  it("does NOT buffer or store a GraphQL mutation", async () => {
    const cache = makeCache();
    const req = makeRequest({ method: "POST", url: "/graphql", body: { query: "mutation { x }" }, isJson: true });
    const res = makeResponse();
    mockUpstream({ statusCode: 200, body: '{"data":{"x":null}}' });
    const done = awaitEnd(res);
    forwardToGitHub(req, res as unknown as Response, cache);
    await done;

    expect(cache.store as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("does NOT buffer or store a PATCH request", async () => {
    const cache = makeCache();
    const req = makeRequest({ method: "PATCH", url: "/repos/alice/myrepo/issues/1", body: { state: "closed" }, isJson: true });
    const res = makeResponse();
    mockUpstream({ statusCode: 200, body: '{"state":"closed"}' });
    const done = awaitEnd(res);
    forwardToGitHub(req, res as unknown as Response, cache);
    await done;

    expect(cache.store as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("cache key includes callerId so different callers are isolated", async () => {
    const cache = makeCache();
    const req1 = makeRequest({ url: "/repos/alice/myrepo/issues" });
    const res1 = makeResponse("caller-1");
    const res2 = makeResponse("caller-2");

    mockUpstream({ statusCode: 200, body: '{"x":1}' });
    const done1 = awaitEnd(res1);
    forwardToGitHub(req1, res1 as unknown as Response, cache);
    await done1;

    mockUpstream({ statusCode: 200, body: '{"x":2}' });
    const done2 = awaitEnd(res2);
    forwardToGitHub(req1, res2 as unknown as Response, cache);
    await done2;

    const calls = (cache.store as ReturnType<typeof vi.fn>).mock.calls as [string, CachedResponse][];
    expect(calls).toHaveLength(2);
    // The two cache keys must be different
    expect(calls[0][0]).not.toBe(calls[1][0]);
  });
});

// ── Tests: callerId fallback ───────────────────────────────────────────────────

describe("forwardToGitHub — callerId fallback", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("falls back to empty string callerId when res.locals.callerId is absent", async () => {
    const cache = makeCache();
    const req = makeRequest({});
    const res = makeResponse();
    res.locals = {};  // no callerId

    mockUpstream({ statusCode: 200, body: '{"ok":true}' });
    const done = awaitEnd(res);
    forwardToGitHub(req, res as unknown as Response, cache);
    await done;

    expect(res._statusCode).toBe(200);
    expect(cache.store as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
  });
});

// ── Tests: Transfer-Encoding stripping (issue #44) ────────────────────────────

describe("forwardToGitHub — Transfer-Encoding / Buffer-body (issue #44)", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("strips transfer-encoding from outgoing headers when re-serialising a JSON body", async () => {
    const body = { title: "my PR", labels: ["AI-Work"] };
    const req = makeRequest({
      method: "PATCH",
      url: "/repos/alice/myrepo/pulls/1",
      body,
      isJson: true,
      extraHeaders: { "transfer-encoding": "chunked" },
    });
    const res = makeResponse();
    let capturedHeaders: Record<string, unknown> | undefined;

    vi.spyOn(https, "request").mockImplementationOnce((options, callback) => {
      capturedHeaders = (options as https.RequestOptions).headers as Record<string, unknown>;
      const fakeRes = Object.assign(new EventEmitter(), {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        pipe: vi.fn((dest: { end: (d?: Buffer) => void }) => { process.nextTick(() => { dest.end(Buffer.from("{}")); }); }),
      }) as unknown as IncomingMessage;
      const fakeReq = Object.assign(new EventEmitter(), { setHeader: vi.fn(), write: vi.fn(), end: vi.fn() }) as unknown as ClientRequest;
      process.nextTick(() => { if (callback) { callback(fakeRes); process.nextTick(() => { fakeRes.emit("end"); }); } });
      return fakeReq;
    });

    const done = awaitEnd(res);
    forwardToGitHub(req, res as unknown as Response);
    await done;

    expect(capturedHeaders?.["transfer-encoding"]).toBeUndefined();
    expect(capturedHeaders?.["authorization"]).toBe("token ghp_real");
  });

  it("does not add transfer-encoding to outgoing headers for a JSON body without it", async () => {
    const body = { state: "closed" };
    const req = makeRequest({ method: "PATCH", url: "/repos/alice/myrepo/issues/1", body, isJson: true });
    const res = makeResponse();
    let capturedHeaders: Record<string, unknown> | undefined;

    vi.spyOn(https, "request").mockImplementationOnce((options, callback) => {
      capturedHeaders = (options as https.RequestOptions).headers as Record<string, unknown>;
      const fakeRes = Object.assign(new EventEmitter(), {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        pipe: vi.fn((dest: { end: (d?: Buffer) => void }) => { process.nextTick(() => { dest.end(Buffer.from("{}")); }); }),
      }) as unknown as IncomingMessage;
      const fakeReq = Object.assign(new EventEmitter(), { setHeader: vi.fn(), write: vi.fn(), end: vi.fn() }) as unknown as ClientRequest;
      process.nextTick(() => { if (callback) { callback(fakeRes); process.nextTick(() => { fakeRes.emit("end"); }); } });
      return fakeReq;
    });

    const done = awaitEnd(res);
    forwardToGitHub(req, res as unknown as Response);
    await done;

    expect(capturedHeaders?.["transfer-encoding"]).toBeUndefined();
  });

  it("writes a Buffer body directly and strips transfer-encoding when express.raw() consumed the stream", async () => {
    const rawBody = Buffer.from("raw-upload-data");
    const req = makeRequest({
      method: "POST",
      url: "/repos/alice/myrepo/releases/1/assets",
      body: rawBody,
      isJson: false,
      extraHeaders: { "transfer-encoding": "chunked" },
    });
    const res = makeResponse();
    let capturedHeaders: Record<string, unknown> | undefined;
    let writeArg: Buffer | undefined;
    let endCalled = false;

    vi.spyOn(https, "request").mockImplementationOnce((options, callback) => {
      capturedHeaders = (options as https.RequestOptions).headers as Record<string, unknown>;
      const fakeRes = Object.assign(new EventEmitter(), {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        pipe: vi.fn((dest: { end: (d?: Buffer) => void }) => { process.nextTick(() => { dest.end(Buffer.from("{}")); }); }),
      }) as unknown as IncomingMessage;
      const fakeReq = Object.assign(new EventEmitter(), {
        setHeader: vi.fn(),
        write: vi.fn((data: Buffer) => { writeArg = data; }),
        end: vi.fn(() => { endCalled = true; }),
      }) as unknown as ClientRequest;
      process.nextTick(() => { if (callback) { callback(fakeRes); process.nextTick(() => { fakeRes.emit("end"); }); } });
      return fakeReq;
    });

    const done = awaitEnd(res);
    forwardToGitHub(req, res as unknown as Response);
    await done;

    expect(capturedHeaders?.["transfer-encoding"]).toBeUndefined();
    expect(writeArg).toStrictEqual(rawBody);
    expect(endCalled).toBe(true);
    expect((req.pipe as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("falls through to pipe when req.body is an empty Buffer (no-body GET)", async () => {
    const req = makeRequest({ method: "GET", url: "/repos/alice/myrepo/issues", body: Buffer.alloc(0) });
    const res = makeResponse();
    const upstream = mockUpstream({ statusCode: 200, body: '{"items":[]}' });
    const done = awaitEnd(res);
    forwardToGitHub(req, res as unknown as Response);
    await done;

    expect((req.pipe as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect(upstream.getOptions()?.hostname).toBe("api.github.com");
  });
});
