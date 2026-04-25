import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { createAuthMiddleware } from "../auth.js";

const CONFIG = { proxyToken: "fake-proxy-token-abc123", githubPat: "ghp_realTokenHere" };

function makeReq(authHeader?: string): Partial<Request> {
  return { headers: authHeader ? { authorization: authHeader } : {} };
}

function makeRes(): { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn>; _statusCode: number } {
  const res = {
    _statusCode: 0,
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  res.status.mockImplementation((code: number) => { res._statusCode = code; return res; });
  return res;
}

describe("createAuthMiddleware", () => {
  it("rejects requests with no Authorization header", () => {
    const mw = createAuthMiddleware(CONFIG);
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn();
    mw(req as Request, res as unknown as Response, next as NextFunction);
    expect(res._statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects requests with a malformed Authorization header", () => {
    const mw = createAuthMiddleware(CONFIG);
    const req = makeReq("NotAToken");
    const res = makeRes();
    const next = vi.fn();
    mw(req as Request, res as unknown as Response, next as NextFunction);
    expect(res._statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects requests with wrong token", () => {
    const mw = createAuthMiddleware(CONFIG);
    const req = makeReq("Bearer wrong-token");
    const res = makeRes();
    const next = vi.fn();
    mw(req as Request, res as unknown as Response, next as NextFunction);
    expect(res._statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("accepts Bearer <proxyToken> and swaps to real PAT", () => {
    const mw = createAuthMiddleware(CONFIG);
    const req = makeReq(`Bearer ${CONFIG.proxyToken}`);
    const res = makeRes();
    const next = vi.fn();
    mw(req as Request, res as unknown as Response, next as NextFunction);
    expect(next).toHaveBeenCalledOnce();
    expect((req as Request).headers["authorization"]).toBe(`token ${CONFIG.githubPat}`);
  });

  it("accepts token <proxyToken> form (case-insensitive) and swaps to real PAT", () => {
    const mw = createAuthMiddleware(CONFIG);
    const req = makeReq(`Token ${CONFIG.proxyToken}`);
    const res = makeRes();
    const next = vi.fn();
    mw(req as Request, res as unknown as Response, next as NextFunction);
    expect(next).toHaveBeenCalledOnce();
    expect((req as Request).headers["authorization"]).toBe(`token ${CONFIG.githubPat}`);
  });
});
