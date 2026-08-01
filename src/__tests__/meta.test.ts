import { describe, it, expect } from "vitest";
import { injectInstalledVersion } from "../meta.js";

function json(obj: unknown): Buffer {
  return Buffer.from(JSON.stringify(obj), "utf8");
}

describe("injectInstalledVersion", () => {
  it("adds installed_version when the field is absent", () => {
    const body = json({ verifiable_password_authentication: true });
    const result = JSON.parse(injectInstalledVersion(body).toString("utf8")) as Record<string, unknown>;
    expect(result.installed_version).toBe("3.30.0");
    expect(result.verifiable_password_authentication).toBe(true);
  });

  it("replaces installed_version when it is an empty string", () => {
    const body = json({ installed_version: "" });
    const result = JSON.parse(injectInstalledVersion(body).toString("utf8")) as Record<string, unknown>;
    expect(result.installed_version).toBe("3.30.0");
  });

  it("leaves an already-present non-empty installed_version untouched", () => {
    const body = json({ installed_version: "3.15.0" });
    const result = JSON.parse(injectInstalledVersion(body).toString("utf8")) as Record<string, unknown>;
    expect(result.installed_version).toBe("3.15.0");
  });

  it("returns malformed (non-JSON) bodies unchanged", () => {
    const body = Buffer.from("not json", "utf8");
    expect(injectInstalledVersion(body)).toBe(body);
  });

  it("returns non-object JSON bodies unchanged", () => {
    const body = json(["a", "b"]);
    expect(injectInstalledVersion(body)).toBe(body);
  });

  it("returns a JSON null body unchanged", () => {
    const body = json(null);
    expect(injectInstalledVersion(body)).toBe(body);
  });

  it("preserves all other fields of a realistic /meta response", () => {
    const body = json({
      verifiable_password_authentication: false,
      github_services_sha: "abc123",
      hooks: ["192.30.252.0/22"],
    });
    const result = JSON.parse(injectInstalledVersion(body).toString("utf8")) as Record<string, unknown>;
    expect(result.verifiable_password_authentication).toBe(false);
    expect(result.github_services_sha).toBe("abc123");
    expect(result.hooks).toStrictEqual(["192.30.252.0/22"]);
    expect(result.installed_version).toBe("3.30.0");
  });
});
