// covers: cli:aidlc-orchestrate(report), function:settingsBesideDecision, hook:aidlc-rebuild-stage-graph
// covers: audit:GATE_APPROVED
//
// "approve, and turn plan approval off" answered at a stage gate while the
// team's memory holds Guard Policy strict: the setter refuses the setting, and
// the approval report that carried it used to end in an engine error, which the
// host's hook put on the person's screen with the agent told to stop, so nothing
// was approved and the person had to give their approval again. The report's
// answer is the agent's next step: nothing shows it to the person, and the same
// report without the setting records the approval on their reply, with plan
// approval still on. Claude Code's question box and Codex's, under Guard Policy
// off and strict.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const CHAT = "01995000-7a11-7000-8000-00000000e231";
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
  // The team's memory holds Guard Policy strict, so plan approval stays on for everyone.
  const memory = join(proj, "aidlc", "spaces", "default", "memory");
  mkdirSync(memory, { recursive: true });
  const team = join(memory, "team.md");
  const existing = existsSync(team) ? readFileSync(team, "utf-8") : "# Team\n";
  writeFileSync(
    team,
    existing.includes("## Guard Policy\n")
      ? existing.replace("## Guard Policy\n", "## Guard Policy\n\nMode: strict\n")
      : `${existing.trimEnd()}\n\n## Guard Policy\n\nMode: strict\n`,
    "utf-8",
  );
  return proj;
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
function report(proj: string, host: Host, extra: string[]) {
  const args = ["--stage", STAGE, "--result", "approved", "--user-input", "Approve", ...extra];
  const command = `bun ${TREE[host]}/tools/aidlc.ts engine orchestrate report ${args.join(" ")}`;
  const r = run(proj, [join(proj, TREE[host], "tools", "aidlc.ts"), "engine", "orchestrate", "report", ...args],
    { ...GATE_ENV, ...(host === "codex" ? { CLAUDE_PROJECT_DIR: undefined } : {}) });
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

describe.each(POLICIES)("Guard Policy %s: an approval asked beside a setting the team locked is recorded in the same turn", (policy) => {
  for (const host of ["claude", "codex"] as const) {
    test(`${host}: the refused setting's report is the agent's step, shown to nobody, and the report without it records the approval`, () => {
      const proj = project(host, policy);
      const state = (args: string[]) => {
        const r = run(proj, [STATE, ...args, "--project-dir", proj], GATE_ENV);
        expect(r.status, r.out).toBe(0);
      };
      state(["checkbox", `${STAGE}=in-progress`]);
      tick();
      state(["gate-start", STAGE]);
      tick();
      const box = answerBox(proj, host, ASKED);
      tick();

      const refused = report(proj, host, ["--plan-approval", "off", "--message", box]);
      expect(refused.status, refused.out).toBe(0);
      const directive = JSON.parse(refused.stdout.trim().split("\n").at(-1) as string) as { kind: string; message: string };
      // The team's line is said once, and the step records the approval the person gave.
      expect(directive.kind, refused.out).toBe("print");
      expect(directive.message).toStartWith('Tell the person in one line: "Your team set Guard Policy to strict in ');
      expect(directive.message).toContain(join("aidlc", "spaces", "default", "memory", "team.md"));
      expect(directive.message).toEndWith(
        'team.md, so plan approval stays on for everyone on this repo. Changing that line there changes it." ' +
          "Then run this report again without the setting to record the approval.",
      );
      expect(directive.message).not.toContain("Nothing was approved");
      expect(rows(proj, "GATE_APPROVED")).toHaveLength(0);
      // Nothing puts an engine error on the person's screen or ends the agent's turn on it.
      const shown = afterTheCall(proj, host, refused.command, refused.stdout);
      expect(shown).not.toContain("systemMessage");
      expect(shown).not.toContain("end your turn");

      // The same turn: no message of theirs in between.
      const approved = report(proj, host, ["--message", box]);
      expect(approved.status, approved.out).toBe(0);
      expect(JSON.parse(approved.stdout.trim().split("\n").at(-1) as string).kind, approved.out).toBe("done");
      expect(latestTurn(proj)).toBe(box);
      const gate = rows(proj, "GATE_APPROVED");
      expect(gate, approved.out).toHaveLength(1);
      expect(field(gate[0], "Message Id")).toBe(box);
      expect(field(gate[0], "Person Reply")).toBe(ASKED);
      expect(rows(proj, "CEREMONY_SET")).toHaveLength(0);
      expect(getField(readFileSync(seededStateFile(proj), "utf-8"), "Plan Approval")).not.toBe("off (set by you)");
    });
  }

  // Guard Policy itself and a check other than plan approval: the team's own line for each.
  for (const [asked, flag, kept] of [
    ["approve, and relax the Guard Policy", ["--guard-policy", "relaxed"], "so it stays strict for everyone on this repo."],
    ["approve, and turn the review freeze off", ["--guard.review-freeze", "off"], "so review-freeze stays on for everyone on this repo."],
  ] as const) {
    test(`claude: ${flag[0]} ${flag[1]} beside the approval: the team's line for it is the step`, () => {
      const proj = project("claude", policy);
      const state = (args: string[]) => {
        const r = run(proj, [STATE, ...args, "--project-dir", proj], GATE_ENV);
        expect(r.status, r.out).toBe(0);
      };
      state(["checkbox", `${STAGE}=in-progress`]);
      tick();
      state(["gate-start", STAGE]);
      tick();
      const box = answerBox(proj, "claude", asked);
      tick();
      const refused = report(proj, "claude", [...flag, "--message", box]);
      expect(refused.status, refused.out).toBe(0);
      const directive = JSON.parse(refused.stdout.trim().split("\n").at(-1) as string) as { kind: string; message: string };
      expect(directive.kind, refused.out).toBe("print");
      expect(directive.message).toStartWith('Tell the person in one line: "Your team set Guard Policy to strict in ');
      expect(directive.message).toEndWith(
        `${kept} Changing that line there changes it." Then run this report again without the setting to record the approval.`,
      );
      expect(rows(proj, "GATE_APPROVED")).toHaveLength(0);
    });
  }

  // Beside a setting the team does not keep, the report without the settings
  // would drop that one too: the setter's own refusal is the step, as before.
  test("claude: a setting the team does not keep, asked with the locked one: the setter's refusal is the step", () => {
    const proj = project("claude", policy);
    const state = (args: string[]) => {
      const r = run(proj, [STATE, ...args, "--project-dir", proj], GATE_ENV);
      expect(r.status, r.out).toBe(0);
    };
    state(["checkbox", `${STAGE}=in-progress`]);
    tick();
    state(["gate-start", STAGE]);
    tick();
    const box = answerBox(proj, "claude", "approve, turn plan approval off and learnings off");
    tick();

    const refused = report(proj, "claude", ["--plan-approval", "off", "--learnings", "off", "--message", box]);
    expect(refused.status, refused.out).toBe(0);
    const directive = JSON.parse(refused.stdout.trim().split("\n").at(-1) as string) as { kind: string; message: string };
    expect(directive.kind, refused.out).toBe("print");
    expect(directive.message).not.toContain("Tell the person in one line");
    expect(directive.message).toEndWith(" Nothing was approved: run this report again without the setting to record the approval.");
    expect(rows(proj, "GATE_APPROVED")).toHaveLength(0);
    expect(afterTheCall(proj, "claude", refused.command, refused.stdout)).not.toContain("systemMessage");
  });
});
