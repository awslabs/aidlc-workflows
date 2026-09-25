import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntentRegistryEntry } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { exactCodexUtilityArgv, expectCliSuccess, expectCreatedIntent, expectSpaceInclude } from "../harness/codex-workspace-evidence.ts";

// Full Suite 35849463712, job 107144118072, exec-codex-workspace-6.log.
// The completed command's JSON output was empty, although the root tool result
// and saved active state/audit independently showed successful initialization.
// The session identifier is synthetic; command events retain the observed shape.
const CAPTURED_STDOUT = String.raw`{"type":"thread.started","thread_id":"00000000-0000-7000-8000-000000000003"}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"/bin/zsh -lc 'bun .codex/tools/aidlc.ts engine intent create --scope poc --arguments \"teamB onboarding flow\"'","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"/bin/zsh -lc 'bun .codex/tools/aidlc.ts engine intent create --scope poc --arguments \"teamB onboarding flow\"'","aggregated_output":"","exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Ran the exact command and stopped."}}
{"type":"turn.completed","usage":{"input_tokens":31929,"cached_input_tokens":15418,"cache_write_input_tokens":0,"output_tokens":99,"reasoning_output_tokens":0}}`;

// Relevant state sections from that capture. Registry/include fixtures below
// are synthetic: the failure capture did not retain those files.
const STATE = `# AI-DLC State Tracking

## Project Information
- **Project**: teamB onboarding flow
- **Scope**: poc

## Phase Progress
- **Initialization**: Verified
- **Ideation**: Active

## Stage Progress
### INITIALIZATION PHASE
- [x] workspace-scaffold — EXECUTE
- [x] workspace-detection — EXECUTE
- [x] state-init — EXECUTE

### IDEATION PHASE
- [-] intent-capture — EXECUTE

## Current Status
- **Current Stage**: intent-capture
- **Status**: Running

## Session Resume Point
- **Last Completed Stage**: state-init
`;
const AUDIT = `## Workflow Start
**Timestamp**: 2026-09-23T10:44:56Z
**Event**: WORKFLOW_STARTED
**Scope**: poc
**Request**: /aidlc teamB onboarding flow
**Repos**: repo-a, repo-b

---

## Workspace Initialised
**Timestamp**: 2026-09-23T10:44:56Z
**Event**: WORKSPACE_INITIALISED
**Scope**: poc

---

## Stage Completion
**Timestamp**: 2026-09-23T10:44:56Z
**Event**: STAGE_COMPLETED
**Stage**: state-init

---
`;
const EXPECTED = { space: "teamb", scope: "poc", project: "teamB onboarding flow", stopAfterCreate: true };
const ROUTE = /\bengine\s+intent\s+create\b/;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-workspace-evidence-")));
  roots.push(root);
  const intents = join(root, "aidlc", "spaces", "teamb", "intents");
  const created: IntentRegistryEntry = {
    uuid: "00000000-0000-7000-8000-000000000001",
    slug: "teamb-onboarding-flow", dirName: "260923-teamb-onboarding-flow",
    scope: "poc", status: "in-flight", repos: ["repo-a", "repo-b"],
  };
  const dir = join(intents, created.dirName!);
  mkdirSync(join(dir, "audit"), { recursive: true });
  mkdirSync(join(root, ".codex"));
  const config = join(root, ".codex", "config.toml");
  writeFileSync(config, '[shell_environment_policy.set]\nAIDLC_RULES_DIR = "aidlc/spaces/teamb/memory"\n');
  writeFileSync(join(root, "aidlc", "active-space"), "teamb\n");
  writeFileSync(join(intents, "active-intent"), `${created.dirName}\n`);
  const registry = join(intents, "intents.json");
  writeFileSync(registry, JSON.stringify([created]));
  const state = join(dir, "aidlc-state.md"), audit = join(dir, "audit", "session.md");
  writeFileSync(state, STATE);
  writeFileSync(audit, AUDIT);
  return { root, intents, dir, config, registry, state, audit, created, before: [] as IntentRegistryEntry[] };
}

