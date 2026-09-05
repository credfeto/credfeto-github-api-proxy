import { describe, it, expect } from "vitest";
import { rewriteEmbeddedApiGithubUrls, rewriteJsonResponseBody, rewriteResponseHeaders } from "../rewrite-urls.js";

const PROXY_ORIGIN = "https://proxy.example.com";

describe("rewriteEmbeddedApiGithubUrls", () => {
  it("rewrites a bare api.github.com URL preserving path and query", () => {
    const result = rewriteEmbeddedApiGithubUrls(
      "https://api.github.com/repos/alice/myrepo/issues?page=2",
      PROXY_ORIGIN,
    );
    expect(result).toBe(`${PROXY_ORIGIN}/repos/alice/myrepo/issues?page=2`);
  });

  it("rewrites multiple URLs embedded in one string (Link header shape)", () => {
    const input =
      '<https://api.github.com/repos/alice/myrepo/issues?page=2>; rel="next", <https://api.github.com/repos/alice/myrepo/issues?page=5>; rel="last"';
    const result = rewriteEmbeddedApiGithubUrls(input, PROXY_ORIGIN);
    expect(result).toBe(
      `<${PROXY_ORIGIN}/repos/alice/myrepo/issues?page=2>; rel="next", <${PROXY_ORIGIN}/repos/alice/myrepo/issues?page=5>; rel="last"`,
    );
  });

  it("rewrites a URL with an explicit port", () => {
    const result = rewriteEmbeddedApiGithubUrls("https://api.github.com:443/repos/alice/myrepo", PROXY_ORIGIN);
    expect(result).toBe(`${PROXY_ORIGIN}:443/repos/alice/myrepo`);
  });

  it("rewrites a bare host with no trailing path", () => {
    const result = rewriteEmbeddedApiGithubUrls("https://api.github.com", PROXY_ORIGIN);
    expect(result).toBe(PROXY_ORIGIN);
  });

  it("leaves html_url (github.com web host) untouched", () => {
    const input = "https://github.com/alice/myrepo/issues/1";
    expect(rewriteEmbeddedApiGithubUrls(input, PROXY_ORIGIN)).toBe(input);
  });

  it("leaves a lookalike host that merely starts with api.github.com untouched", () => {
    const input = "https://api.github.com.evil.com/phish";
    expect(rewriteEmbeddedApiGithubUrls(input, PROXY_ORIGIN)).toBe(input);
  });

  it("leaves plain text with no URL untouched", () => {
    expect(rewriteEmbeddedApiGithubUrls("no urls here", PROXY_ORIGIN)).toBe("no urls here");
  });

  it("treats a proxyOrigin containing $-patterns as a literal replacement, not a substitution token", () => {
    const trickyOrigin = "https://evil$&$1$`$'.example.com";
    const result = rewriteEmbeddedApiGithubUrls("https://api.github.com/repos/alice/myrepo", trickyOrigin);
    expect(result).toBe(`${trickyOrigin}/repos/alice/myrepo`);
  });
});

