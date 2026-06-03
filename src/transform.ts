/**
 * GraphQL request body transformations applied before forwarding to GitHub.
 *
 * These transformations exist to paper over differences between how the gh CLI
 * constructs requests when GH_HOST is set to a non-github.com host (Enterprise
 * URL conventions) versus what the github.com GraphQL API expects.
 */

interface CreatePullRequestInput {
  repositoryId?: string;
  headRepositoryId?: string | null;
  [key: string]: unknown;
}

interface GraphQLBody {
  query?: unknown;
  variables?: {
    input?: CreatePullRequestInput;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * When gh CLI runs with GH_HOST pointing at this proxy it cannot match git
 * remotes (which reference github.com) to the configured host, so it cannot
 * determine the head repository from git context.  It therefore omits
 * headRepositoryId from the createPullRequest input, which GitHub rejects with
 * "Head repository can't be blank".
 *
 * Fix: if headRepositoryId is absent or null and repositoryId is present,
 * default headRepositoryId to repositoryId (same-repository PR, not a fork).
 */
export function transformCreatePullRequest(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;

  const gql = body as GraphQLBody;
  if (typeof gql.query !== "string") return body;

  const query = gql.query.trimStart();
  if (!query.startsWith("mutation")) return body;
  if (!query.includes("createPullRequest")) return body;

  const input = gql.variables?.input;
  if (!input || typeof input !== "object") return body;
  if (input.headRepositoryId != null) return body;
  if (typeof input.repositoryId !== "string") return body;

  return {
    ...gql,
    variables: {
      ...gql.variables,
      input: {
        ...input,
        headRepositoryId: input.repositoryId,
      },
    },
  };
}
