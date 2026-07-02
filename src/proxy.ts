import type { Request, Response } from "express";
import https from "https";
import http from "http";
import { URL } from "url";
import {
  type ResponseCache,
  type CachedResponse,
  isCacheable,
  serializeBody,
  buildCacheKey,
} from "./cache.js";

const GITHUB_API_HOST = "api.github.com";
const GITHUB_UPLOADS_HOST = "uploads.github.com";

/**
 * Forward the incoming request to GitHub and pipe the response back.
 *
 * We do a manual proxy rather than http-proxy-middleware so we can:
 *  1. Modify headers (the auth swap has already happened in middleware)
 *  2. Cleanly handle body parsing for JSON (needed for GraphQL inspection)
 *  3. Intercept responses to implement ETag / short-TTL caching
 */
export function forwardToGitHub(req: Request, res: Response, responseCache?: ResponseCache): void {
  const targetHost =
    req.path.startsWith("/uploads") ? GITHUB_UPLOADS_HOST : GITHUB_API_HOST;

  const targetUrl = new URL(`https://${targetHost}${req.url}`);
  const callerId: string = typeof res.locals.callerId === "string" ? res.locals.callerId : "";

  // ── Caching: check for a live cache hit ─────────────────────────────────
  let cacheKey: string | undefined;
  let preSerialisedBody: string | undefined;

  if (responseCache !== undefined && isCacheable(req.method, req.url, req.body)) {
    const { hash: bodyHash, json } = serializeBody(req.body);
    preSerialisedBody = json;
    cacheKey = buildCacheKey(req.method, req.url, bodyHash, callerId);

    const cached = responseCache.getCachedResponse(cacheKey);
    if (cached !== undefined) {
      const replyHeaders: Record<string, string | string[] | number | undefined> = {
        ...cached.headers,
        "content-length": cached.body.length,
      };
      delete replyHeaders["transfer-encoding"];
      res.writeHead(cached.statusCode, replyHeaders);
      res.end(cached.body);
      return;
    }
  }

  // If we have a stored ETag for this key, send it as If-None-Match so GitHub
  // can return 304 (which does not consume rate-limit quota).
  const etagEntry = cacheKey !== undefined ? responseCache?.getETagEntry(cacheKey) : undefined;

  const headers: http.OutgoingHttpHeaders = {
    ...req.headers,
    host: targetHost,
    "user-agent": req.headers["user-agent"] ?? "github-api-proxy/1.0",
    "if-none-match": undefined,
    "x-forwarded-for": undefined,
    "x-forwarded-host": undefined,
    "x-forwarded-proto": undefined,
  };

  if (etagEntry !== undefined) {
    headers["if-none-match"] = etagEntry.etag;
  }

  // Remove undefined entries
  for (const key of Object.keys(headers)) {
    if (headers[key] === undefined) delete headers[key];
  }

  const options: https.RequestOptions = {
    hostname: targetUrl.hostname,
    path: targetUrl.pathname + targetUrl.search,
    method: req.method,
    headers,
  };

  const proxyReq = https.request(options, (proxyRes) => {
    // ── 304 Not Modified: replay the previously cached body ──────────────
    if (proxyRes.statusCode === 304 && etagEntry !== undefined) {
      const replyHeaders: Record<string, string | string[] | number | undefined> = {
        ...etagEntry.headers,
        ...proxyRes.headers,  // 304 headers (e.g. updated rate-limit) override stale stored values
        "content-length": etagEntry.body.length,
      };
      delete replyHeaders["transfer-encoding"];
      res.writeHead(etagEntry.statusCode, replyHeaders);
      res.end(etagEntry.body);
      proxyRes.on("error", (err: Error) => { console.error("Proxy upstream error (after 304 replay):", err.message); });
      proxyRes.resume();
      return;
    }

    // ── Cacheable response: buffer so we can store it ────────────────────
    // Only buffer JSON responses — binary downloads (release assets, etc.) must
    // be piped to avoid loading arbitrarily large bodies into heap.
    const contentType = typeof proxyRes.headers["content-type"] === "string"
      ? proxyRes.headers["content-type"]
      : "";
    const isJsonResponse = contentType.includes("application/json") || contentType.includes("application/graphql");

    if (cacheKey !== undefined && responseCache !== undefined && isJsonResponse) {
      const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
      let totalBuffered = 0;
      let overflowed = false;
      const chunks: Buffer[] = [];
      proxyRes.on("data", (chunk: Buffer) => {
        if (overflowed) {
          res.write(chunk);
          return;
        }
        totalBuffered += chunk.length;
        if (totalBuffered > MAX_BUFFER_BYTES) {
          // Too large to cache: flush buffered data directly and stop accumulating
          overflowed = true;
          const overflowHeaders = { ...(proxyRes.headers as Record<string, string | string[] | undefined>) };
          delete overflowHeaders["transfer-encoding"];
          res.writeHead(proxyRes.statusCode ?? 502, overflowHeaders);
          for (const c of chunks) res.write(c);
          chunks.length = 0;
          res.write(chunk);
          return;
        }
        chunks.push(chunk);
      });
      proxyRes.on("end", () => {
        if (overflowed) {
          res.end();
          return;
        }
        const body = Buffer.concat(chunks);
        const statusCode = proxyRes.statusCode ?? 200;
        const etag = typeof proxyRes.headers.etag === "string" ? proxyRes.headers.etag : undefined;
        const responseHeaders: Record<string, string | string[] | undefined> = {
          ...(proxyRes.headers as Record<string, string | string[] | undefined>),
        };
        delete responseHeaders["transfer-encoding"];
        const cachedResponse: CachedResponse = {
          statusCode,
          headers: responseHeaders,
          body,
        };
        if (statusCode >= 200 && statusCode < 300) {
          responseCache.store(cacheKey!, cachedResponse, etag);
        }
        res.writeHead(statusCode, { ...responseHeaders, "content-length": body.length });
        res.end(body);
      });
      proxyRes.on("error", (err: Error) => {
        console.error("Proxy upstream error:", err.message);
        if (!res.headersSent) {
          res.status(502).json({ message: "Bad gateway" });
        }
      });
      return;
    }

    // ── Default: pipe through ────────────────────────────────────────────
    proxyRes.on("error", (err: Error) => {
      console.error("Proxy upstream error:", err.message);
      if (!res.headersSent) {
        res.status(502).json({ message: "Bad gateway" });
      }
    });
    res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on("error", (err) => {
    console.error("Proxy upstream error:", err.message);
    if (!res.headersSent) {
      res.status(502).json({ message: "Bad gateway" });
    }
  });

  // The body has already been parsed by express.json() for /graphql; for all
  // other paths we pipe the raw stream.  We need to reconstruct the body for
  // GraphQL since express consumed it.
  if (req.is("application/json") && req.body !== undefined) {
    const serialised = preSerialisedBody ?? JSON.stringify(req.body);
    proxyReq.setHeader("content-length", Buffer.byteLength(serialised));
    proxyReq.write(serialised);
    proxyReq.end();
  } else {
    req.pipe(proxyReq, { end: true });
  }
}
