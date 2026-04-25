# GitHub API Proxy

A lightweight reverse proxy that sits between an AI agent and the GitHub API.
The proxy holds your real GitHub Personal Access Token (PAT); agents get a
**fake proxy token** that only works through this proxy and can never be used
to hit GitHub directly.

The proxy **blocks all operations that would write code to a repository**
(commits, ref updates, file writes, git push) while passing through everything
else: reading and creating issues, reading and creating pull requests, reading
CI/Actions results, etc.

---

## Requirements

### R1 — Token isolation

| Requirement | Detail |
|---|---|
| Agents receive a fake token | The `PROXY_TOKEN` env var is issued to agents. It has no value outside the proxy. |
| Proxy holds the real PAT | `GITHUB_PAT` is only known to the proxy process. Agents never see it. |
| Token swap is transparent | The proxy replaces `Authorization: Bearer <fake>` with `Authorization: token <real>` before forwarding. Both `Bearer` and `token` schemes are accepted from the agent side. |

### R2 — Blocked REST operations

All of the following return **HTTP 403** with a JSON body explaining why:

| Method | Path pattern | Why blocked |
|---|---|---|
| `POST` | `/repos/:owner/:repo/git/blobs` | Creates a git blob — raw building block of commits |
| `POST` | `/repos/:owner/:repo/git/trees` | Creates a git tree — raw building block of commits |
| `POST` | `/repos/:owner/:repo/git/commits` | Directly creates a git commit |
| `POST` | `/repos/:owner/:repo/git/refs` | Creates a branch or tag |
| `PATCH` | `/repos/:owner/:repo/git/refs/**` | Advances a branch (fast-forward / force-push equivalent) |
| `DELETE` | `/repos/:owner/:repo/git/refs/**` | Deletes a branch or tag |
| `PUT` | `/repos/:owner/:repo/contents/**` | Creates or updates a file (generates a commit) |
| `DELETE` | `/repos/:owner/:repo/contents/**` | Deletes a file (generates a commit) |
| `POST` | `**/git-receive-pack` | HTTPS git push (server-side receive) |
| `GET` | `**/info/refs?service=git-receive-pack` | HTTPS git push advertisement phase |

**Read operations on the same paths are allowed** (e.g. `GET /repos/:owner/:repo/git/commits/:sha`).

### R3 — Blocked GraphQL mutations

GraphQL mutations that create, move, or delete git objects are blocked:

| Mutation | Why blocked |
|---|---|
| `createCommitOnBranch` | Commits code directly via GraphQL |
| `createRef` | Creates a branch or tag |
| `updateRef` | Advances a branch |
| `deleteRef` | Deletes a branch or tag |

All **queries** are allowed. **Non-git mutations** (e.g. `createIssue`,
`addComment`, `createPullRequest`, `mergePullRequest`) are allowed.

### R4 — Allowed operations (non-exhaustive)

The proxy explicitly allows:

- Reading and creating issues (`GET /repos/:o/:r/issues`, `POST /repos/:o/:r/issues`)
- Reading and creating issue comments
- Reading and creating pull requests (`GET/POST /repos/:o/:r/pulls`)
- Updating pull requests (title, body, state) — `PATCH /repos/:o/:r/pulls/:id`
- Listing and reading CI/Actions runs (`GET /repos/:o/:r/actions/runs`)
- Listing and reading workflow files (`GET /repos/:o/:r/actions/workflows`)
- Triggering workflow dispatches (`POST /repos/:o/:r/actions/workflows/:id/dispatches`)
- Reading notifications (`GET /notifications`)
- Reading user info (`GET /user`)
- All GraphQL queries (read-only operations)
- Non-git GraphQL mutations (issue/PR management)
- `GET /info/refs?service=git-upload-pack` (git fetch/clone — read-only)

### R5 — GitHub CLI compatibility

The proxy speaks the same HTTP API as `api.github.com`, so the GitHub CLI
(`gh`) works without modification if you redirect it:

```sh
export GH_HOST=localhost:3000   # or your proxy address
export GH_TOKEN=<your-proxy-token>
# gh now routes through the proxy
gh issue list --repo owner/repo
gh pr view 42 --repo owner/repo
```

Destructive `gh` commands (creating commits via `gh api`) will be blocked by the
proxy with a 403 response and a human-readable message.

---

## Architecture

```
Agent / gh CLI
      │  Authorization: Bearer <fake-proxy-token>
      ▼
┌─────────────────────────────────────────────────────┐
│  GitHub API Proxy  (this server)                    │
│                                                     │
│  1. Auth middleware      — validate fake token      │
│                          — swap to real PAT         │
│  2. REST blocklist       — 403 on commit endpoints  │
│  3. GraphQL blocklist    — 403 on git mutations     │
│  4. Forward              — pipe to api.github.com   │
└─────────────────────────────────────────────────────┘
      │  Authorization: token <real-github-pat>
      ▼
  api.github.com
```

---

## Getting started

### Prerequisites

- Node.js 20+
- A GitHub PAT (classic with `repo`, `read:org`, `workflow` scopes, or a
  fine-grained PAT with Issues, Pull Requests, Actions, Workflows read/write
  as appropriate)

### Install

```sh
npm install
```

### Configure

```sh
cp .env.example .env
# Edit .env and fill in PROXY_TOKEN and GITHUB_PAT
```

### Run

```sh
npm run dev          # development mode (tsx, no build step)
npm run build && npm start   # production
```

### Test

```sh
npm test
```

Tests cover:

- All blocked REST endpoints return 403
- All allowed REST endpoints pass through
- Blocked GraphQL mutations return 403
- Allowed GraphQL queries and non-git mutations pass through
- Auth: missing token → 401, wrong token → 403, correct token → token swapped
  and forwarded

---

## Security notes

- **Never commit `.env`** — the `.gitignore` excludes it.
- The proxy token should be a long random string (32+ bytes of hex).
- Run the proxy on localhost or a private network — it is not hardened for
  public internet exposure (no rate limiting, no TLS termination built-in).
- If you expose it externally, put it behind a TLS-terminating reverse proxy
  (nginx, caddy, etc.).
- The GraphQL inspection is pattern-matching, not a full GraphQL parser. It
  covers all known GitHub git-write mutations. If GitHub adds new git-write
  mutations in future, the blocklist in `src/blocklist.ts` must be updated.
