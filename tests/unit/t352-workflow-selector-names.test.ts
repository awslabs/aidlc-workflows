// covers: function:resolveWorkflowSelection,
// subcommand:aidlc-utility:scope-save, subcommand:aidlc-utility:status
//
// t352 - an explicit --space or --intent is one name. It becomes a path
// segment, so a "../" could otherwise reach a record outside the project. The
// shared resolver refuses a path for every command before anything is read or
// written; every single name still resolves as before.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolveWorkflowSelection } from "../../core/tools/aidlc-lib.ts";
import { cleanupTestProject, createTestProject, setupIntegrationProject } from "../harness/fixtures.ts";

const BUN = process.execPath;
const tempDirs: string[] = [];
const outside: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) cleanupTestProject(tempDirs.pop()!);
  while (outside.length > 0) rmSync(outside.pop()!, { recursive: true, force: true });
});

/** Run one of the project's own tools, with no fixture seams leaking in. */
function runTool(proj: string, tool: string, args: string[]): { status: number; out: string } {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: proj };
  for (const key of ["AIDLC_SCOPE_MAPPING", "AIDLC_SCOPE_GRID", "AIDLC_SCOPES_DIR", "AIDLC_COMPOSED_SCOPES_DIR", "AIDLC_STAGE_GRAPH"]) {
    delete env[key];
  }
  const res = spawnSync(BUN, [join(proj, ".claude", "tools", tool), ...args, "--project-dir", proj], {
    encoding: "utf-8",
    env,
  });
  return { status: res.status ?? 1, out: `${res.stdout}${res.stderr}` };
}

describe("t352 (1) the resolver takes one name per selector", () => {
  test("a path in --space or --intent is refused, and engine-minted names resolve", () => {
    const proj = createTestProject();
    tempDirs.push(proj);
    // A backslash separates only on Windows; elsewhere it is part of a name.
    const backslashed = process.platform === "win32" ? ["a\\b", "..\\x"] : [];
    for (const space of ["../other", "a/b", "..", ".", ...backslashed]) {
      expect(() => resolveWorkflowSelection(proj, { space }), space).toThrow("is not a space name: it is a path.");
    }
    for (const intent of ["../../outside", "a/b", "..", ".", ...backslashed]) {
      expect(() => resolveWorkflowSelection(proj, { intent }), intent).toThrow("is not an intent name: it is a path.");
    }
    if (process.platform !== "win32") {
      expect(resolveWorkflowSelection(proj, { intent: "back\\slash" }).intent).toBe("back\\slash");
    }
    // Any single name still resolves as before, however it is spelled, and an
    // empty intent is still the legacy flat record.
    expect(resolveWorkflowSelection(proj, { space: "teamB" }).space).toBe("teamB");
    expect(resolveWorkflowSelection(proj, { intent: "" }).intent).toBe("");
    expect(resolveWorkflowSelection(proj, { space: "default", intent: "260928-date-parser" })).toMatchObject({
      space: "default",
      intent: "260928-date-parser",
    });
    expect(resolveWorkflowSelection(proj, { intent: "3f2a9c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c" }).intent).toBe(
      "3f2a9c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c",
    );
  });
});

describe("t352 (2) no command reads or writes through a path selector", () => {
  function projectWithOutsideRecord(): { proj: string; traversal: string; outsideAudit: string } {
    const proj = setupIntegrationProject({ noAidlcDocs: true, stripEnvScope: true });
    tempDirs.push(proj);
    const created = runTool(proj, "aidlc-utility.ts", [
      "intent-create", "--scope", "bugfix", "--arguments=fix the flaky date parser", "--label", "date parser",
    ]);
    expect(created.status, created.out).toBe(0);
    // A copy of the record beside the project, which "../" selectors reach.
    const intents = join(proj, "aidlc", "spaces", "default", "intents");
    const record = readdirSync(intents).find((name) => existsSync(join(intents, name, "aidlc-state.md")))!;
    const target = join(dirname(proj), `${basename(proj)}-outside`);
    cpSync(join(intents, record), target, { recursive: true });
    outside.push(target);
    return {
      proj,
      traversal: `../../../../${basename(target)}`,
      outsideAudit: join(target, "audit"),
    };
  }
  const auditText = (dir: string) =>
    existsSync(dir) ? readdirSync(dir).map((file) => readFileSync(join(dir, file), "utf-8")).join("\n") : "";

  test("scope save refuses a path selector, directly and through the engine dispatcher", () => {
    const { proj, traversal, outsideAudit } = projectWithOutsideRecord();
    const auditBefore = auditText(outsideAudit);
    const attempts: Array<[string, string[]]> = [
      ["aidlc-utility.ts", ["scope-save", "--name", "quick-fix", "--intent", traversal]],
      ["aidlc-utility.ts", ["scope-save", "--name", "quick-fix", "--space", "../../.."]],
      ["aidlc.ts", ["engine", "scope", "save", "--name", "quick-fix", "--intent", traversal]],
      ["aidlc.ts", ["engine", "scope", "save", "--name", "quick-fix", "--space", "../../.."]],
    ];
    for (const [tool, args] of attempts) {
      const res = runTool(proj, tool, args);
      expect(res.status, `${tool} ${args.join(" ")}\n${res.out}`).not.toBe(0);
      expect(res.out, args.join(" ")).toMatch(/is not an? (intent|space) name/);
    }
    // Nothing was saved in the project, and the outside record's audit is untouched.
    expect(existsSync(join(proj, "aidlc", "scopes", "quick-fix.md"))).toBe(false);
    expect(readdirSync(join(proj, ".claude", "scopes"))).not.toContain("aidlc-quick-fix.md");
    expect(auditText(outsideAudit)).toBe(auditBefore);
  });

  test("any other command that takes the selectors refuses them too", () => {
    const { proj, traversal } = projectWithOutsideRecord();
    const status = runTool(proj, "aidlc-utility.ts", ["status", "--intent", traversal]);
    expect(status.status).not.toBe(0);
    expect(status.out).toContain("is not an intent name");
  });
});
