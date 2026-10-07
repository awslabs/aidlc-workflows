// covers: function:parseTypedGuardSwitchRequest, function:applyTypedGuardSwitchPrompt, function:fencesOffCreationGranted
//
// A fence switch ("/aidlc --guard.review-freeze off") typed together with a
// request is for that request, the way Guard Policy typed with it is: the open
// work keeps its checks, new work takes the switch when it is created, and
// continuing the open work instead applies it there. Typed before any work
// exists, it is for the piece of work this chat starts next. Typed alone
// beside open work, it applies to that work at once, as before.

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
  removeWorkspaceRecord,
  runOrchestrateNext,
  seededStateFile,
} from "../harness/fixtures.ts";
import { getField, hooksHealthDir, pendingPersonLines } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(120_000);

const BUN = process.execPath;
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const SESSION = "01995000-7a11-7000-8000-000000000012";
// The runner's fixture profile carries a presence bypass that would authorize a
// command to lower a check; clear it so only the person's words can.
const CLEAR = {
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0",
  AIDLC_SESSION_OVERRIDE: SESSION,
  AIDLC_UNATTENDED: "0",
};
const TYPED = "/aidlc --guard.review-freeze off fix the parser";

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

/** Open work under a strict Guard Policy, set by the person. */
function openWork(): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  const state = readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8")
    .replace("- **Change Control**: strict (from scope feature)", "- **Guard Policy**: strict (set by you)");
  writeFileSync(seededStateFile(proj), state, "utf-8");
  return proj;
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

/** One piece of work started from the terminal, whose session runs the hooks. */
function oneOpenRecord(): { proj: string; open: string } {
  const proj = emptyProject();
  expect(utility(proj, ["intent-create", "--scope", "enterprise"]).status).toBe(0);
  const health = hooksHealthDir(proj);
  mkdirSync(health, { recursive: true });
  writeFileSync(join(health, "write-audit-log.last"), new Date().toISOString());
  return { proj, open: readFileSync(join(intents(proj), "active-intent"), "utf-8").trim() };
}

function intents(proj: string): string {
  return join(proj, "aidlc", "spaces", "default", "intents");
}

function activeState(proj: string): string {
  const record = readFileSync(join(intents(proj), "active-intent"), "utf-8").trim();
  return readFileSync(join(intents(proj), record, "aidlc-state.md"), "utf-8");
}

function guardsOff(state: string): string {
  return getField(state, "Guards Off") ?? "";
}

function reply(proj: string, prompt: string): string {
  const result = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }),
    env: { ...process.env, ...CLEAR, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
  // The hook may answer in JSON; compare the text it carries.
  const out = result.stdout ?? "";
  try {
    const parsed = JSON.parse(out) as { additionalContext?: unknown; hookSpecificOutput?: { additionalContext?: unknown } };
    const text = parsed.additionalContext ?? parsed.hookSpecificOutput?.additionalContext;
    if (typeof text === "string") return text;
  } catch {
    // Plain text output.
  }
  return out;
}

