// covers: function:unitsReposAsk, function:unitsRepoChange, function:unitsRepoChangeLine, function:unitsRepoChangeQuestion, function:noteUnitsReposAsked, function:unitsReposAskPassedOver, function:clearUnitsReposAsked, audit:CHANGE_ACCEPTED
//
// After Units Generation is approved, a change to the work's repos lands
// at once. Under Guard Policy strict the next step asks once whether its Units
// still stand, through the real `next` and its directive validator. Any reply
// carries on with the approved Units, recorded once, and the question is not
// put again; the other choice goes back to Units Generation. Relaxed, off and an
// unattended run carry on without asking; an undo leaves nothing to ask.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestProject, createTestProject, FIXTURES_DIR, REPO_ROOT, seededStateFile } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);

const TREE = join(REPO_ROOT, "dist", "claude");
const STATE_FIXTURE = readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8");
const STAGE_LINE = /^- \[[ x-]\] ([a-z0-9-]+) \u2014 EXECUTE$/gm;
const FIXTURE_STAGES = [...STATE_FIXTURE.matchAll(STAGE_LINE)].map((match) => match[1] ?? "");
const UNITS = "units-generation";
const LINE =
  "Units Generation was approved before this change: carrying on with its Units and app-b added. You can go back to Units Generation any time.";

const projects: string[] = [];
afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

function git(dir: string, args: string[]): void {
  const r = spawnSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf-8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

// Units Generation approved and the next stage not started, in a workspace
// whose work records app-a; app-b is cloned beside it.
function workspace(policy: "strict" | "relaxed" | "off" = "strict"): string {
  const proj = createTestProject();
  projects.push(proj);
  cpSync(join(TREE, ".claude"), join(proj, ".claude"), { recursive: true });
  cpSync(join(TREE, "aidlc"), join(proj, "aidlc"), { recursive: true });
  const at = FIXTURE_STAGES.indexOf(UNITS);
  const state = STATE_FIXTURE
    .replace(/^(- \*\*Current Stage\*\*: ).*$/m, `$1${UNITS}`)
    .replace(/^(- \*\*In Progress\*\*: ).*$/m, `$1${UNITS}`)
    .replace(/^- \*\*Change Control\*\*: .*$/m, `- **Change Control**: ${policy} (you)`)
    .replace(STAGE_LINE, (line, slug: string) =>
      line.replace(/^- \[[ x-]\]/, `- [${FIXTURE_STAGES.indexOf(slug) <= at ? "x" : " "}]`));
  writeFileSync(seededStateFile(proj), state, "utf-8");
  for (const repo of ["app-a", "app-b"]) {
    mkdirSync(join(proj, repo, "src"), { recursive: true });
    writeFileSync(join(proj, repo, "src", "main.ts"), "export const x = 1;\n");
    git(join(proj, repo), ["init", "-q"]);
    git(join(proj, repo), ["add", "-A"]);
    git(join(proj, repo), ["commit", "-qm", "seed"]);
  }
  const registry = join(proj, "aidlc", "spaces", "default", "intents", "intents.json");
  const rows = JSON.parse(readFileSync(registry, "utf-8"));
  rows[0].repos = ["app-a"];
  writeFileSync(registry, `${JSON.stringify(rows, null, 2)}\n`);
  appendAuditEntry("STAGE_COMPLETED", { Stage: UNITS, Details: "approved", Artifacts: "units" }, proj);
  return proj;
}

type Printed = Record<string, unknown> & { kind?: string };

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  delete env.AIDLC_UNATTENDED;
  return { ...env, ...extra };
}

