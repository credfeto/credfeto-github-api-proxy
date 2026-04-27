import express from "express";
import type { Request, Response, NextFunction } from "express";
import { createAuthMiddleware, type AuthConfig } from "./auth.js";
import { checkRestBlock, checkGraphQLBlock } from "./blocklist.js";
import { forwardToGitHub } from "./proxy.js";

export function createApp(authConfig: AuthConfig): express.Application {
  const app = express();

  // ── Normalise Enterprise-shaped paths to github.com equivalents ──────────
  //
  // When `GH_HOST` is set to a non-github.com host, the gh CLI uses GitHub
  // Enterprise URL conventions:
  //   REST    → /api/v3/<path>   (e.g. /api/v3/repos/owner/repo/issues)
  //   GraphQL → /api/graphql     (vs. /graphql on github.com)
  //
  // Both are rewritten before auth + blocklist + forward so the rest of the
  // pipeline only ever sees github.com-shaped paths. A blocked mutation via
  // /api/graphql still returns 403; auth on /api/v3/* still fires.
  //
  // To add a new exact rewrite: add to REWRITE_EXACT (search tag: REWRITE_EXACT).
  // To add a new prefix strip:  add to STRIP_PREFIXES (search tag: STRIP_PREFIXES).
  const REWRITE_EXACT: [string, string][] = [
    ["/api/graphql", "/graphql"], // Enterprise GraphQL path → github.com path
  ];
  const STRIP_PREFIXES = ["/api/v3"]; // STRIP_PREFIXES
  app.use((req: Request, _res: Response, next: NextFunction) => {
    for (const [from, to] of REWRITE_EXACT) {
      if (req.url === from || req.url.startsWith(from + "?")) {
        req.url = to + req.url.slice(from.length);
        break;
      }
    }
    for (const prefix of STRIP_PREFIXES) {
      if (req.url.startsWith(prefix + "/") || req.url === prefix) {
        req.url = req.url.slice(prefix.length) || "/";
        break;
      }
    }
    next();
  });

  // Parse JSON bodies so we can inspect GraphQL mutations.
  // We use a generous limit; GitHub's GraphQL requests can be large.
  app.use(express.json({ limit: "10mb" }));

  // Raw body pass-through for non-JSON content (git smart-HTTP, uploads, etc.)
  app.use(
    express.raw({ type: "*/*", limit: "50mb" })
  );

  // ── Health check (unauthenticated) ────────────────────────────────────────
  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  // ── Authentication ─────────────────────────────────────────────────────────
  app.use(createAuthMiddleware(authConfig));

  // ── REST blocklist ─────────────────────────────────────────────────────────
  app.use((req: Request, res: Response, next: NextFunction) => {
    const result = checkRestBlock(req.method, req.path);
    if (result.blocked) {
      res.status(403).json({
        message: "Operation blocked by proxy policy",
        reason: result.reason,
        method: req.method,
        path: req.path,
      });
      return;
    }
    next();
  });

  // ── GraphQL mutation blocklist ─────────────────────────────────────────────
  app.post("/graphql", (req: Request, res: Response, next: NextFunction) => {
    const result = checkGraphQLBlock(req.body);
    if (result.blocked) {
      res.status(403).json({
        message: "Operation blocked by proxy policy",
        reason: result.reason,
      });
      return;
    }
    next();
  });

  // ── Forward everything else to GitHub ─────────────────────────────────────
  app.all("*", forwardToGitHub);

  return app;
}
