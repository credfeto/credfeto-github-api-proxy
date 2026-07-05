import type { IETagStore, IResponseCache, CachedResponse, ETagEntry } from "./cache.js";

export class InMemoryETagStore implements IETagStore {
  private readonly store = new Map<string, { entry: ETagEntry; expiresAt: number }>();

  constructor(private readonly ttlMs: number = 86_400_000) {
    setInterval(() => {
      const now = Date.now();
      for (const [key, record] of this.store) {
        if (now > record.expiresAt) this.store.delete(key);
      }
    }, ttlMs).unref();
  }

  get(key: string): ETagEntry | undefined {
    const record = this.store.get(key);
    if (record === undefined) return undefined;
    if (Date.now() > record.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return record.entry;
  }

  set(key: string, entry: ETagEntry): void {
    this.store.set(key, { entry, expiresAt: Date.now() + this.ttlMs });
  }
}

export class InMemoryResponseCache implements IResponseCache {
  private readonly store = new Map<string, { response: CachedResponse; expiresAt: number }>();

  constructor(private readonly ttlMs: number = 60_000) {
    setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.store) {
        if (now > entry.expiresAt) this.store.delete(key);
      }
    }, ttlMs).unref();
  }

  get(key: string): CachedResponse | undefined {
    const entry = this.store.get(key);
    if (entry === undefined) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.response;
  }

  set(key: string, response: CachedResponse): void {
    this.store.set(key, { response, expiresAt: Date.now() + this.ttlMs });
  }
}
