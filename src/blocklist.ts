/**
 * REST endpoint patterns that would write commits or push code.
 *
 * Rules:
 *  - Git Data API (blobs, trees, commits, refs)  — creating these is the raw
 *    building block of every programmatic commit
 *  - Contents write API (PUT = upsert file, DELETE = delete file)
 *  - Smart-HTTP git push (git-receive-pack / info/refs?service=git-receive-pack)
 *
 * ALLOW everything else: reads of all resources, issue creation/editing,
 * PR operations, Actions reads, etc.
 */

export interface BlockResult {
  blocked: boolean;
  reason?: string;
}

/** REST paths that must be blocked, keyed by HTTP method(s). */
const BLOCKED_REST: Array<{ methods: string[]; pattern: RegExp; reason: string }> = [
  // --- Git Data API write endpoints ---
  {
    methods: ["POST"],
    pattern: /^\/repos\/[^/]+\/[^/]+\/git\/blobs(?:\/|\?|$)/i,
    reason: "Creating git blobs is a commit-building operation",
  },
  {
    methods: ["POST"],
    pattern: /^\/repos\/[^/]+\/[^/]+\/git\/trees(?:\/|\?|$)/i,
    reason: "Creating git trees is a commit-building operation",
  },
  {
    methods: ["POST"],
    pattern: /^\/repos\/[^/]+\/[^/]+\/git\/commits(?:\/|\?|$)/i,
    reason: "Creating git commits is a direct commit operation",
  },
  {
    methods: ["POST", "PATCH", "DELETE"],
    pattern: /^\/repos\/[^/]+\/[^/]+\/git\/refs(?:\/|\?|$)/i,
    reason: "Mutating git refs advances or deletes branches/tags",
  },
  // --- Contents write API ---
  {
    methods: ["PUT"],
    pattern: /^\/repos\/[^/]+\/[^/]+\/contents\/.+/i,
    reason: "PUT /contents creates or updates a file (commits to the repo)",
  },
  {
    methods: ["DELETE"],
    pattern: /^\/repos\/[^/]+\/[^/]+\/contents\/.+/i,
    reason: "DELETE /contents deletes a file (commits to the repo)",
  },
  // --- Smart-HTTP git push ---
  {
    methods: ["POST"],
    pattern: /\/git-receive-pack(?:\?|$)/i,
    reason: "git-receive-pack is the server side of git push",
  },
  {
    methods: ["GET"],
    pattern: /\/info\/refs.*service=git-receive-pack/i,
    reason: "info/refs?service=git-receive-pack is the advertisement phase of git push",
  },
  // --- No-PR merge endpoints ---
  // These merge branches directly with no pull request involved, so there is
  // no review/status-check gate for the merge-gate module to verify against.
  {
    methods: ["POST"],
    pattern: /^\/repos\/[^/]+\/[^/]+\/merges(?:\/|\?|$)/i,
    reason: "POST /merges merges a branch directly without going through a pull request",
  },
  {
    methods: ["POST"],
    pattern: /^\/repos\/[^/]+\/[^/]+\/merge-upstream(?:\/|\?|$)/i,
    reason: "merge-upstream syncs a fork with its upstream without a pull request or review",
  },
];

/**
 * GraphQL mutation names that create, move, or delete git refs/commits, or
 * merge branches with no pull request/review involved. Queries are always
 * allowed. Non-git mutations (createIssue, addComment, etc.) are also
 * allowed. Keyed by mutation name so each gets its own reason text.
 */
const BLOCKED_GRAPHQL_MUTATIONS: ReadonlyMap<string, string> = new Map([
  ["createCommitOnBranch", "GraphQL mutation 'createCommitOnBranch' creates or manipulates git objects"],
  ["createRef", "GraphQL mutation 'createRef' creates or manipulates git objects"],
  ["updateRef", "GraphQL mutation 'updateRef' creates or manipulates git objects"],
  ["deleteRef", "GraphQL mutation 'deleteRef' creates or manipulates git objects"],
  [
    "mergeBranch",
    "GraphQL mutation 'mergeBranch' merges a branch directly without going through a pull request",
  ],
]);

/** Check whether a REST request should be blocked. */
export function checkRestBlock(method: string, path: string): BlockResult {
  const upper = method.toUpperCase();

  for (const rule of BLOCKED_REST) {
    if (rule.methods.includes(upper) && rule.pattern.test(path)) {
      return { blocked: true, reason: rule.reason };
    }
  }
  return { blocked: false };
}

/**
 * Extract the top-level operation names from a GraphQL request body.
 * Returns an empty array for queries (they start with "query" or "{") and
 * for any body that cannot be parsed.
 *
 * We only inspect the operation type — never execute user-supplied code.
 */
export function extractGraphQLMutations(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const { query } = body as Record<string, unknown>;
  if (typeof query !== "string") return [];

  // Quick bail-out: if the document starts with "query" or "{" it's a read
  const trimmed = query.trimStart();
  if (trimmed.startsWith("query") || trimmed.startsWith("{")) return [];
  if (!trimmed.startsWith("mutation")) return [];

  // Extract named mutations: `mutation Foo(` or `mutation Foo {`
  const names: string[] = [];
  const named = /mutation\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = named.exec(query)) !== null) {
    names.push(m[1]);
  }

  // Also extract the field names called inside mutation bodies
  // e.g. `{ createCommitOnBranch(...) { ... } }`
  // Simple heuristic: find known blocked names in the mutation string
  for (const blocked of BLOCKED_GRAPHQL_MUTATIONS.keys()) {
    if (query.includes(blocked)) {
      names.push(blocked);
    }
  }

  return [...new Set(names)];
}

/** Check whether a GraphQL request body contains a blocked mutation. */
export function checkGraphQLBlock(body: unknown): BlockResult {
  const names = extractGraphQLMutations(body);
  for (const name of names) {
    const reason = BLOCKED_GRAPHQL_MUTATIONS.get(name);
    if (reason !== undefined) {
      return { blocked: true, reason };
    }
  }
  return { blocked: false };
}
