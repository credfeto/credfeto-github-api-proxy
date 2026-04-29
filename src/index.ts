import "dotenv/config";
import { readFileSync } from "fs";
import { createApp } from "./app.js";
import { startServer, registerShutdownHandlers } from "./server.js";
import type { CredentialPair } from "./auth.js";

function loadCredentials(): CredentialPair[] {
  const credentialsFile = process.env.CREDENTIALS_FILE;

  if (credentialsFile) {
    let raw: string;
    try {
      raw = readFileSync(credentialsFile, "utf8");
    } catch (err) {
      console.error(`Failed to read credentials file: ${credentialsFile}`, err);
      process.exit(1);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error(`Credentials file is not valid JSON: ${credentialsFile}`, err);
      process.exit(1);
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      console.error("Credentials file must contain a non-empty JSON array of {proxyToken, githubPat} pairs");
      process.exit(1);
    }

    return parsed as CredentialPair[];
  }

  // Fallback: single pair from environment variables (backward-compatible)
  const proxyToken = process.env.PROXY_TOKEN;
  const githubPat = process.env.GITHUB_PAT;

  if (!proxyToken || !githubPat) {
    console.error("Either CREDENTIALS_FILE or both PROXY_TOKEN and GITHUB_PAT environment variables are required");
    process.exit(1);
  }

  return [{ proxyToken, githubPat }];
}

const PORT = Number(process.env.PORT ?? 3000);
const credentials = loadCredentials();
const app = createApp(credentials);
const handle = startServer(app, PORT);
registerShutdownHandlers(handle);
