// covers: function:workspaceSourceFingerprint, function:isIncidentalArtifactName
//
// The plan-approval source floor is a filesystem walk that hashes every path it
// finds and refuses stage completion when a path changed that no reviewed unit's
// manifest claims (RFC #662). Before this change the walk had no OS/editor
// artifact exclusion, so an incidental `.DS_Store` or an editor swap file caused
// spurious drift and forced re-approval (#1099). This pins a small, vendor-neutral
// exclusion of never-source OS/editor artifacts — and, critically, that it does
// NOT over-reach: a real source file still moves the fingerprint, and a Git-ignored
// *source* file stays bound (the walk deliberately binds ignored application
// source; gitignore is not its exclusion boundary — see t314).

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspaceSourceFingerprint } from "../../core/tools/aidlc-lib.ts";
import { cleanupTestProject, createTestProject } from "../harness/fixtures.ts";

const created: string[] = [];
afterEach(() => {
  while (created.length) cleanupTestProject(created.pop());
});

function sourceProject(): string {
  const project = createTestProject();
  created.push(project);
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "main.ts"), "export const main = 1;\n");
  return project;
}

const fp = (project: string): string | null =>
  workspaceSourceFingerprint(project);

describe("t345 source-floor OS/editor-artifact exclusion (#1099)", () => {
  test("incidental OS/editor artifacts do not move the fingerprint", () => {
    const project = sourceProject();
    const base = fp(project);
    expect(base).not.toBeNull();

    // OS droppings at root and nested; editor swap/backup files.
    writeFileSync(join(project, ".DS_Store"), "\0\0");
    writeFileSync(join(project, "src", ".DS_Store"), "\0\0");
    writeFileSync(join(project, "Thumbs.db"), "x");
    writeFileSync(join(project, "desktop.ini"), "x");
    writeFileSync(join(project, "src", "main.ts.swp"), "x");
    writeFileSync(join(project, "src", "main.ts~"), "x");

    expect(fp(project)).toBe(base);
  });

  test("a real source file still moves the fingerprint (guard still fires)", () => {
    const project = sourceProject();
    const base = fp(project);
    writeFileSync(join(project, "src", "other.ts"), "export const x = 2;\n");
    expect(fp(project)).not.toBe(base);
  });

  test("a Git-ignored SOURCE file is still bound (gitignore is not the boundary)", () => {
    // The walk deliberately binds ignored application source (t314). The artifact
    // exclusion must NOT reach into that: a gitignored .ts is not an OS artifact,
    // so it stays bound — changing it must still move the fingerprint.
    const project = sourceProject();
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
    const git = (args: string[]) =>
      spawnSync("git", ["-C", project, ...args], { env, encoding: "utf-8" });
    git(["init"]);
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "t"]);
    writeFileSync(join(project, ".gitignore"), "ignored-source.ts\n", "utf-8");
    const ignored = join(project, "ignored-source.ts");
    writeFileSync(ignored, "export const ignored = 1;\n");
    const base = fp(project);
    expect(base).not.toBeNull();

    writeFileSync(ignored, "export const ignored = 2;\n");
    expect(fp(project)).not.toBe(base);
  });
});
