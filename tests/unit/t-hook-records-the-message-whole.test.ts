// covers: hook:aidlc-record-human-turn, function:handleConfigChange, function:takePersonsOwnLine, function:carriedCreationFlags
//
// The human-turn hook records the person's message whole and applies nothing:
// no setting, no grant, no note. The agent reads the line and runs the setter
// the engine names, on every harness; the engine keeps a setting typed before
// any work exists for the piece of work the chat starts next; a flag typed with
// a reply keeps both halves; a question about a switch is the agent's to
// answer. Driven end to end over the real hook, the real engine and the real
// setter, with the session the chat runs under.
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  createTestProject,
  FIXTURES_DIR,
  REPO_ROOT,
  removeWorkspaceRecord,
  runOrchestrateNext,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import {
  auditBlockField,
  getField,
  hooksHealthDir,
  planApprovalRuntimeFile,
  readAuditShardEvents,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import * as guardSwitch from "../../dist/claude/.claude/tools/aidlc-guard-switch.ts";
import { listMessages } from "../../dist/claude/.claude/tools/aidlc-message-store.ts";
import { renderTestingContract, resolveTestingPosture } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";

setDefaultTimeout(120_000);

const BUN = process.execPath;
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const SESSION = "01995000-7a11-7000-8000-0000000000c3";
const OTHER = "01995000-7a11-7000-8000-0000000000c4";
const CLEAR = {
  AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "0",
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0",
  AIDLC_SESSION_OVERRIDE: SESSION,
  AIDLC_UNATTENDED: "0",
};
const HARNESSES = ["claude", "codex", "copilot", "cursor", "kiro", "kiro-ide", "opencode"];

interface Emitted {
  kind: string;
  ask_type?: string;
  message?: string;
  narration?: string;
  confirm_command?: string;
  scope_commands?: Array<{ scope: string; command: string }>;
  plan_approval?: { status?: string };
}

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

function openWork(
  policy: "strict" | "relaxed" | "off" = "relaxed",
  planApproval: "on" | "off" | "off-by-you" = "on",
): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  const planLine = planApproval === "on"
    ? "\n- **Plan Approval**: on (set by you)"
    : planApproval === "off-by-you"
      ? "\n- **Plan Approval**: off (set by you)"
      : "\n- **Plan Approval**: off (from scope poc)";
  const state = readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8")
    .replace("- **Scope**: feature", "- **Scope**: poc")
    .replace("- **Change Control**: strict (from scope feature)", `- **Guard Policy**: ${policy} (set by you)${planLine}`)
    .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation");
  writeFileSync(seededStateFile(proj), state, "utf-8");
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "src", "base.ts"), "export const base = true;\n", "utf-8");
  const sessions = join(proj, "aidlc", ".aidlc-sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, ".current-session"), `${SESSION}\n`, "utf-8");
  return proj;
}

/** The team holds Guard Policy strict for everyone on the repo; the file that holds it. */
function lockMemory(proj: string): string {
  const dir = join(proj, "aidlc", "spaces", "default", "memory");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "team.md");
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "# Team\n";
  writeFileSync(
    path,
    existing.includes("## Guard Policy\n")
      ? existing.replace("## Guard Policy\n", "## Guard Policy\n\nMode: strict\n")
      : `${existing.trimEnd()}\n\n## Guard Policy\n\nMode: strict\n`,
    "utf-8",
  );
  return path;
}

/** No work yet; the person's chat runs AI-DLC's hooks. */
function emptyProject(): string {
  const proj = createTestProject();
  created.push(proj);
  removeWorkspaceRecord(proj);
  const health = hooksHealthDir(proj);
  mkdirSync(health, { recursive: true });
  writeFileSync(join(health, "record-human-turn.last"), new Date().toISOString());
  return proj;
}

function stageDir(proj: string): string {
  return join(seededRecordDir(proj), "construction", "code-generation");
}

function writePlan(proj: string): void {
  mkdirSync(stageDir(proj), { recursive: true });
  writeFileSync(
    join(stageDir(proj), "code-generation-plan.md"),
    "# Code Generation Plan\n\n## Summary\n\n- Builds: slugify for titles\n- Touches: src/slugify.ts\n" +
      "- Tests: 3 unit tests\n\n## Steps\n\n- [ ] Step 1: write slugify\n\n" +
      renderTestingContract(resolveTestingPosture(proj)),
    "utf-8",
  );
  writeFileSync(join(stageDir(proj), "unit-test-instructions.md"), "# Unit Test Instructions\n\nRun `bun test`.\n", "utf-8");
}

