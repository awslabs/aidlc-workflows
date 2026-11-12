// covers: function:renderRunner, function:rewriteNativeOnboarding
//
// Text the tools generate into an install names only what that harness has:
//   - a scope runner (renderRunner in aidlc-runner-gen.ts) asks with the
//     protocol's own "structured question", which each harness's
//     question-rendering annex binds to its own tool, and names no one
//     harness's tool (it said AskUserQuestion, Claude Code's, on all seven);
//   - the native onboarding's Permissions line written for Kiro's `aidlc` agent
//     (rewriteNativeOnboarding in scripts/package.ts) stays on the trees that
//     ship that agent; Cursor and opencode keep their own bullet, the one their
//     copy install shows, and Codex gets its own bullet without the
//     copy-channel scripts.
// Read from the shipped and released trees the packager wrote.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

const read = (path: string): string => readFileSync(path, "utf-8").replace(/\r\n/g, "\n");

function files(root: string, pattern: RegExp): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...files(path, pattern));
    else if (pattern.test(entry.name)) out.push(path);
  }
  return out;
}

const permissionsBullets = (root: string): string[] => [
  ...new Set(files(root, /\.(?:mdc?|toml)$/).flatMap((file) => read(file).match(/^- \*\*Permissions\*\*:.*$/gm) ?? [])),
];

describe("t-generated-text-names-what-the-harness-has", () => {
  test.each(HARNESS_MATRIX.map((harness) => [harness.name, harness] as const))(
    "%s: no scope runner names one harness's question tool",
    (_name, harness) => {
      const runners = files(harness.distRoot, /^SKILL\.md$/).filter((file) =>
        read(file).includes("generated-by: aidlc-runner-gen"),
      );
      expect(runners.length).toBeGreaterThan(0);
      const named = runners
        .filter((file) => /AskUserQuestion|request_user_input/.test(read(file)))
        .map((file) => relative(harness.distRoot, file));
      expect(named).toEqual([]);
    },
  );

  test.each(
    HARNESS_MATRIX.filter((harness) => harness.name === "cursor" || harness.name === "opencode").map(
      (harness) => [harness.name, harness] as const,
    ),
  )("%s: the native install keeps the harness's own Permissions bullet", (name, harness) => {
    const release = join(REPO_ROOT, "dist-release", name);
    expect(existsSync(release)).toBe(true);
    const native = permissionsBullets(release);
    expect(native.length).toBeGreaterThan(0);
    for (const bullet of native) expect(bullet).not.toContain("the `aidlc` agent");
    expect(native).toEqual(permissionsBullets(harness.distRoot));
  });

  test("codex: the native install names its own rules file, the engine prefix and the git commands it allows", () => {
    const native = permissionsBullets(join(REPO_ROOT, "dist-release", "codex"));
    expect(native.length).toBe(1);
    expect(native[0]).not.toContain("the `aidlc` agent");
    expect(native[0]).toContain("`.codex/rules/default.rules`");
    expect(native[0]).toContain("`aidlc engine ...` and `git worktree`/`commit`/`add`");
    expect(native[0]).not.toContain("bun ");
    const rules = read(join(REPO_ROOT, "dist-release", "codex", ".codex", "rules", "default.rules"));
    for (const allowed of ['["aidlc", "engine"]', '["git", "worktree"]', '["git", "commit"]', '["git", "add"]']) {
      expect(rules).toContain(allowed);
    }
  });

  test.each(
    HARNESS_MATRIX.filter((harness) => harness.manifest.tierFlavor === "kiro").map(
      (harness) => [harness.name, harness] as const,
    ),
  )("%s: the native install names the aidlc agent it ships", (name) => {
    const native = permissionsBullets(join(REPO_ROOT, "dist-release", name));
    expect(native.length).toBeGreaterThan(0);
    for (const bullet of native) expect(bullet).toContain("the `aidlc` agent pre-approves");
  });
});
