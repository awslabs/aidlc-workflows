// On a native install the skill's scripts run as `BUN_BE_BUN=1 aidlc <script>`.
// The doctor run they start must not inherit that switch, or the nested
// `aidlc doctor` starts Bun instead of AI-DLC and the doctor findings are lost.
// Also which harness tree doctor checks, and which tree's tools the skill takes
// AI-DLC's own Kiro policy reader from.

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorEnv, importKiroPolicyReader, ownTree } from "../../core/skills/aidlc-issue-report/scripts/lib-project.ts";

const AIDLC_EXE = "/home/u/.local/share/aidlc/versions/2.11.2/aidlc";

test("a native aidlc doctor does not inherit BUN_BE_BUN", () => {
  const env = doctorEnv(["/home/u/.local/bin/aidlc"], AIDLC_EXE, { BUN_BE_BUN: "1", PATH: "/usr/bin" });
  expect(env.BUN_BE_BUN).toBeUndefined();
  expect(env.PATH).toBe("/usr/bin");
});

test("a copied tree's aidlc.ts run by the aidlc executable gets it", () => {
  const env = doctorEnv([AIDLC_EXE, ".kiro/tools/aidlc.ts"], AIDLC_EXE, {});
  expect(env.BUN_BE_BUN).toBe("1");
});

test("a copied tree's aidlc.ts run by bun needs no switch", () => {
  const env = doctorEnv(["/opt/homebrew/bin/bun", ".kiro/tools/aidlc.ts"], "/opt/homebrew/bin/bun", { BUN_BE_BUN: "1" });
  expect(env.BUN_BE_BUN).toBeUndefined();
});

test("the doctor child gets the project on its command line, not the AI tool's own project folder", () => {
  const env = doctorEnv(["/home/u/.local/bin/aidlc"], AIDLC_EXE, { CLAUDE_PROJECT_DIR: "/home/u/mono", AIDLC_PROJECT_DIR: "/home/u/mono", PATH: "/usr/bin" });
  expect(env.CLAUDE_PROJECT_DIR).toBeUndefined();
  expect(env.AIDLC_PROJECT_DIR).toBeUndefined();
  expect(env.PATH).toBe("/usr/bin");
});

test("a tool's version is asked without BUN_BE_BUN", async () => {
  if (process.platform === "win32") return;
  const { chmodSync, mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { versionOf } = await import("../../core/skills/aidlc-issue-report/scripts/lib-project.ts");
  const tool = join(mkdtempSync(join(tmpdir(), "version-env-")), "tool");
  writeFileSync(tool, ["#!/bin/sh", 'echo "1.2.3 $' + '{BUN_BE_BUN:-unset}"', ""].join("\n"));
  chmodSync(tool, 0o755);
  const before = process.env.BUN_BE_BUN;
  process.env.BUN_BE_BUN = "1";
  try {
    expect(versionOf(tool, ["--version"])).toBe("1.2.3 unset");
  } finally {
    if (before === undefined) delete process.env.BUN_BE_BUN;
    else process.env.BUN_BE_BUN = before;
  }
});

test("doctor is told the harness tree to check, and no harness name of the AI tool's own reaches it", () => {
  const env = doctorEnv(["/home/u/.local/bin/aidlc"], AIDLC_EXE, { AIDLC_HARNESS_DIR: ".claude", AIDLC_HARNESS_NAME: "claude" }, ".kiro");
  expect([env.AIDLC_HARNESS_DIR, env.AIDLC_HARNESS_NAME]).toEqual([".kiro", undefined]);
  expect(doctorEnv(["/home/u/.local/bin/aidlc"], AIDLC_EXE, { AIDLC_HARNESS_DIR: ".claude" }).AIDLC_HARNESS_DIR).toBeUndefined();
});

test("doctor checks the harness tree the skill runs from; elsewhere, the first", () => {
  const trees = [{ dir: ".claude" }, { dir: ".codex" }, { dir: ".kiro" }, { dir: ".aidlc" }];
  const at = (rel: string) => ownTree(trees, "/p", `/p/${rel}`)?.dir;
  expect(at(".kiro/skills/aidlc-issue-report/scripts")).toBe(".kiro");
  expect(at(".agents/skills/aidlc-issue-report/scripts")).toBe(".codex");
  expect(at(".github/skills/aidlc-issue-report/scripts")).toBe(".aidlc");
  expect(ownTree(trees, "/p", "/home/u/skills/aidlc-issue-report/scripts")?.dir).toBe(".claude");
  expect(at(".cursor/skills/aidlc-issue-report/scripts")).toBe(".claude");
});

test("Kiro CLI's policy reader comes from the harness tree the skill runs from, else from another tree that has it", async () => {
  const project = mkdtempSync(join(tmpdir(), "kiro-policy-reader-"));
  const none = mkdtempSync(join(tmpdir(), "kiro-policy-none-"));
  const real = mkdtempSync(join(tmpdir(), "kiro-policy-real-"));
  try {
    const tool = (dir: string, body: string) => {
      mkdirSync(join(project, dir, "tools"), { recursive: true });
      writeFileSync(join(project, dir, "tools", "aidlc-kiro-chat-record.ts"), body);
    };
    const skill = (dir: string) => join(project, dir, "skills", "aidlc-issue-report", "scripts");
    // An older .claude install without the reader, an older .codex one whose reader answers no, and the .kiro one,
    // which answers yes, null, in another shape, or throws.
    tool(".claude", "export const other = 1;\n");
    tool(".codex", "export const kiroPoliciesApproveForMe = () => false;\n");
    tool(".kiro", "const answers: Record<string, unknown> = { yes: true, null: null, odd: 'yes' };\nexport const kiroPoliciesApproveForMe = (dirs: string[]) => { if (!(dirs[0] in answers)) throw new Error('x'); return answers[dirs[0]]; };\n");
    const kiro = await importKiroPolicyReader(project, skill(".kiro"));
    expect([kiro?.(["yes"]), kiro?.(["null"]), kiro?.(["odd"]), kiro?.(["throws"])]).toEqual([true, null, undefined, undefined]);
    expect((await importKiroPolicyReader(project, join(project, ".agents", "skills", "aidlc-issue-report", "scripts")))?.(["yes"])).toBe(false);
    // The .claude tree has none, so the next tree that has one answers.
    expect((await importKiroPolicyReader(project, skill(".claude")))?.(["yes"])).toBe(true);
    expect(await importKiroPolicyReader(none, skill(".kiro"))).toBeUndefined();
    // The installed tools' own file carries the reader under the name the skill looks for, and it reads the policy.
    mkdirSync(join(real, ".kiro", "tools"), { recursive: true });
    writeFileSync(join(real, ".kiro", "tools", "aidlc-kiro-chat-record.ts"), readFileSync(join(import.meta.dir, "../../core/tools/aidlc-kiro-chat-record.ts")));
    mkdirSync(join(real, "workspace"));
    writeFileSync(join(real, "workspace", "permissions.yaml"), "rules: []\npolicies:\n  - approve-for-me\n");
    expect((await importKiroPolicyReader(real, join(real, ".kiro", "skills", "aidlc-issue-report", "scripts")))?.([join(real, "workspace")])).toBe(true);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(none, { recursive: true, force: true });
    rmSync(real, { recursive: true, force: true });
  }
});
