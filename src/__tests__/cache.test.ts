import { describe, it, expect, vi } from "vitest";
import { isCacheable, hashBody, buildCacheKey, ResponseCache } from "../cache.js";
import type { IETagStore, IResponseCache, CachedResponse, ETagEntry } from "../cache.js";

// ── isCacheable ───────────────────────────────────────────────────────────────

describe("isCacheable", () => {
  it.each([
    { method: "GET", url: "/repos/alice/myrepo/issues", body: undefined, expected: true, label: "GET REST" },
    { method: "GET", url: "/repos/alice/myrepo/actions/runs?per_page=10", body: undefined, expected: true, label: "GET with query string" },
    { method: "POST", url: "/graphql", body: { query: "query { viewer { login } }" }, expected: true, label: "POST /graphql query" },
    { method: "POST", url: "/graphql", body: { query: "query ListIssues { repository { issues { nodes { number } } } }" }, expected: true, label: "POST /graphql named query" },
    { method: "POST", url: "/graphql", body: { query: "  query { viewer { login } }" }, expected: true, label: "POST /graphql query with leading whitespace" },
    { method: "POST", url: "/graphql?foo=bar", body: { query: "query { viewer { login } }" }, expected: true, label: "POST /graphql with query string (full URL is cache key)" },
  ])("$label is cacheable", ({ method, url, body, expected }) => {
    expect(isCacheable(method, url, body)).toBe(expected);
  });

  it.each([
    { method: "POST", url: "/graphql", body: { query: "mutation { createIssue(input:{}) { issue { number } } }" }, label: "POST /graphql mutation" },
    { method: "POST", url: "/graphql", body: { query: "  mutation CreateIssue { createIssue(input:{}) { issue { number } } }" }, label: "POST /graphql mutation with leading whitespace" },
    { method: "POST", url: "/repos/alice/myrepo/issues", body: { title: "bug" }, label: "POST to REST endpoint" },
    { method: "PATCH", url: "/repos/alice/myrepo/issues/1", body: { state: "closed" }, label: "PATCH" },
    { method: "DELETE", url: "/repos/alice/myrepo/issues/1", body: undefined, label: "DELETE" },
    { method: "PUT", url: "/repos/alice/myrepo/issues/1", body: undefined, label: "PUT" },
    { method: "POST", url: "/graphql", body: null, label: "POST /graphql null body" },
    { method: "POST", url: "/graphql", body: "raw-string", label: "POST /graphql non-object body" },
    { method: "POST", url: "/graphql", body: { noQuery: true }, label: "POST /graphql body missing query field" },
    { method: "POST", url: "/graphql", body: { query: 42 }, label: "POST /graphql non-string query field" },
  ])("$label is not cacheable", ({ method, url, body }) => {
    expect(isCacheable(method, url, body)).toBe(false);
  });
});

// ── hashBody ──────────────────────────────────────────────────────────────────

