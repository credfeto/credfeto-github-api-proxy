import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";

// We must mock 'fs' before importing the module under test so that the module
// picks up the mock when it is first evaluated.
vi.mock("fs", () => ({ readFileSync: vi.fn() }));

// Import after the mock is set up.
const { loadCredentials, EXIT_CODES } = await import("../credentials.js");

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockFile(content: string): void {
  (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(content);
}

/**
 * Sentinel error thrown by the mocked process.exit so execution stops at the
 * call site (matching real behaviour) without killing the test runner.
 */
class MockExitError extends Error {
  constructor(public readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

/**
 * Call loadCredentials(), expecting it to call process.exit().
 * Returns the exit code that was passed to process.exit().
 */
function expectExit(fn: () => void): number | undefined {
  let caught: MockExitError | undefined;
  try {
    fn();
  } catch (e) {
    if (e instanceof MockExitError) caught = e;
    else throw e;
  }
  if (!caught) throw new Error("process.exit was not called");
  return caught.code;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("loadCredentials", () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = { ...origEnv };
    vi.spyOn(process, "exit").mockImplementation((code?: number) => {
      throw new MockExitError(code);
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = origEnv;
    vi.restoreAllMocks();
  });

  // ── Failure: no CREDENTIALS_FILE set ────────────────────────────────────

  it("exits with NO_CREDENTIALS_FILE when CREDENTIALS_FILE is not set", () => {
    delete process.env.CREDENTIALS_FILE;
    expect(expectExit(() => loadCredentials())).toBe(EXIT_CODES.NO_CREDENTIALS_FILE);
  });

  it("exits with NO_CREDENTIALS_FILE when CREDENTIALS_FILE is an empty string", () => {
    process.env.CREDENTIALS_FILE = "";
    expect(expectExit(() => loadCredentials())).toBe(EXIT_CODES.NO_CREDENTIALS_FILE);
  });

  // ── Failure: file unreadable ─────────────────────────────────────────────

  it("exits with FILE_UNREADABLE when the file does not exist (ENOENT)", () => {
    process.env.CREDENTIALS_FILE = "/nonexistent/path.json";
    (readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    });
    expect(expectExit(() => loadCredentials())).toBe(EXIT_CODES.FILE_UNREADABLE);
  });

  it("exits with FILE_UNREADABLE when the file exists but is not readable (EACCES)", () => {
    process.env.CREDENTIALS_FILE = "/proxy/credentials.json";
    (readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw Object.assign(new Error("EACCES: permission denied, open '/proxy/credentials.json'"), {
        code: "EACCES",
        errno: -13,
        syscall: "open",
        path: "/proxy/credentials.json",
      });
    });
    expect(expectExit(() => loadCredentials())).toBe(EXIT_CODES.FILE_UNREADABLE);
  });

  it("exits with FILE_UNREADABLE when the file exists but is not readable (EPERM)", () => {
    process.env.CREDENTIALS_FILE = "/proxy/credentials.json";
    (readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw Object.assign(new Error("EPERM: operation not permitted, open '/proxy/credentials.json'"), {
        code: "EPERM",
        errno: -1,
        syscall: "open",
        path: "/proxy/credentials.json",
      });
    });
    expect(expectExit(() => loadCredentials())).toBe(EXIT_CODES.FILE_UNREADABLE);
  });

  it("exits with FILE_UNREADABLE when a generic read error is thrown", () => {
    process.env.CREDENTIALS_FILE = "/app/credentials.json";
    (readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("unexpected read error");
    });
    expect(expectExit(() => loadCredentials())).toBe(EXIT_CODES.FILE_UNREADABLE);
  });

  it("logs the credentials file path when the file cannot be read", () => {
    const filePath = "/proxy/credentials.json";
    process.env.CREDENTIALS_FILE = filePath;
    (readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw Object.assign(new Error("EACCES: permission denied, open '/proxy/credentials.json'"), {
        code: "EACCES",
      });
    });
    const consoleErrorSpy = vi.mocked(console.error);
    expect(expectExit(() => loadCredentials())).toBe(EXIT_CODES.FILE_UNREADABLE);
    expect(consoleErrorSpy.mock.calls.some(args => String(args[0]).includes(filePath))).toBe(true);
  });

  // ── Failure: invalid JSON ────────────────────────────────────────────────

  it("exits with FILE_INVALID_JSON when the file contains invalid JSON", () => {
    process.env.CREDENTIALS_FILE = "/app/credentials.json";
    mockFile("not-valid-json{{{");
    expect(expectExit(() => loadCredentials())).toBe(EXIT_CODES.FILE_INVALID_JSON);
  });

  // ── Failure: empty / invalid structure ───────────────────────────────────

  it("exits with EMPTY_OR_INVALID when the file contains an empty array", () => {
    process.env.CREDENTIALS_FILE = "/app/credentials.json";
    mockFile("[]");
    expect(expectExit(() => loadCredentials())).toBe(EXIT_CODES.EMPTY_OR_INVALID);
  });

  it("exits with EMPTY_OR_INVALID when the file contains a JSON object (not array)", () => {
    process.env.CREDENTIALS_FILE = "/app/credentials.json";
    mockFile('{"proxyToken":"a","githubPat":"b"}');
    expect(expectExit(() => loadCredentials())).toBe(EXIT_CODES.EMPTY_OR_INVALID);
  });

  it("exits with EMPTY_OR_INVALID when a pair is missing proxyToken", () => {
    process.env.CREDENTIALS_FILE = "/app/credentials.json";
    mockFile('[{"githubPat":"ghp_real"}]');
    expect(expectExit(() => loadCredentials())).toBe(EXIT_CODES.EMPTY_OR_INVALID);
  });

  it("exits with EMPTY_OR_INVALID when a pair is missing githubPat", () => {
    process.env.CREDENTIALS_FILE = "/app/credentials.json";
    mockFile('[{"proxyToken":"fake-token"}]');
    expect(expectExit(() => loadCredentials())).toBe(EXIT_CODES.EMPTY_OR_INVALID);
  });

  it("exits with EMPTY_OR_INVALID when proxyToken is an empty string", () => {
    process.env.CREDENTIALS_FILE = "/app/credentials.json";
    mockFile('[{"proxyToken":"","githubPat":"ghp_real"}]');
    expect(expectExit(() => loadCredentials())).toBe(EXIT_CODES.EMPTY_OR_INVALID);
  });

  it("exits with EMPTY_OR_INVALID when githubPat is an empty string", () => {
    process.env.CREDENTIALS_FILE = "/app/credentials.json";
    mockFile('[{"proxyToken":"fake-token","githubPat":""}]');
    expect(expectExit(() => loadCredentials())).toBe(EXIT_CODES.EMPTY_OR_INVALID);
  });

  // ── Failure: proxyToken matches a githubPat ───────────────────────────────

  it("exits with TOKEN_COLLISION when proxyToken equals its own githubPat", () => {
    process.env.CREDENTIALS_FILE = "/app/credentials.json";
    mockFile('[{"proxyToken":"same-token","githubPat":"same-token"}]');
    expect(expectExit(() => loadCredentials())).toBe(EXIT_CODES.TOKEN_COLLISION);
  });

  it("exits with TOKEN_COLLISION when a proxyToken equals another entry's githubPat", () => {
    process.env.CREDENTIALS_FILE = "/app/credentials.json";
    mockFile(
      JSON.stringify([
        { proxyToken: "ghp_realB", githubPat: "ghp_realA" },
        { proxyToken: "fake-tokenB", githubPat: "ghp_realB" },
      ]),
    );
    expect(expectExit(() => loadCredentials())).toBe(EXIT_CODES.TOKEN_COLLISION);
  });

  // ── Success ──────────────────────────────────────────────────────────────

  it("returns credentials for a valid single-pair file", () => {
    process.env.CREDENTIALS_FILE = "/app/credentials.json";
    const pairs = [{ proxyToken: "fake-token-abc", githubPat: "ghp_realtoken123" }];
    mockFile(JSON.stringify(pairs));
    const result = loadCredentials();
    expect(result).toEqual(pairs);
  });

  it("returns credentials for a valid multi-pair file", () => {
    process.env.CREDENTIALS_FILE = "/app/credentials.json";
    const pairs = [
      { proxyToken: "fake-token-1", githubPat: "ghp_real1" },
      { proxyToken: "fake-token-2", githubPat: "ghp_real2" },
    ];
    mockFile(JSON.stringify(pairs));
    const result = loadCredentials();
    expect(result).toEqual(pairs);
  });

  it("does not exit when proxyToken and githubPat are both unique across all pairs", () => {
    process.env.CREDENTIALS_FILE = "/app/credentials.json";
    mockFile(
      JSON.stringify([
        { proxyToken: "proxy-a", githubPat: "ghp_real_a" },
        { proxyToken: "proxy-b", githubPat: "ghp_real_b" },
      ]),
    );
    // Should not throw
    expect(() => loadCredentials()).not.toThrow();
  });
});
