import type { Request, Response, NextFunction } from "express";

export interface CredentialPair {
  /** The fake token agents present to the proxy */
  proxyToken: string;
  /** The real GitHub PAT the proxy swaps in */
  githubPat: string;
}

/**
 * Middleware: validate that the incoming request carries a known proxy token,
 * then replace it with the matching real GitHub PAT before forwarding.
 *
 * GitHub uses the Authorization header in the form:
 *   Authorization: Bearer <token>
 *   Authorization: token <token>
 *
 * Both forms are handled. If no credential pair matches the presented token,
 * the request is rejected with 401.
 */
export function createAuthMiddleware(credentials: CredentialPair[]) {
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
    const credential = credentials.find(c => c.proxyToken === presented);
    if (!credential) {
      res.status(401).json({ message: "Invalid proxy token" });
      return;
    }

    // Swap in the real PAT for the matched credential pair
    req.headers["authorization"] = `token ${credential.githubPat}`;
    next();
  };
}
