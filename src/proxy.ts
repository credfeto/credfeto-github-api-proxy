import type { Request, Response } from "express";
import https from "https";
import http from "http";
import { URL } from "url";

const GITHUB_API_HOST = "api.github.com";
const GITHUB_UPLOADS_HOST = "uploads.github.com";

/**
 * Forward the incoming request to GitHub and pipe the response back.
 *
 * We do a manual proxy rather than http-proxy-middleware so we can:
 *  1. Modify headers (the auth swap has already happened in middleware)
 *  2. Cleanly handle body parsing for JSON (needed for GraphQL inspection)
 */
export function forwardToGitHub(req: Request, res: Response): void {
  const targetHost =
    req.path.startsWith("/uploads") ? GITHUB_UPLOADS_HOST : GITHUB_API_HOST;

  const targetUrl = new URL(`https://${targetHost}${req.url}`);

  const headers: http.OutgoingHttpHeaders = {
    ...req.headers,
    host: targetHost,
    "user-agent": req.headers["user-agent"] ?? "github-api-proxy/1.0",
    "x-forwarded-for": undefined,
    "x-forwarded-host": undefined,
    "x-forwarded-proto": undefined,
  };

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
    res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on("error", (err) => {
    console.error("Proxy upstream error:", err.message);
    if (!res.headersSent) {
      res.status(502).json({ message: "Bad gateway", detail: err.message });
    }
  });

  // The body has already been parsed by express.json() for /graphql; for all
  // other paths we pipe the raw stream.  We need to reconstruct the body for
  // GraphQL since express consumed it.
  if (req.is("application/json") && req.body !== undefined) {
    const serialised = JSON.stringify(req.body);
    proxyReq.setHeader("content-length", Buffer.byteLength(serialised));
    proxyReq.write(serialised);
    proxyReq.end();
  } else {
    req.pipe(proxyReq, { end: true });
  }
}
