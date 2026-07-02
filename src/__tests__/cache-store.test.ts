import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InMemoryETagStore, InMemoryResponseCache } from "../cache-store.js";
import type { ETagEntry, CachedResponse } from "../cache.js";

const SAMPLE_BODY = Buffer.from('{"data":"value"}');
const SAMPLE_HEADERS: Record<string, string> = { "content-type": "application/json" };
const SAMPLE_STATUS = 200;

const SAMPLE_RESPONSE: CachedResponse = {
  statusCode: SAMPLE_STATUS,
  headers: SAMPLE_HEADERS,
  body: SAMPLE_BODY,
};

const SAMPLE_ETAG_ENTRY: ETagEntry = {
  ...SAMPLE_RESPONSE,
  etag: '"abc123"',
};

// ── InMemoryETagStore ─────────────────────────────────────────────────────────

describe("InMemoryETagStore", () => {
  it("returns undefined for an unknown key", () => {
    const store = new InMemoryETagStore();
    expect(store.get("missing")).toBeUndefined();
  });

  it("returns the entry after setting it", () => {
    const store = new InMemoryETagStore();
    store.set("key1", SAMPLE_ETAG_ENTRY);
    expect(store.get("key1")).toStrictEqual(SAMPLE_ETAG_ENTRY);
  });

  it("overwrites an existing entry", () => {
    const store = new InMemoryETagStore();
    store.set("key1", SAMPLE_ETAG_ENTRY);
    const updated: ETagEntry = { ...SAMPLE_ETAG_ENTRY, etag: '"new-etag"' };
    store.set("key1", updated);
    expect(store.get("key1")?.etag).toBe('"new-etag"');
  });

  it("isolates entries by key", () => {
    const store = new InMemoryETagStore();
    const entry1: ETagEntry = { ...SAMPLE_ETAG_ENTRY, etag: '"etag-1"' };
    const entry2: ETagEntry = { ...SAMPLE_ETAG_ENTRY, etag: '"etag-2"' };
    store.set("key1", entry1);
    store.set("key2", entry2);
    expect(store.get("key1")?.etag).toBe('"etag-1"');
    expect(store.get("key2")?.etag).toBe('"etag-2"');
  });

  it("stores body, headers, and statusCode alongside etag", () => {
    const store = new InMemoryETagStore();
    store.set("k", SAMPLE_ETAG_ENTRY);
    const result = store.get("k");
    expect(result?.body).toStrictEqual(SAMPLE_BODY);
    expect(result?.headers).toStrictEqual(SAMPLE_HEADERS);
    expect(result?.statusCode).toBe(SAMPLE_STATUS);
  });
});

// ── InMemoryResponseCache ─────────────────────────────────────────────────────

describe("InMemoryResponseCache", () => {
  it("returns undefined for an unknown key", () => {
    const cache = new InMemoryResponseCache();
    expect(cache.get("missing")).toBeUndefined();
  });

  it("returns the response immediately after setting it (within TTL)", () => {
    const cache = new InMemoryResponseCache(60_000);
    cache.set("k", SAMPLE_RESPONSE);
    expect(cache.get("k")).toStrictEqual(SAMPLE_RESPONSE);
  });

  it("returns undefined after the TTL has expired", () => {
    vi.useFakeTimers();
    try {
      const cache = new InMemoryResponseCache(1_000);
      cache.set("k", SAMPLE_RESPONSE);
      vi.advanceTimersByTime(1_001);
      expect(cache.get("k")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the response before the TTL has expired", () => {
    vi.useFakeTimers();
    try {
      const cache = new InMemoryResponseCache(1_000);
      cache.set("k", SAMPLE_RESPONSE);
      vi.advanceTimersByTime(999);
      expect(cache.get("k")).toStrictEqual(SAMPLE_RESPONSE);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a default TTL of 60 seconds when not specified", () => {
    vi.useFakeTimers();
    try {
      const cache = new InMemoryResponseCache();
      cache.set("k", SAMPLE_RESPONSE);
      vi.advanceTimersByTime(59_999);
      expect(cache.get("k")).toStrictEqual(SAMPLE_RESPONSE);
      vi.advanceTimersByTime(2);
      expect(cache.get("k")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("overwrites a cached response on repeated set", () => {
    const cache = new InMemoryResponseCache(60_000);
    cache.set("k", SAMPLE_RESPONSE);
    const updated: CachedResponse = { ...SAMPLE_RESPONSE, statusCode: 201 };
    cache.set("k", updated);
    expect(cache.get("k")?.statusCode).toBe(201);
  });

  it("isolates entries by key (caller isolation)", () => {
    const cache = new InMemoryResponseCache(60_000);
    const r1: CachedResponse = { ...SAMPLE_RESPONSE, statusCode: 200 };
    const r2: CachedResponse = { ...SAMPLE_RESPONSE, statusCode: 201 };
    cache.set("caller-a|/repos/x/issues|hash", r1);
    cache.set("caller-b|/repos/x/issues|hash", r2);
    expect(cache.get("caller-a|/repos/x/issues|hash")?.statusCode).toBe(200);
    expect(cache.get("caller-b|/repos/x/issues|hash")?.statusCode).toBe(201);
  });
});
