import { readFileSync } from "fs";
import type { CredentialPair } from "./auth.js";

/**
 * Exit codes used when the app cannot start due to a credentials problem.
 *
 * These are intentionally distinct so callers (tests, scripts) can tell exactly
 * what went wrong from the process exit code alone.
 */
export const EXIT_CODES = {
  NO_CREDENTIALS_FILE: 1,
  FILE_UNREADABLE: 2,
  FILE_INVALID_JSON: 3,
  EMPTY_OR_INVALID: 4,
  TOKEN_COLLISION: 5,
} as const;

/**
 * Load and validate credentials from the file pointed to by CREDENTIALS_FILE.
 *
 * Rules (app exits with a distinct code on every violation):
 *  1 – CREDENTIALS_FILE env var is not set.
 *  2 – The file cannot be read.
 *  3 – The file is not valid JSON.
 *  4 – The file does not contain a non-empty array of {proxyToken, githubPat} pairs
 *      where both values are non-empty strings.
 *  5 – Any proxyToken equals any githubPat anywhere in the list (a fake token
 *      must never match a real PAT to prevent accidental token exposure).
 */
export function loadCredentials(): CredentialPair[] {
  const credentialsFile = process.env.CREDENTIALS_FILE;

  if (!credentialsFile) {
    console.error("CREDENTIALS_FILE environment variable is required");
    process.exit(EXIT_CODES.NO_CREDENTIALS_FILE);
  }

  let raw: string;
  try {
    raw = readFileSync(credentialsFile, "utf8");
  } catch (err) {
    console.error(`Failed to read credentials file: ${credentialsFile}`, err);
    process.exit(EXIT_CODES.FILE_UNREADABLE);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`Credentials file is not valid JSON: ${credentialsFile}`, err);
    process.exit(EXIT_CODES.FILE_INVALID_JSON);
  }

  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every(
      (item): item is CredentialPair =>
        item !== null &&
        typeof item === "object" &&
        typeof (item as Record<string, unknown>).proxyToken === "string" &&
        ((item as Record<string, unknown>).proxyToken as string).length > 0 &&
        typeof (item as Record<string, unknown>).githubPat === "string" &&
        ((item as Record<string, unknown>).githubPat as string).length > 0,
    )
  ) {
    console.error(
      "Credentials file must contain a non-empty JSON array of {proxyToken, githubPat} pairs with non-empty string values",
    );
    process.exit(EXIT_CODES.EMPTY_OR_INVALID);
  }

  const credentials = parsed as CredentialPair[];

  const allGithubPats = new Set(credentials.map(c => c.githubPat));
  const collision = credentials.find(c => allGithubPats.has(c.proxyToken));
  if (collision) {
    console.error(
      `Invalid credentials: proxyToken "${collision.proxyToken}" matches a real GitHub PAT in the credentials list. ` +
        "Fake tokens must never equal real PATs.",
    );
    process.exit(EXIT_CODES.TOKEN_COLLISION);
  }

  return credentials;
}
