import crypto from "crypto";

// Guards against pathological/cyclic depth when recursively walking a parsed JSON body.
export const MAX_JSON_WALK_DEPTH = 50;

function sortJsonKeys(val: unknown, depth = 0): unknown {
  if (depth > MAX_JSON_WALK_DEPTH) return val;
  if (val === null || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map((v) => sortJsonKeys(v, depth + 1));
  const obj = val as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    result[k] = sortJsonKeys(obj[k], depth + 1);
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
  return serializeBody(body).hash;
}

export function serializeBody(body: unknown): { hash: string; json: string | undefined } {
  let data: Buffer;
  let json: string | undefined;
  if (body === undefined || body === null) {
    data = Buffer.alloc(0);
  } else if (Buffer.isBuffer(body)) {
    data = body;
  } else if (typeof body === "string") {
    data = Buffer.from(body, "utf8");
  } else {
    json = JSON.stringify(sortJsonKeys(body));
    data = Buffer.from(json, "utf8");
  }
  return { hash: crypto.createHash("sha256").update(data).digest("hex"), json };
}

export function buildCacheKey(method: string, url: string, bodyHash: string, callerId: string, proxyOrigin: string): string {
  return `${method}\0${url}\0${bodyHash}\0${callerId}\0${proxyOrigin}`;
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
