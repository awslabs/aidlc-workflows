// covers: cli:aidlc-orchestrate(report), hook:aidlc-rebuild-stage-graph, function:engineErrorRelayMessage
// covers: audit:CEREMONY_SET, audit:GATE_APPROVED
//
// "approve, and turn plan approval off for the rest of this work" answered at a
// stage gate after an earlier reply that nothing recorded (the "done" that
// handed in the questions file): the approval report that carries the setting
// and names no message is told the replies' ids, records nothing, and its step
// is the agent's to take at once. Live Claude Code runs met it as an engine
// error: the hook put the line with the ids on the person's screen and told the
// agent to end its turn, and the person was asked to say go ahead again. Here
// the step is no error, nothing shows it to the person, and naming the reply
// that asked records the approval and the setting in the same turn, with no
// message of theirs in between. Claude Code's question box and Codex's.
// Each case runs under Guard Policy off and strict.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  auditBlockField, formatGuardPolicy, getField, readAuditShardEvents, setGuardPolicyLine, writeSessionPidEntry,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, REPO_ROOT, seededStateFile, seedStateFile,
} from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const CHAT = "01995000-7a11-7000-8000-00000000a5e7";
const ASKED = "approve, and turn plan approval off for the rest of this work";
const STAGE = "feasibility";
const GATE_QUESTION = "Feasibility complete. How would you like to proceed?";
const CLEAR = {
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0", AIDLC_UNATTENDED: "0", AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "0",
  AIDLC_DISABLE_LEARNINGS: "0", AIDLC_DISABLE_SUMMARY_CONFIRMATION: "0",
};
// Only the gate's own setup: the stage's files, review and summary are not what is tested.
const GATE_ENV = {
  AIDLC_SKIP_ARTIFACT_GUARD: "1", AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1", AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
};
const POLICIES: Array<"off" | "strict"> = ["off", "strict"];
type Host = "claude" | "codex";
const TREE: Record<Host, string> = { claude: ".claude", codex: ".codex" };

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

// The engine's times are to the second: each step waits for the next one.
const tick = () => Bun.sleepSync(1100);

function run(proj: string, args: string[], extra: NodeJS.ProcessEnv = {}, input?: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env, ...CLEAR, AIDLC_SESSION_OVERRIDE: CHAT, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, ...extra,
  };
  // No mark of the shell that runs the suite: the agent's shell is no terminal of the person's own tool.
  for (const key of Object.keys(env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_|CODEX_THREAD_ID$|CODEX_SESSION_ID$)/.test(key)) delete env[key];
  }
  const r = spawnSync(BUN, args, {
    cwd: proj, env, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    ...(input === undefined ? {} : { input }),
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const rows = (proj: string, event: string) => readAuditShardEvents(proj).filter((row) => row.event === event);
const field = (row: { block: string } | undefined, name: string): string | null =>
  row === undefined ? null : auditBlockField(row.block, name);
const latestTurn = (proj: string): string => {
  const id = field(rows(proj, "HUMAN_TURN").at(-1), "Message Id");
  expect(id).not.toBeNull();
  return id as string;
};

function project(host: Host, policy: "off" | "strict"): string {
  const proj = createTestProject();
  created.push(proj);
  seedStateFile(proj, "state-mid-ideation.md");
  const statePath = seededStateFile(proj);
  writeFileSync(statePath, setGuardPolicyLine(readFileSync(statePath, "utf-8"), formatGuardPolicy(policy, "you")));
  // The host's own install, as a person's project has it.
  if (!existsSync(join(proj, TREE[host]))) cpSync(join(REPO_ROOT, "dist", host, TREE[host]), join(proj, TREE[host]), { recursive: true });
  if (host === "codex") writeSessionPidEntry(proj, process.pid, CHAT);
  return proj;
}

// The person types `prompt`, through the host's own human-turn hook.
function say(proj: string, host: Host, prompt: string): string {
  const r = host === "claude"
    ? run(proj, [join(proj, ".claude", "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"], {},
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: CHAT, cwd: proj, prompt }))
    : run(proj, [join(proj, ".codex", "hooks", "aidlc-codex-adapter.ts"), "record-human-turn"], { CLAUDE_PROJECT_DIR: undefined },
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: CHAT, turn_id: "t1", cwd: proj, prompt }));
  expect(r.status, r.out).toBe(0);
  return latestTurn(proj);
}

