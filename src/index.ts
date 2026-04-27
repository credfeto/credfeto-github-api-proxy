import "dotenv/config";
import { createApp } from "./app.js";
import { startServer, registerShutdownHandlers } from "./server.js";

const PORT = Number(process.env.PORT ?? 3000);
const PROXY_TOKEN = process.env.PROXY_TOKEN;
const GITHUB_PAT = process.env.GITHUB_PAT;

if (!PROXY_TOKEN) {
  console.error("PROXY_TOKEN environment variable is required");
  process.exit(1);
}

if (!GITHUB_PAT) {
  console.error("GITHUB_PAT environment variable is required");
  process.exit(1);
}

const app = createApp({ proxyToken: PROXY_TOKEN, githubPat: GITHUB_PAT });
const handle = startServer(app, PORT);
registerShutdownHandlers(handle);