function run(proj: string, tool: string, args: string[], env = childEnv()): { status: number; stdout: string } {
  const res = spawnSync(process.execPath, [join(proj, ".claude", "tools", tool), ...args, "--project-dir", proj], {
    cwd: proj,
    env,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS * 4),
  });
  return { status: res.status ?? -1, stdout: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

// `next` as the agent runs it, through every rules part.
function next(proj: string, env = childEnv(), first = ["next"]): Printed {
  let args = first;
  for (let part = 0; part < 20; part++) {
    const { stdout } = run(proj, "aidlc-orchestrate.ts", args, env);
    const directive = JSON.parse(stdout.trim()) as Printed;
    if (directive.kind !== "load-steering") return directive;
    args = ["continue", String(directive.receipt)];
  }
  throw new Error("the rules parts did not end");
}

function personSays(proj: string, prompt: string): void {
  const res = spawnSync(process.execPath, [join(proj, ".claude", "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "units-repos-session", prompt }),
    env: childEnv({ CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj }),
    encoding: "utf-8",
  });
  if (res.status !== 0) throw new Error(`record-human-turn failed: ${res.stderr}`);
}

function intent(proj: string, ...args: string[]): void {
  const r = run(proj, "aidlc-utility.ts", ["intent", ...args]);
  if (r.status !== 0) throw new Error(`intent ${args.join(" ")} failed: ${r.stdout}`);
}

const accepted = (proj: string) =>
  readAuditShardEvents(proj).filter((row) => row.event === "CHANGE_ACCEPTED" && row.block.includes("**Checkpoint**: units-generation"));
const said = (directive: Printed): string => JSON.stringify(directive);

describe("a repo change after Units Generation is approved", () => {
  test("under strict the next step asks once; a reply carries on with the approved Units, recorded once, never asked again", () => {
    const proj = workspace();
    intent(proj, "add-repo", "app-b");
    const asked = next(proj);
    expect(asked.kind, said(asked)).toBe("ask");
    expect(asked.ask_type).toBe("units-repos");
    expect(asked.response_route).toBe("command");
    expect(asked.question).toBe("Units Generation was approved before this change to the work's repos (app-b added). Do its Units still stand?");
    const choices = asked.choices as Array<{ label: string; command?: string }>;
    expect(choices.map(({ label }) => label)).toEqual(["They stand", "Go back to Units Generation"]);
    expect(choices[0].command).toEndWith("aidlc-orchestrate.ts next");
    expect(choices[1].command).toEndWith("aidlc-orchestrate.ts next --stage units-generation");
    expect(accepted(proj)).toHaveLength(0);
    // The agent runs `next` again before the person replies: the same question.
    expect(next(proj).ask_type).toBe("units-repos");

    personSays(proj, "they stand");
    const step = next(proj);
    expect(step.kind, said(step)).toBe("run-stage");
    expect(said(step)).toContain(LINE);
    expect(accepted(proj)).toHaveLength(1);
    expect(accepted(proj)[0].block).toContain(`**Details**: ${LINE}`);
    const again = next(proj);
    expect(again.kind, said(again)).toBe("run-stage");
    expect(said(again)).not.toContain("Do its Units still stand");
    expect(accepted(proj)).toHaveLength(1);
  });

  test("the go-back choice's command reaches Units Generation, and nothing is recorded as accepted", () => {
    const proj = workspace();
    intent(proj, "add-repo", "app-b");
    const asked = next(proj);
    expect(asked.ask_type).toBe("units-repos");
    personSays(proj, "go back to units generation");
    const back = next(proj, childEnv(), ["next", "--stage", UNITS]);
    expect(back.kind, said(back)).not.toBe("ask");
    expect(said(back)).toContain(UNITS);
    expect(said(back)).not.toContain("Do its Units still stand");
    expect(accepted(proj)).toHaveLength(0);
  });

  test("a second change after the first is settled is asked about once more", () => {
    const proj = workspace();
    intent(proj, "add-repo", "app-b");
    expect(next(proj).ask_type).toBe("units-repos");
    personSays(proj, "keep them");
    expect(next(proj).kind).toBe("run-stage");
    mkdirSync(join(proj, "app-c", "src"), { recursive: true });
    writeFileSync(join(proj, "app-c", "src", "c.ts"), "export const c = 1;\n");
    git(join(proj, "app-c"), ["init", "-q"]);
    git(join(proj, "app-c"), ["add", "-A"]);
    git(join(proj, "app-c"), ["commit", "-qm", "seed"]);
    intent(proj, "add-repo", "app-c");
    const asked = next(proj);
    expect(asked.ask_type, said(asked)).toBe("units-repos");
    expect(asked.question).toBe(
      "Units Generation was approved before this change to the work's repos (app-b and app-c added). Do its Units still stand?",
    );
  });

  test("an undo of the change leaves nothing to ask", () => {
    const proj = workspace();
    intent(proj, "add-repo", "app-b");
    intent(proj, "remove-repo", "app-b");
    const step = next(proj);
    expect(step.kind, said(step)).toBe("run-stage");
    expect(accepted(proj)).toHaveLength(0);
  });

  test("relaxed and off never ask: the change was recorded when it was made", () => {
    for (const policy of ["relaxed", "off"] as const) {
      const proj = workspace(policy);
      intent(proj, "add-repo", "app-b");
      expect(accepted(proj)).toHaveLength(1);
      const step = next(proj);
      expect(step.kind, said(step)).toBe("run-stage");
      expect(accepted(proj)).toHaveLength(1);
    }
  });

  test("an unattended run under strict carries on and records it, without asking", () => {
    const proj = workspace();
    intent(proj, "add-repo", "app-b");
    const step = next(proj, childEnv({ AIDLC_UNATTENDED: "1" }));
    expect(step.kind, said(step)).toBe("run-stage");
    expect(accepted(proj)).toHaveLength(1);
  });
});
