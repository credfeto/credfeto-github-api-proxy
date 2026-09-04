import express from "express";
import type { Request, Response, NextFunction } from "express";
import { createAuthMiddleware, type CredentialPair } from "./auth.js";
import { checkRestBlock, checkGraphQLBlock, sendBlockedResponse } from "./blocklist.js";
import { createRestMergeGate, createGraphQLMergeGate } from "./merge-gate.js";
import { forwardToGitHub } from "./proxy.js";
import { transformCreatePullRequest } from "./transform.js";
import { ResponseCache } from "./cache.js";
import { InMemoryETagStore, InMemoryResponseCache } from "./cache-store.js";

function extractGraphQLOp(req: Request): string | null {
  if (req.method !== "POST" || req.path !== "/graphql") return null;
  const query: string = typeof req.body?.query === "string" ? req.body.query : "";
  const match = /^\s*(query|mutation|subscription)\s*(\w+)?/i.exec(query);
  if (match === null) return null;
  return match[2] !== undefined ? `${match[1]}:${match[2]}` : match[1];
}

export function createApp(credentials: CredentialPair[]): express.Application {
  const app = express();

  const rawTtl = parseInt(process.env.CACHE_TTL_SECONDS ?? "60", 10);
  if (!Number.isFinite(rawTtl) || rawTtl < 1 || rawTtl > 86_400) {
    throw new Error(`Invalid CACHE_TTL_SECONDS: "${process.env.CACHE_TTL_SECONDS ?? ""}"`);
  }
  const ttlMs = rawTtl * 1000;
  const etagTtlMs = Math.max(ttlMs, 86_400_000);
  const responseCache = new ResponseCache(new InMemoryETagStore(etagTtlMs), new InMemoryResponseCache(ttlMs));

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

  // ── Request logging ───────────────────────────────────────────────────────
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.on("finish", () => {
      const op = extractGraphQLOp(req);
      const detail = op !== null ? ` (${op})` : "";
      console.log(`${req.method} ${req.url}${detail} -> ${res.statusCode}`);
    });
    next();
  });

  // ── Health check (unauthenticated) ────────────────────────────────────────
  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  // ── Authentication ─────────────────────────────────────────────────────────
  app.use(createAuthMiddleware(credentials));

  // ── REST blocklist ─────────────────────────────────────────────────────────
  app.use((req: Request, res: Response, next: NextFunction) => {
    const result = checkRestBlock(req.method, req.path);
    if (result.blocked) {
      sendBlockedResponse(res, result.reason, { method: req.method, path: req.path });
      return;
    }
    next();
  });

  // ── REST merge gate ──────────────────────────────────────────────────────
  // Independently verifies a PR is cleanly mergeable before forwarding a merge
  // request, so a caller whose underlying PAT has admin-bypass rights cannot
  // use this proxy to land a PR that fails required reviews/status checks.
  app.use(createRestMergeGate());

  // ── GraphQL mutation blocklist ─────────────────────────────────────────────
  app.post("/graphql", (req: Request, res: Response, next: NextFunction) => {
    const result = checkGraphQLBlock(req.body);
    if (result.blocked) {
      sendBlockedResponse(res, result.reason);
      return;
    }
    next();
  });

  // ── GraphQL merge gate ───────────────────────────────────────────────────
  app.post("/graphql", createGraphQLMergeGate());

  // ── GraphQL mutation transforms ────────────────────────────────────────────
  // Applied after the blocklist so blocked mutations never reach this stage.
  app.post("/graphql", (req: Request, _res: Response, next: NextFunction) => {
    req.body = transformCreatePullRequest(req.body);
    next();
  });

  // ── Forward everything else to GitHub ─────────────────────────────────────
  // The wildcard is wrapped in {} to make it optional so this also matches the
  // bare root path "/" (e.g. GET /api/v3/ stripped to "/", which gh's token
  // scope check hits on every `gh auth login`/`gh auth status`). An unbraced
  // `/*splat` requires at least one path segment and would 404 on root.
  app.all("/{*splat}", (req: Request, res: Response) => { forwardToGitHub(req, res, responseCache); });

  return app;
}
