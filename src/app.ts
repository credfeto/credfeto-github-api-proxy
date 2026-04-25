import express from "express";
import type { Request, Response, NextFunction } from "express";
import { createAuthMiddleware, type AuthConfig } from "./auth.js";
import { checkRestBlock, checkGraphQLBlock } from "./blocklist.js";
import { forwardToGitHub } from "./proxy.js";

export function createApp(authConfig: AuthConfig): express.Application {
  const app = express();

  // Parse JSON bodies so we can inspect GraphQL mutations.
  // We use a generous limit; GitHub's GraphQL requests can be large.
  app.use(express.json({ limit: "10mb" }));

  // Raw body pass-through for non-JSON content (git smart-HTTP, uploads, etc.)
  app.use(
    express.raw({ type: "*/*", limit: "50mb" })
  );

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
