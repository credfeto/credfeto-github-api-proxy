import { describe, it, expect } from "vitest";
import { transformCreatePullRequest } from "../transform.js";

const CREATE_PR_MUTATION = `mutation CreatePullRequest($input: CreatePullRequestInput!) {
  createPullRequest(input: $input) {
    pullRequest { number url }
  }
}`;

const CREATE_ISSUE_MUTATION = `mutation CreateIssue($input: CreateIssueInput!) {
  createIssue(input: $input) {
    issue { number }
  }
}`;

const VIEWER_QUERY = `query { viewer { login } }`;

describe("transformCreatePullRequest — non-mutation passthrough", () => {
  it("passes through null unchanged", () => {
    expect(transformCreatePullRequest(null)).toBeNull();
  });

  it("passes through a string unchanged", () => {
    expect(transformCreatePullRequest("raw")).toBe("raw");
  });

  it("passes through a query (not a mutation) unchanged", () => {
    const body = { query: VIEWER_QUERY };
    expect(transformCreatePullRequest(body)).toBe(body);
  });

  it("passes through a non-createPullRequest mutation unchanged", () => {
    const body = {
      query: CREATE_ISSUE_MUTATION,
      variables: { input: { repositoryId: "R_base", title: "Bug" } },
    };
    expect(transformCreatePullRequest(body)).toBe(body);
  });

  it("passes through a body with no query field unchanged", () => {
    const body = { variables: { input: { repositoryId: "R_x" } } };
    expect(transformCreatePullRequest(body)).toBe(body);
  });
});

describe("transformCreatePullRequest — headRepositoryId missing", () => {
  it("sets headRepositoryId to repositoryId when headRepositoryId is absent", () => {
    const body = {
      query: CREATE_PR_MUTATION,
      variables: {
        input: {
          repositoryId: "R_base123",
          baseRefName: "main",
          headRefName: "feature/my-branch",
          title: "My PR",
          draft: true,
        },
      },
    };
    const result = transformCreatePullRequest(body) as typeof body;
    expect(result.variables.input.headRepositoryId).toBe("R_base123");
  });

  it("sets headRepositoryId to repositoryId when headRepositoryId is null", () => {
    const body = {
      query: CREATE_PR_MUTATION,
      variables: {
        input: {
          repositoryId: "R_base456",
          headRepositoryId: null,
          baseRefName: "main",
          headRefName: "feature/foo",
          title: "PR",
        },
      },
    };
    const result = transformCreatePullRequest(body) as typeof body;
    expect(result.variables.input.headRepositoryId).toBe("R_base456");
  });

  it("preserves all other input fields when transforming", () => {
    const body = {
      query: CREATE_PR_MUTATION,
      variables: {
        input: {
          repositoryId: "R_base789",
          baseRefName: "main",
          headRefName: "feature/bar",
          title: "My title",
          body: "My body",
          draft: false,
        },
      },
    };
    const result = transformCreatePullRequest(body) as typeof body;
    expect(result.variables.input.repositoryId).toBe("R_base789");
    expect(result.variables.input.baseRefName).toBe("main");
    expect(result.variables.input.headRefName).toBe("feature/bar");
    expect(result.variables.input.title).toBe("My title");
    expect(result.variables.input.body).toBe("My body");
    expect(result.variables.input.draft).toBe(false);
  });
});

describe("transformCreatePullRequest — headRepositoryId already set", () => {
  it("does not overwrite an existing headRepositoryId", () => {
    const body = {
      query: CREATE_PR_MUTATION,
      variables: {
        input: {
          repositoryId: "R_base",
          headRepositoryId: "R_fork",
          baseRefName: "main",
          headRefName: "feature/fork-branch",
          title: "Fork PR",
        },
      },
    };
    const result = transformCreatePullRequest(body) as typeof body;
    expect(result.variables.input.headRepositoryId).toBe("R_fork");
  });

  it("returns the same object reference when no transform is needed", () => {
    const body = {
      query: CREATE_PR_MUTATION,
      variables: {
        input: {
          repositoryId: "R_base",
          headRepositoryId: "R_fork",
          baseRefName: "main",
          headRefName: "feature/x",
          title: "X",
        },
      },
    };
    expect(transformCreatePullRequest(body)).toBe(body);
  });
});

describe("transformCreatePullRequest — missing input fields", () => {
  it("passes through when variables.input is absent", () => {
    const body = { query: CREATE_PR_MUTATION, variables: {} };
    expect(transformCreatePullRequest(body)).toBe(body);
  });

  it("passes through when variables is absent", () => {
    const body = { query: CREATE_PR_MUTATION };
    expect(transformCreatePullRequest(body)).toBe(body);
  });

  it("passes through when repositoryId is not a string", () => {
    const body = {
      query: CREATE_PR_MUTATION,
      variables: { input: { repositoryId: 42 } },
    };
    expect(transformCreatePullRequest(body)).toBe(body);
  });
});