type Fixture = ReturnType<typeof fixture>;
function verify(f: Fixture, stdout = CAPTURED_STDOUT, stopAfterCreate = true) {
  return expectCliSuccess({ rc: 0, stdout }, ROUTE, () =>
    expectCreatedIntent(f.root, f.before, { ...EXPECTED, stopAfterCreate }));
}
const events = () => CAPTURED_STDOUT.split("\n").map(line => JSON.parse(line));
const jsonl = (rows: ReturnType<typeof events>) => rows.map(row => JSON.stringify(row)).join("\n");
const withOutput = (output: string) => {
  const rows = events();
  rows[3].item.aggregated_output = output;
  return jsonl(rows);
};
const editState = (f: Fixture, from: string, to: string) => writeFileSync(f.state, STATE.replace(from, to));

test("captured empty JSON output succeeds only with a new, active, fully bootstrapped intent", () => {
  const f = fixture();
  expect(verify(f)).toEqual({ dir: f.dir, state: STATE });
});

test("creating a second intent preserves the prior registry row and selects the new record", () => {
  const f = fixture();
  f.before = [{ ...f.created, uuid: "00000000-0000-7000-8000-000000000002",
    slug: "prior-work", dirName: "260922-prior-work", scope: "feature" }];
  writeFileSync(f.registry, JSON.stringify([...f.before, f.created]));
  expect(verify(f).dir).toBe(f.dir);
  // A valid new record does not excuse losing or rewriting the previous row.
  writeFileSync(f.registry, JSON.stringify([f.created]));
  expect(() => verify(f)).toThrow();
  writeFileSync(f.registry, JSON.stringify([{ ...f.before[0], scope: "poc" }, f.created]));
  expect(() => verify(f)).toThrow();
  f.before[0].uuid = "invalid-prior-identity";
  writeFileSync(f.registry, JSON.stringify([...f.before, f.created]));
  expect(() => verify(f)).toThrow();
});

test("the skill-driven beat permits progress after bootstrap; direct creation must stop at the handoff", () => {
  const f = fixture();
  writeFileSync(f.state, STATE
    .replace("**Current Stage**: intent-capture", "**Current Stage**: requirements-analysis")
    .replace("**Last Completed Stage**: state-init", "**Last Completed Stage**: reverse-engineering")
    .replace("- [-] intent-capture", "- [x] intent-capture"));
  expect(verify(f, CAPTURED_STDOUT, false).dir).toBe(f.dir);
  expect(() => verify(f)).toThrow();
});

const brokenState: [string, (f: Fixture) => void][] = [
  ["missing state", f => rmSync(f.state)],
  ["registry with only the pre-bootstrap state header", f =>
    writeFileSync(f.state, "# AI-DLC State Tracking\n- **Project**: teamB onboarding flow\n- **Scope**: poc\n")],
  ["unfinished initialization", f => editState(f, "- [x] state-init", "- [ ] state-init")],
  ["unverified initialization", f => editState(f, "**Initialization**: Verified", "**Initialization**: Active")],
  ["wrong project", f => editState(f, "teamB onboarding flow", "unrelated work")],
  ["wrong scope", f => editState(f, "**Scope**: poc", "**Scope**: feature")],
  ["wrong handoff status", f => editState(f, "**Status**: Running", "**Status**: Pending")],
  ["stale native include", f => writeFileSync(f.config,
    '[shell_environment_policy.set]\nAIDLC_RULES_DIR = "aidlc/spaces/default/memory"\n')],
  ["wrong active space", f => writeFileSync(join(f.root, "aidlc", "active-space"), "default\n")],
  ["missing active intent", f => rmSync(join(f.intents, "active-intent"))],
  ["wrong active intent", f => writeFileSync(join(f.intents, "active-intent"), "260922-prior-work\n")],
  ["unregistered record", f => writeFileSync(f.registry, "[]")],
  ["unchanged registry", f => { f.before = [f.created]; }],
  ["wrong repo span", f => writeFileSync(f.registry, JSON.stringify([{ ...f.created, repos: ["repo-a"] }]))],
  ["invalid intent identity", f => writeFileSync(f.registry, JSON.stringify([{ ...f.created, uuid: "invalid" }]))],
  ["wrong registry status", f => writeFileSync(f.registry, JSON.stringify([{ ...f.created, status: "complete" }]))],
  ["missing audit", f => rmSync(f.audit)],
  ["missing bootstrap audit completion", f => writeFileSync(f.audit, AUDIT.replace("STAGE_COMPLETED", "STAGE_STARTED"))],
  ["foreign workflow creation in the audit", f => writeFileSync(f.audit, `${AUDIT}\n${AUDIT}`)],
];
test.each(brokenState)("empty or nonempty command output cannot conceal %s", (_name, breakState) => {
  const f = fixture();
  breakState(f);
  expect(() => verify(f)).toThrow();
  expect(() => verify(f, withOutput("Intent created: 260923-teamb-onboarding-flow (space: teamb)\nState initialized: poc scope\n"))).toThrow();
});

