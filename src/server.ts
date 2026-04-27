import type { Server } from "http";
import type { Socket } from "net";
import type express from "express";

export interface ServerHandle {
  server: Server;
  connections: Set<Socket>;
}

export function startServer(app: express.Application, port: number): ServerHandle {
  const connections = new Set<Socket>();

  const server = app.listen(port, () => {
    console.log(`GitHub API proxy listening on http://localhost:${port}`);
    console.log("Forwarding authenticated requests to https://api.github.com");
    console.log("Commit/push operations are blocked.");
  });

  server.on("connection", (socket: Socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
  });

  return { server, connections };
}

export function registerShutdownHandlers(handle: ServerHandle): void {
  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, shutting down gracefully`);
    handle.server.close(() => {
      console.log("HTTP server closed");
      process.exit(0);
    });
    for (const socket of handle.connections) {
      socket.destroy();
    }
    // Force-exit if connections don't drain within 5 s
    setTimeout(() => {
      console.error("Forced shutdown after timeout");
      process.exit(1);
    }, 5_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