describe("rewriteJsonResponseBody — URL rewriting", () => {
  it("rewrites a top-level field", () => {
    const body = Buffer.from(JSON.stringify({ url: "https://api.github.com/repos/alice/myrepo" }));
    const result = rewriteJsonResponseBody(body, PROXY_ORIGIN, undefined);
    expect(JSON.parse(result.toString("utf8"))).toStrictEqual({ url: `${PROXY_ORIGIN}/repos/alice/myrepo` });
  });

  it("rewrites a nested field", () => {
    const body = Buffer.from(
      JSON.stringify({ subject: { url: "https://api.github.com/notifications/threads/1" } }),
    );
    const result = rewriteJsonResponseBody(body, PROXY_ORIGIN, undefined);
    expect(JSON.parse(result.toString("utf8"))).toStrictEqual({
      subject: { url: `${PROXY_ORIGIN}/notifications/threads/1` },
    });
  });

  it("rewrites values embedded in arrays", () => {
    const body = Buffer.from(
      JSON.stringify([{ url: "https://api.github.com/repos/alice/myrepo/issues/1" }]),
    );
    const result = rewriteJsonResponseBody(body, PROXY_ORIGIN, undefined);
    expect(JSON.parse(result.toString("utf8"))).toStrictEqual([
      { url: `${PROXY_ORIGIN}/repos/alice/myrepo/issues/1` },
    ]);
  });

  it("leaves html_url untouched alongside a rewritten url field", () => {
    const body = Buffer.from(
      JSON.stringify({
        url: "https://api.github.com/repos/alice/myrepo/issues/1",
        html_url: "https://github.com/alice/myrepo/issues/1",
      }),
    );
    const result = rewriteJsonResponseBody(body, PROXY_ORIGIN, undefined);
    expect(JSON.parse(result.toString("utf8"))).toStrictEqual({
      url: `${PROXY_ORIGIN}/repos/alice/myrepo/issues/1`,
      html_url: "https://github.com/alice/myrepo/issues/1",
    });
  });

  it("returns the original buffer unchanged when malformed JSON is given", () => {
    const body = Buffer.from("not json{");
    expect(rewriteJsonResponseBody(body, PROXY_ORIGIN, undefined)).toBe(body);
  });

  it("returns the original buffer unchanged for a top-level JSON primitive", () => {
    const body = Buffer.from(JSON.stringify("just a string"));
    expect(rewriteJsonResponseBody(body, PROXY_ORIGIN, undefined)).toBe(body);
  });

  it("returns the original buffer unchanged when nothing needed rewriting", () => {
    const body = Buffer.from(JSON.stringify({ html_url: "https://github.com/alice/myrepo" }));
    expect(rewriteJsonResponseBody(body, PROXY_ORIGIN, undefined)).toBe(body);
  });
});

const ADMIN_MERGE_QUERY = "query { repository(owner:\"a\",name:\"b\"){ pullRequest(number:1){ viewerCanMergeAsAdmin } } }";