const brokenExecution: [string, (rows: ReturnType<typeof events>) => void][] = [
  ["prose without a command", rows => { rows.splice(2, 2); }],
  ["unrelated command", rows => {
    rows[2].item.command = "pwd";
    rows[3].item.command = "pwd";
  }],
  ["command with nonzero exit in a successful turn", rows => { rows[3].item.exit_code = 1; }],
  ["command without an exit code", rows => { rows[3].item.exit_code = null; }],
  ["failed command status despite exit zero", rows => { rows[3].item.status = "failed"; }],
  ["started command without completion", rows => { rows.splice(3, 1); }],
  ["completed command without a completed turn", rows => { rows.pop(); }],
  ["failed turn", rows => { rows[5].type = "turn.failed"; }],
  ["command from an earlier turn", rows => {
    rows.push({ type: "turn.started" }, { type: "turn.completed" });
  }],
  ["failed invocation followed by success", rows => {
    rows.splice(3, 0, { type: "item.completed",
      item: { ...rows[3].item, id: "failed-command", status: "failed", exit_code: 1 } });
  }],
  ["failed completion later overwritten with the same item id", rows => {
    rows.splice(3, 0, { type: "item.completed", item: { ...rows[3].item, status: "failed", exit_code: 1 } });
  }],
];
test.each(brokenExecution)("correct disk state cannot conceal %s", (_name, breakExecution) => {
  const f = fixture();
  const rows = events();
  breakExecution(rows);
  expect(() => verify(f, jsonl(rows))).toThrow();
});

test.each([
  { rc: 1 }, { rc: 0, signal: "SIGTERM" }, { rc: 0, error: "spawn failed" },
])("process failure cannot be rescued by a successful command or disk state: %j", processResult => {
  const f = fixture();
  expect(() => expectCliSuccess({ stdout: CAPTURED_STDOUT, ...processResult }, ROUTE, () =>
    expectCreatedIntent(f.root, f.before, EXPECTED))).toThrow();
});

test("space switching requires both cursor and native include even when JSON output is empty", () => {
  const f = fixture();
  const stdout = CAPTURED_STDOUT.replaceAll(
    String.raw`engine intent create --scope poc --arguments \"teamB onboarding flow\"`,
    "engine space teamb",
  );
  const check = () => expectCliSuccess({ rc: 0, stdout }, /\bengine\s+space\s+teamb\b/, () =>
    expectSpaceInclude(f.root, "teamb"));
  check();
  const config = readFileSync(f.config, "utf-8");
  writeFileSync(f.config, config.replace("teamb", "default"));
  expect(check).toThrow();
  writeFileSync(f.config, config);
  writeFileSync(join(f.root, "aidlc", "active-space"), "default\n");
  expect(check).toThrow();
});

const withCommand = (command: string) => {
  const rows = events();
  rows[2].item.command = command;
  rows[3].item.command = command;
  return jsonl(rows);
};
const CREATE = 'bun .codex/tools/aidlc.ts engine intent create --scope poc --arguments "teamB onboarding flow"';
// Full Suite 36043454212, codex-3 Windows, exec-codex-workspace logs: Codex
// displays its PowerShell wrapper with the executable path's backslashes doubled.
const PWSH = String.raw`"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command`;
// Live verification 36061390100, codex-3 Windows: the model asked for a
// non-login shell, which Codex runs as `-NoProfile -Command` (`-c` on POSIX).
const PWSH_NO_PROFILE = String.raw`"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -Command`;

