import type { IncomingMessage, ClientRequest } from "http";
import { EventEmitter } from "events";
import https from "https";
import { vi } from "vitest";

export type UpstreamSetup = { statusCode?: number; headers?: Record<string, string>; body?: string };

/**
 * Installs a one-shot spy on https.request. The fake response fires via
 * process.nextTick so the proxy has time to set up listeners or call pipe first.
 * Returns the request options that were passed to https.request.
 */
export function mockUpstream(setup: UpstreamSetup = {}): { getOptions: () => https.RequestOptions | null } {
  let captured: https.RequestOptions | null = null;

  vi.spyOn(https, "request").mockImplementationOnce(((
    options: https.RequestOptions,
    callback?: (res: IncomingMessage) => void,
  ) => {
    captured = options;

    const fakeRes = Object.assign(new EventEmitter(), {
      statusCode: setup.statusCode ?? 200,
      headers: { "content-type": "application/json", ...setup.headers },
      // For non-buffered (pipe) path: call dest.end so the response completes
      pipe: vi.fn((dest: { end: (d?: Buffer) => void }) => {
        process.nextTick(() => {
          dest.end(setup.body !== undefined ? Buffer.from(setup.body) : undefined);
        });
      }),
    }) as unknown as IncomingMessage;

    const fakeReq = Object.assign(new EventEmitter(), {
      setHeader: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    }) as unknown as ClientRequest;

    // Fire the upstream response asynchronously
    process.nextTick(() => {
      if (callback) {
        callback(fakeRes);
        // Emit data/end after the proxy registers its listeners
        process.nextTick(() => {
          if (setup.body !== undefined) fakeRes.emit("data", Buffer.from(setup.body));
          fakeRes.emit("end");
        });
      }
    });

    return fakeReq;
  }) as unknown as typeof https.request);

  return { getOptions: () => captured };
}

/** Installs a one-shot spy on https.request whose request emits a network-level "error" instead of a response. */
export function mockUpstreamError(error: Error): void {
  vi.spyOn(https, "request").mockImplementationOnce((() => {
    const fakeReq = Object.assign(new EventEmitter(), {
      setHeader: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    }) as unknown as ClientRequest;

    process.nextTick(() => fakeReq.emit("error", error));

    return fakeReq;
  }) as unknown as typeof https.request);
}
