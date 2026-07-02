import type { IETagStore, IResponseCache, CachedResponse, ETagEntry } from "./cache.js";

export class InMemoryETagStore implements IETagStore {
  private readonly store = new Map<string, ETagEntry>();

  get(key: string): ETagEntry | undefined {
    return this.store.get(key);
  }

  set(key: string, entry: ETagEntry): void {
    this.store.set(key, entry);
  }
}

export class InMemoryResponseCache implements IResponseCache {
  private readonly store = new Map<string, { response: CachedResponse; expiresAt: number }>();

  constructor(private readonly ttlMs: number = 60_000) {}

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