// The person answers the gate in the host's own question box, typing their own words.
function answerBox(proj: string, host: Host, reply: string): string {
  const r = host === "claude"
    ? run(proj, [join(proj, ".claude", "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"], {}, JSON.stringify({
      hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", session_id: CHAT, cwd: proj,
      tool_input: { questions: [{ question: GATE_QUESTION, options: [{ label: "Approve" }, { label: "Request Changes" }] }] },
      tool_response: { answers: { [GATE_QUESTION]: reply } },
    }))
    : run(proj, [join(proj, ".codex", "hooks", "aidlc-codex-adapter.ts"), "record-human-turn"], { CLAUDE_PROJECT_DIR: undefined },
      JSON.stringify({
        hook_event_name: "PostToolUse", tool_name: "request_user_input", session_id: CHAT, turn_id: "t2", cwd: proj,
        tool_input: { questions: [{ id: "q1", question: GATE_QUESTION, options: ["Approve", "Request Changes"] }] },
        tool_response: JSON.stringify({ answers: { q1: { answers: [reply] } } }),
      }));
  expect(r.status, r.out).toBe(0);
  return latestTurn(proj);
}

// The approval report as the agent runs it, through the host's own engine command.
function report(proj: string, host: Host, extra: string[] = []) {
  const command = `bun ${TREE[host]}/tools/aidlc.ts engine orchestrate report --stage ${STAGE} ` +
    `--result approved --user-input "Approve" --plan-approval off${extra.length > 0 ? ` ${extra.join(" ")}` : ""}`;
  const r = run(proj, [join(proj, TREE[host], "tools", "aidlc.ts"), "engine", "orchestrate", "report",
    "--stage", STAGE, "--result", "approved", "--user-input", "Approve", "--plan-approval", "off",
    ...extra], { ...GATE_ENV, ...(host === "codex" ? { CLAUDE_PROJECT_DIR: undefined } : {}) });
  return { ...r, command };
}

// What the host's PostToolUse hook prints after that report: the line the person would be shown, if any.
function afterTheCall(proj: string, host: Host, command: string, stdout: string): string {
  const r = host === "claude"
    ? run(proj, [join(proj, ".claude", "hooks", "aidlc-rebuild-stage-graph.ts")], { AIDLC_HARNESS_NAME: "claude" },
      JSON.stringify({
        hook_event_name: "PostToolUse", session_id: CHAT, tool_name: "Bash", tool_input: { command },
        tool_response: { stdout, stderr: "", interrupted: false },
      }))
    : run(proj, [join(proj, ".codex", "hooks", "aidlc-codex-adapter.ts"), "rebuild-stage-graph"], { CLAUDE_PROJECT_DIR: undefined },
      JSON.stringify({
        session_id: CHAT, turn_id: "t3", cwd: proj, hook_event_name: "PostToolUse", tool_name: "Bash",
        tool_input: { command }, tool_response: stdout, tool_use_id: "call_report",
      }));
  expect(r.status, r.out).toBe(0);
  return r.stdout;
}

describe.each(POLICIES)("Guard Policy %s: a setting at a gate after an unrecorded reply is recorded in the same turn", (policy) => {
  for (const host of ["claude", "codex"] as const) {
    test(`${host}: "done", then the setting in the gate box: the report's step is the agent's, shown to nobody, and naming the box answer records both`, () => {
      const proj = project(host, policy);
      const state = (args: string[]) => {
        const r = run(proj, [STATE, ...args, "--project-dir", proj], GATE_ENV);
        expect(r.status, r.out).toBe(0);
      };
      state(["checkbox", `${STAGE}=in-progress`]);
      tick();
      const done = say(proj, host, "done");
      tick();
      state(["gate-start", STAGE]);
      tick();
      const box = answerBox(proj, host, ASKED);
      expect(box).not.toBe(done);
      tick();

      const unnamed = report(proj, host);
      expect(unnamed.status, unnamed.out).toBe(0);
      const directive = JSON.parse(unnamed.stdout.trim().split("\n").at(-1) as string) as { kind: string; message: string };
      // The agent's next step, as every refused report's step for a choice the person made is.
      expect(directive.kind, unnamed.out).toBe("print");
      expect(directive.message).toContain(done);
      expect(directive.message).toContain(box);
      expect(directive.message).toContain("--message");
      expect(rows(proj, "GATE_APPROVED")).toHaveLength(0);
      expect(rows(proj, "CEREMONY_SET")).toHaveLength(0);
      // Nothing puts the step with its ids on the person's screen or ends the agent's turn on it.
      const shown = afterTheCall(proj, host, unnamed.command, unnamed.stdout);
      expect(shown).not.toContain("systemMessage");
      expect(shown).not.toContain("end your turn");
      expect(shown).not.toContain(done);

      // The same turn: no message of theirs in between.
      const named = report(proj, host, ["--message", box]);
      expect(named.status, named.out).toBe(0);
      expect(JSON.parse(named.stdout.trim().split("\n").at(-1) as string).kind, named.out).toBe("done");
      expect(latestTurn(proj)).toBe(box);
      const approved = rows(proj, "GATE_APPROVED");
      expect(approved, named.out).toHaveLength(1);
      expect(field(approved[0], "Message Id")).toBe(box);
      expect(field(approved[0], "Person Reply")).toBe(ASKED);
      const set = rows(proj, "CEREMONY_SET").at(-1);
      expect(field(set, "Key")).toBe("plan_approval");
      expect(field(set, "New")).toBe("off");
      expect(field(set, "Source")).toBe("you");
      expect(field(set, "Message Id")).toBe(box);
      expect(field(set, "Person Reply")).toBe(ASKED);
      expect(getField(readFileSync(seededStateFile(proj), "utf-8"), "Plan Approval")).toBe("off (set by you)");
      expect(named.stdout).toContain("Plan Approval changed");
    });
  }
});
