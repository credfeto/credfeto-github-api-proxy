# Proxy Safety Instructions

[Back to Local Instructions Index](index.md)

## Critical Constraint

**This proxy is the AI agent's own communication channel to GitHub.** Breaking it cuts off the agent from the GitHub API entirely, preventing it from opening PRs, reading issues, or doing any further work. Treat every change to this repo as potentially self-breaking.

## Test Coverage

- Every code path that runs at startup (`loadCredentials`, configuration parsing, middleware wiring) **must** have automated tests.
- Tests must cover all failure modes: missing file, unreadable file, invalid JSON, empty array, malformed entries.
- Do not merge any change that reduces test coverage on the startup path.
- Run the full test suite (`npm test`) locally and confirm it passes before pushing.

## Manual Operational Changes

Any change that requires a manual step on the host (editing a file, setting a permission, creating a directory, pulling a new image) **must** be:

1. Called out explicitly in the PR description with step-by-step instructions.
2. Documented in `README.md` under the relevant setup section.

If the change cannot be applied without downtime, say so in the PR.

## File Permissions on Volume Mounts

The container runs as a **non-root user**. Files accessed via Docker volume mounts (e.g. `credentials.json`) must be readable by that user.

- Document the required permission in `README.md`: the credentials file must be readable by the container's UID.
- When adding any new volume-mounted file, add a note in the PR and README stating the required permissions.
- Example: `chmod 640 credentials.json` with the file owned by the host user that matches the container UID, or `chmod 644` if world-readable is acceptable for that file.

## Container Startup Logging

Startup code must log enough information to diagnose failures without an agent present:

- Log which configuration source is being used (e.g. `CREDENTIALS_FILE=/proxy/credentials.json`).
- Log the number of credential pairs loaded on success.
- Log the full error message and the relevant config value (file path, env var name) on every failure before calling `process.exit(1)`.
- Do **not** log credential values (tokens, PATs) — only metadata (file path, pair count, token prefix if needed for debugging).
