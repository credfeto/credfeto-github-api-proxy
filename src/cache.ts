import crypto from "crypto";

function sortJsonKeys(val: unknown): unknown {
  if (val === null || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map(sortJsonKeys);
  const obj = val as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    result[k] = sortJsonKeys(obj[k]);
  }
  return result;
}

export interface CachedResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface ETagEntry extends CachedResponse {
  etag: string;
}

export interface IETagStore {
  get(key: string): ETagEntry | undefined;
  set(key: string, entry: ETagEntry): void;
}

export interface IResponseCache {
  get(key: string): CachedResponse | undefined;
  set(key: string, response: CachedResponse): void;
}

export function hashBody(body: unknown): string {
  let data: Buffer;
  if (body === undefined || body === null) {
    data = Buffer.alloc(0);
  } else if (Buffer.isBuffer(body)) {
    data = body;
  } else if (typeof body === "string") {
    data = Buffer.from(body, "utf8");
  } else {
    data = Buffer.from(JSON.stringify(sortJsonKeys(body)), "utf8");
  }
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function buildCacheKey(method: string, url: string, bodyHash: string, callerId: string): string {
  return `${method}\0${url}\0${bodyHash}\0${callerId}`;
}

export function isCacheable(method: string, url: string, body: unknown): boolean {
  if (method === "GET") return true;
  if (method !== "POST") return false;
  const path = url.split("?")[0];
  if (path !== "/graphql") return false;
  if (typeof body !== "object" || body === null) return false;
  const query = (body as { query?: unknown }).query;
  if (typeof query !== "string") return false;
  return !/^\s*(mutation|subscription)\b/i.test(query);
}

export class ResponseCache {
  constructor(
    private readonly etagStore: IETagStore,
    private readonly responseCache: IResponseCache,
  ) {}

  getETagEntry(key: string): ETagEntry | undefined {
    return this.etagStore.get(key);
  }

  getCachedResponse(key: string): CachedResponse | undefined {
    return this.responseCache.get(key);
  }

  store(key: string, response: CachedResponse, etag?: string): void {
    if (etag !== undefined) {
      this.etagStore.set(key, { ...response, etag });
    }
    this.responseCache.set(key, response);
  }
}
