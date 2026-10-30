import { describe, expect, it } from "vitest";
import { parseMutationRootFields } from "../graphql-parse.js";

describe("parseMutationRootFields", () => {
  it("returns null for a document that cannot be parsed", () => {
    expect(parseMutationRootFields("mutation { updateRef(input: {}) { ref { id } }")).toBeNull();
  });

  it("returns an empty set for a query-only document", () => {
    expect(parseMutationRootFields("query { viewer { login } }")).toEqual(new Set<string>());
  });

  it("returns root field names, not aliases or nested fields", () => {
    expect(
      parseMutationRootFields("mutation { harmless: updateRef(input: {}) { ref { createRef } } }"),
    ).toEqual(new Set(["updateRef"]));
  });

  it("collects root fields from every mutation operation in the document", () => {
    expect(
      parseMutationRootFields("query Q { viewer { login } } mutation A { addComment } mutation B { createRef }"),
    ).toEqual(new Set(["addComment", "createRef"]));
  });

  it("follows inline fragments and fragment spreads", () => {
    expect(
      parseMutationRootFields(
        "mutation { ... on Mutation { createRef } ...F } fragment F on Mutation { deleteRef }",
      ),
    ).toEqual(new Set(["createRef", "deleteRef"]));
  });

  it("ignores a spread of an undefined fragment", () => {
    expect(parseMutationRootFields("mutation { addComment ...Missing }")).toEqual(new Set(["addComment"]));
  });

  it("terminates on a fragment cycle", () => {
    expect(
      parseMutationRootFields(
        "mutation { ...A } fragment A on Mutation { createRef ...B } fragment B on Mutation { deleteRef ...A }",
      ),
    ).toEqual(new Set(["createRef", "deleteRef"]));
  });
});
