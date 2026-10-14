// covers: function:keepSettingsForNextWork, function:keptForPickedWork, function:recordCeremoniesAtCreation, subcommand:aidlc-utility:intent, subcommand:aidlc-utility:space
//
// A setting typed in a chat where work exists but none is selected is kept for
// the work that chat picks up or starts next. Picking existing work (the pick
// question's own command, or a space switch landing on its one piece of work)
// applies it there through the setter, said once after the line naming the
// work, and spends it, so new work started later does not get it too. It is
// not applied when it was typed for a new-work question still open, when it is
// from another sitting, or when a later word took it back.
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  removeWorkspaceRecord,
  runOrchestrateNext,
  seedAidlcMemory,
} from "../harness/fixtures.ts";
import { getField, hooksHealthDir, planApprovalRuntimeFile } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const TOOLS = join(AIDLC_SRC, "tools");
const CHAT = "01995000-7a11-7000-8000-00000000c0fe";
const chat = { ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0", AIDLC_UNATTENDED: "0", AIDLC_SESSION_OVERRIDE: CHAT };
const REVIEW_FREEZE_OFF = "The review freeze check is off for this piece of work";

let proj = "";
afterEach(() => {
  if (proj) cleanupTestProject(proj);
  proj = "";
});

function utility(args: string[], env: NodeJS.ProcessEnv = { ...process.env }): { status: number; out: string } {
  const r = spawnSync(process.execPath, [join(TOOLS, "aidlc-utility.ts"), ...args, "--project-dir", proj], {
    cwd: proj,
    encoding: "utf-8",
    env: { ...env, CLAUDE_PROJECT_DIR: proj },
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function intentsDir(space = "default"): string {
  return join(proj, "aidlc", "spaces", space, "intents");
}

function records(space = "default"): string[] {
  return existsSync(intentsDir(space)) ? readdirSync(intentsDir(space)).filter((name) => /^\d{6}-/.test(name)).sort() : [];
}

function state(record: string, space = "default"): string {
  return readFileSync(join(intentsDir(space), record, "aidlc-state.md"), "utf-8");
}

/**
 * Two pieces of work started from the terminal, this chat on neither; the one
 * it picks runs strict (most plans run Guard Policy off, which already has the
 * review freeze check off).
 */
function workNoneSelected(): string[] {
  proj = createTestProject();
  seedAidlcMemory(proj);
  removeWorkspaceRecord(proj);
  for (const scope of ["poc", "enterprise"]) expect(utility(["intent-create", "--scope", scope]).status).toBe(0);
  rmSync(join(intentsDir(), "active-intent"), { force: true });
  // The person's chat runs AI-DLC's hooks: their line comes through the prompt hook.
  const health = hooksHealthDir(proj);
  mkdirSync(health, { recursive: true });
  writeFileSync(join(health, "record-human-turn.last"), new Date().toISOString());
  return [records().find((name) => name.endsWith("-poc"))!, records().find((name) => name.endsWith("-enterprise"))!];
}

function reply(prompt: string): void {
  const r = spawnSync(process.execPath, [join(TOOLS, "aidlc.ts"), "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: CHAT, prompt }),
    env: { ...chat, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
  });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
}

function next(args: string[]): Record<string, unknown> {
  const r = runOrchestrateNext(join(TOOLS, "aidlc-orchestrate.ts"), proj, args, { cwd: proj, env: chat });
  expect(r.directive, r.out.slice(0, 400)).not.toBeNull();
  return r.directive as Record<string, unknown>;
}

function runNamed(step: Record<string, unknown>): { status: number; out: string } {
  const named = /Run `bun \.claude\/tools\/(aidlc[a-z-]*\.ts) ([^`]+)`/.exec(String(step.message));
  expect(named, JSON.stringify(step).slice(0, 300)).not.toBeNull();
  const r = spawnSync(process.execPath, [join(TOOLS, named![1]), ...named![2].split(" ")], {
    cwd: proj,
    encoding: "utf-8",
    env: { ...chat, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// The agent's first step: a bare next (Kiro IDE; the engine takes the line from
// the record) or next with the person's line (Claude Code).
const SHAPES: Array<[string, (line: string[]) => string[]]> = [
  ["a bare next", () => []],
  ["next with the line", (line) => line],
];

function typeSetting(line: string, first: (line: string[]) => string[] = () => []): string {
  reply(line);
  const step = next(first(line.replace(/^\/aidlc\s+/, "").split(" ")));
  const kept = runNamed(step);
  expect(kept.status, kept.out).toBe(0);
  return kept.out;
}

function pick(record: string): string {
  const asked = next([]);
  expect(asked.ask_type, JSON.stringify(asked).slice(0, 300)).toBe("intent-pick");
  const switched = runNamed(next(["--pick", record]));
  expect(switched.status, switched.out).toBe(0);
  expect(switched.out).toContain("Now working on");
  return switched.out;
}

function times(text: string, part: string): number {
  return text.split(part).length - 1;
}

describe("t-kept-setting-follows-the-pick: the work the chat picks gets what was kept", () => {
  test.each(SHAPES)("a check typed off, then existing work picked: it is on that work, said once, and spent: %s", (_shape, first) => {
    const [, picked] = workNoneSelected();
    const kept = typeSetting("/aidlc --guard.review-freeze off", first);
    expect(kept).toContain("for the work you pick up or start next (set by you)");
    const said = pick(picked);
    expect(times(said, REVIEW_FREEZE_OFF), said).toBe(1);
    expect(getField(state(picked), "Guards Off") ?? "").toContain("review-freeze");
    const made = utility(["intent-create", "--scope", "poc"], chat);
    expect(made.status, made.out).toBe(0);
    const created = readFileSync(join(intentsDir(), "active-intent"), "utf-8").trim();
    expect(getField(state(created), "Guards Off") ?? "").not.toContain("review-freeze");
  });

  test.each(SHAPES)("from the typed line to the pick and on, no print comes back twice, and the setting is said once: %s", (_shape, first) => {
    const [, picked] = workNoneSelected();
    const prints: string[] = [];
    const seen = (step: Record<string, unknown>): void => {
      const text = String(step.message ?? step.question ?? "");
      expect(prints, `the same print twice: ${text.slice(0, 160)}`).not.toContain(text);
      prints.push(text);
    };
    reply("/aidlc --guard.review-freeze off");
    const setter = next(first(["--guard.review-freeze", "off"]));
    seen(setter);
    expect(runNamed(setter).status).toBe(0);
    const asked = next([]);
    seen(asked);
    expect(asked.ask_type).toBe("intent-pick");
    const picking = next(["--pick", picked]);
    seen(picking);
    const switched = runNamed(picking);
    expect(times(switched.out, REVIEW_FREEZE_OFF), switched.out).toBe(1);
    // The agent carries on as the pick's step says: the work's own step, the
    // setting not said again and not handed to the setter a second time. (A
    // further bare next while that step waits repeats the step itself.)
    for (let call = 0; call < 2; call += 1) {
      const after = next([]);
      if (call === 0) seen(after);
      const text = JSON.stringify(after);
      expect(text).not.toContain("review freeze check is off");
      expect(text).not.toContain("config set guard.review-freeze");
    }
    expect(getField(state(picked), "Guards Off") ?? "").toContain("review-freeze");
  });

  test("depth and sensors typed, then existing work picked: both land there, as theirs", () => {
    const [, picked] = workNoneSelected();
    const before = getField(state(picked), "Depth");
    expect(before).not.toBe("Minimal");
    typeSetting("/aidlc --depth minimal --sensors off");
    const said = pick(picked);
    expect(getField(state(picked), "Depth")).toBe("Minimal");
    expect(getField(state(picked), "Sensors")).toBe("off (set by you)");
    expect(times(said, "Sensors"), said).toBe(1);
  });

  test("a check typed off and then strict: the later word wins, and the picked work keeps the check on", () => {
    const [, picked] = workNoneSelected();
    typeSetting("/aidlc --guard.review-freeze off");
    typeSetting("/aidlc --guard-policy strict", (line) => line);
    const kept = JSON.parse(readFileSync(planApprovalRuntimeFile(proj, `ceremonies-at-creation-${CHAT}.json`), "utf-8")) as {
      settings: Record<string, string>;
    };
    expect(kept.settings["guard.review-freeze"]).toBeUndefined();
    const said = pick(picked);
    expect(said).not.toContain(REVIEW_FREEZE_OFF);
    expect(getField(state(picked), "Guards Off") ?? "").not.toContain("review-freeze");
  });

  // A later word takes back an earlier one in the kept record as it would on
  // selected work: one name for one setting, and a whole-policy word clears
  // the checks it would clear there.
  test("plan approval off, then on again by its other name: the later word wins on the picked work", () => {
    const [, picked] = workNoneSelected();
    typeSetting("/aidlc --plan-approval off");
    reply("/aidlc config set guard.plan-approval on");
    const on = next(["config", "set", "guard.plan-approval", "on"]);
    expect(String(on.message)).toContain("Plan approval will be on for the work you pick up or start next (set by you)");
    const said = pick(picked);
    expect(said).not.toContain("built without asking");
    expect(getField(state(picked), "Plan Approval") ?? "").not.toContain("off");
  });

  test("a check kept on, then Guard Policy off: the later whole-policy word wins, as on selected work", () => {
    const [, picked] = workNoneSelected();
    typeSetting("/aidlc --guard.review-freeze on");
    const off = typeSetting("/aidlc --guard-policy off", (line) => line);
    expect(off).toContain("is off for the work you pick up or start next (set by you)");
    pick(picked);
    expect(getField(state(picked), "Guard Policy")).toBe("off (set by you)");
    expect(getField(state(picked), "Guards On") ?? "").not.toContain("review-freeze");
  });

  test("a space switch that lands on that space's one piece of work picks it", () => {
    workNoneSelected();
    expect(utility(["space-create", "foo"]).status).toBe(0);
    expect(utility(["intent-create", "--scope", "enterprise", "--space", "foo"]).status).toBe(0);
    expect(utility(["space", "default"]).status).toBe(0);
    rmSync(join(intentsDir("foo"), "active-intent"), { force: true });
    rmSync(join(intentsDir(), "active-intent"), { force: true });
    const [lone] = records("foo");
    typeSetting("/aidlc --guard.review-freeze off");
    const switched = utility(["space", "foo"], chat);
    expect(switched.status, switched.out).toBe(0);
    expect(switched.out).toContain("Now working in space");
    expect(times(switched.out, REVIEW_FREEZE_OFF), switched.out).toBe(1);
    expect(getField(state(lone, "foo"), "Guards Off") ?? "").toContain("review-freeze");
  });
});

describe("t-kept-setting-follows-the-pick: what is not carried to the picked work", () => {
  test("kept in another sitting: nothing is applied or said", () => {
    const [, picked] = workNoneSelected();
    typeSetting("/aidlc --guard.review-freeze off");
    const path = planApprovalRuntimeFile(proj, `ceremonies-at-creation-${CHAT}.json`);
    const record = JSON.parse(readFileSync(path, "utf-8")) as { recordedAt: string };
    record.recordedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    writeFileSync(path, `${JSON.stringify(record)}\n`);
    const said = pick(picked);
    expect(said).not.toContain(REVIEW_FREEZE_OFF);
    expect(getField(state(picked), "Guards Off") ?? "").not.toContain("review-freeze");
  });

  test("typed while a new-work question was open: it is for that work, not the work picked instead", () => {
    const [, picked] = workNoneSelected();
    // The person describes new work; the agent proposes a plan, and the plan
    // question is in front of them when they type the setting.
    reply("add a CSV export");
    const reading = next(["add", "a", "CSV", "export"]);
    const request = /--request ([0-9a-f]{8})/.exec(String(reading.message))?.[1];
    expect(request, JSON.stringify(reading).slice(0, 300)).toBeDefined();
    const offer = String(reading.message).includes("--propose <plan> --request")
      ? next(["--propose", "bugfix", "--request", request!])
      : next(["--request", request!, "--propose", "bugfix"]);
    expect(offer.ask_type, JSON.stringify(offer).slice(0, 300)).toBe("scope-confirm");
    const kept = typeSetting("/aidlc --guard.review-freeze off", (line) => line);
    expect(kept).toContain("for the piece of work you start now (set by you)");
    const said = pick(picked);
    expect(said).not.toContain(REVIEW_FREEZE_OFF);
    expect(getField(state(picked), "Guards Off") ?? "").not.toContain("review-freeze");
  });

  test("a team's strict Guard Policy: nothing is kept, the picked work is unchanged, and the team's line is not said again", () => {
    const [, picked] = workNoneSelected();
    const memory = join(proj, "aidlc", "spaces", "default", "memory", "project.md");
    mkdirSync(join(proj, "aidlc", "spaces", "default", "memory"), { recursive: true });
    const existing = existsSync(memory) ? readFileSync(memory, "utf-8") : "# Project\n";
    writeFileSync(memory, existing.includes("## Guard Policy\n")
      ? existing.replace("## Guard Policy\n", "## Guard Policy\n\nMode: strict\n")
      : `${existing.trimEnd()}\n\n## Guard Policy\n\nMode: strict\n`);
    reply("/aidlc --guard.review-freeze off");
    const team = next([]);
    expect(String(team.message)).toContain("Your team set Guard Policy to strict");
    const said = pick(picked);
    expect(said).not.toContain("Your team set Guard Policy to strict");
    expect(getField(state(picked), "Guards Off") ?? "").not.toContain("review-freeze");
  });
});

describe("t-kept-setting-follows-the-pick: the keep line says where it goes", () => {
  test("no work at all: for the piece of work they start now", () => {
    proj = createTestProject();
    removeWorkspaceRecord(proj);
    const health = hooksHealthDir(proj);
    mkdirSync(health, { recursive: true });
    writeFileSync(join(health, "record-human-turn.last"), new Date().toISOString());
    const kept = typeSetting("/aidlc --guard.review-freeze off");
    expect(kept).toContain("for the piece of work you start now (set by you)");
    expect(kept).not.toContain("pick up");
  });

  test("only finished work here: nothing to pick up, so for the piece of work they start now", () => {
    const done = workNoneSelected();
    for (const record of done) {
      const path = join(intentsDir(), record, "aidlc-state.md");
      writeFileSync(path, readFileSync(path, "utf-8").replace(/^- \*\*Status\*\*:.*$/m, "- **Status**: Completed"));
    }
    expect(getField(state(done[0]), "Status")).toBe("Completed");
    const kept = typeSetting("/aidlc --guard.review-freeze off");
    expect(kept).toContain("for the piece of work you start now (set by you)");
    expect(kept).not.toContain("pick up");
  });
});