describe("hashBody", () => {
  it("returns a 64-char hex string", () => {
    expect(hashBody(undefined)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("null and undefined produce the same hash (both treated as empty)", () => {
    expect(hashBody(null)).toBe(hashBody(undefined));
  });

  it("produces consistent output for the same input", () => {
    const body = { query: "query { viewer { login } }" };
    expect(hashBody(body)).toBe(hashBody(body));
  });

  it("produces different hashes for different inputs", () => {
    expect(hashBody({ a: 1 })).not.toBe(hashBody({ a: 2 }));
  });

  it("handles Buffer input", () => {
    const buf = Buffer.from("hello");
    const hash = hashBody(buf);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(hashBody(undefined));
  });

  it("handles string input", () => {
    const hash = hashBody("hello");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("Buffer and string of same content produce the same hash", () => {
    expect(hashBody("hello")).toBe(hashBody(Buffer.from("hello", "utf8")));
  });
});

// ── buildCacheKey ─────────────────────────────────────────────────────────────

describe("buildCacheKey", () => {
  it("produces a stable key for the same inputs", () => {
    const key = buildCacheKey("GET", "/repos/alice/myrepo/issues", "abc123", "caller-1");
    expect(buildCacheKey("GET", "/repos/alice/myrepo/issues", "abc123", "caller-1")).toBe(key);
  });

  it("different callers produce different keys", () => {
    const a = buildCacheKey("GET", "/repos/alice/myrepo/issues", "abc", "caller-1");
    const b = buildCacheKey("GET", "/repos/alice/myrepo/issues", "abc", "caller-2");
    expect(a).not.toBe(b);
  });

  it("different methods produce different keys", () => {
    const a = buildCacheKey("GET", "/graphql", "abc", "caller");
    const b = buildCacheKey("POST", "/graphql", "abc", "caller");
    expect(a).not.toBe(b);
  });

  it("different URLs produce different keys", () => {
    const a = buildCacheKey("GET", "/repos/alice/myrepo/issues", "abc", "caller");
    const b = buildCacheKey("GET", "/repos/alice/myrepo/pulls", "abc", "caller");
    expect(a).not.toBe(b);
  });

  it("different body hashes produce different keys", () => {
    const a = buildCacheKey("POST", "/graphql", "hash-a", "caller");
    const b = buildCacheKey("POST", "/graphql", "hash-b", "caller");
    expect(a).not.toBe(b);
  });

  it("includes all four components so partial matches do not collide", () => {
    // Ensure 'method+url' from one entry can't alias 'method'+url' from another.
    const a = buildCacheKey("GET\0/x", "", "", "");
    const b = buildCacheKey("GET", "/x", "", "");
    expect(a).not.toBe(b);
  });
});

// ── ResponseCache ─────────────────────────────────────────────────────────────

const BODY = Buffer.from('{"ok":true}');
const RESPONSE: CachedResponse = {
  statusCode: 200,
  headers: { "content-type": "application/json" },
  body: BODY,
};

function makeStores(): { etagStore: IETagStore; responseCache: IResponseCache } {
  const etagMap = new Map<string, ETagEntry>();
  const responseMap = new Map<string, CachedResponse>();
  return {
    etagStore: {
      get: (k) => etagMap.get(k),
      set: (k, v) => { etagMap.set(k, v); },
    },
    responseCache: {
      get: (k) => responseMap.get(k),
      set: (k, v) => { responseMap.set(k, v); },
    },
  };
}

describe("ResponseCache", () => {
  it("getCachedResponse returns undefined on miss", () => {
    const { etagStore, responseCache } = makeStores();
    const cache = new ResponseCache(etagStore, responseCache);
    expect(cache.getCachedResponse("missing")).toBeUndefined();
  });

  it("getCachedResponse returns the response after store()", () => {
    const { etagStore, responseCache } = makeStores();
    const cache = new ResponseCache(etagStore, responseCache);
    cache.store("k", RESPONSE, '"etag"');
    expect(cache.getCachedResponse("k")).toStrictEqual(RESPONSE);
  });

  it("getETagEntry returns undefined on miss", () => {
    const { etagStore, responseCache } = makeStores();
    const cache = new ResponseCache(etagStore, responseCache);
    expect(cache.getETagEntry("missing")).toBeUndefined();
  });

  it("getETagEntry returns the entry with etag after store() with etag", () => {
    const { etagStore, responseCache } = makeStores();
    const cache = new ResponseCache(etagStore, responseCache);
    cache.store("k", RESPONSE, '"abc123"');
    const entry = cache.getETagEntry("k");
    expect(entry?.etag).toBe('"abc123"');
    expect(entry?.body).toStrictEqual(BODY);
  });

  it("store() without etag does not persist an etag entry", () => {
    const { etagStore, responseCache } = makeStores();
    const cache = new ResponseCache(etagStore, responseCache);
    cache.store("k", RESPONSE);
    expect(cache.getETagEntry("k")).toBeUndefined();
    expect(cache.getCachedResponse("k")).toStrictEqual(RESPONSE);
  });

  it("etag entry includes all response fields", () => {
    const { etagStore, responseCache } = makeStores();
    const cache = new ResponseCache(etagStore, responseCache);
    cache.store("k", RESPONSE, '"etag-value"');
    const entry = cache.getETagEntry("k");
    expect(entry?.statusCode).toBe(200);
    expect(entry?.headers).toStrictEqual({ "content-type": "application/json" });
    expect(entry?.body).toStrictEqual(BODY);
    expect(entry?.etag).toBe('"etag-value"');
  });

  it("delegates getETagEntry to the etagStore", () => {
    const etagGetSpy = vi.fn().mockReturnValue(undefined);
    const etagSetSpy = vi.fn();
    const responseGetSpy = vi.fn().mockReturnValue(undefined);
    const responseSetSpy = vi.fn();
    const cache = new ResponseCache(
      { get: etagGetSpy, set: etagSetSpy },
      { get: responseGetSpy, set: responseSetSpy },
    );
    cache.getETagEntry("key");
    expect(etagGetSpy).toHaveBeenCalledWith("key");
  });

  it("delegates getCachedResponse to the responseCache", () => {
    const etagGetSpy = vi.fn().mockReturnValue(undefined);
    const responseGetSpy = vi.fn().mockReturnValue(undefined);
    const cache = new ResponseCache(
      { get: etagGetSpy, set: vi.fn() },
      { get: responseGetSpy, set: vi.fn() },
    );
    cache.getCachedResponse("key");
    expect(responseGetSpy).toHaveBeenCalledWith("key");
  });
});
