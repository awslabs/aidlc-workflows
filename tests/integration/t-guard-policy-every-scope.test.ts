// covers: function:guardPolicyAcceptsChanges, function:scopeDefinitionGuardPolicy, function:resolveGuardPolicy
//
// Guard Policy off holds whatever the scope is: a shipped scope, a plugin's
// scope, a composed plan, a saved composed scope, or a team's memory layer.
// Every case creates its work through the project's own installed tools, so the
// scope is read by the engine's own loader, and the policy through the one
// reader every changed-input check uses.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardPolicyAcceptsChanges } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { setupIntegrationProject } from "../harness/fixtures.ts";
import { buildPluginProjection, composePluginFixture } from "../harness/plugin-kit.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const PLUGIN_SCOPE = "test-pro-validation";
const temps: string[] = [];

afterAll(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// The project's OWN tools with no fixture seams, so scopes resolve the way they
// do for a person.
function runTool(proj: string, tool: string, args: string[]): { status: number; out: string } {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: proj };
  for (const key of ["AIDLC_SCOPE_MAPPING", "AIDLC_SCOPE_GRID", "AIDLC_SCOPES_DIR", "AIDLC_COMPOSED_SCOPES_DIR", "AIDLC_STAGE_GRAPH"]) {
    delete env[key];
  }
  const res = spawnSync(BUN, [join(proj, ".claude", "tools", tool), ...args, "--project-dir", proj], {
    encoding: "utf-8",
    env: env as Record<string, string>,
  });
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function create(proj: string, scope: string, extra: string[] = []): void {
  const made = runTool(proj, "aidlc-utility.ts", [
    "intent-create", "--scope", scope, "--arguments=fix the flaky date parser", "--label", `work on ${scope}`, ...extra,
  ]);
  expect(made.status, made.out).toBe(0);
}

function policyLine(proj: string): string {
  const intents = join(proj, "aidlc", "spaces", "default", "intents");
  const records = readdirSync(intents)
    .map((name) => join(intents, name))
    .filter((path) => existsSync(join(path, "aidlc-state.md")))
    .sort((a, b) => statSync(join(b, "aidlc-state.md")).mtimeMs - statSync(join(a, "aidlc-state.md")).mtimeMs);
  const state = readFileSync(join(records[0], "aidlc-state.md"), "utf-8");
  return /- \*\*Guard Policy\*\*: (.*)/.exec(state)?.[1] ?? "(no line)";
}

function effective(proj: string): string {
  const got = runTool(proj, "aidlc-utility.ts", ["config-get", "guard-policy"]);
  expect(got.status, got.out).toBe(0);
  return got.out.trim();
}

function declareMemory(proj: string, layer: "org" | "team" | "project", mode: string): void {
  const path = join(proj, "aidlc", "spaces", "default", "memory", `${layer}.md`);
  const content = readFileSync(path, "utf-8");
  const next = content.replace(/(## Guard Policy\n\n)<!--[\s\S]*?-->/, `$1Mode: ${mode}`);
  expect(next).not.toBe(content);
  writeFileSync(path, next);
}

function plainProject(): string {
  const proj = setupIntegrationProject({ noAidlcDocs: true, stripEnvScope: true });
  temps.push(proj);
  return proj;
}

describe("a plugin's scope", () => {
  let tmp = "";
  let undeclared = "";
  let declaredStrict = "";

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "aidlc-t-every-scope-"));
    temps.push(tmp);
    const built = join(tmp, "plugin", "claude");
    buildPluginProjection("test-pro", "claude", built);
    undeclared = composePluginFixture({ plugin: "test-pro", harness: "claude", projectDir: join(tmp, "undeclared"), pluginBuilt: built }).projectDir;
    const builtStrict = join(tmp, "plugin-strict", "claude");
    buildPluginProjection("test-pro", "claude", builtStrict);
    declaredStrict = composePluginFixture({
      plugin: "test-pro",
      harness: "claude",
      projectDir: join(tmp, "strict"),
      pluginBuilt: builtStrict,
      beforeCompose: ({ pluginBuilt }) => {
        const found = spawnSync("find", [pluginBuilt, "-name", `${PLUGIN_SCOPE}.md`], { encoding: "utf-8" }).stdout.trim().split("\n").filter(Boolean);
        expect(found.length).toBeGreaterThan(0);
        for (const file of found) {
          writeFileSync(file, readFileSync(file, "utf-8").replace("skeleton: off\n", "skeleton: off\nguard_policy: strict\n"));
        }
      },
    }).projectDir;
  });

  test("with no guard_policy key it starts off, and the reader accepts changes", () => {
    create(undeclared, PLUGIN_SCOPE);
    expect(policyLine(undeclared)).toBe(`off (from scope ${PLUGIN_SCOPE})`);
    expect(effective(undeclared)).toContain("off");
    expect(guardPolicyAcceptsChanges(undeclared)).toBe(true);
  });

  test("an author who writes strict gets strict", () => {
    create(declaredStrict, PLUGIN_SCOPE);
    expect(policyLine(declaredStrict)).toBe(`strict (from scope ${PLUGIN_SCOPE})`);
    expect(guardPolicyAcceptsChanges(declaredStrict)).toBe(false);
  });
});

describe("a composed plan", () => {
  test("an unsaved custom plan and a saved composed scope both start off", () => {
    const proj = plainProject();
    create(proj, "bugfix", ["--add", "functional-design", "--skip", "deployment-pipeline,deployment-execution"]);
    expect(policyLine(proj)).toBe("off (from scope bugfix)");
    expect(guardPolicyAcceptsChanges(proj)).toBe(true);
    const saved = runTool(proj, "aidlc-utility.ts", ["scope-save", "--name", "quick-fix", "--keywords", "parser-fix"]);
    expect(saved.status, saved.out).toBe(0);
    create(proj, "quick-fix");
    expect(policyLine(proj)).toBe("off (from scope quick-fix)");
    expect(guardPolicyAcceptsChanges(proj)).toBe(true);
  });
});

describe("a team's memory layer", () => {
  test("Mode: off replaces a strict scope default, and status names the layer", () => {
    const proj = plainProject();
    create(proj, "enterprise");
    expect(policyLine(proj)).toBe("strict (from scope enterprise)");
    expect(guardPolicyAcceptsChanges(proj)).toBe(false);
    declareMemory(proj, "team", "off");
    expect(effective(proj)).toContain("off (from team.md)");
    expect(guardPolicyAcceptsChanges(proj)).toBe(true);
  });

  test("the narrowest layer wins, and a strict lock in any layer still wins over all", () => {
    const proj = plainProject();
    create(proj, "classic");
    declareMemory(proj, "org", "off");
    declareMemory(proj, "project", "relaxed");
    expect(effective(proj)).toContain("relaxed (from project.md)");
    declareMemory(proj, "team", "strict");
    expect(effective(proj)).toContain("strict");
    expect(guardPolicyAcceptsChanges(proj)).toBe(false);
  });

  test("a value the person set for this work keeps it", () => {
    const proj = plainProject();
    create(proj, "classic", ["--guard-policy", "strict"]);
    expect(policyLine(proj)).toBe("strict (set by you)");
    declareMemory(proj, "team", "off");
    expect(guardPolicyAcceptsChanges(proj)).toBe(false);
  });
});