function next(proj: string, args: string[] = []): { directive: Emitted | null; out: string } {
  const result = runOrchestrateNext(ORCHESTRATE, proj, args, { env: { ...process.env, ...CLEAR } });
  return { directive: result.directive as unknown as Emitted | null, out: result.out };
}

function askFor(proj: string): void {
  writePlan(proj);
  const step = next(proj);
  expect(step.directive?.kind, step.out).toBe("ask");
  expect(step.directive?.ask_type, step.out).toBe("plan-approval");
}

function reply(proj: string, prompt: string, session = SESSION): string {
  const result = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, prompt }),
    env: { ...process.env, ...CLEAR, AIDLC_SESSION_OVERRIDE: session, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout ?? "";
}

function configSet(proj: string, args: string[], session: string | null = SESSION): { status: number; out: string } {
  const env: Record<string, string | undefined> = { ...process.env, ...CLEAR, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj };
  delete env.AIDLC_SESSION_OVERRIDE;
  if (session !== null) env.AIDLC_SESSION_OVERRIDE = session;
  const result = spawnSync(BUN, [DISPATCHER, "engine", "config", "set", ...args, "--project-dir", proj], {
    cwd: proj,
    env,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function utility(proj: string, args: string[], session: string | null = SESSION): { status: number; stdout: string; stderr: string } {
  const env: Record<string, string | undefined> = { ...process.env, ...CLEAR, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj };
  delete env.AIDLC_SESSION_OVERRIDE;
  if (session !== null) env.AIDLC_SESSION_OVERRIDE = session;
  const result = spawnSync(BUN, [UTILITY, ...args, "--project-dir", proj], { cwd: proj, env, encoding: "utf-8" });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function answer(proj: string, details: string): { code: number; out: string } {
  const result = spawnSync(BUN, [
    LOG, "answer", "--stage", "code-generation", "--checkpoint", "plan-approval", "--details", details, "--project-dir", proj,
  ], {
    cwd: proj,
    env: { ...process.env, ...CLEAR, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { code: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function rows(proj: string, event: string): string[] {
  return readAuditShardEvents(proj).filter((row) => row.event === event).map((row) => row.block);
}

function lastTurnMark(proj: string): string | null {
  const turns = rows(proj, "HUMAN_TURN");
  expect(turns.length).toBeGreaterThan(0);
  return auditBlockField(turns[turns.length - 1], "Reply");
}

function state(proj: string): string {
  return readFileSync(seededStateFile(proj), "utf-8");
}

function intents(proj: string): string {
  return join(proj, "aidlc", "spaces", "default", "intents");
}

function createdState(proj: string): string {
  const record = readFileSync(join(intents(proj), "active-intent"), "utf-8").trim();
  return readFileSync(join(intents(proj), record, "aidlc-state.md"), "utf-8");
}

function requestIn(step: { directive: Emitted | null; out: string }): string {
  const id = /--request ([0-9a-f]{8})/.exec(String(step.directive?.message))?.[1];
  if (id === undefined) throw new Error(`no request in ${step.out}`);
  return id;
}

const keptForNextWork = (proj: string): boolean =>
  existsSync(planApprovalRuntimeFile(proj, `plan-approval-off-at-creation-${SESSION}.json`));

describe("the hook records the message whole and applies nothing", () => {
  test("a flags-only line with work open: recorded with its settings, marked a command, nothing changed, no note", () => {
    const proj = openWork();
    const before = state(proj);
    const note = reply(proj, "/aidlc --plan-approval off");
    expect(note).not.toContain("AIDLC Guard Policy");
    expect(state(proj)).toBe(before);
    expect(rows(proj, "CEREMONY_SET")).toHaveLength(0);
    expect(keptForNextWork(proj)).toBe(false);
    expect(lastTurnMark(proj)).toBe("command");
    const record = listMessages(proj).at(-1)!;
    expect(record.text).toBe("/aidlc --plan-approval off");
    expect(record.words).toBeNull();
    expect(record.settings).toEqual([{ key: "plan-approval", value: "off" }]);
    expect("applied" in record).toBe(false);
  });

  test("plain words at the plan question: recorded as a reply, nothing changed; the agent's setter then lowers it with their words", () => {
    const proj = openWork();
    askFor(proj);
    const before = state(proj);
    reply(proj, "skip plan approval for this work");
    expect(state(proj)).toBe(before);
    expect(rows(proj, "CEREMONY_SET")).toHaveLength(0);
    expect(lastTurnMark(proj)).toBeNull();
    // The agent read their words and names them; the setter finds them on record.
    const lowered = configSet(proj, ["plan-approval", "off", "--person-words", "skip plan approval for this work"]);
    expect(lowered.status, lowered.out).toBe(0);
    expect(getField(state(proj), "Plan Approval")).toBe("off (set by you)");
    expect(rows(proj, "CEREMONY_SET").join("\n")).toContain("**Person Reply**: skip plan approval for this work");
  });

  test("a flags-only Guard Policy line: next names the setter, and the setter says it was asked in the chat", () => {
    const proj = openWork("strict");
    reply(proj, "/aidlc --guard-policy off");
    expect(getField(state(proj), "Guard Policy")).toBe("strict (set by you)");
    expect(rows(proj, "GUARD_POLICY_SET")).toHaveLength(0);
    const step = next(proj, ["--guard-policy", "off"]);
    expect(step.directive?.kind, step.out).toBe("print");
    expect(String(step.directive?.message)).toContain("config set guard-policy off");
    expect(step.out).not.toContain("already applied");
    const lowered = configSet(proj, ["guard-policy", "off"]);
    expect(lowered.status, lowered.out).toBe(0);
    expect(lowered.out).toContain("as you asked in the chat");
    expect(lowered.out).not.toContain("because you said");
    expect(getField(state(proj), "Guard Policy")).toBe("off (set by you)");
  });
});

describe("a flag typed with a reply keeps both halves", () => {
  test("the turn is a reply, log answer accepts it, and next names the setter beside the plan step", () => {
    const proj = openWork("relaxed");
    askFor(proj);
    reply(proj, "/aidlc --guard-policy off approve the plan");
    expect(lastTurnMark(proj)).toBeNull();
    expect(getField(state(proj), "Guard Policy")).toBe("relaxed (set by you)");
    const step = next(proj, ["--guard-policy", "off", "approve", "the", "plan"]);
    expect(step.directive?.kind, step.out).toBe("print");
    const message = String(step.directive?.message);
    expect(message).toContain("config set guard-policy off");
    expect(message).toContain("--checkpoint plan-approval");
    const recorded = answer(proj, "Approve Plan");
    expect(recorded.code, recorded.out).toBe(0);
    const lowered = configSet(proj, ["guard-policy", "off"]);
    expect(lowered.status, lowered.out).toBe(0);
    expect(getField(state(proj), "Guard Policy")).toBe("off (set by you)");
  });

  test("words behind -- describe new work: the turn is a command", () => {
    const proj = openWork();
    askFor(proj);
    reply(proj, "/aidlc --guard-policy off -- add the export");
    expect(lastTurnMark(proj)).toBe("command");
  });

  test("a question about the switch is nobody's answer: no mark, nothing changed, the plan question stays open", () => {
    const proj = openWork();
    askFor(proj);
    reply(proj, "skip plan approval?");
    expect(lastTurnMark(proj)).toBeNull();
    expect(rows(proj, "CEREMONY_SET")).toHaveLength(0);
    expect(rows(proj, "QUESTION_ANSWERED")).toHaveLength(0);
    expect(getField(state(proj), "Plan Approval")).toBe("on (set by you)");
    const step = next(proj);
    expect(step.directive?.kind, step.out).toBe("ask");
    expect(step.directive?.ask_type, step.out).toBe("plan-approval");
  });
});

describe("a setting typed before any work exists is kept by the engine", () => {
  test("next names the setter, the setter keeps it, and the work the chat starts next takes it", () => {
    const proj = emptyProject();
    reply(proj, "/aidlc --plan-approval off");
    expect(keptForNextWork(proj)).toBe(false);
    const step = next(proj, ["--plan-approval", "off"]);
    expect(step.directive?.kind, step.out).toBe("print");
    expect(step.out).not.toContain("No workflow state found");
    expect(String(step.directive?.message)).toContain("config set plan-approval off");
    const kept = configSet(proj, ["plan-approval", "off"]);
    expect(kept.status, kept.out).toBe(0);
    expect(kept.out).toContain("will be off for the piece of work you start now (set by you)");
    expect(keptForNextWork(proj)).toBe(true);
    const offer = next(proj, ["--scope", "feature", "--", "build the export"]);
    const made = utility(proj, ["intent-create", "--request", requestIn(offer)]);
    expect(made.status, made.stderr).toBe(0);
    expect(getField(createdState(proj), "Plan Approval")).toBe("off (set by you)");
    expect(keptForNextWork(proj)).toBe(false);
  });

  test("on typed after off withdraws it, and depth typed before the work reaches the work too", () => {
    const proj = emptyProject();
    reply(proj, "/aidlc --plan-approval off");
    expect(configSet(proj, ["plan-approval", "off"]).status).toBe(0);
    reply(proj, "/aidlc --plan-approval on --depth minimal");
    const withdrawn = configSet(proj, ["plan-approval", "on", "--depth", "minimal"]);
    expect(withdrawn.status, withdrawn.out).toBe(0);
    expect(keptForNextWork(proj)).toBe(false);
    const offer = next(proj, ["--scope", "feature", "--", "build the export"]);
    expect(utility(proj, ["intent-create", "--request", requestIn(offer)]).status).toBe(0);
    const made = createdState(proj);
    expect(getField(made, "Plan Approval") ?? "").toStartWith("on");
    expect(getField(made, "Depth")).toBe("Minimal");
  });

  test("Copilot-shaped: the agent's next arrives bare after a flags-only line, with no work and with work open", () => {
    const fresh = emptyProject();
    reply(fresh, "/aidlc --plan-approval off");
    const noWork = next(fresh, []);
    expect(noWork.directive?.kind, noWork.out).toBe("print");
    expect(noWork.out).not.toContain("No workflow state found");
    expect(String(noWork.directive?.message)).toContain("config set plan-approval off");

    const open = openWork();
    reply(open, "/aidlc --plan-approval off");
    const withWork = next(open, []);
    expect(withWork.directive?.kind, withWork.out).toBe("print");
    expect(String(withWork.directive?.message)).toContain("config set plan-approval off");
    expect(getField(state(open), "Plan Approval")).toBe("on (set by you)");
  });
});

describe("creation takes a check typed off, under the person-turn rule", () => {
  test("the plan offer carries the Guard Policy and the check typed with the work, and creation records them as theirs", () => {
    const proj = emptyProject();
    reply(proj, "/aidlc --guard-policy relaxed --guard.review-freeze off fix the parser");
    // The agent proposes the plan it reads in their words (the first step for
    // new work); the plan question that comes back is the offer.
    const first = next(proj, ["--guard-policy", "relaxed", "--guard.review-freeze", "off", "fix the parser"]);
    const propose = /`([^`]*next --propose <plan> --request [0-9a-f]{8})`/.exec(String(first.directive?.message))?.[1];
    expect(propose, first.out).toBeDefined();
    const proposal = (propose as string).replace("<plan>", "bugfix");
    const offer = next(proj, proposal.slice(proposal.indexOf(" next ") + 6).split(" "));
    expect(offer.directive?.kind, offer.out).toBe("ask");
    const commands = [offer.directive?.confirm_command, ...(offer.directive?.scope_commands ?? []).map((row) => row.command)]
      .filter((command): command is string => typeof command === "string");
    expect(commands.length, offer.out).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).toContain("--guard-policy relaxed");
      expect(command).toContain("--guard.review-freeze off");
    }
    const request = /--request ([0-9a-f]{8})/.exec(commands[0])?.[1];
    expect(request, commands[0]).toBeDefined();
    const made = utility(proj, [
      "intent-create", "--scope", "enterprise", "--request", request!, "--guard-policy", "relaxed", "--guard.review-freeze", "off",
    ]);
    expect(made.status, made.stderr).toBe(0);
    const built = createdState(proj);
    expect(getField(built, "Guard Policy")).toBe("relaxed (set by you)");
    expect(getField(built, "Guards Off") ?? "").toContain("review-freeze");
  });

  test("with no message of theirs in the chat, the check stays on and the setter's line says whose call it is", () => {
    const proj = emptyProject();
    const refused = utility(proj, ["intent-create", "--scope", "enterprise", "--guard.review-freeze", "off"], OTHER);
    expect(refused.status, refused.stdout).not.toBe(0);
    expect(refused.stderr).toContain("is the person's call");
    expect(existsSync(join(intents(proj), "active-intent"))).toBe(false);
  });
});

// The chain the agent is told to follow cannot loop. A bare `next` takes the
// person's own recorded line (takePersonsOwnLine, the Copilot CLI shape where
// the agent passes no arguments), so each step must lead somewhere: a stage
// step, a setting applied and said, or one question for the person. The loop:
// a print that names a command, the command run, then a bare `next` that takes
// the same line and prints the same thing again, forever, applying the setting
// twice on the way.
describe("the chain the agent follows ends, within three steps, and applies a setting once", () => {
  /**
   * The agent's own loop: ask the engine for the step with a bare `next`, say or
   * run exactly the one command the step names, ask again. At most `max` engine
   * calls. Returns what it was told, what it ran, and how the chain ended.
   */
  function chainFromBareNext(
    proj: string,
    max = 3,
    first: string[] = [],
  ): { prints: string[]; ran: string[]; refused: string[]; ended: string } {
    const prints: string[] = [];
    const ran: string[] = [];
    const refused: string[] = [];
    for (let call = 0; call < max; call += 1) {
      // The first call is the agent's own: bare (Copilot CLI), or with the
      // person's line as its arguments (`next $ARGUMENTS`, Claude Code).
      const step = next(proj, call === 0 ? first : []);
      const kind = step.directive?.kind ?? "none";
      if (kind !== "print") return { prints, ran, refused, ended: kind };
      const message = String(step.directive?.message ?? "");
      prints.push(message);
      // A step that names a command to run is the only one the agent acts on;
      // any other print is the line it says to the person, and the turn ends.
      const command = /Run `([^`]+)`/.exec(message)?.[1];
      if (command === undefined) return { prints, ran, refused, ended: "said" };
      const result = runAsTheAgent(proj, command);
      // A setter that refuses says so and exits non-zero: that refusal is the
      // line said, and the agent asks the engine again.
      if (result.status !== 0) refused.push(`${command}: ${result.out}`);
      ran.push(command);
    }
    return { prints, ran, refused, ended: "unresolved" };
  }

  /**
   * The agent runs the command a step names and prints its output as it came.
   * The command names the install's own tool path (`.claude/tools/...`), which
   * a person's project has and a fixture does not: run the same tool out of the
   * build under test, with the same arguments.
   */
  function runAsTheAgent(proj: string, command: string): { status: number; out: string } {
    const argv = command.split(/\s+/).map((token) =>
      /^\.[\\/]?[a-z-]*[\\/]tools[\\/]aidlc[a-z-]*\.ts$/.test(token)
        ? join(AIDLC_SRC, "tools", token.split(/[\\/]/).pop() as string)
        : token);
    const result = spawnSync(argv[0] === "bun" ? BUN : argv[0], argv.slice(1), {
      cwd: proj,
      env: { ...process.env, ...CLEAR, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  }

  const settingRows = (proj: string): number =>
    rows(proj, "CEREMONY_SET").length + rows(proj, "GUARD_POLICY_SET").length + rows(proj, "GUARD_DISABLED").length;

  function endsCleanly(proj: string, note: string, first: string[] = []): { prints: string[] } {
    const before = settingRows(proj);
    const walk = chainFromBareNext(proj, 3, first);
    expect(walk.refused, `${note}: the setter refused`).toHaveLength(0);
    expect(["ask", "run-stage", "said"], `${note}: ended ${walk.ended} after ${JSON.stringify(walk.prints.map((line) => line.slice(0, 60)))}`)
      .toContain(walk.ended);
    expect(new Set(walk.prints).size, `${note}: a print came back twice`).toBe(walk.prints.length);
    expect(walk.ran.length, `${note}: ran ${JSON.stringify(walk.ran)}`).toBeLessThanOrEqual(1);
    expect(settingRows(proj) - before, `${note}: a setting was applied more than once`).toBeLessThanOrEqual(1);
    return walk;
  }

  test("a settings-only line before any work", () => {
    const proj = emptyProject();
    reply(proj, "/aidlc --plan-approval off");
    endsCleanly(proj, "settings only, no work");
    expect(keptForNextWork(proj)).toBe(true);
  });

  test("a settings-only line with work open", () => {
    const proj = openWork("strict");
    reply(proj, "/aidlc --guard-policy off");
    endsCleanly(proj, "settings only, work open");
    expect(getField(state(proj), "Guard Policy")).toBe("off (set by you)");
  });

  test("a settings-only line with the plan question open", () => {
    const proj = openWork();
    askFor(proj);
    reply(proj, "/aidlc --plan-approval off");
    endsCleanly(proj, "settings only, plan question open");
  });

  test("a setting typed with a reply", () => {
    const proj = openWork();
    askFor(proj);
    reply(proj, "/aidlc --guard-policy off approve the plan");
    endsCleanly(proj, "a setting with a reply");
  });

  test("a misspelt flag", () => {
    const proj = openWork();
    reply(proj, "/aidlc --plan-aprroval off");
    endsCleanly(proj, "a misspelt flag");
  });

  test("a question about a check", () => {
    const proj = openWork();
    askFor(proj);
    reply(proj, "skip plan approval?");
    endsCleanly(proj, "a question about a check");
  });

  test("the same line twice: the second bare next is the work's own step, not the line again", () => {
    const proj = openWork("strict");
    reply(proj, "/aidlc --guard-policy off");
    const first = chainFromBareNext(proj);
    expect(first.ran).toHaveLength(1);
    const second = chainFromBareNext(proj);
    for (const line of second.prints) expect(first.prints, "the same print came back").not.toContain(line);
    expect(second.ran, "a second setter ran for one line").toHaveLength(0);
    expect(rows(proj, "GUARD_POLICY_SET")).toHaveLength(1);
  });

  // The shape the case above misses: a setter that changes nothing writes no
  // row, so the person's turn stayed the latest row and a bare `next` named the
  // same setter forever. The line is handed to the setter once, whatever the
  // setter then says.
  const SHAPES = [
    { shape: "a bare next (Copilot CLI)", first: (_line: string[]): string[] => [] },
    { shape: "next with their line (Claude Code)", first: (line: string[]): string[] => line },
  ];

  test.each(SHAPES)("a setting already in force, typed again: said once, then the work's own step, from $shape", ({ first }) => {
    const proj = openWork("off");
    reply(proj, "/aidlc --guard-policy off");
    endsCleanly(proj, "already off, typed again", first(["--guard-policy", "off"]));
    expect(rows(proj, "GUARD_POLICY_SET")).toHaveLength(0);
    expect(getField(state(proj), "Guard Policy")).toBe("off (set by you)");
  });

  test.each(SHAPES)("plan approval already off, set by them, typed again: said once, then the work's own step, from $shape", ({ first }) => {
    const proj = openWork("relaxed", "off-by-you");
    reply(proj, "/aidlc --plan-approval off");
    endsCleanly(proj, "plan approval already off, typed again", first(["--plan-approval", "off"]));
    expect(rows(proj, "CEREMONY_SET")).toHaveLength(0);
    expect(getField(state(proj), "Plan Approval")).toBe("off (set by you)");
  });

  test.each(SHAPES)("a team lock on the line: the engine says the team's line once, then the work's own step, from $shape", ({ first }) => {
    const proj = openWork("strict");
    const memory = lockMemory(proj);
    reply(proj, "/aidlc --guard-policy relaxed");
    const walk = endsCleanly(proj, "a team lock on relaxed", first(["--guard-policy", "relaxed"]));
    expect(walk.prints.join("\n")).toContain(`Your team set Guard Policy to strict in ${memory}`);
    expect(getField(state(proj), "Guard Policy")).toBe("strict (set by you)");
    expect(rows(proj, "GUARD_POLICY_SET")).toHaveLength(0);
  });

  // Windows spells a path with backslashes, and a refusal printed as JSON
  // doubles every one: the person read "C:\\wf-tmp\\..." for their own
  // memory file. What they read must be the plain line: no JSON frame (what
  // doubles them, on any machine) and the path as the file system spells it.
  test("the team's line reaches the person as a plain line, with the memory file spelled as the file system spells it", () => {
    const proj = openWork("strict");
    const memory = lockMemory(proj);
    reply(proj, "/aidlc --guard-policy relaxed");
    const step = next(proj, ["--guard-policy", "relaxed"]);
    const message = String(step.directive?.message);
    const command = /Run `([^`]+)`/.exec(message)?.[1];
    const read = command === undefined ? message : runAsTheAgent(proj, command).out;
    expect(read.trim().startsWith("{"), read).toBe(false);
    expect(read).toContain(`Your team set Guard Policy to strict in ${memory} (section: Guard Policy)`);
  });
});

describe("one reader of the line", () => {
  test("no skill says the hook applied the switch, and the hook's parser family is gone", () => {
    for (const harness of HARNESSES) {
      const skill = readFileSync(join(REPO_ROOT, "harness", harness, "skills", "aidlc", "SKILL.md"), "utf-8");
      expect(skill, harness).not.toContain("the human-turn hook applied it");
      expect(skill, harness).not.toContain("the harness has already applied it");
    }
    expect(Object.keys(guardSwitch)).not.toContain("isTypedGuardSwitchPrompt");
    expect(Object.keys(guardSwitch)).not.toContain("applyTypedGuardSwitchPrompt");
  });
});
