// On a native install the skill's scripts run as `BUN_BE_BUN=1 aidlc <script>`.
// The doctor run they start must not inherit that switch, or the nested
// `aidlc doctor` starts Bun instead of AI-DLC and the doctor findings are lost.

import { expect, test } from "bun:test";
import { doctorEnv } from "../../core/skills/aidlc-issue-report/scripts/lib-project.ts";

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
