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
import { injectInstalledVersion } from "./meta.js";

const GITHUB_API_HOST = "api.github.com";
const GITHUB_UPLOADS_HOST = "uploads.github.com";

const REDACTED = "[REDACTED]";
const MAX_DIAGNOSTIC_BODY_BYTES = 64 * 1024;

function redactAuthorization(headers: http.OutgoingHttpHeaders): http.OutgoingHttpHeaders {
  const redacted: http.OutgoingHttpHeaders = { ...headers };
  if (redacted.authorization !== undefined) redacted.authorization = REDACTED;
  return redacted;
}

/**
 * Logs full request/response detail when GitHub responds to a POST with a 5xx
 * status, so a recurrence of issue #53 (createPullRequest failing with an
 * opaque upstream 500) leaves enough evidence to find the real cause.
 */
function logUpstream5xx(details: {
  method: string;
  path: string;
  requestHeaders: http.OutgoingHttpHeaders;
  requestBody: string | undefined;
  statusCode: number;
  responseHeaders: http.IncomingHttpHeaders;
  responseBody: Buffer;
}): void {
  console.error(
    "Proxy upstream 5xx error on POST request:",
    JSON.stringify({
      request: {
        method: details.method,
        path: details.path,
        headers: redactAuthorization(details.requestHeaders),
        body: details.requestBody,
      },
      response: {
        statusCode: details.statusCode,
        headers: details.responseHeaders,
        body: details.responseBody.toString("utf8"),
      },
    }),
  );
}

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

  let targetUrl: URL;
  try {
    targetUrl = new URL(`https://${targetHost}${req.url}`);
  } catch {
    res.status(400).json({ message: "Bad request: invalid URL path" });
    return;
  }
  const callerId: string = typeof res.locals.callerId === "string" ? res.locals.callerId : "";

  // gh CLI feature-detects against GET /meta's installed_version field (see meta.ts);
  // real api.github.com/meta never sets it, so the proxy synthesizes one on the way out.
  const isMetaRequest = req.method === "GET" && req.path === "/meta";

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

  // Determine body disposition before building headers so we can strip conflicting transfer fields.
  // express.json() parses application/json and sets req.body to the parsed object.
  // express.raw({ type:"*/*" }) buffers everything else into req.body as a Buffer.
  // Both consume the underlying stream, so piping req would send an empty body.
  const isJsonBody = Boolean(req.is("application/json")) && req.body !== undefined && !Buffer.isBuffer(req.body);
  const isBufferBody = !isJsonBody && Buffer.isBuffer(req.body) && (req.body as Buffer).length > 0;
  const outgoingBodyForLog: string | undefined = isJsonBody
    ? (preSerialisedBody ?? JSON.stringify(req.body))
    : isBufferBody
      ? `<buffer: ${(req.body as Buffer).length} bytes>`
      : undefined;

  const headers: http.OutgoingHttpHeaders = {
    ...req.headers,
    host: targetHost,
    "user-agent": req.headers["user-agent"] ?? "github-api-proxy/1.0",
    "if-none-match": undefined,
    "x-forwarded-for": undefined,
    "x-forwarded-host": undefined,
    "x-forwarded-proto": undefined,
    // When we re-serialise the body, remove transfer-encoding (RFC 7230 §3.3.2 forbids
    // combining it with content-length) and the stale content-length from the original
    // request (we will set the correct value after serialisation).
    ...(isJsonBody || isBufferBody ? { "transfer-encoding": undefined, "content-length": undefined } : {}),
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

    if (((cacheKey !== undefined && responseCache !== undefined) || isMetaRequest) && isJsonResponse) {
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
        const rawBody = Buffer.concat(chunks);
        const body = isMetaRequest ? injectInstalledVersion(rawBody) : rawBody;
        const statusCode = proxyRes.statusCode ?? 200;
        const etag = typeof proxyRes.headers.etag === "string" ? proxyRes.headers.etag : undefined;
        const responseHeaders: Record<string, string | string[] | undefined> = {
          ...(proxyRes.headers as Record<string, string | string[] | undefined>),
        };
        delete responseHeaders["transfer-encoding"];
        if (cacheKey !== undefined && responseCache !== undefined && statusCode >= 200 && statusCode < 300) {
          const cachedResponse: CachedResponse = {
            statusCode,
            headers: responseHeaders,
            body,
          };
          responseCache.store(cacheKey, cachedResponse, etag);
        }
        if (req.method === "POST" && statusCode >= 500) {
          logUpstream5xx({
            method: req.method,
            path: options.path ?? "",
            requestHeaders: headers,
            requestBody: outgoingBodyForLog,
            statusCode,
            responseHeaders: proxyRes.headers,
            responseBody: rawBody,
          });
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

    // Tee a bounded copy of the body for diagnostics when GitHub returns a 5xx
    // for a POST; the client still gets the full, untouched piped response.
    if (req.method === "POST" && (proxyRes.statusCode ?? 0) >= 500) {
      const diagnosticChunks: Buffer[] = [];
      let diagnosticBuffered = 0;
      proxyRes.on("data", (chunk: Buffer) => {
        if (diagnosticBuffered >= MAX_DIAGNOSTIC_BODY_BYTES) return;
        diagnosticChunks.push(chunk);
        diagnosticBuffered += chunk.length;
      });
      proxyRes.on("end", () => {
        logUpstream5xx({
          method: req.method,
          path: options.path ?? "",
          requestHeaders: headers,
          requestBody: outgoingBodyForLog,
          statusCode: proxyRes.statusCode ?? 0,
          responseHeaders: proxyRes.headers,
          responseBody: Buffer.concat(diagnosticChunks),
        });
      });
    }

    res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on("error", (err) => {
    console.error("Proxy upstream error:", err.message);
    if (!res.headersSent) {
      res.status(502).json({ message: "Bad gateway" });
    }
  });

  // Write or pipe the request body.
  // isJsonBody / isBufferBody were determined above; both paths write a known-length body
  // directly so the correct content-length can be set (transfer-encoding was stripped from
  // the outgoing headers above).  Only truly unmodified streams fall through to pipe.
  if (isJsonBody) {
    const serialised = preSerialisedBody ?? JSON.stringify(req.body);
    proxyReq.setHeader("content-length", Buffer.byteLength(serialised));
    proxyReq.write(serialised);
    proxyReq.end();
  } else if (isBufferBody) {
    const buf = req.body as Buffer;
    proxyReq.setHeader("content-length", buf.length);
    proxyReq.write(buf);
    proxyReq.end();
  } else {
    req.pipe(proxyReq, { end: true });
  }
}
