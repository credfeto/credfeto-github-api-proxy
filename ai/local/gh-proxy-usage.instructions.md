<!-- Locally Maintained -->
# gh CLI Usage via the Proxy

[Back to Local Instructions Index](index.md)

## Creating Pull Requests (MANDATORY)

When `GH_HOST` is set to this proxy host the `gh` CLI cannot match git remotes (which reference `github.com`) to the configured host.  It therefore cannot determine the head repository from git context, which causes `gh pr create` to fall back to the authenticated user's default branch and produce:

```text
GraphQL: Head sha can't be blank, Base sha can't be blank,
Head repository can't be blank,
No commits between <org>:main and <user>:main, …
```

**Always specify `--head <owner>:<branch>` explicitly:**

```bash
gh pr create \
  --repo <owner>/<repo> \
  --head <owner>:<branch-name> \
  --draft \
  --title "…" \
  --body "…"
```

Where `<owner>` is the organisation or user that owns the repository and `<branch-name>` is the current working branch (obtained from `git branch --show-current`).

This makes the head ref unambiguous and allows `gh` to look up the correct `headRepositoryId` via the proxy's GraphQL forwarding.

## Background

The proxy automatically injects `headRepositoryId = repositoryId` when `headRepositoryId` is absent from a `createPullRequest` mutation input (see `src/transform.ts`).  This corrects the "Head repository can't be blank" error but cannot fix an incorrect `headRefName` — only the `--head` flag can supply the correct branch name.
