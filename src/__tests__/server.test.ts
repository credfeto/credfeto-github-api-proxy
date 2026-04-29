import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Server } from "http";
import type { Socket } from "net";
import { startServer, registerShutdownHandlers, type ServerHandle } from "../server.js";
import { createApp } from "../app.js";

vi.mock("../proxy.js", () => ({
  forwardToGitHub: vi.fn((_req, res) => res.status(200).json({ proxied: true })),
}));

const CONFIG = [{ proxyToken: "test-token", githubPat: "ghp_test" }];

describe("startServer", () => {
  let handle: ServerHandle;

  afterEach(() => {
    handle?.server.close();
  });

  it("starts listening and returns a server and connections set", () =>
    new Promise<void>((resolve) => {
      const app = createApp(CONFIG);
      handle = startServer(app, 0); // port 0 = OS-assigned free port
      handle.server.once("listening", () => {
        expect(handle.server.listening).toBe(true);
        expect(handle.connections).toBeInstanceOf(Set);
        resolve();
      });
    }));

  it("tracks a connection in the set and removes it when the socket closes", () =>
    new Promise<void>((resolve) => {
      const app = createApp(CONFIG);
      handle = startServer(app, 0);
      handle.server.once("listening", () => {
        const fakeSocket = { on: vi.fn() } as unknown as Socket;

        // Grab our connection listener directly (avoid touching the HTTP server
        // internals that would crash on a bare fake socket)
        const listeners = handle.server.rawListeners("connection");
        const ourListener = listeners.find(
          (fn) => fn.toString().includes("connections.add"),
        ) as ((socket: Socket) => void) | undefined;
        expect(ourListener).toBeDefined();

        ourListener!(fakeSocket);
        expect(handle.connections.has(fakeSocket)).toBe(true);

        // Fire the "close" callback that our listener registered on the socket
        const closeCall = (fakeSocket.on as ReturnType<typeof vi.fn>).mock.calls.find(
          (c) => c[0] === "close",
        );
        expect(closeCall).toBeDefined();
        (closeCall![1] as () => void)();

        expect(handle.connections.has(fakeSocket)).toBe(false);
        resolve();
      });
    }));
});

describe("registerShutdownHandlers", () => {
  beforeEach(() => {
    vi.spyOn(process, "on");
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers SIGTERM and SIGINT handlers", () => {
    const mockServer = {
      close: vi.fn(),
    } as unknown as Server;
    const handle: ServerHandle = { server: mockServer, connections: new Set() };

    registerShutdownHandlers(handle);

    const registered = (process.on as ReturnType<typeof vi.spyOn>).mock.calls.map(
      (c) => c[0],
    );
    expect(registered).toContain("SIGTERM");
    expect(registered).toContain("SIGINT");
  });

  it("calls server.close and destroys open connections on SIGTERM", () => {
    const closeMock = vi.fn();
    const mockServer = { close: closeMock } as unknown as Server;
    const mockSocket = { destroy: vi.fn() } as unknown as Socket;
    const connections = new Set<Socket>([mockSocket]);
    const handle: ServerHandle = { server: mockServer, connections };

    registerShutdownHandlers(handle);

    // Invoke the SIGTERM handler directly
    const sigtermCall = (process.on as ReturnType<typeof vi.spyOn>).mock.calls.find(
      (c) => c[0] === "SIGTERM",
    );
    expect(sigtermCall).toBeDefined();
    (sigtermCall![1] as () => void)();

    expect(closeMock).toHaveBeenCalledOnce();
    expect(mockSocket.destroy).toHaveBeenCalledOnce();
  });

  it("calls process.exit(0) when server.close callback fires", () => {
    const closeMock = vi.fn((cb: () => void) => cb());
    const mockServer = { close: closeMock } as unknown as Server;
    const handle: ServerHandle = { server: mockServer, connections: new Set() };

    registerShutdownHandlers(handle);

    const sigtermCall = (process.on as ReturnType<typeof vi.spyOn>).mock.calls.find(
      (c) => c[0] === "SIGTERM",
    );
    (sigtermCall![1] as () => void)();

    expect(process.exit).toHaveBeenCalledWith(0);
  });
});
