// covers: function:workspaceManifestAt, file:core/tools/aidlc-workspace-manifest.ts
//
// The workspace's repo list lives in aidlc/repos.json from 2.12, and a root
// repos.json an older AI-DLC wrote is still read: one order of places for every
// reader, on disk and at a commit of a workspace that is not here.

import { describe, expect, test } from "bun:test";
import {
  REPOS_MANIFEST_PLACES,
  workspaceManifestAt,
} from "../../dist/claude/.claude/tools/aidlc-workspace-manifest.ts";

const list = (...names: string[]): string =>
  `${JSON.stringify({ repos: names.map((name) => ({ name })) }, null, 2)}\n`;

describe("where the repo list is read", () => {
  test("aidlc/repos.json comes first, then the root one", () => {
    expect([...REPOS_MANIFEST_PLACES]).toEqual(["aidlc/repos.json", "repos.json"]);
  });

  test("a reader given both places gets aidlc/'s list, with its text kept", () => {
    const files: Record<string, string> = { "aidlc/repos.json": list("billing"), "repos.json": list("storefront") };
    const found = workspaceManifestAt((rel) => files[rel] ?? null);
    expect(found?.path).toBe("aidlc/repos.json");
    expect(found?.text).toBe(files["aidlc/repos.json"]);
    expect(found?.manifest.repos.map((repo) => repo.name)).toEqual(["billing"]);
  });

  test("a root list alone is still read", () => {
    const found = workspaceManifestAt((rel) => (rel === "repos.json" ? list("storefront") : null));
    expect(found?.path).toBe("repos.json");
    expect(found?.manifest.repos.map((repo) => repo.name)).toEqual(["storefront"]);
  });

  test("no list in either place reads as none", () => {
    expect(workspaceManifestAt(() => null)).toBeNull();
  });

  test("an invalid list in the first place is an error, never the root list instead", () => {
    const files: Record<string, string> = { "aidlc/repos.json": "{ not json", "repos.json": list("storefront") };
    expect(() => workspaceManifestAt((rel) => files[rel] ?? null)).toThrow("repos.json is not valid JSON");
  });
});