function utility(proj: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(BUN, [UTILITY, ...args, "--project-dir", proj], {
    cwd: proj,
    env: { ...process.env, ...CLEAR, CLAUDE_PROJECT_DIR: proj },
    encoding: "utf-8",
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function next(proj: string, args: string[]): { directive: Record<string, unknown> | null; out: string } {
  const result = runOrchestrateNext(ORCHESTRATE, proj, args, { env: { ...process.env, ...CLEAR } });
  return { directive: result.directive as Record<string, unknown> | null, out: result.out };
}

/** The `next` arguments of an answer command the engine handed out. */
function answerArgs(command: unknown): string[] {
  const text = String(command);
  return text.slice(text.indexOf(" next ") + 6).split(" ");
}

function requestIn(message: unknown, out: string): string {
  const id = /--request ([0-9a-f]{8})/.exec(String(message))?.[1];
  if (id === undefined) throw new Error(`no request in ${out}`);
  return id;
}

function lockMemory(proj: string): string {
  const dir = join(proj, "aidlc", "spaces", "default", "memory");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "project.md");
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "# Project\n";
  writeFileSync(
    path,
    existing.includes("## Guard Policy\n")
      ? existing.replace("## Guard Policy\n", "## Guard Policy\n\nMode: strict\n")
      : `${existing.trimEnd()}\n\n## Guard Policy\n\nMode: strict\n`,
    "utf-8",
  );
  return path;
}

describe("a fence switch typed with a request beside open work", () => {
  for (const typed of [TYPED, "/aidlc --guard.review-freeze off -- fix the parser"]) {
    test(`"${typed}" leaves the open work's checks as they are and says whose it is`, () => {
      const proj = openWork();
      const before = readFileSync(seededStateFile(proj), "utf-8");
      expect(reply(proj, typed)).toContain("The review freeze check is off for the work you are asking for (set by you).");
      expect(readFileSync(seededStateFile(proj), "utf-8")).toBe(before);
    });
  }

  test("new work picked: it starts with the check off, the person hears so, and the open work is untouched", () => {
    const { proj, open } = oneOpenRecord();
    const openBefore = readFileSync(join(intents(proj), open, "aidlc-state.md"), "utf-8");
    // A strict plan for the new work, so the check is on until the switch turns it off.
    reply(proj, "/aidlc --guard.review-freeze off enterprise fix the parser");
    const routing = next(proj, ["--guard.review-freeze", "off", "enterprise", "fix", "the", "parser"]);
    const ask = routing.directive as { ask_type?: string; new_work_description?: string; new_intent_command?: string } | null;
    expect(ask?.ask_type, routing.out).toBe("new-work-routing");
    // The switch is not part of what the person asked for.
    expect(ask?.new_work_description).toBe("fix the parser");
    // The person picks new work.
    const routed = next(proj, answerArgs(ask?.new_intent_command));
    expect(pendingPersonLines(proj, SESSION).lines.join(" "), routed.out).toContain(
      "The review freeze check is off for the new work (set by you).",
    );
    const made = utility(proj, ["intent-create", "--request", requestIn(routed.directive?.message, routed.out)]);
    expect(made.status, made.stderr).toBe(0);
    expect(guardsOff(activeState(proj))).toContain("review-freeze");
    expect(readFileSync(join(intents(proj), open, "aidlc-state.md"), "utf-8")).toBe(openBefore);
  });

  test("continuing the open work instead applies it there", () => {
    const { proj } = oneOpenRecord();
    reply(proj, TYPED);
    const routing = next(proj, ["--guard.review-freeze", "off", "--", "fix the parser"]);
    const ask = routing.directive as { ask_type?: string; continue_command?: string } | null;
    expect(ask?.ask_type, routing.out).toBe("new-work-routing");
    expect(String(ask?.continue_command)).toContain("--guard.review-freeze off");
    const kept = next(proj, answerArgs(ask?.continue_command));
    expect(String(kept.directive?.message), kept.out).toContain("guard.review-freeze off");
  });

  test("a team's strict Guard Policy refuses it, naming the file, and the new work keeps the check", () => {
    const { proj } = oneOpenRecord();
    const memory = lockMemory(proj);
    expect(reply(proj, TYPED)).toContain(memory);
    const routing = next(proj, ["--guard.review-freeze", "off", "fix the parser"]);
    const routed = next(proj, answerArgs((routing.directive as { new_intent_command?: string } | null)?.new_intent_command));
    const made = utility(proj, ["intent-create", "--request", requestIn(routed.directive?.message, routed.out)]);
    expect(made.status, made.stderr).toBe(0);
    expect(guardsOff(activeState(proj))).not.toContain("review-freeze");
  });

  test("typed alone, with no request, it is for the open work at once", () => {
    const proj = openWork();
    expect(reply(proj, "/aidlc --guard.review-freeze off")).toContain("The review freeze check is off for this piece of work");
    expect(guardsOff(readFileSync(seededStateFile(proj), "utf-8"))).toContain("review-freeze");
  });
});

describe("a fence switch typed before any work exists", () => {
  const requestOf = (proj: string, task: string): { id: string; out: string } => {
    const printed = next(proj, ["--scope", "enterprise", "--", task]);
    return { id: requestIn(printed.directive?.message, printed.out), out: printed.out };
  };

  test("it is for the piece of work this chat starts next", () => {
    const proj = emptyProject();
    expect(reply(proj, "/aidlc --guard.review-freeze off")).toContain(
      "The review freeze check is off for the piece of work you start now (set by you).",
    );
    const asked = requestOf(proj, "build the export");
    const made = utility(proj, ["intent-create", "--request", asked.id]);
    expect(made.status, made.stderr).toBe(0);
    expect(guardsOff(activeState(proj))).toContain("review-freeze");
  });

  test("typed with the request, creation takes it", () => {
    const proj = emptyProject();
    expect(reply(proj, TYPED)).toContain("The review freeze check is off for the work you are asking for (set by you).");
    const asked = requestOf(proj, "fix the parser");
    const made = utility(proj, ["intent-create", "--request", asked.id]);
    expect(made.status, made.stderr).toBe(0);
    expect(guardsOff(activeState(proj))).toContain("review-freeze");
  });

  test.each([
    "/aidlc --guard.review-freeze on",
    "/aidlc --guard.review-freeze on fix the parser",
    "/aidlc --guard.review-freeze off --guard.review-freeze on",
    "/aidlc --guard.review-freeze off --guard.review-freeze on fix the parser",
  ])("typed on (%s), the new work starts with it on", (typed) => {
    const proj = emptyProject();
    reply(proj, typed);
    const asked = requestOf(proj, "fix the parser");
    expect(utility(proj, ["intent-create", "--request", asked.id]).status).toBe(0);
    expect(guardsOff(activeState(proj))).not.toContain("review-freeze");
  });

  test("plan approval typed on before the work stays on", () => {
    const proj = emptyProject();
    reply(proj, "/aidlc --guard.plan-approval on");
    const asked = requestOf(proj, "build the export");
    expect(utility(proj, ["intent-create", "--request", asked.id]).status).toBe(0);
    expect(getField(activeState(proj), "Plan Approval") ?? "").toStartWith("on");
  });

  test("turned back on before the work, the new work starts with it on", () => {
    const proj = emptyProject();
    reply(proj, "/aidlc --guard.review-freeze off");
    reply(proj, "/aidlc --guard.review-freeze on");
    const asked = requestOf(proj, "build the export");
    expect(utility(proj, ["intent-create", "--request", asked.id]).status).toBe(0);
    expect(guardsOff(activeState(proj))).not.toContain("review-freeze");
  });

  test("a creation that names no request never takes it", () => {
    const proj = emptyProject();
    reply(proj, "/aidlc --guard.review-freeze off");
    expect(utility(proj, ["intent-create", "--scope", "enterprise"]).status).toBe(0);
    expect(guardsOff(activeState(proj))).not.toContain("review-freeze");
  });
});
