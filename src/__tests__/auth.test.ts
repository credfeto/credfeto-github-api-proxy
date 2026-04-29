import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { createAuthMiddleware } from "../auth.js";

const PAIR_1 = { proxyToken: "fake-proxy-token-abc123", githubPat: "ghp_realTokenHere" };
const PAIR_2 = { proxyToken: "fake-proxy-token-xyz789", githubPat: "ghp_anotherRealToken" };
const CREDENTIALS = [PAIR_1, PAIR_2];

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
    const mw = createAuthMiddleware(CREDENTIALS);
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn();
    mw(req as Request, res as unknown as Response, next as NextFunction);
    expect(res._statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects requests with a malformed Authorization header", () => {
    const mw = createAuthMiddleware(CREDENTIALS);
    const req = makeReq("NotAToken");
    const res = makeRes();
    const next = vi.fn();
    mw(req as Request, res as unknown as Response, next as NextFunction);
    expect(res._statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects requests with a token that matches no credential pair", () => {
    const mw = createAuthMiddleware(CREDENTIALS);
    const req = makeReq("Bearer unknown-token");
    const res = makeRes();
    const next = vi.fn();
    mw(req as Request, res as unknown as Response, next as NextFunction);
    expect(res._statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("accepts the first pair's proxyToken and swaps to its real PAT", () => {
    const mw = createAuthMiddleware(CREDENTIALS);
    const req = makeReq(`Bearer ${PAIR_1.proxyToken}`);
    const res = makeRes();
    const next = vi.fn();
    mw(req as Request, res as unknown as Response, next as NextFunction);
    expect(next).toHaveBeenCalledOnce();
    expect((req as Request).headers["authorization"]).toBe(`token ${PAIR_1.githubPat}`);
  });

  it("accepts the second pair's proxyToken and swaps to its real PAT", () => {
    const mw = createAuthMiddleware(CREDENTIALS);
    const req = makeReq(`Bearer ${PAIR_2.proxyToken}`);
    const res = makeRes();
    const next = vi.fn();
    mw(req as Request, res as unknown as Response, next as NextFunction);
    expect(next).toHaveBeenCalledOnce();
    expect((req as Request).headers["authorization"]).toBe(`token ${PAIR_2.githubPat}`);
  });

  it("accepts token <proxyToken> form (case-insensitive) and swaps to real PAT", () => {
    const mw = createAuthMiddleware(CREDENTIALS);
    const req = makeReq(`Token ${PAIR_1.proxyToken}`);
    const res = makeRes();
    const next = vi.fn();
    mw(req as Request, res as unknown as Response, next as NextFunction);
    expect(next).toHaveBeenCalledOnce();
    expect((req as Request).headers["authorization"]).toBe(`token ${PAIR_1.githubPat}`);
  });

  it("does not cross-contaminate: PAIR_1 token maps only to PAIR_1 PAT", () => {
    const mw = createAuthMiddleware(CREDENTIALS);
    const req = makeReq(`Bearer ${PAIR_1.proxyToken}`);
    const res = makeRes();
    const next = vi.fn();
    mw(req as Request, res as unknown as Response, next as NextFunction);
    expect((req as Request).headers["authorization"]).not.toContain(PAIR_2.githubPat);
  });

  it("works with a single-pair list (backward-compatible behaviour)", () => {
    const mw = createAuthMiddleware([PAIR_1]);
    const req = makeReq(`Bearer ${PAIR_1.proxyToken}`);
    const res = makeRes();
    const next = vi.fn();
    mw(req as Request, res as unknown as Response, next as NextFunction);
    expect(next).toHaveBeenCalledOnce();
    expect((req as Request).headers["authorization"]).toBe(`token ${PAIR_1.githubPat}`);
  });
});