describe("rewriteJsonResponseBody — admin-merge masking", () => {
  it("forces a top-level viewerCanMergeAsAdmin:true to false", () => {
    const body = Buffer.from(JSON.stringify({ viewerCanMergeAsAdmin: true }));
    const result = rewriteJsonResponseBody(body, PROXY_ORIGIN, ADMIN_MERGE_QUERY);
    expect(JSON.parse(result.toString("utf8"))).toStrictEqual({ viewerCanMergeAsAdmin: false });
  });

  it("forces a deeply nested viewerCanMergeAsAdmin:true to false", () => {
    const body = Buffer.from(
      JSON.stringify({
        data: { repository: { pullRequest: { number: 7, viewerCanMergeAsAdmin: true } } },
      }),
    );
    const result = rewriteJsonResponseBody(body, PROXY_ORIGIN, ADMIN_MERGE_QUERY);
    expect(JSON.parse(result.toString("utf8"))).toStrictEqual({
      data: { repository: { pullRequest: { number: 7, viewerCanMergeAsAdmin: false } } },
    });
  });

  it("forces viewerCanMergeAsAdmin:true inside an array", () => {
    const body = Buffer.from(
      JSON.stringify({ nodes: [{ viewerCanMergeAsAdmin: true }, { viewerCanMergeAsAdmin: false }] }),
    );
    const result = rewriteJsonResponseBody(body, PROXY_ORIGIN, ADMIN_MERGE_QUERY);
    expect(JSON.parse(result.toString("utf8"))).toStrictEqual({
      nodes: [{ viewerCanMergeAsAdmin: false }, { viewerCanMergeAsAdmin: false }],
    });
  });

  it("leaves viewerCanMergeAsAdmin:false untouched (no unnecessary rewrite)", () => {
    const body = Buffer.from(JSON.stringify({ viewerCanMergeAsAdmin: false }));
    expect(rewriteJsonResponseBody(body, PROXY_ORIGIN, ADMIN_MERGE_QUERY)).toBe(body);
  });

  it("fires even when the body has no api.github.com URL in it", () => {
    const body = Buffer.from(JSON.stringify({ viewerCanMergeAsAdmin: true, number: 1 }));
    expect(body.includes("api.github.com")).toBe(false);
    const result = rewriteJsonResponseBody(body, PROXY_ORIGIN, ADMIN_MERGE_QUERY);
    expect(JSON.parse(result.toString("utf8")).viewerCanMergeAsAdmin).toBe(false);
  });

  it("returns the original buffer unchanged when the field is absent", () => {
    const body = Buffer.from(JSON.stringify({ number: 1 }));
    expect(rewriteJsonResponseBody(body, PROXY_ORIGIN, ADMIN_MERGE_QUERY)).toBe(body);
  });

  it("returns the original buffer unchanged for malformed JSON", () => {
    const body = Buffer.from("not json{ viewerCanMergeAsAdmin");
    expect(rewriteJsonResponseBody(body, PROXY_ORIGIN, ADMIN_MERGE_QUERY)).toBe(body);
  });

  it("masks an aliased viewerCanMergeAsAdmin field (query aliasing bypass)", () => {
    const query = 'query { repository(owner:"a",name:"b"){ pullRequest(number:1){ x: viewerCanMergeAsAdmin } } }';
    const body = Buffer.from(JSON.stringify({ data: { repository: { pullRequest: { x: true } } } }));
    const result = rewriteJsonResponseBody(body, PROXY_ORIGIN, query);
    expect(JSON.parse(result.toString("utf8"))).toStrictEqual({
      data: { repository: { pullRequest: { x: false } } },
    });
  });

  it("does not mask an unrelated field that merely shares the alias name", () => {
    const body = Buffer.from(JSON.stringify({ x: true }));
    expect(rewriteJsonResponseBody(body, PROXY_ORIGIN, undefined)).toBe(body);
  });

  it("masks an aliased field even when a GraphQL comment splits the alias from the field name (comment-interrupted alias bypass)", () => {
    const query =
      'query { repository(owner:"a",name:"b"){ pullRequest(number:1){ x: #hide\n viewerCanMergeAsAdmin } } }';
    const body = Buffer.from(JSON.stringify({ data: { repository: { pullRequest: { x: true } } } }));
    const result = rewriteJsonResponseBody(body, PROXY_ORIGIN, query);
    expect(JSON.parse(result.toString("utf8"))).toStrictEqual({
      data: { repository: { pullRequest: { x: false } } },
    });
  });
});

describe("rewriteResponseHeaders", () => {
  it("rewrites a string header value", () => {
    const headers = { location: "https://api.github.com/repos/alice/myrepo/issues/1" };
    const result = rewriteResponseHeaders(headers, PROXY_ORIGIN);
    expect(result.location).toBe(`${PROXY_ORIGIN}/repos/alice/myrepo/issues/1`);
  });

  it("rewrites each entry of a multi-value header", () => {
    const headers = {
      link: [
        '<https://api.github.com/repos/alice/myrepo/issues?page=2>; rel="next"',
        '<https://api.github.com/repos/alice/myrepo/issues?page=5>; rel="last"',
      ],
    };
    const result = rewriteResponseHeaders(headers, PROXY_ORIGIN);
    expect(result.link).toStrictEqual([
      `<${PROXY_ORIGIN}/repos/alice/myrepo/issues?page=2>; rel="next"`,
      `<${PROXY_ORIGIN}/repos/alice/myrepo/issues?page=5>; rel="last"`,
    ]);
  });

  it("leaves unrelated headers untouched", () => {
    const headers = { "content-type": "application/json", "x-ratelimit-remaining": "59" };
    const result = rewriteResponseHeaders(headers, PROXY_ORIGIN);
    expect(result).toStrictEqual(headers);
  });

  it("preserves an undefined-valued header entry", () => {
    const headers = { "content-type": "application/json", "if-none-match": undefined };
    const result = rewriteResponseHeaders(headers, PROXY_ORIGIN);
    expect(result["if-none-match"]).toBeUndefined();
  });
});
