import express from "express";
import type { Request, Response, NextFunction } from "express";
import { createAuthMiddleware, type AuthConfig } from "./auth.js";
import { checkRestBlock, checkGraphQLBlock } from "./blocklist.js";
import { forwardToGitHub } from "./proxy.js";

export function createApp(authConfig: AuthConfig): express.Application {
  const app = express();

  // ── Strip the /api/v3 prefix that gh CLI adds for non-github.com hosts ───
  //
  // Why this exists: when `GH_HOST` is set to anything other than `github.com`
  // (which is required to point gh at this proxy — see README §R5), the gh
  // CLI hardcodes the GitHub Enterprise URL convention and prepends
  // `/api/v3/` to every REST call. Without this rewrite, agents pointing
  // gh at the proxy would see every API call 404 because we serve the
  // *github.com*-shaped surface (`/user`, `/repos/...`) at the root.
  //
  // The rewrite happens BEFORE auth + blocklist + forward, so the rest of
  // the pipeline only ever sees normalised paths — both `/user` and
  // `/api/v3/user` go through the same auth check, the same blocklist
  // (so a `POST /api/v3/repos/o/r/git/commits` is still blocked), and
  // forward to the same upstream URL.
  //
  // Path-prefix gotcha: GitHub's REST endpoint family is `/api/v3/*`, but
  // GraphQL lives at `/graphql` regardless of REST/Enterprise URL pattern.
  // We only strip `/api/v3/`. If GitHub ever introduces a `/api/v4/` REST
  // surface and gh starts sending that to non-github.com hosts, this
  // middleware needs a parallel branch — search this file for `STRIP_PREFIXES`
  // and add the new prefix to that array.
  const STRIP_PREFIXES = ["/api/v3"];
  app.use((req: Request, _res: Response, next: NextFunction) => {
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
