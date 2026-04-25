import type { Request, Response, NextFunction } from "express";

export interface AuthConfig {
  /** The fake token agents present to the proxy */
  proxyToken: string;
  /** The real GitHub PAT the proxy swaps in */
  githubPat: string;
}

/**
 * Middleware: validate that the incoming request carries the expected proxy
 * token, then replace it with the real GitHub PAT before forwarding.
 *
 * GitHub uses the Authorization header in the form:
 *   Authorization: Bearer <token>
 *   Authorization: token <token>
 *
 * Both forms are handled.
 */
export function createAuthMiddleware(config: AuthConfig) {
  return function authMiddleware(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers["authorization"];

    if (!authHeader) {
      res.status(401).json({ message: "Authorization header required" });
      return;
    }

    // Support both `Bearer <token>` and `token <token>`
    const match = /^(?:bearer|token)\s+(.+)$/i.exec(authHeader);
    if (!match) {
      res.status(401).json({ message: "Malformed Authorization header" });
      return;
    }

    const presented = match[1].trim();
    if (presented !== config.proxyToken) {
      res.status(403).json({ message: "Invalid proxy token" });
      return;
    }

    // Swap in the real PAT
    req.headers["authorization"] = `token ${config.githubPat}`;
    next();
  };
}