test("only one exact utility invocation carries the route; valid disk state cannot rescue a compound or decoy command", () => {
  for (const command of [
    `/bin/zsh -lc '${CREATE}; mkdir -p aidlc'`,
    `/bin/zsh -lc '${CREATE} && true'`,
    `/bin/zsh -lc '${CREATE} | tee out'`,
    `/bin/zsh -lc '${CREATE} > out'`,
    `/bin/zsh -lc 'echo ${CREATE.replaceAll('"', "")}'`,
    `/bin/zsh -lc 'true # ${CREATE.replaceAll('"', "")}'`,
    `/bin/zsh -lc 'bun .codex/tools/aidlc.ts engine intent create --arguments "$(touch x)"'`,
    `/bin/zsh -lc 'bun .codex/tools/aidlc.ts engine intent create --arguments \`id\`'`,
    `/bin/zsh -lc 'python3 x.py .codex/tools/aidlc.ts engine intent create'`,
    `/bin/zsh -lc 'bun .codex/tools/aidlc.ts.bak engine intent create'`,
    `${PWSH} '${CREATE}; New-Item -ItemType Directory aidlc'`,
    `${PWSH} '${CREATE} | Out-File out'`,
    `${PWSH} 'bun .codex/tools/aidlc.ts engine intent create --arguments "$(New-Item x)"'`,
  ]) {
    const f = fixture();
    expect(() => verify(f, withCommand(command)), command).toThrow();
  }
});

test("the exact parser accepts Codex's own shell wrappers and plain quoting only", () => {
  const argv = ["engine", "intent", "create", "--scope", "poc", "--arguments", "teamB onboarding flow"];
  expect(exactCodexUtilityArgv(`/bin/zsh -lc '${CREATE}'`)).toEqual(argv);
  expect(exactCodexUtilityArgv(`/bin/bash -lc "${CREATE.replaceAll('"', '\\"')}"`)).toEqual(argv);
  expect(exactCodexUtilityArgv(CREATE)).toEqual(argv);
  expect(exactCodexUtilityArgv("bun ./.codex/tools/aidlc.ts engine space switch 'teamB'"))
    .toEqual(["engine", "space", "switch", "teamB"]);
  expect(exactCodexUtilityArgv(`${PWSH} '${CREATE}'`)).toEqual(argv);
  expect(exactCodexUtilityArgv(`${PWSH} "${CREATE.replaceAll('"', '\\"')}"`)).toEqual(argv);
  expect(exactCodexUtilityArgv(`${PWSH_NO_PROFILE} '${CREATE}'`)).toEqual(argv);
  expect(exactCodexUtilityArgv(`/bin/bash -c '${CREATE}'`)).toEqual(argv);
  for (const command of [
    `${CREATE}; true`, `${CREATE} &`, `(${CREATE})`, `FOO=1 ${CREATE}`, `${CREATE} 2>&1`,
    "bun .codex/tools/aidlc.ts engine intent create ~", "bun .codex/tools/aidlc.ts engine intent create *",
    'bun .codex/tools/aidlc.ts engine intent create --arguments "$HOME"', "bun .codex/tools/aidlc.ts 'unterminated",
    `/bin/zsh -lc '${CREATE}' extra`, "node .codex/tools/aidlc.ts engine intent create",
    `${PWSH} '${CREATE}' extra`, `${PWSH} '${CREATE} && true'`,
    String.raw`"C:\\tools\\other.exe" -Command '${CREATE}'`, `pwsh.exe -Command '${CREATE}'`,
    `${PWSH_NO_PROFILE} '${CREATE}; New-Item aidlc'`,
    String.raw`"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -ExecutionPolicy Bypass -Command '${CREATE}'`,
    `/bin/bash -xc '${CREATE}'`, `/bin/bash -c '${CREATE} && true'`,
  ]) expect(exactCodexUtilityArgv(command), command).toBeNull();
  const f = fixture();
  expect(verify(f, withCommand(`/bin/bash -lc "${CREATE.replaceAll('"', '\\"')}"`))).toEqual({ dir: f.dir, state: STATE });
  const w = fixture();
  expect(verify(w, withCommand(`${PWSH} '${CREATE}'`))).toEqual({ dir: w.dir, state: STATE });
  const n = fixture();
  expect(verify(n, withCommand(`${PWSH_NO_PROFILE} '${CREATE}'`))).toEqual({ dir: n.dir, state: STATE });
});

test("a progress-tolerant beat still requires the new intent to be Running", () => {
  for (const status of ["Completed", "Archived", ""]) {
    const f = fixture();
    editState(f, "- **Status**: Running", status ? `- **Status**: ${status}` : "");
    expect(() => verify(f, CAPTURED_STDOUT, false), status || "missing").toThrow();
  }
  expect(verify(fixture(), CAPTURED_STDOUT, false).state).toBe(STATE);
});
