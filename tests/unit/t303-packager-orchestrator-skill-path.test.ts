// covers: file:scripts/package.ts
//
// The packager refreshes generated table regions in the assembled orchestrator
// skill. The location is an open harness contract, not a hardcoded shortlist.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { HarnessManifest } from "../../scripts/manifest-types.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

describe("t303 manifest-owned orchestrator skill path", () => {
  test("every harness declares an in-tree emitted skill that exists in dist", async () => {
    const harnesses = readdirSync(join(REPO_ROOT, "harness"))
      .filter((name) => existsSync(join(REPO_ROOT, "harness", name, "manifest.ts")))
      .sort();

    for (const name of harnesses) {
      const module = await import(
        pathToFileURL(join(REPO_ROOT, "harness", name, "manifest.ts")).href
      ) as { default: HarnessManifest };
      const rel = module.default.orchestratorSkillPath;
      expect(rel).toBeDefined();
      if (!rel) throw new Error(`${name} does not declare orchestratorSkillPath`);
      expect(rel.length).toBeGreaterThan(0);
      expect(isAbsolute(rel)).toBe(false);
      expect(rel.split(/[\\/]/)).not.toContain("..");
      expect(existsSync(join(REPO_ROOT, "dist", name, rel))).toBe(true);
    }
  });

  test("package.ts resolves the optional manifest field with the in-tree default", () => {
    const source = readFileSync(join(REPO_ROOT, "scripts", "package.ts"), "utf-8");
    expect(source).toContain("manifest.orchestratorSkillPath");
    expect(source).toContain(
      'join(manifest.harnessDir, "skills", "aidlc", "SKILL.md")',
    );
    expect(source).not.toContain('join(projectRoot, ".agents", "skills", "aidlc"');
    expect(source).not.toContain('join(projectRoot, ".github", "skills", "aidlc"');
  });
});
