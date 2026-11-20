// covers: function:combineTestObligations, function:isSubstantiveRuleText, file:memory/org.md
//
// The shipped rule layers say what the engine does with them:
//   - a team's or project's practice replaces a framework default (org.md's
//     Way of Working says so, and the testing posture reads team over org),
//     so no shipped header or reading guide calls a narrower rule that differs
//     from a broader one rejected;
//   - org.md's per-scope test floors name the same scopes as the Testing
//     Contract (combineTestObligations): classic, the default scope, adds no
//     floor in either;
//   - the Inception phase rule asks no trace to an Ideation document, which
//     the default scope never writes;
//   - the empty team and project templates still read as holding no rule, in
//     today's header and in the earlier one a team's own files keep;
//   - `aidlc config` on an existing project keeps its own rule files byte for
//     byte (they are the team's committed files): the new wording reaches a
//     new project, and the engine's own bundled seed.
// Read from every shipped tree's memory and knowledge, and one config run.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { combineTestObligations } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import { isSubstantiveRuleText } from "../../dist/claude/.claude/tools/aidlc-steering.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

const read = (path: string): string => readFileSync(path, "utf-8").replace(/\r\n/g, "\n");
const flat = (text: string): string => text.replace(/\s*\n>?\s*/g, " ");

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function temp(prefix: string): string {
  const path = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  temporary.push(path);
  return path;
}

// One `config` run from the released Claude Code tree, with the host's own runtime and home kept out.
function configure(dir: string): { status: number; out: string } {
  const machine = temp("aidlc-t-rules-machine-");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: machine, USERPROFILE: machine, XDG_CONFIG_HOME: join(machine, ".config") };
  for (const name of Object.keys(env)) if (name.startsWith("CLAUDE") || name.startsWith("AIDLC_")) delete env[name];
  env.AIDLC_INSTALL_ROOT = join(machine, "share", "aidlc");
  env.AIDLC_BIN_DIR = join(machine, "bin");
  const result = spawnSync(process.execPath, [
    join(REPO_ROOT, "core", "tools", "aidlc-init.ts"),
    "config", "--project-dir", dir, "--from", join(REPO_ROOT, "dist-release", "claude"), "--harness", "claude", "--mcp", "none", "--yes",
  ], { cwd: dir, env, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const SCOPES = ["mvp", "enterprise", "feature", "infra", "classic", "bugfix", "security-patch", "express", "poc", "refactor", "workshop"];

describe("t-rule-layers-say-what-the-engine-does", () => {
  test.each(HARNESS_MATRIX.map((harness) => [harness.name, harness] as const))(
    "%s: the shipped rule layers agree with the engine",
    (_name, harness) => {
      const memory = join(harness.distRoot, "aidlc", "spaces", "default", "memory");
      const org = read(join(memory, "org.md"));
      const rules = [
        org,
        read(join(memory, "team.md")),
        read(join(memory, "project.md")),
        read(join(harness.engineRoot, "knowledge", "aidlc-shared", "rules-reading.md")),
      ].map(flat);
      for (const text of rules) {
        expect(text).not.toContain("contradictions with broader policy are rejected");
        expect(text).not.toContain("must not contradict broader policy");
        expect(text).not.toContain("admission error, not an override");
      }
      const floorLine = flat(org).match(/- ((?:`[a-z-]+`, )*`[a-z-]+`) add an 80% line-coverage floor/);
      expect(floorLine).not.toBeNull();
      const named = [...(floorLine?.[1] ?? "").matchAll(/`([a-z-]+)`/g)].map((m) => m[1]).sort();
      const withFloor = SCOPES.filter((scope) =>
        combineTestObligations(scope, "standard").scope_floor.some((line) => line.includes("80% line-coverage")),
      ).sort();
      expect(named).toEqual(withFloor);
      expect(read(join(memory, "phases", "inception.md"))).not.toContain("trace back to an ideation artifact");
    },
  );

  test("the empty team and project templates hold no rule, in today's header and the earlier one", () => {
    const memory = join(HARNESS_MATRIX[0].distRoot, "aidlc", "spaces", "default", "memory");
    for (const name of ["team.md", "project.md"]) expect(isSubstantiveRuleText(read(join(memory, name))), name).toBe(false);
    const earlierTeam = [
      "# Team-Level Rules",
      "",
      "> This team's affirmed practices and corrections. Loaded after `org.md` as",
      "> strict-additive guidance; contradictions with broader policy are rejected.",
      "> Populated by the practices-discovery affirmation gate. Edit at the gate,",
      "> not directly.",
      "",
    ].join("\n");
    expect(isSubstantiveRuleText(earlierTeam)).toBe(false);
  });

  test("config keeps an existing project's own rule files as they are", () => {
    const dir = temp("aidlc-t-rules-project-");
    mkdirSync(join(dir, ".git"));
    const first = configure(dir);
    expect(first.status, first.out).toBe(0);
    const memory = join(dir, "aidlc", "spaces", "default", "memory");
    // A project made by an earlier release: its files carry the earlier wording.
    const earlier: Record<string, string> = {
      "org.md": "# Org-Level Rules\n\n> Framework defaults. narrower layers add\n> specialisation and must not contradict broader policy.\n",
      "team.md": "# Team-Level Rules\n\n> This team's affirmed practices and corrections. Loaded after `org.md` as\n> strict-additive guidance; contradictions with broader policy are rejected.\n",
      "project.md": "# Project-Level Rules\n\n> Project-specific specialisation and corrections. Loaded after `org.md` and\n> `team.md` as strict-additive guidance; contradictions with broader policy\n> are rejected. Populated by practices-discovery and the self-learning loop.\n",
      "phases/inception.md": "# Inception\n\n## Traceability\n\n- Every requirement must trace back to an ideation artifact (intent, feasibility, or scope)\n",
    };
    for (const [name, text] of Object.entries(earlier)) writeFileSync(join(memory, name), text);
    const again = configure(dir);
    expect(again.status, again.out).toBe(0);
    for (const [name, text] of Object.entries(earlier)) expect(readFileSync(join(memory, name), "utf-8"), name).toBe(text);
    expect(isSubstantiveRuleText(earlier["team.md"])).toBe(false);
    expect(isSubstantiveRuleText(earlier["project.md"])).toBe(false);
  });
});
