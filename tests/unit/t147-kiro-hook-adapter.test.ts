// t147-kiro-hook-adapter: the Kiro stdin shim normalizes live-captured
// payloads into the core hooks' contract.
//
// covers: file:hooks/aidlc-continue-workflow.ts, file:hooks/aidlc-session-start.ts, file:hooks/aidlc-sync-workflow-state.ts, file:hooks/aidlc-log-subagent.ts, hook:aidlc-plan-approval-guard, function:splitKiroCommandArgs, function:sanitizeHarnessPlainText, function:decodeHarnessPlainText
//
// WHAT. Each case pipes a fixture from tests/fixtures/kiro-hook-payloads/
// (field-verbatim captures off kiro-cli 2.6.1 — findings.md §0.2) into
// `bun dist/kiro/.kiro/hooks/aidlc-kiro-adapter.ts <target>` inside a
// scratch project that has an active workflow state, then asserts the
// observable core-hook effect:
//   stop          → {"decision":"block"} when the engine says work remains;
//                   silent exit 0 when no workflow state exists.
//   session-start → plain-text context (NOT the {"additionalContext"} JSON
//                   wrapper — the shim unwraps it for Kiro's stdout channel).
//   sync-workflow-state    → todo_list create with "[slug]" suffix dispatches
//                   set-status (state file's Current Stage updates).
//   audit/sensors + rebuild-stage-graph + log-subagent → fail-open exit 0 on
//   both fixture input and malformed stdin (advisory contract G5).
//
// WHY SUBPROCESS. The adapter IS a subprocess shim — in-process unit testing
// would bypass the exact stdin/stdout/exit-code surface being contracted.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createIntent,
  markSubagentInflight,
  readIntentRegistry,
  sanitizeHarnessPlainText,
  splitKiroCommandArgs,
  subagentInflightMarkerPath,
  writeActiveDirectiveMarker,
  writeSessionIntentHandoff,
  writeSessionIntentUuid,
  stateDigest,
} from "../../core/tools/aidlc-lib.ts";
import {
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  intentsDirOf,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { envWithoutCommandOnPath } from "../harness/test-command-paths.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const KIRO_TREE = join(REPO_ROOT, "dist", "kiro", ".kiro");
const FIXTURES = JSON.parse(
  readFileSync(join(REPO_ROOT, "tests", "fixtures", "kiro-hook-payloads", "payloads.json"), "utf-8"),
) as Record<string, unknown>;
const ADAPTER_TOOL_NAMES = FIXTURES._adapter_tool_names as {
  writes: string[];
  deletes: string[];
  reads: string[];
};

// P9 per-intent layout: the core hooks the Kiro adapter shims to resolve state
// via stateFilePath() and the audit trail via auditFilePath() — under the active
// intent's record, not the flat aidlc-docs/ root. So the scratch project seeds
// the per-intent workspace shell + the state fixture into the default record (so
// the active-intent cursor resolves) + the resolved audit SHARD (pinned clone-id
// so audit reads are deterministic).
const PINNED_CLONE_ID = "testcloneid147";
function pinnedShardName(): string {
  const host =
    hostname()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "host";
  return `${host}-${PINNED_CLONE_ID}.md`;
}

/** Seed the per-intent workspace shell (active-space + intents/<record> + cursors
 *  + registry) into an arbitrary dir. Mirrors fixtures.ts seedWorkspaceShell. */
function seedShell(dir: string): void {
  const intentsDir = intentsDirOf(dir, DEFAULT_SPACE);
  mkdirSync(join(dir, "aidlc", "spaces", DEFAULT_SPACE, "memory"), { recursive: true });
  mkdirSync(seededRecordDir(dir), { recursive: true });
  writeFileSync(join(dir, "aidlc", "active-space"), `${DEFAULT_SPACE}\n`, "utf-8");
  writeFileSync(join(intentsDir, "active-intent"), `${DEFAULT_RECORD_DIR}\n`, "utf-8");
  writeFileSync(
    join(intentsDir, "intents.json"),
    `${JSON.stringify(
      [{ uuid: "00000000-0000-7000-8000-000000000001", slug: DEFAULT_RECORD_DIR.replace(/-[0-9a-f]+$/, ""), status: "in-flight" }],
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

// Scratch project: a .kiro tree (copied) + the per-intent workspace shell with an
// active workflow state so the core hooks' self-gates open. Built per test.
function scratchProject(withState: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "t147-"));
  cpSync(KIRO_TREE, join(dir, ".kiro"), { recursive: true });
  // Exercise the authored shim even when the packaged dependency tree is older.
  cpSync(
    join(REPO_ROOT, "harness", "kiro", "hooks", "aidlc-kiro-adapter.ts"),
    join(dir, ".kiro", "hooks", "aidlc-kiro-adapter.ts"),
  );
  seedShell(dir);
  seedActiveSpaceMemory(dir);
  if (withState) {
    // State fixture into the default record so the active-intent cursor resolves.
    writeFileSync(
      seededStateFile(dir),
      readFileSync(join(REPO_ROOT, "tests", "fixtures", "state-brownfield-feature.md"), "utf-8"),
    );
    // The resolved audit shard (pinned clone-id) keeps log-subagent writes
    // deterministic and seeds the "# AI-DLC Audit Log" header.
    writeFileSync(join(dir, "aidlc", ".aidlc-clone-id"), `${PINNED_CLONE_ID}\n`, "utf-8");
    const auditDir = seededAuditDir(dir);
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(join(auditDir, pinnedShardName()), "# AI-DLC Audit Log\n");
  }
  return dir;
}

/** Concatenate every audit shard (clone-id-name-agnostic read). */
function readAudit(dir: string): string {
  const auditDir = seededAuditDir(dir);
  let names: string[];
  try {
    names = require("node:fs").readdirSync(auditDir) as string[];
  } catch {
    return "";
  }
  return names
    .filter((n: string) => n.endsWith(".md"))
    .sort()
    .map((n: string) => readFileSync(join(auditDir, n), "utf-8"))
    .join("\n");
}

/** The adapter's own drop log, one line per recorded degradation. */
function dropLines(dir: string): string[] {
  const path = join(seededRecordDir(dir), ".aidlc-engine/hooks-health", "kiro-adapter.drops");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").split("\n").filter((l) => l.trim().length > 0);
}

// The core hooks resolve their own health directory from the docs root, which
// moves with the space and the intent - and before an intent exists it is not
// under a record at all. So find the file rather than deriving its path.
function freezeDropFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.name === ".kiro" || entry.name === "node_modules") continue;
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "review-freeze.drops") found.push(full);
    }
  };
  walk(dir);
  return found;
}

function appendInteractionEvent(
  dir: string,
  event: "DECISION_RECORDED" | "QUESTION_ANSWERED" | "STAGE_STARTED",
  stage: string,
): void {
  appendFileSync(
    join(seededAuditDir(dir), pinnedShardName()),
    `\n## ${event}\n` +
      `**Timestamp**: ${new Date().toISOString()}\n` +
      `**Event**: ${event}\n` +
      `**Stage**: ${stage}\n\n---\n`,
    "utf-8",
  );
}

function runAdapter(
  projectDir: string,
  target: string,
  payload: unknown,
  extraArgs: string[] = [],
  envOverrides: NodeJS.ProcessEnv = {},
  // Defaults to the project, which is where a manifest-invoked hook runs. Spelled
  // out only by the case that has to prove a guard reads the RESOLVED project
  // rather than whatever directory the host happened to launch it from.
  cwd: string = projectDir,
): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(
    "bun",
    [
      join(projectDir, ".kiro", "hooks", "aidlc-kiro-adapter.ts"),
      target,
      ...extraArgs,
    ],
    {
      cwd,
      input: typeof payload === "string" ? payload : JSON.stringify(payload),
      encoding: "utf-8",
      env: {
        ...process.env,
        AIDLC_UNATTENDED: undefined,
        CLAUDE_PROJECT_DIR: projectDir,
        ...envOverrides,
      } as NodeJS.ProcessEnv,
      timeout: 30_000,
    },
  );
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    code: r.status ?? -1,
  };
}

// The dispatch-ADMISSION edge, which on this row is reached through the
// `log-subagent` PreToolUse registration and nothing else. There is deliberately no
// `aidlc-deliver-stage-rules.json`: always-included steering plus the delegate's own
// `resources` preload is the delivery channel, and `t245` pins that absence. So the
// admission half - refusing a dispatch whose delegate would start with no rules
// preloaded - rides the one manifest whose matcher is exactly the dispatch tools.
//
// These tests used to call a bare `deliver-stage-rules` target. That proved the
// handler worked and said NOTHING about whether production ever reached it, which
// is how a target with no registration at all stayed green here for a full review
// cycle. Go through the registered target instead.
/** Invoke the admission edge the way a manifest does: registered target, registered
 *  trigger. The event is pinned because the adapter admits only on PreToolUse - a
 *  payload omitting it would silently skip every check these tests assert. The
 *  spelling matches the live-captured fixture; the adapter canonicalizes both. */
function runDispatchAdmission(
  projectDir: string,
  payload: Record<string, unknown>,
  extraArgs: string[] = [],
  envOverrides: NodeJS.ProcessEnv = {},
): { stdout: string; stderr: string; code: number } {
  return runAdapter(
    projectDir,
    "log-subagent",
    { hook_event_name: "preToolUse", ...payload },
    extraArgs,
    envOverrides,
  );
}

// The delegation window is how a guard learns WHO is acting now that the
// per-agent registration (and its persona argv) is gone. Opening it is the same
// event Kiro sends when the conductor delegates: the dispatch tool's PreToolUse.
// Both calls must resolve the same session identity, which they do - neither
// payload carries session_id, so both fall back to the remembered one.
/** The delegation ledger the adapter wrote for this project. Its directory is keyed
 *  by a hash of the session id, so it is found rather than constructed. */
function findDelegationLedger(projectDir: string): string {
  const root = join(projectDir, "aidlc", ".aidlc-sessions", "kiro-delegation");
  const buckets = readdirSync(root);
  expect(buckets.length, `exactly one delegation bucket under ${root}`).toBe(1);
  return join(root, buckets[0], "windows.ndjson");
}

/** The active-space memory tree every real project has, copied from the shipped one.
 *  `scratchProject` seeds it because the dispatch admission edge now reaches production:
 *  it refuses a delegation whose worker preload resolves to no rule file, and it forwards
 *  the core rule loader's refusal when a REQUIRED stage rule is missing. Both are
 *  upstream's designed contract, which these tests are not exempt from. So the DEFAULT
 *  fixture is admissible, as a real project is, and a test that wants a refusal creates
 *  the defect itself. Seeds only when absent, so a case that supplies its own tree or
 *  deliberately empties one is left alone. */
function seedActiveSpaceMemory(projectDir: string): void {
  const memory = join(projectDir, "aidlc", "spaces", "default", "memory");
  if (existsSync(join(memory, "org.md"))) return;
  mkdirSync(dirname(memory), { recursive: true });
  cpSync(
    join(REPO_ROOT, "dist", "kiro", "aidlc", "spaces", "default", "memory"),
    memory,
    { recursive: true },
  );
}

function openDelegationWindow(projectDir: string, agent: string): void {
  const r = runAdapter(projectDir, "log-subagent", {
    hook_event_name: "PreToolUse",
    cwd: projectDir,
    tool_name: `subagent_${agent}`,
    tool_input: { prompt: `delegate to ${agent}` },
  });
  expect(r.code, `open window for ${agent}: ${r.stdout}${r.stderr}`).toBe(0);
}

function closeDelegationWindow(projectDir: string, agent: string): void {
  runAdapter(projectDir, "log-subagent", {
    hook_event_name: "PostToolUse",
    cwd: projectDir,
    tool_name: `subagent_${agent}`,
    tool_input: { prompt: `delegate to ${agent}` },
    tool_response: `**Agent:** ${agent}\ndone`,
  });
}

// A CREW dispatch: one event naming several personas in `stages[].role`. It opens
// one window per persona, and one close must release all of them.
function openCrewWindow(projectDir: string, agents: string[]): void {
  const r = runAdapter(projectDir, "log-subagent", crewPayload(projectDir, agents, "PreToolUse"));
  expect(r.code, `open crew window ${agents.join("+")}`).toBe(0);
}

function closeCrewWindow(projectDir: string, agents: string[]): void {
  runAdapter(projectDir, "log-subagent", {
    ...crewPayload(projectDir, agents, "PostToolUse"),
    tool_response: "crew done",
  });
}

function crewPayload(
  projectDir: string,
  agents: string[],
  event: "PreToolUse" | "PostToolUse",
): Record<string, unknown> {
  return {
    hook_event_name: event,
    cwd: projectDir,
    tool_name: "subagent",
    tool_input: {
      task: "crew",
      stages: agents.map((agent, index) => ({
        name: `stage_${index}`,
        role: agent,
        prompt_template: "{task}",
      })),
    },
  };
}

function runEngine(projectDir: string, args: string[]) {
  const result = spawnSync(process.execPath, [
    join(projectDir, ".kiro", "tools", "aidlc-orchestrate.ts"), ...args,
  ], {
    cwd: projectDir, encoding: "utf-8", timeout: 30_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });
  expect(result.status, result.stderr).toBe(0);
  return { stdout: result.stdout, directive: JSON.parse(result.stdout) };
}

/** A deterministic engine fixture behind the real adapter subprocess boundary. */
function stubNext(projectDir: string, response: string): string {
  const calls = join(projectDir, "next-calls.ndjson");
  writeFileSync(join(projectDir, "next-response.txt"), response);
  writeFileSync(join(projectDir, ".kiro", "tools", "aidlc-orchestrate.ts"), `
import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write(readFileSync(${JSON.stringify(join(projectDir, "next-response.txt"))}, "utf8"));
`);
  return calls;
}

function runDispatchCore(
  projectDir: string,
  payload: unknown,
): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(
    "bun",
    [join(projectDir, ".kiro", "hooks", "aidlc-deliver-stage-rules.ts")],
    {
      cwd: projectDir,
      input: JSON.stringify(payload),
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
      timeout: 30_000,
    },
  );
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    code: r.status ?? -1,
  };
}

function seedUnapprovedCodeGeneration(dir: string, unit: string): void {
  const state = readFileSync(seededStateFile(dir), "utf-8").replace(
    /(- \*\*Current Stage\*\*:\s*)[^\n]+/,
    `$1code-generation`,
  );
  writeFileSync(seededStateFile(dir), state, "utf-8");
  writeActiveDirectiveMarker(dir, {
    kind: "run-stage",
    stage: "code-generation",
    unit,
    state_sha256: stateDigest(state),
  });
  mkdirSync(join(seededRecordDir(dir), "construction", unit, "code-generation"), {
    recursive: true,
  });
}

describe("t147 Kiro hook adapter (live-captured payload fixtures)", () => {
  test("unattended prompt submit does not mint HUMAN_TURN", () => {
    const dir = scratchProject(true);
    try {
      const payload = {
        ...(FIXTURES.userPromptSubmit as Record<string, unknown>),
        cwd: dir,
      };
      // The mint belongs to record-human-turn, which this row registers in its own
      // manifest. verb-intercept used to mint as well - that was the pre-merge CLI
      // row, where hook wiring lived inside the agent config and there was no
      // second registration to double-count with. Asserting BOTH halves here is
      // the point: the mint happens once, and it happens on the other seam.
      expect(runAdapter(dir, "verb-intercept", payload).code).toBe(0);
      expect(readAudit(dir), "verb-intercept must not mint").not.toContain("HUMAN_TURN");

      expect(
        runAdapter(dir, "record-human-turn", payload, [], {
          AIDLC_UNATTENDED: "1",
        }).code,
      ).toBe(0);
      expect(readAudit(dir), "unattended withholds the ledger event")
        .not.toContain("HUMAN_TURN");
      expect(runAdapter(dir, "record-human-turn", payload).code).toBe(0);
      expect(readAudit(dir)).toContain("HUMAN_TURN");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("1: stop blocks with a reason while the workflow has pending work", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "continue-workflow", FIXTURES.stop);
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout) as { decision?: string; reason?: string };
      expect(out.decision).toBe("block");
      expect(out.reason ?? "").not.toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("1a: stop forwards session identity and allows an exact post-create handoff", () => {
    const dir = scratchProject(true);
    try {
      const original = readIntentRegistry(dir)[0];
      const created = createIntent(dir, "new-work", "default", "bugfix");
      const sessionId = "kiro-handoff-session";
      writeSessionIntentUuid(dir, sessionId, created.uuid);
      writeSessionIntentHandoff(dir, sessionId, original.uuid, created.uuid);

      const r = runAdapter(dir, "continue-workflow", {
        ...FIXTURES.stop as Record<string, unknown>,
        session_id: sessionId,
      });
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("1b: plan-approval guard blocks an unapproved developer stage", () => {
    const dir = scratchProject(true);
    try {
      seedUnapprovedCodeGeneration(dir, "todo-core");
      const r = runAdapter(dir, "plan-approval-guard", {
        hook_event_name: "preToolUse",
        cwd: dir,
        tool_name: "subagent",
        tool_input: {
          task: "AIDLC-UNIT: todo-core\nImplement todo-core",
          stages: [
            {
              name: "review_todo_core",
              role: "aidlc-quality-agent",
              prompt_template: "AIDLC-UNIT: unrelated-unit\nReview another unit",
            },
            {
              name: "implement_todo_core",
              role: "aidlc-developer-agent",
              prompt_template: "AIDLC-UNIT: todo-core\nImplement todo-core",
            },
          ],
        },
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("Code generation cannot start");
      expect(r.stderr).toContain("unit todo-core");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("1bb: plan-approval guard blocks native Kiro write and shell mutation payloads", () => {
    const dir = scratchProject(true);
    try {
      seedUnapprovedCodeGeneration(dir, "todo-core");
      for (const payload of [
        {
          hook_event_name: "preToolUse",
          cwd: dir,
          tool_name: "fs_write",
          tool_input: { path: join(dir, "src", "blocked.ts") },
        },
        {
          hook_event_name: "preToolUse",
          cwd: dir,
          tool_name: "execute_bash",
          tool_input: { command: "sort input.txt -o src/blocked.txt" },
        },
      ]) {
        const r = runAdapter(dir, "plan-approval-guard", payload);
        expect(r.code).toBe(2);
        expect(r.stderr).toContain("Code generation cannot");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("1bc: execute_pwsh normalises to Bash in the plan-approval-guard path like execute_bash", () => {
    const dir = scratchProject(true);
    try {
      seedUnapprovedCodeGeneration(dir, "todo-core");
      const verdict = (toolName: string) =>
        runAdapter(dir, "plan-approval-guard", {
          hook_event_name: "preToolUse",
          cwd: dir,
          tool_name: toolName,
          tool_input: { command: "sort input.txt -o src/blocked.txt" },
        });
      const bash = verdict("execute_bash");
      expect(bash.code).toBe(2);
      expect(bash.stderr).toContain("Code generation cannot");
      // On a Windows host the same shell tool is named execute_pwsh: guarded, not
      // failed open, with the identical verdict and reason.
      const pwsh = verdict("execute_pwsh");
      expect(pwsh.code).toBe(2);
      expect(pwsh.stderr).toBe(bash.stderr);
      expect(pwsh.stdout).toBe(bash.stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("1c: plan-approval guard normalizes defensive direct dispatch shapes", () => {
    const dir = scratchProject(true);
    try {
      seedUnapprovedCodeGeneration(dir, "todo-core");
      for (const [index, payload] of [
        FIXTURES.preToolUse_invoke_sub_agent,
        {
          hook_event_name: "preToolUse",
          tool_name: "subagent",
          tool_input: {
            name: "aidlc-developer-agent",
            prompt: "AIDLC-UNIT: todo-core\nImplement todo-core",
          },
        },
        {
          hook_event_name: "preToolUse",
          tool_name: "subagent",
          tool_input: {
            name: "aidlc-developer-agent",
            prompt: "AIDLC-UNIT: todo-core\nImplement todo-core",
            stages: [],
          },
        },
        {
          hook_event_name: "preToolUse",
          tool_name: "subagent",
          tool_input: {
            name: "aidlc-developer-agent",
            prompt: "AIDLC-UNIT: todo-core\nImplement todo-core",
            stages: [{}],
          },
        },
        {
          hook_event_name: "preToolUse",
          tool_name: "subagent_aidlc-developer-agent",
          tool_input: {
            prompt: "AIDLC-UNIT: todo-core\nImplement todo-core",
          },
        },
        {
          hook_event_name: "preToolUse",
          tool_name: "invoke_sub_agent",
          tool_input: {
            name: "",
            subagent_type: "aidlc-developer-agent",
            prompt: "",
            task: "AIDLC-UNIT: todo-core\nImplement todo-core",
          },
        },
        {
          hook_event_name: "preToolUse",
          tool_name: "invoke_sub_agent",
          tool_input: {
            name: "   ",
            subagent_type: " aidlc-developer-agent ",
            prompt: "   ",
            task: "AIDLC-UNIT: todo-core\nImplement todo-core",
          },
        },
      ].entries()) {
        const r = runAdapter(dir, "plan-approval-guard", {
          ...payload as Record<string, unknown>,
          cwd: dir,
        });
        expect(r.code, `payload-${index}`).toBe(2);
        expect(r.stderr, `payload-${index}`).toContain("Code generation cannot start");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("1d: malformed crew stages fail open without bypassing a valid developer stage", () => {
    const dir = scratchProject(true);
    try {
      seedUnapprovedCodeGeneration(dir, "todo-core");
      const r = runAdapter(dir, "plan-approval-guard", {
        hook_event_name: "preToolUse",
        cwd: dir,
        tool_name: "subagent",
        tool_input: {
          task: "Implement todo-core",
          stages: [null, {
            role: "aidlc-developer-agent",
            prompt_template: "AIDLC-UNIT: todo-core\nImplement todo-core",
          }],
        },
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("Code generation cannot start");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("1e: mixed alias payloads preserve a direct developer identity for plan approval", () => {
    const dir = scratchProject(true);
    try {
      seedUnapprovedCodeGeneration(dir, "todo-core");
      const r = runAdapter(dir, "plan-approval-guard", {
        hook_event_name: "preToolUse",
        cwd: dir,
        tool_name: "subagent",
        tool_input: {
          name: "aidlc-developer-agent",
          prompt: "AIDLC-UNIT: todo-core\nImplement todo-core",
          task: "",
          stages: [{
            role: "aidlc-quality-agent",
            prompt_template: "Review todo-core",
          }],
        },
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("Code generation cannot start");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("1f: response shells stay inert for pre-dispatch hooks", () => {
    const dir = scratchProject(true);
    try {
      seedUnapprovedCodeGeneration(dir, "todo-core");
      const payload = {
        hook_event_name: "preToolUse",
        cwd: dir,
        tool_name: "subagent_response",
        tool_input: { subagent_type: "aidlc-developer-agent" },
      };
      for (const target of ["log-subagent", "plan-approval-guard"]) {
        const r = runAdapter(dir, target, payload);
        expect(r.code, target).toBe(0);
        expect(r.stdout, target).toBe("");
        expect(r.stderr, target).toBe("");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("2: stop is silent (no block) when no workflow state exists", () => {
    const dir = scratchProject(false);
    try {
      const r = runAdapter(dir, "continue-workflow", FIXTURES.stop);
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("2a: stop stays silent for an open logged question and blocks after its answer", () => {
    const dir = scratchProject(true);
    try {
      appendInteractionEvent(dir, "STAGE_STARTED", "requirements-analysis");
      appendInteractionEvent(dir, "DECISION_RECORDED", "requirements-analysis");

      const waiting = runAdapter(dir, "continue-workflow", FIXTURES.stop);
      expect(waiting.code).toBe(0);
      expect(waiting.stdout.trim()).toBe("");

      appendInteractionEvent(dir, "QUESTION_ANSWERED", "requirements-analysis");
      const resolved = runAdapter(dir, "continue-workflow", FIXTURES.stop);
      expect(resolved.code).toBe(0);
      expect(
        (JSON.parse(resolved.stdout) as { decision?: string }).decision,
      ).toBe("block");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("3: session-start emits plain-text context, not the JSON wrapper", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "session-start", FIXTURES.agentSpawn);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("AIDLC WORKFLOW ACTIVE");
      expect(r.stdout).not.toContain("additionalContext");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("3a: terminal utility output stays UTF-8 and drops only terminal controls", () => {
    const dir = scratchProject(true);
    try {
      writeFileSync(
        join(dir, ".kiro", "tools", "aidlc-utility.ts"),
        [
          'process.stdout.write("Unicode: ─ ✓ █▒ ⇄\\n");',
          'process.stdout.write("Path: C:\\\\work\\\\file.txt; literal: \\\\\\\\x1b[31m\\n");',
          'process.stdout.write("\\u001b[31mred\\u001b[0m\\n");',
          'process.stdout.write("\\u001b]633;P;Cwd=C:\\\\shell\\\\noise\\u0007");',
          'process.stdout.write("after-osc\\u0008\\n");',
          'process.stderr.write("stderr: → preserved\\n");',
          "process.exit(7);",
        ].join("\n"),
        "utf-8",
      );

      const r = runAdapter(dir, "verb-intercept", {
        cwd: dir,
        prompt: "/aidlc --status",
      });
      expect(r.code).toBe(0);
      expect(r.stderr).toBe("");
      expect(r.stdout).toContain("Unicode: ─ ✓ █▒ ⇄");
      expect(r.stdout).toContain("Path: C:\\work\\file.txt");
      expect(r.stdout).toContain("literal: \\\\x1b[31m");
      expect(r.stdout).toContain("red");
      expect(r.stdout).toContain("after-osc");
      expect(r.stdout).toContain("stderr: → preserved");
      expect(r.stdout).not.toContain("\u001b");
      expect(r.stdout).not.toContain("\u0008");
      expect(r.stdout).not.toContain("Cwd=C:\\shell\\noise");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("3b: plain-text sanitizer drops unterminated 7-bit and 8-bit controls", () => {
    for (const introducer of ["\u001b[", "\u009b"]) {
      expect(sanitizeHarnessPlainText(`before${introducer}31`)).toBe("before");
    }
    for (const introducer of [
      "\u001bP",
      "\u001bX",
      "\u001b]",
      "\u001b^",
      "\u001b_",
      "\u0090",
      "\u0098",
      "\u009d",
      "\u009e",
      "\u009f",
    ]) {
      expect(
        sanitizeHarnessPlainText(`before${introducer}terminal-payload`),
      ).toBe("before");
    }
  });

  test("3c: terminal dispatch preserves unquoted, quoted, and UNC Windows paths", () => {
    const dir = scratchProject(true);
    try {
      const argvPath = join(dir, "terminal-argv.json");
      writeFileSync(
        join(dir, ".kiro", "tools", "aidlc-utility.ts"),
        [
          'import { writeFileSync } from "node:fs";',
          `writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));`,
          'process.stdout.write("ok\\n");',
        ].join("\n"),
        "utf-8",
      );
      for (const [prompt, expected] of [
        [
          String.raw`/aidlc --doctor --export --output C:\temp\diag`,
          String.raw`C:\temp\diag`,
        ],
        [
          String.raw`/aidlc --doctor --export --output "C:\Program Files\diag"`,
          String.raw`C:\Program Files\diag`,
        ],
        [
          String.raw`/aidlc --doctor --export --output \\server\share\diag`,
          String.raw`\\server\share\diag`,
        ],
      ] as const) {
        const r = runAdapter(dir, "verb-intercept", { cwd: dir, prompt });
        expect(r.code, prompt).toBe(0);
        expect(
          JSON.parse(readFileSync(argvPath, "utf-8")),
          prompt,
        ).toEqual(["doctor", "--export", "--output", expected]);
      }

      const trailing = runAdapter(dir, "verb-intercept", {
        cwd: dir,
        prompt:
          String.raw`/aidlc --doctor --output C:\temp\ --export`,
      });
      expect(trailing.code).toBe(0);
      expect(JSON.parse(readFileSync(argvPath, "utf-8"))).toEqual([
        "doctor",
        "--output",
        "C:\\temp\\",
        "--export",
      ]);

      for (const [prompt, expected] of [
        [
          '/aidlc --doctor --output "C:\\" --export',
          "C:\\",
        ],
        [
          '/aidlc --doctor --output "C:\\Program Files\\diag\\" --export',
          "C:\\Program Files\\diag\\",
        ],
        [
          String.raw`/aidlc --doctor --output .\diag\ --export`,
          ".\\diag\\",
        ],
        [
          '/aidlc --doctor --output "out\\" --export',
          "out\\",
        ],
        [
          String.raw`/aidlc --doctor --output out\ --export`,
          "out\\",
        ],
      ] as const) {
        const r = runAdapter(dir, "verb-intercept", { cwd: dir, prompt });
        expect(r.code, prompt).toBe(0);
        expect(
          JSON.parse(readFileSync(argvPath, "utf-8")),
          prompt,
        ).toEqual(["doctor", "--output", expected, "--export"]);
      }

      expect(
        splitKiroCommandArgs(String.raw`one\ argument "a\"b"`),
      ).toEqual(["one argument", 'a"b']);
      expect(
        splitKiroCommandArgs(
          String.raw`answer\ the\ question\;\ continue\ without\ waiting`,
        ),
      ).toEqual(["answer the question; continue without waiting"]);

      for (const [prompt, expected] of [
        [
          String.raw`/aidlc --doctor --export --output reports\ 2026`,
          "reports 2026",
        ],
        [
          String.raw`/aidlc --doctor --export --output /tmp/report\ dir`,
          "/tmp/report dir",
        ],
      ] as const) {
        const r = runAdapter(dir, "verb-intercept", { cwd: dir, prompt });
        expect(r.code, prompt).toBe(0);
        expect(
          JSON.parse(readFileSync(argvPath, "utf-8")),
          prompt,
        ).toEqual(["doctor", "--export", "--output", expected]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("3d: only complete non-steering packets within the 10 KiB UTF-8 hook budget are pre-dispatched", () => {
    const dir = scratchProject(false);
    try {
      const args = ["--depth", "Standard"];
      const prompt = "/aidlc --depth Standard";
      const empty = JSON.stringify({ kind: "print", message: "" });
      const calls = stubNext(dir, empty);
      const first = runAdapter(dir, "verb-intercept", { cwd: dir, prompt });
      expect(first.code).toBe(0);
      expect(first.stdout).toContain("SYSTEM (deterministic engine pre-dispatch)");
      const framing = Buffer.byteLength(first.stdout) - Buffer.byteLength(empty);
      expect(framing).toBeGreaterThan(0);
      for (const packetBytes of [10 * 1024 - 1, 10 * 1024, 10 * 1024 + 1]) {
        const remaining = packetBytes - framing - Buffer.byteLength(empty);
        // UTF-8 exceeds JS string length, so a character-count bound fails here.
        const message = "界".repeat(Math.floor(remaining / 3)) + "x".repeat(remaining % 3);
        const response = JSON.stringify({ kind: "print", message });
        expect(Buffer.byteLength(response) + framing).toBe(packetBytes);
        expect(response.length + framing).toBeLessThan(10 * 1024);
        writeFileSync(join(dir, "next-response.txt"), response);
        const result = runAdapter(dir, "verb-intercept", { cwd: dir, prompt });
        expect(result.code).toBe(0);
        const latch = join(dir, "aidlc", ".aidlc-forwarding-latch");
        if (packetBytes <= 10 * 1024) {
          expect(Buffer.byteLength(result.stdout)).toBe(packetBytes);
          // The fence carries a per-invocation nonce, so match it rather than a
          // fixed marker - and use a backreference, which also proves the two ends
          // carry the SAME nonce. That is the property the injection fix rests on:
          // a body that reproduces one marker still cannot close the block.
          const fenced = result.stdout.match(
            /--- DIRECTIVE ([0-9a-f]{12}) ---\n([\s\S]*?)\n--- END DIRECTIVE \1 ---/,
          );
          expect(fenced, "the directive is fenced with a matching nonce").not.toBeNull();
          expect(fenced?.[2]).toBe(response);
          expect(existsSync(latch)).toBe(false);
        } else {
          expect(result.stdout).toContain("deterministic argument forwarding");
          expect(result.stdout).not.toContain("ALREADY");
          expect(result.stdout).not.toContain(message);
          expect(JSON.parse(readFileSync(latch, "utf8")).args).toEqual(args);
        }
      }
      expect(readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line)))
        .toEqual(Array.from({ length: 4 }, () => ["next", ...args]));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("3e: steering of any size and incomplete JSON use exact-argv forwarding under every native shell alias", () => {
    const dir = scratchProject(false);
    try {
      const raw = '--stage "reverse-engineering" --depth Standard';
      const args = ["--stage", "reverse-engineering", "--depth", "Standard"];
      const token = Buffer.from('{"opaque":"keep-this-token-verbatim"}').toString("base64url");
      const calls = stubNext(dir, "");
      for (const [tool_name, text] of [
        ["execute_bash", "small complete rule\n"],
        ["execute_pwsh", "large complete rule 界\n".repeat(1000)],
        ["shell", "another complete rule\n"],
      ]) {
        const response = JSON.stringify({
          kind: "load-steering", stage: "reverse-engineering", part: 1, parts: 1,
          rules_content: [{ path: "aidlc/spaces/default/memory/org.md", text }],
          continue_token: token,
        });
        writeFileSync(join(dir, "next-response.txt"), response);
        const hook = runAdapter(dir, "verb-intercept", {
          cwd: dir, prompt: `Step 1: run \`aidlc engine orchestrate next ${raw}\``,
        });
        expect(hook.code).toBe(0);
        expect(hook.stdout).toContain(`engine orchestrate next ${raw}`);
        expect(hook.stdout).not.toContain(token);
        expect(hook.stdout).not.toContain("rules_content");
        expect(hook.stdout).not.toContain("ALREADY");
        const guard = (suffix: string) => runAdapter(dir, "guard-tool-call", {
          cwd: dir, tool_name,
          tool_input: { command: `bun .kiro/tools/aidlc.ts engine orchestrate next${suffix}` },
        });
        expect(guard("").code).toBe(2);
        expect(guard(" --stage reverse-engineering").code).toBe(2);
        expect(guard(` ${raw}`).code).toBe(0);
        expect(existsSync(join(dir, "aidlc", ".aidlc-forwarding-latch"))).toBe(false);
        // Actual child stdout carries the entire packet, including the final
        // token; no hook prefix or simulated truncation participates in delivery.
        const tool = runEngine(dir, ["next", ...args]);
        expect(tool.stdout).toBe(response);
        expect(tool.directive.rules_content[0].text).toBe(text);
        expect(tool.directive.continue_token).toBe(token);
      }
      expect(readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line)))
        .toEqual(Array.from({ length: 6 }, () => ["next", ...args]));
      writeFileSync(join(dir, "next-response.txt"), '{"kind":"print","message":"incomplete');
      const incomplete = runAdapter(dir, "verb-intercept", { cwd: dir, prompt: `/aidlc ${raw}` });
      expect(incomplete.stdout).toContain("deterministic argument forwarding");
      expect(incomplete.stdout).not.toContain("--- DIRECTIVE ---");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("3f: small config pre-dispatch keeps its terminal latch and native roll-forward guards", () => {
    const dir = scratchProject(false);
    try {
      const response = JSON.stringify({ kind: "print", message: "Configure the requested values, then stop." });
      stubNext(dir, response);
      const result = runAdapter(dir, "verb-intercept", { cwd: dir, prompt: "/aidlc --config" });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(response);
      expect(result.stdout).toContain("deterministic engine pre-dispatch");
      expect(JSON.parse(readFileSync(join(dir, "aidlc", ".aidlc-readonly-latch"), "utf8")).source)
        .toBe("config-alias");
      for (const tool_name of ["execute_bash", "execute_pwsh", "shell"]) {
        const guard = runAdapter(dir, "guard-tool-call", {
          cwd: dir, tool_name, tool_input: { command: "bun .kiro/tools/aidlc.ts engine orchestrate next" },
        });
        expect(guard.code, tool_name).toBe(2);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("3g: single-stage tool delivery issues once and retains every real rule chunk and opaque continuation", () => {
    const dir = scratchProject(true);
    try {
      const memory = join(dir, "aidlc", "spaces", DEFAULT_SPACE, "memory");
      cpSync(join(REPO_ROOT, "core", "memory"), memory, { recursive: true });
      const rule = `# Native rule delivery\n${"Keep the full rule: café 日本語; never invent a token.\n".repeat(900)}`;
      writeFileSync(join(memory, "org.md"), rule);
      const stateBefore = readFileSync(seededStateFile(dir), "utf8");
      const started = () => (readAudit(dir).match(/\*\*Event\*\*: STAGE_STARTED/g) ?? []).length;
      const before = started();
      const raw = "--stage reverse-engineering --single";
      const hook = runAdapter(dir, "verb-intercept", { cwd: dir, prompt: `/aidlc ${raw}` });
      expect(hook.code).toBe(0);
      expect(hook.stdout).toContain(`engine orchestrate next ${raw}`);
      expect(hook.stdout).not.toContain("ALREADY");
      expect(started()).toBe(before); // No hook-side isolated attempt or issuance.
      expect(existsSync(join(seededRecordDir(dir), ".aidlc-active-directive.json"))).toBe(false);
      const accepted = runAdapter(dir, "guard-tool-call", {
        cwd: dir, tool_name: "execute_pwsh",
        tool_input: { command: `bun .kiro/tools/aidlc.ts engine orchestrate next ${raw}` },
      });
      expect(accepted.code).toBe(0);
      let packet = runEngine(dir, ["next", "--stage", "reverse-engineering", "--single"]);
      expect(packet.directive.kind).toBe("load-steering");
      expect(Buffer.byteLength(packet.stdout)).toBeGreaterThan(10 * 1024);
      expect(started()).toBe(before + 1);
      const texts = new Map<string, string>();
      const parts = packet.directive.parts;
      expect(parts).toBeGreaterThan(1);
      for (let part = 1; part <= parts; part++) {
        expect(packet.directive).toMatchObject({ kind: "load-steering", part, parts });
        expect(Buffer.byteLength(packet.stdout.trim())).toBeLessThanOrEqual(28 * 1024);
        for (const entry of packet.directive.rules_content as Array<{ path: string; text: string }>) {
          texts.set(entry.path, (texts.get(entry.path) ?? "") + entry.text);
        }
        const token = packet.directive.continue_token as string;
        expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
        // Pass the exact emitted token; the real engine verifies its envelope.
        packet = runEngine(dir, ["continue", token]);
        expect(started()).toBe(before + 1);
      }
      expect(packet.directive).toMatchObject({ kind: "run-stage", stage: "reverse-engineering", single: true });
      expect([...texts.keys()]).toEqual(packet.directive.rules_in_context);
      for (const [path, text] of texts) expect(text).toBe(readFileSync(join(dir, path), "utf8"));
      expect(texts.get(`aidlc/spaces/${DEFAULT_SPACE}/memory/org.md`)).toBe(rule);
      expect(readFileSync(seededStateFile(dir), "utf8")).toBe(stateBefore);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);

  test("3h: single-stage bypass also precedes compiled engine dispatch", () => {
    const dir = scratchProject(false);
    try {
      const called = join(dir, "compiled-next.json");
      const script = join(dir, "compiled-spy.ts");
      writeFileSync(script, `
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "engine" && args[1] === "orchestrate") {
  writeFileSync(${JSON.stringify(called)}, JSON.stringify(args));
  console.log(JSON.stringify({ kind: "print", message: "compiled next response" }));
}
`);
      const executable = join(dir, process.platform === "win32" ? "compiled-spy.cmd" : "compiled-spy");
      writeFileSync(executable, process.platform === "win32"
        ? `@"${process.execPath}" "${script}" %*\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
      if (process.platform !== "win32") chmodSync(executable, 0o755);
      const env = { AIDLC_COMPILED_EXECUTABLE: executable };
      const single = runAdapter(dir, "verb-intercept", {
        cwd: dir, prompt: "/aidlc --stage reverse-engineering --single",
      }, [], env);
      expect(single.code).toBe(0);
      expect(single.stdout).toContain("deterministic argument forwarding");
      expect(existsSync(called)).toBe(false);
      const ordinary = runAdapter(dir, "verb-intercept", {
        cwd: dir, prompt: "/aidlc --stage reverse-engineering",
      }, [], env);
      expect(ordinary.code).toBe(0);
      expect(ordinary.stdout).toContain("compiled next response");
      expect(JSON.parse(readFileSync(called, "utf8")))
        .toEqual(["engine", "orchestrate", "next", "--stage", "reverse-engineering"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("4: todo_list create with [slug] suffix syncs the state file", () => {
    const dir = scratchProject(true);
    try {
      const before = readFileSync(seededStateFile(dir), "utf-8");
      const r = runAdapter(dir, "sync-workflow-state", FIXTURES.postToolUse_todo_create);
      expect(r.code).toBe(0);
      const after = readFileSync(seededStateFile(dir), "utf-8");
      // The fixture's [intent-capture] slug dispatches set-status; assert the
      // Current Stage field reflects it (robust to the fixture state already
      // being on intent-capture: require the field present AND the heartbeat).
      expect(/\*\*Current Stage\*\*:\s*intent-capture/.test(after)).toBe(true);
      expect(before).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("5: todo_list complete (no [slug] create) is a clean no-op", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "sync-workflow-state", FIXTURES.postToolUse_todo_complete);
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("5a: state-transition guard preserves exit 2 and stderr", () => {
    const dir = scratchProject(false);
    try {
      const r = runAdapter(dir, "state-transition-guard", {
        cwd: dir,
        tool_name: "execute_bash",
        tool_input: {
          command:
            "bun .kiro/tools/aidlc-state.ts approve feasibility",
        },
      });
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain(
        "Stage status cannot be changed with aidlc-state.ts approve",
      );
      expect(r.stderr).toContain("aidlc-orchestrate.ts report");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("5b: subagent dispatch silently uses native preload for incomplete briefs and accepts exact rules", () => {
    const dir = scratchProject(true);
    try {
      cpSync(
        join(REPO_ROOT, "dist", "kiro", "aidlc"),
        join(dir, "aidlc"),
        { recursive: true },
      );
      const basePrompt =
        "Run .kiro/aidlc-common/stages/inception/user-stories.md.";
      const payload = (promptTemplate: string) => ({
        cwd: dir,
        tool_name: "subagent",
        tool_input: {
          mode: "blocking",
          task: "Draft the user stories contribution.",
          stages: [
            {
              name: "product",
              role: "aidlc-product-agent",
              prompt_template: promptTemplate,
            },
          ],
        },
      });

      // Native preload is the delivery channel, so an incomplete brief is
      // expected and silent. Its diagnostic is opt-in, not a retry warning.
      const incomplete = runDispatchAdmission(dir, payload(basePrompt));
      expect(incomplete.code, incomplete.stderr).toBe(0);
      expect(incomplete.stdout).toBe("");
      expect(incomplete.stderr).toBe("");
      const debugLog = join(seededRecordDir(dir), ".aidlc-engine/hooks-health", "hook-debug.log");
      const traced = runDispatchAdmission(
        dir,
        payload(basePrompt),
        [],
        { AIDLC_HOOK_DEBUG: "1" },
      );
      expect(traced.code, traced.stderr).toBe(0);
      expect(traced.stdout).toBe("");
      expect(traced.stderr).toBe("");
      expect(readFileSync(debugLog, "utf-8")).toContain(
        'target="log-subagent" transport="native-preload"',
      );

      const proposed = runDispatchCore(dir, payload(basePrompt));
      expect(proposed.code, proposed.stderr).toBe(0);
      const rewrite = JSON.parse(proposed.stdout) as {
        hookSpecificOutput?: {
          updatedInput?: {
            stages?: Array<{ prompt_template?: string }>;
          };
        };
      };
      const exactPrompt =
        rewrite.hookSpecificOutput?.updatedInput?.stages?.[0]?.prompt_template ??
        "";
      expect(exactPrompt).toContain("AIDLC_DISPATCH_RULES_BEGIN");
      const complete = runDispatchAdmission(dir, payload(exactPrompt));
      expect(complete.code, complete.stderr).toBe(0);
      expect(complete.stdout).toBe("");
      expect(complete.stderr).toBe("");

      const direct = runDispatchAdmission(dir, {
        ...FIXTURES.preToolUse_invoke_sub_agent as Record<string, unknown>,
        cwd: dir,
        tool_input: { name: "aidlc-product-agent", prompt: basePrompt },
      });
      expect(direct.code).toBe(0);
      expect(direct.stdout).toBe("");
      expect(direct.stderr).toBe("");

      const blankPrompt = runDispatchAdmission(dir, {
        ...FIXTURES.preToolUse_invoke_sub_agent as Record<string, unknown>,
        cwd: dir,
        tool_name: "subagent",
        tool_input: {
          name: "aidlc-product-agent",
          prompt: "",
          task: basePrompt,
          stages: [],
        },
      });
      expect(blankPrompt.code, blankPrompt.stderr).toBe(0);
      expect(blankPrompt.stdout).toBe("");
      expect(blankPrompt.stderr).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("5c: oversized valid rules use Kiro preload while unloadable rules still block", () => {
    const oversizedDir = scratchProject(true);
    try {
      cpSync(
        join(REPO_ROOT, "dist", "kiro", "aidlc"),
        join(oversizedDir, "aidlc"),
        { recursive: true },
      );
      writeFileSync(
        join(
          oversizedDir,
          "aidlc",
          "spaces",
          "default",
          "memory",
          "org.md",
        ),
        `# Organization\n\n${"x".repeat(600_000)}\n`,
        "utf-8",
      );
      const payload = {
        cwd: oversizedDir,
        tool_name: "subagent",
        tool_input: {
          stages: [{
            role: "aidlc-product-agent",
            prompt_template:
              "Run .kiro/aidlc-common/stages/inception/user-stories.md.",
          }, {
            role: "aidlc-quality-agent",
            prompt_template: "Review the user stories.",
          }],
        },
      };
      const oversized = runDispatchAdmission(oversizedDir, payload);
      expect(oversized.code, oversized.stderr).toBe(0);
      expect(oversized.stdout).toBe("");
      expect(oversized.stderr).toContain("exceeds the safe");
      expect(oversized.stderr).toContain("active-memory preload fallback");
      // The blocking preload check outranks the advisory fallback: once the
      // worker's own Markdown config is stale, the dispatch is refused and the
      // fallback notice is gone. (This row validates the roster Markdown, not a
      // JSON sibling -- see the native-preload block below.)
      const workerFile = writeWorkerConfig(
        oversizedDir,
        "aidlc-quality-agent",
        workerFrontmatter("aidlc-quality-agent", []),
      );
      const blocked = runDispatchAdmission(oversizedDir, payload);
      expect(blocked.code, blocked.stderr).toBe(2);
      expect(blocked.stdout).toBe("");
      expect(blocked.stderr).toContain(workerFile);
      expect(blocked.stderr).not.toContain("active-memory preload fallback");
    } finally {
      rmSync(oversizedDir, { recursive: true, force: true });
    }

    const missingDir = scratchProject(true);
    try {
      cpSync(
        join(REPO_ROOT, "dist", "kiro", "aidlc"),
        join(missingDir, "aidlc"),
        { recursive: true },
      );
      rmSync(
        join(
          missingDir,
          "aidlc",
          "spaces",
          "default",
          "memory",
          "org.md",
        ),
      );
      const missing = runDispatchAdmission(missingDir, {
        cwd: missingDir,
        tool_name: "subagent",
        tool_input: {
          stages: [{
            role: "aidlc-product-agent",
            prompt_template:
              "Run .kiro/aidlc-common/stages/inception/user-stories.md.",
          }],
        },
      });
      expect(missing.code).toBe(2);
      expect(missing.stderr).toContain("Cannot load required stage rule");
    } finally {
      rmSync(missingDir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Native preload validation. Upstream (#1250) added this as a flow-blocking
  // check and read `<agent>.json`, because that row shipped a JSON config beside
  // every persona Markdown. THIS row merged the two and ships the Markdown alone,
  // so the same contract -- the active-space memory preload, declared by the
  // worker and repointed on a space switch -- is carried in the roster file's
  // frontmatter. The fixtures below are upstream's, restated on that surface.
  // ---------------------------------------------------------------------------

  /** The frontmatter a roster worker carries. `resources: null` omits the key,
   *  which is the "absent resources" shape. */
  const workerFrontmatter = (agent: string, resources: string[] | null): string => {
    const lines = [`name: ${agent}`, `description: ${agent} persona`];
    if (resources !== null) {
      lines.push("resources:");
      for (const resource of resources) lines.push(`  - '${resource}'`);
    }
    return `---\n${lines.join("\n")}\n---\n\nYou are ${agent}.\n`;
  };

  /** Rewrite a roster worker's Markdown config -- the file this row validates --
   *  and return its path, which is what the failure text has to name. */
  const writeWorkerConfig = (dir: string, agent: string, contents: string): string => {
    const file = join(dir, ".kiro", "agents", `${agent}.md`);
    writeFileSync(file, contents);
    return file;
  };

  const MEMORY_GLOB = "file://aidlc/spaces/default/memory/**/*.md";

  test.each([
    ["empty resources", workerFrontmatter("aidlc-product-agent", [])],
    ["absent resources", workerFrontmatter("aidlc-product-agent", null)],
    [
      "stale-space glob",
      workerFrontmatter("aidlc-product-agent", ["file://aidlc/spaces/old-space/memory/**/*.md"]),
    ],
    // Upstream's "malformed JSON" case. Unparseable frontmatter is the Markdown
    // analogue: without the fence there is no frontmatter to read at all, and a
    // body that merely LOOKS like one must not be mistaken for a declaration.
    ["malformed frontmatter", `name: aidlc-product-agent\nresources:\n  - '${"file://aidlc/spaces/default/memory/**/*.md"}'\n`],
    // The scalar trap, which has no JSON counterpart: `resources: <value>` on one
    // line is not the shape this contract uses. A substring check would pass it;
    // the structural reader rejects it, because a scalar it cannot walk is a
    // declaration it cannot verify.
    ["scalar resources", `---\nname: aidlc-product-agent\nresources: ${"file://aidlc/spaces/default/memory/**/*.md"}\n---\n`],
    [
      "partial memory glob",
      workerFrontmatter("aidlc-product-agent", ["file://aidlc/spaces/default/memory/org*.md"]),
    ],
  ])("native preload blocks %s and names the worker repair", (_name, frontmatter) => {
    const dir = scratchProject(false);
    try {
      const memory = join(dir, "aidlc", "spaces", "default", "memory");
      writeFileSync(join(memory, "org.md"), "# Organization\n\nKeep the mandated review.\n");
      const oldMemory = join(dir, "aidlc", "spaces", "old-space", "memory");
      mkdirSync(oldMemory, { recursive: true });
      writeFileSync(join(oldMemory, "org.md"), "# Previous organization\n");
      const workerFile = writeWorkerConfig(dir, "aidlc-product-agent", frontmatter);

      const result = runDispatchAdmission(dir, {
        cwd: dir,
        tool_name: "invoke_sub_agent",
        tool_input: { name: "aidlc-product-agent", prompt: "Inspect the project." },
      });
      expect(result.code, result.stderr).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(workerFile);
      expect(result.stderr).toContain(MEMORY_GLOB);
      expect(result.stderr).toContain("/aidlc space switch default");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Upstream's sixth table case was "missing worker file": it deleted the
  // validated `<agent>.json` while the roster-marking `<agent>.md` stayed, so the
  // worker was in the roster with no readable config. That shape cannot exist
  // here -- the Markdown IS both the roster marker and the config, so deleting it
  // takes the agent OUT of the roster and the dispatch is correctly not validated
  // at all. The risk it guarded is still real, and this is the shape that carries
  // it on this row: the roster file exists but cannot be read.
  test("native preload blocks a roster worker whose config cannot be read", () => {
    const dir = scratchProject(false);
    try {
      writeFileSync(
        join(dir, "aidlc", "spaces", "default", "memory", "org.md"),
        "# Organization\n",
      );
      // A directory where the config must be a file: existsSync still passes, so
      // the worker stays in the roster, and the read fails.
      const workerFile = join(dir, ".kiro", "agents", "aidlc-product-agent.md");
      rmSync(workerFile);
      mkdirSync(workerFile);

      const result = runDispatchAdmission(dir, {
        cwd: dir,
        tool_name: "invoke_sub_agent",
        tool_input: { name: "aidlc-product-agent", prompt: "Inspect the project." },
      });
      expect(result.code, result.stderr).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(workerFile);
      expect(result.stderr).toContain("cannot read the worker config");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("native preload allows a repaired resource with a nested memory file", () => {
    const dir = scratchProject(false);
    try {
      const phases = join(dir, "aidlc", "spaces", "default", "memory", "phases");
      mkdirSync(phases, { recursive: true });
      writeFileSync(join(phases, "inception.md"), "# Inception\n");
      // A stale declaration first, then the repair, so the allow is not a
      // pass-by-default: the same dispatch must move from blocked to admitted.
      writeWorkerConfig(dir, "aidlc-product-agent", workerFrontmatter("aidlc-product-agent", []));
      const payload = {
        cwd: dir,
        tool_name: "invoke_sub_agent",
        tool_input: { name: "aidlc-product-agent", prompt: "Inspect the project." },
      };
      expect(runDispatchAdmission(dir, payload).code).toBe(2);

      writeWorkerConfig(
        dir,
        "aidlc-product-agent",
        workerFrontmatter("aidlc-product-agent", ["skill://aidlc", MEMORY_GLOB]),
      );
      const repaired = runDispatchAdmission(dir, payload);
      expect(repaired.code, repaired.stderr).toBe(0);
      expect(repaired.stdout).toBe("");
      expect(repaired.stderr).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("native preload blocks a correct glob with no Markdown files", () => {
    const dir = scratchProject(false);
    try {
      const workerFile = writeWorkerConfig(
        dir,
        "aidlc-product-agent",
        workerFrontmatter("aidlc-product-agent", [MEMORY_GLOB]),
      );
      const memory = join(dir, "aidlc", "spaces", "default", "memory");
      // The fixture is admissible by default, so this case has to create the
      // condition it asserts: a glob that is correct and matches nothing.
      rmSync(memory, { recursive: true, force: true });
      mkdirSync(memory, { recursive: true });
      writeFileSync(join(memory, "notes.txt"), "Not a rule file.\n");
      // A directory named like a rule file: the glob matches the name, so only
      // an onlyFiles scan tells the difference.
      mkdirSync(join(memory, "not-a-file.md"));
      const result = runDispatchAdmission(dir, {
        cwd: dir,
        tool_name: "subagent",
        tool_input: {
          stages: [{ role: "aidlc-product-agent", prompt_template: "Inspect the project." }],
        },
      });
      expect(result.code, result.stderr).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(workerFile);
      expect(result.stderr).toContain(MEMORY_GLOB);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("native preload leaves non-roster helpers untouched, including mixed crews", () => {
    const dir = scratchProject(false);
    try {
      // A name using the aidlc- prefix with no roster file is outside the
      // contract, so an empty declaration on it must not block anything.
      const helper = "aidlc-custom-helper-agent";
      writeWorkerConfig(dir, helper, workerFrontmatter(helper, []));
      rmSync(join(dir, ".kiro", "agents", `${helper}.md`));
      const result = runDispatchAdmission(dir, {
        cwd: dir,
        tool_name: "invoke_sub_agent",
        tool_input: { name: helper, prompt: "Inspect the project." },
      });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");

      writeFileSync(
        join(dir, "aidlc", "spaces", "default", "memory", "org.md"),
        "# Organization\n",
      );
      const crew = {
        cwd: dir,
        tool_name: "subagent",
        tool_input: {
          stages: [
            { role: helper, prompt_template: "Inspect the project." },
            { role: "aidlc-product-agent", prompt_template: "Inspect the project." },
          ],
        },
      };
      const allowed = runDispatchAdmission(dir, crew);
      expect(allowed.code, allowed.stderr).toBe(0);
      expect(allowed.stdout).toBe("");
      expect(allowed.stderr).toBe("");
      // The same crew blocks once the ROSTER member is stale, and the helper is
      // never named -- a mixed crew must not implicate the agent it cannot judge.
      const workerFile = writeWorkerConfig(
        dir,
        "aidlc-product-agent",
        workerFrontmatter("aidlc-product-agent", []),
      );
      const blocked = runDispatchAdmission(dir, crew);
      expect(blocked.code, blocked.stderr).toBe(2);
      expect(blocked.stderr).toContain(workerFile);
      expect(blocked.stderr).not.toContain(`${helper}.md`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("native preload leaves the installed composer exempt", () => {
    const dir = scratchProject(false);
    try {
      writeWorkerConfig(
        dir,
        "aidlc-composer-agent",
        workerFrontmatter("aidlc-composer-agent", []),
      );
      const result = runDispatchAdmission(dir, {
        cwd: dir,
        tool_name: "subagent_aidlc-composer-agent",
        tool_input: { prompt: "Compose the requested workflow." },
      });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("native preload gives plugin roster workers an actionable Markdown repair", () => {
    const dir = scratchProject(false);
    try {
      cpSync(
        join(REPO_ROOT, "core", "memory"),
        join(dir, "aidlc", "spaces", "default", "memory"),
        { recursive: true },
      );
      // A plugin persona is a roster worker outside the aidlc- namespace, so the
      // repair it is given must not name space switch or doctor -- neither can
      // repair a hand-authored plugin config.
      const agent = "test-pro-metrics-agent";
      const workerFile = writeWorkerConfig(
        dir,
        agent,
        `---\nname: ${agent}\ndisplay_name: Test Pro Metrics Agent\nplugin: test-pro\n---\n\nInspect testing metrics.\n`,
      );
      // Delegation trust lives in the conductor's Markdown frontmatter on this
      // row (toolsSettings.subagent.trustedAgents), which is where the plugin
      // composer reads and maintains it.
      const conductorFile = join(dir, ".kiro", "agents", "aidlc.md");
      const conductor = readFileSync(conductorFile, "utf-8");
      const anchor = "    trustedAgents:\n";
      expect(conductor, "conductor carries a trustedAgents block").toContain(anchor);
      writeFileSync(
        conductorFile,
        conductor.replace(anchor, `${anchor}      - "${agent}"\n`),
      );

      const prompt = "Run .kiro/aidlc-common/stages/inception/user-stories.md.";
      const shared = runDispatchCore(dir, {
        cwd: dir,
        tool_name: "Task",
        tool_input: { subagent_type: agent, prompt },
      });
      expect(shared.code, shared.stderr).toBe(0);
      const delivered = JSON.parse(shared.stdout).hookSpecificOutput.updatedInput.prompt;
      expect(delivered).toContain(
        readFileSync(join(dir, "aidlc", "spaces", "default", "memory", "org.md"), "utf-8"),
      );

      const payload = {
        cwd: dir,
        tool_name: "invoke_sub_agent",
        tool_input: { name: agent, prompt },
      };
      const blocked = runDispatchAdmission(dir, payload);
      expect(blocked.code, blocked.stderr).toBe(2);
      expect(blocked.stdout).toBe("");
      expect(blocked.stderr).toContain(workerFile);
      expect(blocked.stderr).toContain("resources");
      expect(blocked.stderr).toContain("plugin persona's Markdown frontmatter");
      expect(blocked.stderr).toContain(MEMORY_GLOB);
      expect(blocked.stderr).not.toContain("/aidlc space switch");
      expect(blocked.stderr).not.toContain("/aidlc --doctor");

      writeWorkerConfig(
        dir,
        agent,
        `---\nname: ${agent}\ndisplay_name: Test Pro Metrics Agent\nplugin: test-pro\nresources:\n  - '${"file://aidlc/spaces/default/memory/**/*.md"}'\n---\n\nInspect testing metrics.\n`,
      );
      const repaired = runDispatchAdmission(dir, payload);
      expect(repaired.code, repaired.stderr).toBe(0);
      expect(repaired.stdout).toBe("");
      expect(repaired.stderr).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });


  test("5d: the delegation window is what scopes the lifecycle guard to a persona", () => {
    // This used to walk 14 agent-v1 JSONs and assert each one registered
    // `state-transition-guard <its own name>`. That registration channel is gone
    // (a v3 hook manifest has no agent scope), and the window replaces it: open
    // it and the guard enforces against the delegate, close it and the main
    // session is free to run the same verb. Both halves are asserted here,
    // because either one alone passes for the wrong reason.
    const dir = scratchProject(false);
    try {
      const lifecycle = {
        cwd: dir,
        tool_name: "execute_bash",
        tool_input: { command: "bun .kiro/tools/aidlc-orchestrate.ts next --resume" },
      };

      // Main session: allowed.
      expect(runAdapter(dir, "state-transition-guard", lifecycle).code).toBe(0);

      openDelegationWindow(dir, "aidlc-design-agent");
      const delegated = runAdapter(dir, "state-transition-guard", lifecycle);
      expect(delegated.code).toBe(2);
      expect(delegated.stderr).toContain("aidlc-design-agent");
      expect(delegated.stderr).toContain(
        "only the main workflow session can change stage status or routing",
      );

      closeDelegationWindow(dir, "aidlc-design-agent");
      expect(runAdapter(dir, "state-transition-guard", lifecycle).code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The ledger sits under the project-controlled `aidlc/.aidlc-sessions` tree, which
  // .gitignore does not cover -- so the repository itself can make the write fail.
  // Before this guard the adapter swallowed that failure and admitted the dispatch,
  // and because both persona guards return 0 on an empty agent_type, the delegate
  // then ran with the delegated-review read boundary and the lifecycle-command
  // restrictions skipped. A repo could therefore switch the guards off by committing
  // one file. Both obstruction shapes are asserted: a plain file where a directory is
  // needed, and a planted symlink.
  test("5d1b: a dispatch is refused when the delegation ledger path is obstructed", () => {
    const dir = scratchProject(false);
    try {
      // A regular file exactly where the sessions root has to be a directory.
      const sessions = join(dir, "aidlc", ".aidlc-sessions");
      rmSync(sessions, { recursive: true, force: true });
      mkdirSync(dirname(sessions), { recursive: true });
      writeFileSync(sessions, "planted by the repository\n");

      const refused = runAdapter(dir, "log-subagent", {
        hook_event_name: "PreToolUse",
        cwd: dir,
        tool_name: "subagent_aidlc-design-agent",
        tool_input: { prompt: "delegate to aidlc-design-agent" },
      });
      expect(refused.code, refused.stdout + refused.stderr).toBe(2);
      expect(refused.stderr).toContain("not a directory");
      expect(refused.stderr).toContain("Refusing this dispatch");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("5d1c: a symlink planted inside the ledger path refuses the dispatch too", () => {
    const dir = scratchProject(false);
    try {
      // Everything below the sessions root is created by the adapter, so a symlink
      // there was planted. It is refused rather than followed -- following it would
      // let a repository redirect attribution writes out of the workspace.
      const elsewhere = mkdtempSync(join(tmpdir(), "t147-ledger-escape-"));
      const sessions = join(dir, "aidlc", ".aidlc-sessions");
      mkdirSync(sessions, { recursive: true });
      symlinkSync(elsewhere, join(sessions, "kiro-delegation"));

      const refused = runAdapter(dir, "log-subagent", {
        hook_event_name: "PreToolUse",
        cwd: dir,
        tool_name: "subagent_aidlc-design-agent",
        tool_input: { prompt: "delegate to aidlc-design-agent" },
      });
      expect(refused.code, refused.stdout + refused.stderr).toBe(2);
      expect(refused.stderr).toContain("is a symbolic link");
      rmSync(elsewhere, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The leaf check is separate from the parent walk, and it needs a window that
  // already opened normally -- a symlink AT `windows.ndjson` is only reachable once
  // the bucket exists. Walking only the parent directories left this uncovered, and
  // appendFileSync through a symlink writes wherever it points.
  test("5d1d: the ledger file replaced by a symlink refuses the next dispatch", () => {
    const dir = scratchProject(false);
    try {
      openDelegationWindow(dir, "aidlc-design-agent");
      const ledger = findDelegationLedger(dir);
      const elsewhere = join(mkdtempSync(join(tmpdir(), "t147-ledger-swap-")), "windows.ndjson");
      writeFileSync(elsewhere, "");
      rmSync(ledger);
      symlinkSync(elsewhere, ledger);

      const refused = runAdapter(dir, "log-subagent", {
        hook_event_name: "PreToolUse",
        cwd: dir,
        tool_name: "subagent_aidlc-quality-agent",
        tool_input: { prompt: "delegate to aidlc-quality-agent" },
      });
      expect(refused.code, refused.stdout + refused.stderr).toBe(2);
      expect(refused.stderr).toContain("is a symbolic link");
      rmSync(dirname(elsewhere), { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("5d2: one dispatch of the same persona twice needs two closes", () => {
    // Regression: the window is keyed by the dispatch payload, so two identical
    // concurrent dispatches used to collapse into one entry and a single close
    // released both - dropping enforcement while a delegate was still running.
    const dir = scratchProject(false);
    try {
      const lifecycle = {
        cwd: dir,
        tool_name: "execute_bash",
        tool_input: { command: "bun .kiro/tools/aidlc-orchestrate.ts next --resume" },
      };
      openDelegationWindow(dir, "aidlc-design-agent");
      openDelegationWindow(dir, "aidlc-design-agent");
      closeDelegationWindow(dir, "aidlc-design-agent");
      expect(
        runAdapter(dir, "state-transition-guard", lifecycle).code,
        "one delegate is still inflight",
      ).toBe(2);
      closeDelegationWindow(dir, "aidlc-design-agent");
      expect(runAdapter(dir, "state-transition-guard", lifecycle).code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("9: the 0.x notice fires only on the legacy channel, and reads neither", () => {
    const dir = scratchProject(false);
    try {
      // A supported host carries no USER_PROMPT: the notice must not interrupt a
      // session it cannot diagnose.
      const modern = runAdapter(dir, "legacy-ide-notice", "");
      expect(modern.code).toBe(0);
      expect(modern.stdout).toBe("");
      expect(modern.stderr).toBe("");

      // A 0.x host delivers the payload in USER_PROMPT - on this trigger the tool
      // input, verbatim from a 0.12.333 firing. Exit 2 is the refusal that seam
      // honours (measured: a preToolUse hook exiting 2 refused the read outright),
      // and the denial text is the explanation the model is told to obey. Both
      // streams carry it because `stdout || stderr` is the success path's rule.
      const payload = JSON.stringify({
        path: "/w/AGENTS.md",
        start_line: null,
        end_line: 10,
        explanation: "User asked to read the first 10 lines of AGENTS.md.",
      });
      const legacy = runAdapter(dir, "legacy-ide-notice", "", [], {
        USER_PROMPT: payload,
        // The socket name 0.12.333 was measured to set.
        VSCODE_IPC_HOOK: "/Users/u/Library/Application Support/Kiro/0.12-main.sock",
      });
      expect(legacy.code).toBe(2);
      // The denial has to lead on whichever stream the host surfaces.
      for (const stream of [legacy.stdout, legacy.stderr]) {
        expect(stream.startsWith("ACCESS DENIED.")).toBe(true);
        expect(stream).toContain("no longer supports this version of Kiro IDE");
        expect(stream).toContain("Kiro CLI");
      }

      // A SUPPORTED host that runs this target anyway - which one click on the
      // `Migrate` button beside the legacy hook produces, and where 1.x populates
      // USER_PROMPT just the same - must hear nothing. Otherwise the notice denies
      // every tool call on an install AI-DLC supports. Socket name measured on
      // 1.0.437, trailing dot included.
      const supported = runAdapter(dir, "legacy-ide-notice", "", [], {
        USER_PROMPT: payload,
        VSCODE_IPC_HOOK: "/Users/u/Library/Application Support/Kiro/1.0.-main.sock",
      });
      expect(supported.code).toBe(0);
      expect(supported.stdout).toBe("");
      expect(supported.stderr).toBe("");
      // Silence here is the whole point: a migrated hook on a supported host must
      // not refuse anything, and exit 2 would now do exactly that.

      // An unreadable host line is silence too: informing is this target's only
      // job, and refusing work on a supported install is the worse error.
      for (const ipc of ["", "/tmp/not-a-kiro-socket", "/x/Kiro/main.sock"]) {
        const unknown = runAdapter(dir, "legacy-ide-notice", "", [], {
          USER_PROMPT: payload,
          VSCODE_IPC_HOOK: ipc,
        });
        expect(unknown.code, `silent on ${ipc || "<empty>"}`).toBe(0);
        expect(unknown.stdout, `silent on ${ipc || "<empty>"}`).toBe("");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("5d3: one crew dispatch is one window, however many personas it named", () => {
    // Regression: openDelegation appends one open per persona under the same
    // dispatch key, and a close used to cancel only the most recent - so a
    // two-persona crew left one open inflight until the 6h TTL and the lifecycle
    // guard kept refusing the MAIN session's own verbs after the crew finished.
    const dir = scratchProject(false);
    try {
      const lifecycle = {
        cwd: dir,
        tool_name: "execute_bash",
        tool_input: { command: "bun .kiro/tools/aidlc-orchestrate.ts next --resume" },
      };
      const crew = ["aidlc-developer-agent", "aidlc-quality-agent"];
      openCrewWindow(dir, crew);
      expect(runAdapter(dir, "state-transition-guard", lifecycle).code, "crew inflight").toBe(2);
      closeCrewWindow(dir, crew);
      expect(
        runAdapter(dir, "state-transition-guard", lifecycle).code,
        "one close releases every persona that dispatch named",
      ).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("5d4: a second target on the same dispatch event opens no second window", () => {
    // Regression, measured on a real run: dispatch tools match TWO ledger-writing
    // targets on PreToolUse (`log-subagent`, `plan-approval-guard`) but only one
    // on PostToolUse. The ledger write used to run for every INPUT_TARGET on the
    // reasoning that a repeat for the same event was "a no-op rather than a double
    // count" - but `openDelegation` mints a fresh group per call and a close
    // cancels only the most-recent group, so every dispatch opened two and closed
    // one. The leftover window kept the lifecycle guard refusing the MAIN
    // session's own verbs with the finished delegate named as the caller.
    const dir = scratchProject(false);
    try {
      const lifecycle = {
        cwd: dir,
        tool_name: "execute_bash",
        tool_input: { command: "bun .kiro/tools/aidlc-orchestrate.ts next --resume" },
      };
      const crew = ["aidlc-composer-agent"];
      openCrewWindow(dir, crew);
      // The same host event, delivered to the other target registered on it.
      runAdapter(dir, "plan-approval-guard", crewPayload(dir, crew, "PreToolUse"));
      expect(
        runAdapter(dir, "state-transition-guard", lifecycle).code,
        "the window is open once, not twice",
      ).toBe(2);
      closeCrewWindow(dir, crew);
      expect(
        runAdapter(dir, "state-transition-guard", lifecycle).code,
        "one close releases the dispatch, whatever else saw the same event",
      ).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("5d5: the opening edge REFUSES an unadmitted dispatch and opens no window", () => {
    // ADMISSION BEFORE OPEN. The first cut of this opened the window on the
    // log-subagent edge and tried to cancel it wherever a refusal became Kiro's
    // reject contract. That was wrong twice: it missed the matcherless
    // human-presence gate, which returns 2 far upstream of those sites, and writing
    // a close for a refusal made a refusal indistinguishable from a completion -
    // which needs an event id the payload does not carry, so one refusal's credit
    // could cancel a LATER byte-identical dispatch. Now this edge decides, and a
    // refusal appends nothing at all.
    const dir = scratchProject(true);
    try {
      seedUnapprovedCodeGeneration(dir, "todo-core");
      const dispatch = {
        hook_event_name: "PreToolUse",
        cwd: dir,
        tool_name: "subagent_aidlc-developer-agent",
        tool_input: {
          subagent_type: "aidlc-developer-agent",
          prompt: "AIDLC-UNIT: todo-core\nImplement todo-core",
        },
      };
      expect(
        runAdapter(dir, "log-subagent", dispatch).code,
        "the edge that opens the window refuses before opening one",
      ).toBe(2);
      // And EVERY refuser still refuses on its own evidence. A previous cut stood
      // these two down so the decision would be made once; that made each gate's
      // verdict depend on another registration having run, and with the opening
      // edge absent or its payload malformed the floor had no owner at all.
      expect(
        runAdapter(dir, "plan-approval-guard", dispatch).code,
        "the plan guard does not assume the opening edge ran",
      ).toBe(2);
      // The human-presence floor is a DIFFERENT contract and this fixture does not arm
      // it (no stage at [?]), so 0 is the correct answer here - the floor's own
      // no-stand-down is pinned by 5d7, which arms it.
      expect(
        runAdapter(dir, "enforce-approval-gate", dispatch).code,
        "an unapproved plan is not the presence floor's business",
      ).toBe(0);
      expect(
        runAdapter(dir, "state-transition-guard", {
          hook_event_name: "PreToolUse",
          cwd: dir,
          tool_name: "execute_bash",
          tool_input: { command: "bun .kiro/tools/aidlc-orchestrate.ts next" },
        }).code,
        "a refused dispatch never ran, so it cannot own the main session's verbs",
      ).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("5d7: a malformed dispatch payload cannot bypass the presence floor", () => {
    // The admitter block is gated on `malformedFields` being empty, and a previous cut
    // stood the gate down on the tool NAME alone - so `tool_input: []` skipped the
    // admitter while still disarming the gate, and an ordinary open gate let the call
    // through. Nothing may stand down on a shape it cannot fully parse.
    const dir = scratchProject(true);
    try {
      writeFileSync(
        seededStateFile(dir),
        readFileSync(seededStateFile(dir), "utf-8").replace(/^- \[x\] /m, "- [?] "),
      );
      writeFileSync(
        join(seededAuditDir(dir), pinnedShardName()),
        "# AI-DLC Audit Log\n\n## Stage Awaiting Approval\n" +
          "**Timestamp**: 2026-01-01T00:00:00Z\n**Event**: STAGE_AWAITING_APPROVAL\n\n---\n",
      );
      const armed: NodeJS.ProcessEnv = {
        AIDLC_SKIP_HUMAN_PRESENCE_GUARD: undefined,
        AIDLC_PROJECT_DIR: dir,
      };
      expect(
        runAdapter(dir, "enforce-approval-gate", {
          hook_event_name: "PreToolUse",
          cwd: dir,
          tool_name: "subagent_aidlc-developer-agent",
          tool_input: [],
        }, [], armed).code,
        "a malformed dispatch is still a tool call at an open gate",
      ).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("5d8: the suffix is the identity, so an argument cannot name a different agent", () => {
    // `openDelegation` attributes the window with kiroDispatch's derivation, which
    // treats the `subagent_` suffix as authoritative. A first cut of the admission
    // check derived the agent argument-first, so this payload asked the core guard
    // about the quality agent, was admitted, and then had its window attributed to
    // the developer - two identities for one dispatch.
    const dir = scratchProject(true);
    try {
      seedUnapprovedCodeGeneration(dir, "todo-core");
      expect(
        runAdapter(dir, "log-subagent", {
          hook_event_name: "PreToolUse",
          cwd: dir,
          tool_name: "subagent_aidlc-developer-agent",
          tool_input: {
            name: "aidlc-quality-agent",
            prompt: "AIDLC-UNIT: todo-core\nImplement todo-core",
          },
        }).code,
        "the suffix names the developer, so Code Generation must judge the developer",
      ).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("5d9: an admitted dispatch survives either hook order", () => {
    // The reviewer asked for both orders explicitly. With no gate open and no
    // unapproved Code Generation, all three targets must pass and exactly one window
    // must exist afterwards - whichever ran first.
    for (const order of [
      ["log-subagent", "plan-approval-guard", "enforce-approval-gate"],
      ["enforce-approval-gate", "plan-approval-guard", "log-subagent"],
    ]) {
      const dir = scratchProject(true);
      try {
        const dispatch = {
          hook_event_name: "PreToolUse",
          cwd: dir,
          tool_name: "subagent_aidlc-developer-agent",
          tool_input: { subagent_type: "aidlc-developer-agent", prompt: "no gate is open" },
        };
        for (const target of order) {
          expect(
            runAdapter(dir, target, dispatch).code,
            `${target} in order [${order.join(", ")}]`,
          ).toBe(0);
        }
        const ledger = readFileSync(findDelegationLedger(dir), "utf-8")
          .split("\n")
          .filter((line) => line.includes('"op":"open"'));
        expect(ledger.length, `one window for order [${order.join(", ")}]`).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("5d10: the refusal relays the core guard's own remedy, not a paraphrase", () => {
    // Reducing the core call to `.code === 2` replaced the AIDLC-UNIT /
    // AIDLC-TESTING-CONTRACT remedy with a generic line, which left the conductor
    // without a deterministic retry: it knows it was refused and not what to send.
    const dir = scratchProject(true);
    try {
      seedUnapprovedCodeGeneration(dir, "todo-core");
      const r = runAdapter(dir, "log-subagent", {
        hook_event_name: "PreToolUse",
        cwd: dir,
        tool_name: "subagent_aidlc-developer-agent",
        tool_input: { subagent_type: "aidlc-developer-agent", prompt: "start the unit" },
      });
      expect(r.code).toBe(2);
      expect(r.stderr, "the core guard names what is missing").toContain("Code generation cannot start");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("5d11: two concurrent identical dispatches leave two windows, not one", async () => {
    // The reviewer asked for the concurrent case. Two adapter PROCESSES admitting the
    // same bytes at the same moment must append two groups: the ledger is append-only
    // precisely because a keyed map once collapsed them and the first close released
    // both. Each still needs its own close.
    const dir = scratchProject(true);
    try {
      const payload = JSON.stringify({
        hook_event_name: "PreToolUse",
        cwd: dir,
        tool_name: "subagent_aidlc-developer-agent",
        tool_input: { subagent_type: "aidlc-developer-agent", prompt: "identical bytes" },
      });
      const adapter = join(dir, ".kiro", "hooks", "aidlc-kiro-adapter.ts");
      const spawnOne = () => {
        const proc = Bun.spawn(["bun", adapter, "log-subagent"], {
          cwd: dir,
          stdin: Buffer.from(payload, "utf-8"),
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, AIDLC_PROJECT_DIR: dir } as NodeJS.ProcessEnv,
        });
        return proc.exited;
      };
      const [a, b] = await Promise.all([spawnOne(), spawnOne()]);
      expect(a, "first concurrent admission").toBe(0);
      expect(b, "second concurrent admission").toBe(0);
      const opens = readFileSync(findDelegationLedger(dir), "utf-8")
        .split("\n")
        .filter((line) => line.includes('"op":"open"'));
      expect(opens.length, "two dispatches are two windows").toBe(2);
      const groups = new Set(
        opens.map((line) => String((JSON.parse(line) as { group?: unknown }).group ?? "")),
      );
      expect(groups.size, "and two distinct groups").toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("5d6: an aged-out open's close cannot swallow a later identical dispatch", () => {
    // The credit accounting this replaces failed OPEN in the other direction: an
    // expired open is skipped at replay, so ITS close matched nothing and was
    // remembered as a credit for that key - and the next byte-identical dispatch's
    // open was consumed by it, hiding a delegate that really was running from
    // state-transition-guard and reviewer-scope. A crew dispatch repeated in a long
    // session is the shape that gets there.
    const dir = scratchProject(true);
    try {
      const agent = "aidlc-developer-agent";
      const payload = {
        tool_name: "subagent_aidlc-developer-agent",
        tool_input: { subagent_type: agent, prompt: "same bytes every time" },
      };
      // Let the adapter write the ledger (its path is keyed by a session hash the
      // test has no business reconstructing), then AGE what it wrote and close it.
      expect(
        runAdapter(dir, "log-subagent", { hook_event_name: "PreToolUse", cwd: dir, ...payload }).code,
      ).toBe(0);
      const ledger = findDelegationLedger(dir);
      const aged = Date.now() - 7 * 60 * 60 * 1000; // older than DELEGATION_TTL_MS
      const rows = readFileSync(ledger, "utf-8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .map((row): Record<string, unknown> => ({ ...row, ts: aged }));
      const key = String(rows[0]?.key ?? "");
      expect(key, "the opening edge must have written a keyed open").not.toBe("");
      writeFileSync(
        ledger,
        `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` +
          `${JSON.stringify({ op: "close", key, ts: aged + 1000 })}\n`,
        "utf-8",
      );
      // A fresh, admitted dispatch with the SAME bytes.
      expect(
        runAdapter(dir, "log-subagent", {
          hook_event_name: "PreToolUse",
          cwd: dir,
          ...payload,
        }).code,
      ).toBe(0);
      // The delegate is live, so a lifecycle verb from inside the window is refused.
      expect(
        runAdapter(dir, "state-transition-guard", {
          hook_event_name: "PreToolUse",
          cwd: dir,
          tool_name: "execute_bash",
          tool_input: { command: "bun .kiro/tools/aidlc-orchestrate.ts next" },
        }).code,
        "the new window must be attributed, not consumed by the aged close",
      ).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("5h: the guards read the RESOLVED project, not the process cwd", () => {
    // This row now also serves the CLI, where a hook is invoked with the project
    // named explicitly and the cwd is whatever the host had. Three merged-in guards
    // still read process.cwd() for their state and audit, so the same guarded
    // payload was refused from the project root and allowed from anywhere else -
    // the guard's own answer depended on a directory that carries no authority.
    //
    // Arming this floor takes three things, and missing any one of them makes the
    // case pass for the wrong reason: the runner's global off-switch removed, a
    // stage actually at [?], and an audit that tracks presence WITHOUT a HUMAN_TURN
    // (humanActedSinceGate fails OPEN on a ledger with no events at all).
    const dir = scratchProject(true);
    const foreign = mkdtempSync(join(tmpdir(), "t147-foreign-cwd-"));
    try {
      writeFileSync(
        seededStateFile(dir),
        readFileSync(seededStateFile(dir), "utf-8").replace(/^- \[x\] /m, "- [?] "),
      );
      expect(readFileSync(seededStateFile(dir), "utf-8")).toContain("- [?] ");
      writeFileSync(
        join(seededAuditDir(dir), pinnedShardName()),
        "# AI-DLC Audit Log\n\n## Stage Awaiting Approval\n" +
          "**Timestamp**: 2026-01-01T00:00:00Z\n" +
          "**Event**: STAGE_AWAITING_APPROVAL\n\n---\n",
      );
      const armed: NodeJS.ProcessEnv = {
        AIDLC_SKIP_HUMAN_PRESENCE_GUARD: undefined,
        AIDLC_PROJECT_DIR: dir,
      };
      const payload = {
        hook_event_name: "PreToolUse",
        tool_name: "execute_bash",
        tool_input: { command: "echo not-a-human" },
      };
      expect(
        runAdapter(dir, "enforce-approval-gate", payload, [], armed).code,
        "the floor must refuse while a gate is open and no human has acted",
      ).toBe(2);
      expect(
        runAdapter(dir, "enforce-approval-gate", payload, [], armed, foreign).code,
        "same payload, same project, different cwd: the verdict must not move",
      ).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(foreign, { recursive: true, force: true });
    }
  });

  test("5g: reviewer-scope still enforces when another persona is inflight too", () => {
    // Regression: with two DIFFERENT personas inflight the adapter used to forward
    // an empty identity, so the core guard passed the call through - the exact gap
    // the persona axis exists to close. It resolves the ambiguity from the dispatch
    // record instead.
    const dir = scratchProject(true);
    try {
      mkdirSync(dirname(join(seededRecordDir(dir), ".aidlc-engine/reviewer-dispatch.json")), { recursive: true });
      writeFileSync(
        join(seededRecordDir(dir), ".aidlc-engine/reviewer-dispatch.json"),
        JSON.stringify({
          reviewer: "aidlc-architecture-reviewer-agent",
          stage: "nfr-design",
          unit: "todo-core",
          exempt: [],
        }),
        "utf-8",
      );
      openDelegationWindow(dir, "aidlc-architecture-reviewer-agent");
      openDelegationWindow(dir, "aidlc-developer-agent");
      const r = runAdapter(dir, "reviewer-scope", {
        hook_event_name: "preToolUse",
        cwd: dir,
        tool_name: "read_file",
        tool_input: { path: "construction/sibling-unit/design.md" },
      });
      expect(r.code, "two personas inflight must not disable the guard").toBe(2);
      expect(r.stderr).toContain("This review cannot open");
      // The attribution and its cost are recorded, since the refusal may belong
      // to the other delegate.
      expect(dropLines(dir)).toHaveLength(1);
      expect(dropLines(dir)[0]).toContain("attributed to the dispatched reviewer");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("5g2: a crew with no review in flight leaves the drop log clean", () => {
    // Regression: the ambiguity branch logged a drop whenever two delegates were
    // inflight, including when NO dispatch record existed - the ordinary state of
    // a crew stage. That appended a line per guarded call for the whole stage,
    // and a non-empty .drops file is a release signal in this repo.
    const dir = scratchProject(true);
    try {
      openDelegationWindow(dir, "aidlc-developer-agent");
      openDelegationWindow(dir, "aidlc-quality-agent");
      for (let i = 0; i < 3; i++) {
        const r = runAdapter(dir, "reviewer-scope", {
          hook_event_name: "preToolUse",
          cwd: dir,
          tool_name: "read_file",
          tool_input: { path: `construction/todo-core/file-${i}.md` },
        });
        expect(r.code, "no review in flight: nothing to enforce").toBe(0);
      }
      expect(dropLines(dir), "no record means no drop").toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("5g3: a record naming a delegate that is not inflight is a drop", () => {
    // The other half of the same branch: enforcement WAS expected here, and the
    // adapter could not attribute the call, so the gap is recorded.
    const dir = scratchProject(true);
    try {
      mkdirSync(dirname(join(seededRecordDir(dir), ".aidlc-engine/reviewer-dispatch.json")), { recursive: true });
      writeFileSync(
        join(seededRecordDir(dir), ".aidlc-engine/reviewer-dispatch.json"),
        JSON.stringify({
          reviewer: "aidlc-quality-reviewer-agent",
          stage: "nfr-design",
          unit: "todo-core",
          exempt: [],
        }),
        "utf-8",
      );
      openDelegationWindow(dir, "aidlc-architecture-reviewer-agent");
      openDelegationWindow(dir, "aidlc-developer-agent");
      const r = runAdapter(dir, "reviewer-scope", {
        hook_event_name: "preToolUse",
        cwd: dir,
        tool_name: "read_file",
        tool_input: { path: "construction/sibling-unit/design.md" },
      });
      expect(r.code, "identity unresolved: fail open").toBe(0);
      expect(dropLines(dir)).toHaveLength(1);
      expect(dropLines(dir)[0]).toContain("is not among them");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("5g4: a reviewer's directory walk and filename search reach the guard", () => {
    // Regression: canonicalTool() translated only write, read and shell names, so
    // list_directory/file_search/grep_search fell through to the reviewer-scope
    // branch's `else { return 0 }`. Core carries purpose-built LS/Glob/Grep logic
    // for exactly those shapes and nothing on this row ever fed it, so the read
    // half of the §12a bound was unreachable. The standalone manifest this row
    // ships has to match the names too, or the hook is never invoked at all.
    const dir = scratchProject(true);
    try {
      mkdirSync(dirname(join(seededRecordDir(dir), ".aidlc-engine/reviewer-dispatch.json")), { recursive: true });
      writeFileSync(
        join(seededRecordDir(dir), ".aidlc-engine/reviewer-dispatch.json"),
        JSON.stringify({
          reviewer: "aidlc-architecture-reviewer-agent",
          stage: "nfr-design",
          unit: "todo-core",
          exempt: [],
        }),
        "utf-8",
      );
      openDelegationWindow(dir, "aidlc-architecture-reviewer-agent");

      const sibling = runAdapter(dir, "reviewer-scope", {
        hook_event_name: "preToolUse",
        cwd: dir,
        tool_name: "list_directory",
        tool_input: { path: "construction/sibling-unit", depth: 3 },
      });
      expect(sibling.code, "walking a sibling unit is the violation this guard is for").toBe(2);

      const own = runAdapter(dir, "reviewer-scope", {
        hook_event_name: "preToolUse",
        cwd: dir,
        tool_name: "list_directory",
        tool_input: { path: "construction/todo-core", depth: 1 },
      });
      expect(own.code, "the reviewed unit's own directory stays available").toBe(0);

      // file_search carries the needle as `query` and no search root at all, so it
      // lands on the core rule for a pathless glob that does not limit itself to
      // the reviewed unit. grep_search reaches the pathless-Grep rule the same way;
      // its content regex deliberately does not travel, because matching content is
      // not a file access.
      const search = runAdapter(dir, "reviewer-scope", {
        hook_event_name: "preToolUse",
        cwd: dir,
        tool_name: "file_search",
        tool_input: { query: "design", excludePattern: null, includeIgnoredFiles: null },
      });
      expect(search.code, "a rootless repo-wide filename search is not scoped").toBe(2);

      // grep_search carries no path at all: its only scope is `includePattern`,
      // and that field is frequently null (both shapes are in the capture archive).
      const scoped = runAdapter(dir, "reviewer-scope", {
        hook_event_name: "preToolUse",
        cwd: dir,
        tool_name: "grep_search",
        tool_input: {
          query: "mentions construction/sibling-unit",
          caseSensitive: null,
          excludePattern: null,
          includePattern: "construction/todo-core/**",
        },
      });
      expect(
        scoped.code,
        "a search confined to the reviewed unit is allowed, and its content regex is not scanned",
      ).toBe(0);

      const unscoped = runAdapter(dir, "reviewer-scope", {
        hook_event_name: "preToolUse",
        cwd: dir,
        tool_name: "grep_search",
        tool_input: {
          query: "design",
          caseSensitive: null,
          excludePattern: null,
          includePattern: null,
        },
      });
      expect(
        unscoped.code,
        "a content search that expresses no scope reaches the pathless-Grep rule",
      ).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("5g5: review-freeze stays quiet before a workflow record exists", () => {
    // Regression, measured on a live run: the pre-merge row registered this hook
    // inside the reviewer agents' own configs, so it could not fire before a
    // dispatch. One standalone manifest serving both surfaces also sees the
    // conductor's own writes - including the ones that create the record - and core
    // reaches "nothing to protect" by reading the state file and failing open on
    // the throw, which records a drop. A non-empty .drops file is a release signal
    // in this repo, so "the workflow has not started" must not produce one.
    const dir = scratchProject(false);
    try {
      const r = runAdapter(dir, "review-freeze", {
        hook_event_name: "preToolUse",
        cwd: dir,
        tool_name: "fs_write",
        tool_input: { path: "aidlc/spaces/default/intents/todo/ideation/intent.md" },
      });
      expect(r.code, "no record yet: nothing to freeze").toBe(0);
      expect(
        freezeDropFiles(dir),
        "no record yet is not a swallowed failure",
      ).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("5e: a Kiro worker identity cannot invoke orchestrator lifecycle", () => {
    const dir = scratchProject(false);
    try {
      openDelegationWindow(dir, "aidlc-design-agent");
      const r = runAdapter(
        dir,
        "state-transition-guard",
        {
          cwd: dir,
          tool_name: "execute_bash",
          tool_input: {
            command:
              "bun .kiro/tools/aidlc-orchestrate.ts next --resume",
          },
        },
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("only the main workflow session can change stage status or routing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("5f: defensive read and mutation shapes reach the scoped guard adapters", () => {
    const dir = scratchProject(true);
    try {
      const healthDir = join(seededRecordDir(dir), ".aidlc-engine/hooks-health");
      mkdirSync(dirname(join(seededRecordDir(dir), ".aidlc-engine/reviewer-dispatch.json")), { recursive: true });
      writeFileSync(
        join(seededRecordDir(dir), ".aidlc-engine/reviewer-dispatch.json"),
        JSON.stringify({
          reviewer: "aidlc-architecture-reviewer-agent",
          stage: "nfr-design",
          unit: "todo-core",
          exempt: [],
        }),
        "utf-8",
      );
      const reviewerHeartbeat = join(healthDir, "reviewer-scope.last");
      // The reviewer's identity used to arrive as the persona argv of a
      // registration scoped to that agent. It comes from the delegation window
      // now, so open one for the reviewer before exercising the guard.
      openDelegationWindow(dir, "aidlc-architecture-reviewer-agent");
      for (const tool_name of ADAPTER_TOOL_NAMES.reads) {
        rmSync(reviewerHeartbeat, { force: true });
        const r = runAdapter(
          dir,
          "reviewer-scope",
          {
            hook_event_name: "preToolUse",
            cwd: dir,
            tool_name,
            tool_input: tool_name === "read_files"
              ? { paths: [null, "construction/sibling-unit/design.md"] }
              : { path: "construction/sibling-unit/design.md" },
          },
        );
        expect(r.code, tool_name).toBe(2);
        expect(r.stderr, tool_name).toContain("This review cannot open");
        expect(existsSync(reviewerHeartbeat), tool_name).toBe(true);
      }

      // A delete names its target `targetFile`, not `path`, so the delete cases
      // take the captured payload's own shape and override only the target.
      // Spelled `path` these assertions passed while the adapter forwarded no
      // target at all, claiming a refusal the host's own payload never received.
      const capturedDelete = (FIXTURES.preToolUse_delete_file as {
        tool_input: Record<string, unknown>;
      }).tool_input;
      const mutationInput = (tool_name: string, path: string) =>
        tool_name === "delete_file"
          ? { ...capturedDelete, targetFile: path }
          : { path };

      for (const tool_name of [
        ...ADAPTER_TOOL_NAMES.writes,
        ...ADAPTER_TOOL_NAMES.deletes,
      ]) {
        rmSync(reviewerHeartbeat, { force: true });
        const r = runAdapter(
          dir,
          "reviewer-scope",
          {
            hook_event_name: "preToolUse",
            cwd: dir,
            tool_name,
            tool_input: mutationInput(tool_name, "construction/sibling-unit/design.md"),
          },
        );
        expect(r.code, tool_name).toBe(2);
        expect(r.stderr, tool_name).toContain("This review cannot open");
        expect(existsSync(reviewerHeartbeat), tool_name).toBe(true);
      }

      const freezeHeartbeat = join(healthDir, "review-freeze.last");
      for (const tool_name of [
        ...ADAPTER_TOOL_NAMES.writes,
        ...ADAPTER_TOOL_NAMES.deletes,
      ]) {
        rmSync(freezeHeartbeat, { force: true });
        const r = runAdapter(dir, "review-freeze", {
          hook_event_name: "preToolUse",
          cwd: dir,
          tool_name,
          tool_input: mutationInput(tool_name, "construction/todo-core/design.md"),
        });
        expect(r.code, tool_name).toBe(0);
        expect(existsSync(freezeHeartbeat), tool_name).toBe(true);
      }

      const operations = runAdapter(
        dir,
        "reviewer-scope",
        {
          ...(FIXTURES.preToolUse_fs_read as Record<string, unknown>),
          cwd: dir,
          tool_input: {
            operations: [null, { path: "construction/sibling-unit/design.md" }],
          },
        },
      );
      expect(operations.code).toBe(2);
      expect(operations.stderr).toContain("This review cannot open");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("6: log-subagent emits SUBAGENT_COMPLETED to the audit", () => {
    const dir = scratchProject(true);
    try {
      const sessionId = "kiro-log-session";
      expect(markSubagentInflight(dir, sessionId)).toBe(true);
      const r = runAdapter(dir, "log-subagent", {
        ...(FIXTURES.postToolUse_subagent as Record<string, unknown>),
        session_id: sessionId,
      });
      expect(r.code).toBe(0);
      expect(existsSync(subagentInflightMarkerPath(dir))).toBe(false);
      const audit = readAudit(dir);
      expect(audit).toContain("SUBAGENT_COMPLETED");
      expect(audit).toContain("aidlc-developer-agent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("6a: direct dispatch completions log identity and response events stay inert", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "log-subagent", {
        hook_event_name: "postToolUse",
        cwd: dir,
        tool_name: "subagent",
        tool_input: {
          name: "aidlc-developer-agent",
          prompt: "Implement the unit",
          stages: [],
        },
      });
      expect(r.code).toBe(0);
      const before = readAudit(dir);
      expect(before.match(/SUBAGENT_COMPLETED/g)?.length).toBe(1);
      expect(before).toContain("aidlc-developer-agent");

      const response = runAdapter(dir, "log-subagent", {
        hook_event_name: "postToolUse",
        cwd: dir,
        tool_name: "subagent_response",
        tool_input: { subagent_type: "aidlc-developer-agent" },
      });
      expect(response.code).toBe(0);
      expect(readAudit(dir)).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("7: write-like adapter inputs reach audit and sensors while delete stays out", () => {
    const dir = scratchProject(true);
    try {
      const healthDir = join(seededRecordDir(dir), ".aidlc-engine/hooks-health");
      const auditHeartbeat = join(healthDir, "write-audit-log.last");
      const sensorHeartbeat = join(healthDir, "run-sensors.last");
      for (const tool_name of ADAPTER_TOOL_NAMES.writes) {
        rmSync(auditHeartbeat, { force: true });
        rmSync(sensorHeartbeat, { force: true });
        const r = runAdapter(dir, "audit-and-sensors", {
          ...(FIXTURES.postToolUse_write as Record<string, unknown>),
          cwd: dir,
          tool_name,
          tool_input: {
            path: join(seededRecordDir(dir), "inception", "requirements.md"),
          },
        });
        expect(r.code, tool_name).toBe(0);
        expect(existsSync(auditHeartbeat), tool_name).toBe(true);
        expect(existsSync(sensorHeartbeat), tool_name).toBe(true);
      }

      for (const command of ["str_replace", "append"]) {
        const before = readAudit(dir);
        const edited = runAdapter(dir, "audit-and-sensors", {
          ...(FIXTURES.postToolUse_fs_write_str_replace as Record<string, unknown>),
          cwd: dir,
          tool_input: {
            ...(FIXTURES.postToolUse_fs_write_str_replace as {
              tool_input: Record<string, unknown>;
            }).tool_input,
            command,
            path: join(seededRecordDir(dir), "inception", "requirements.md"),
          },
        });
        expect(edited.code, command).toBe(0);
        expect(readAudit(dir).slice(before.length), command).toContain("**Tool**: Edit");
      }

      const batchPaths = [
        join(seededRecordDir(dir), "inception", "requirements.md"),
        join(seededRecordDir(dir), "inception", "constraints.md"),
      ];
      mkdirSync(join(seededRecordDir(dir), "inception"), { recursive: true });
      for (const path of batchPaths) writeFileSync(path, "draft\n", "utf-8");
      const beforeBatch = readAudit(dir);
      const batch = runAdapter(dir, "audit-and-sensors", {
        hook_event_name: "postToolUse",
        cwd: dir,
        tool_name: "fs_write",
        tool_input: {
          operations: batchPaths.map((path) => ({ path: relative(dir, path) })),
        },
      });
      const batchAudit = readAudit(dir).slice(beforeBatch.length);
      expect(batch.code).toBe(0);
      expect(batchAudit.match(/\*\*Event\*\*: ARTIFACT_(?:CREATED|UPDATED)/g)).toHaveLength(2);
      // The document sensors are gate-fired; PostToolUse still reaches the
      // dispatcher heartbeat but must not evaluate them on intermediate writes.
      expect(batchAudit.match(/\*\*Event\*\*: SENSOR_FIRED/g) ?? []).toHaveLength(0);
      for (const path of batchPaths) {
        expect(batchAudit).toContain(
          `<project-dir>/${relative(dir, path).replace(/\\/g, "/")}`,
        );
      }
      expect(existsSync(sensorHeartbeat)).toBe(true);

      for (const tool_name of ADAPTER_TOOL_NAMES.deletes) {
        rmSync(auditHeartbeat, { force: true });
        const deleted = runAdapter(dir, "audit-and-sensors", {
          cwd: dir,
          tool_name,
          tool_input: { path: "construction/todo-core/design.md" },
        });
        expect(deleted.code, tool_name).toBe(0);
        expect(existsSync(auditHeartbeat), tool_name).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test("7b: the drop ledger records an unparsed payload's SIZE, never its content", () => {
    // This ledger is persistent, so anything interpolated into it outlives the
    // session - and the drop fires for exactly the payloads nothing could parse,
    // which are the ones most likely to be a tool's raw output rather than a path.
    const dir = scratchProject(true);
    try {
      const secret = "SENTINEL-do-not-persist-4c1f9b";
      const r = runAdapter(dir, "audit-and-sensors", {
        ...(FIXTURES.postToolUse_write as Record<string, unknown>),
        cwd: dir,
        tool_name: "fs_write",
        // No path field anywhere, so nothing is extractable and the drop fires.
        tool_input: { content: "draft" },
        tool_response: `wrote something: ${secret}`,
      });
      expect(r.code, r.stdout + r.stderr).toBe(0);
      const drops = dropLines(dir);
      expect(drops.length, drops.join("\n")).toBeGreaterThan(0);
      const line = drops.find((l) => l.includes("no extractable path")) ?? "";
      expect(line, drops.join("\n")).toContain("bytes");
      expect(line).not.toContain(secret);
      // Belt and braces: not anywhere in the ledger, not just not in that line.
      expect(drops.join("\n")).not.toContain(secret);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("8: rebuild-stage-graph target accepts the alias shell payload and exits 0", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "rebuild-stage-graph", FIXTURES.postToolUse_shell);
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("8b: post-shell intent creation binds the exact invoking session", () => {
    const dir = scratchProject(true);
    try {
      const created = createIntent(dir, "kiro-posttool-create", "default");
      const sid = "kiro-creation-session";
      const r = runAdapter(dir, "rebuild-stage-graph", {
        hook_event_name: "postToolUse",
        cwd: dir,
        session_id: sid,
        tool_name: "shell",
        tool_input: {
          command: "bun .kiro/tools/aidlc.ts engine intent create --scope poc",
        },
        tool_response: {
          items: [
            {
              Text: `Intent created: ${created.dirName} (space: default)\n`,
            },
          ],
        },
      });
      expect(r.code).toBe(0);
      expect(
        readFileSync(join(dir, "aidlc", ".aidlc-sessions", sid), "utf-8").trim(),
      ).toBe(created.uuid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Carried from the retired row's own adapter test, which upstream (#1216) had
  // just extended and this branch deletes with that row's file. The behaviour did
  // NOT go with it: the unified adapter still keeps `.kiro-ide-current-session`,
  // and eight read sites feed it into the forwarding latch, the inflight-delegate
  // lookup and three forwarded payloads. Deleting the only test for it would have
  // left that identity path uncovered on the surviving row.
  test("N6c: a real prompt session identity is remembered and an absent one never clobbers it", () => {
    const dir = scratchProject(true);
    const marker = join(dir, "aidlc", ".aidlc-sessions", ".kiro-ide-current-session");
    const prompt = (session: string | undefined) => ({
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      prompt: "Continue the current work",
    });
    try {
      // No identity to remember: the marker must not be invented.
      expect(runAdapter(dir, "record-human-turn", prompt(undefined)).code).toBe(0);
      expect(existsSync(marker)).toBe(false);
      // A real one is remembered, and a repeat does not disturb it.
      for (const session of ["sess_prompt_first", "sess_prompt_first", "sess_prompt_second"]) {
        expect(runAdapter(dir, "record-human-turn", prompt(session)).code).toBe(0);
        expect(readFileSync(marker, "utf-8").trim()).toBe(session);
      }
      // An absent identity afterwards leaves the last real one standing, which is
      // what the read sites fall back to.
      expect(runAdapter(dir, "record-human-turn", prompt(undefined)).code).toBe(0);
      expect(readFileSync(marker, "utf-8").trim()).toBe("sess_prompt_second");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("10: session-start FORWARDS session_id — core hook stamps the per-session→intent record (M3)", () => {
    // M3: the Kiro adapter now forwards session_id when present, so the core
    // hook's per-session→intent STAMP is written (the session→intent record).
    // Proof: create an intent (live cursor resolves a uuid), fire session-start
    // with a session_id in the payload, and assert the stamp file
    // aidlc/.aidlc-sessions/<session_id> was written with that uuid. Without
    // the forwarded session_id the core hook's `if (sessionId)` block is inert.
    const dir = scratchProject(true);
    try {
      const created = createIntent(dir, "kiro-stamp", "default");
      const sid = "kiro-session-abc123";
      const r = runAdapter(dir, "session-start", { ...(FIXTURES.agentSpawn as object), session_id: sid });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("AIDLC WORKFLOW ACTIVE");
      const stampPath = join(dir, "aidlc", ".aidlc-sessions", sid);
      expect(existsSync(stampPath)).toBe(true);
      expect(readFileSync(stampPath, "utf-8").trim()).toBe(created.uuid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("11: resume-rebind OFFER is structurally unreachable on Kiro — every spawn is forced to source=startup (documented limitation)", () => {
    // Kiro's agentSpawn carries no resume discrimination: the adapter ALWAYS
    // forwards source=startup. So even with a genuine cursor drift seeded, a
    // "resume"-shaped payload can never trigger the core hook's SESSION_RESUMED
    // path → no INTENT REBIND OFFER. This is a harness limitation, not a bug;
    // the assertion pins it deterministically (no skip needed). Contrast t149/14
    // where Codex DOES forward a real source and the offer fires.
    const dir = scratchProject(true);
    try {
      const sid = "kiro-session-drift";
      const a = createIntent(dir, "intent-a", "default");
      // First fire stamps the session to A (the live cursor at this point).
      const first = runAdapter(dir, "session-start", {
        ...(FIXTURES.agentSpawn as object),
        session_id: sid,
        source: "resume", // even a resume-shaped payload is coerced to startup
      });
      expect(first.code).toBe(0);
      const stampPath = join(dir, "aidlc", ".aidlc-sessions", sid);
      expect(readFileSync(stampPath, "utf-8").trim()).toBe(a.uuid);
      // Move the live cursor to B — a genuine drift A→B.
      createIntent(dir, "intent-b", "default");
      // Fire again with a resume-shaped payload. Because Kiro coerces to
      // startup, the core hook takes the STARTED path (re-stamps to B), never
      // the RESUMED offer path.
      const second = runAdapter(dir, "session-start", {
        ...(FIXTURES.agentSpawn as object),
        session_id: sid,
        source: "resume",
      });
      expect(second.code).toBe(0);
      expect(second.stdout).not.toContain("INTENT REBIND OFFER");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("9: malformed stdin fails open (exit 0, no output) on every target", () => {
    const dir = scratchProject(true);
    try {
      for (const target of [
        "continue-workflow",
        "session-start",
        "sync-workflow-state",
        "audit-and-sensors",
        "rebuild-stage-graph",
        "log-subagent",
      ]) {
        const r = runAdapter(dir, target, "{not json");
        expect(`${target}:${r.code}`).toBe(`${target}:0`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- Stop-hook run-mode cap on Kiro (issue #365/#367 cross-harness coverage) ---
  //
  // Kiro's stop adapter (case "continue-workflow", aidlc-kiro-adapter.ts:303-314) synthesizes
  // {hook_event_name:"Stop", stop_hook_active:false} with NO transcript_path. So
  // the core hook's conversational carve-out (tier 3) is structurally inert on
  // Kiro: the RUN-MODE-AWARE no-progress cap (blockCap, aidlc-continue-workflow.ts:122-137) is
  // the ONLY release path for a chatting / pausing human. These two tests pin
  // that contract deterministically:
  //   - interactive (no autonomy field) -> cap 2: a 2nd identical no-progress
  //     stop RELEASES (the human is freed after one nudge).
  //   - autonomous Construction -> cap 8: still blocks on call 3 (an unattended
  //     run keeps the loop alive; only a real hang ever hits 8).
  // The per-project guard counter persists under the active record's
  // .aidlc-continue-workflow-hook/block-count.json (stopHookDir, aidlc-lib.ts:1620), so the
  // SAME scratch project is reused across the repeated calls - consecutive
  // no-progress blocks at one unchanging signature, which is exactly what the
  // counter measures.

  /** Run the kiro adapter stop target with CLAUDE_CODE_STOP_HOOK_BLOCK_CAP
   *  explicitly REMOVED, so the mode-aware default cap applies regardless of the
   *  test runner's environment (a leaked override would mask the contract). The
   *  adapter itself never sets the var (verified: aidlc-kiro-adapter.ts builds
   *  {hook_event_name,stop_hook_active} only), and the core hook reads it from
   *  the inherited process env (aidlc-continue-workflow.ts:123). */
  function runStopNoCapEnv(projectDir: string): { stdout: string; code: number } {
    const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir };
    delete (env as Record<string, string | undefined>).CLAUDE_CODE_STOP_HOOK_BLOCK_CAP;
    const r = spawnSync(
      "bun",
      [join(projectDir, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), "continue-workflow"],
      {
        cwd: projectDir,
        // The kiro adapter ignores stdin for the stop target (it synthesizes the
        // payload itself), but feed an empty object for shape parity.
        input: "{}",
        encoding: "utf-8",
        env,
        timeout: 30_000,
      },
    );
    return { stdout: r.stdout ?? "", code: r.status ?? -1 };
  }

  test("12: INTERACTIVE CAP RELEASE - Kiro stop blocks once then releases at the default cap 2 (no transcript -> cap is the chat release path)", () => {
    // Interactive: state has NO Construction Autonomy Mode field, so the
    // mode-aware default cap is INTERACTIVE_BLOCK_CAP=2. The brownfield-feature
    // fixture (Current Stage requirements-analysis [-], no [?]/[R] carve-out, no
    // questions file) yields a pending run-stage, so without the cap the hook
    // would block forever. Repeated identical no-progress stops at the same
    // signature: block on call 1, RELEASE on call 2 (count reaches 2 == cap).
    const dir = scratchProject(true);
    try {
      // Guard the premise: the override must NOT be set in this process (the
      // adapter never sets it, and runStopNoCapEnv strips it for the subprocess).
      expect(process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP).toBeUndefined();

      const first = runStopNoCapEnv(dir);
      expect(first.code).toBe(0);
      const out1 = JSON.parse(first.stdout) as { decision?: string; reason?: string };
      expect(out1.decision).toBe("block");
      expect(out1.reason ?? "").not.toBe("");

      const second = runStopNoCapEnv(dir);
      expect(second.code).toBe(0);
      // At cap 2 the 2nd no-progress block RELEASES: silent allow, no decision.
      expect(second.stdout.trim()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("13: AUTONOMOUS KEEPS CAP 8 - Kiro stop still blocks on call 3 under autonomous Construction (the long ceiling, not the interactive 2)", () => {
    // Autonomous Construction (Construction Autonomy Mode: autonomous) keeps the
    // long ceiling AUTONOMOUS_BLOCK_CAP=8. Same brownfield-feature engine state
    // (pending run-stage) but the autonomy field injected, so the carve-outs are
    // all gated off and only the cap can release. Three consecutive no-progress
    // stops: all three BLOCK (count 1,2,3 < 8). We bound the loop well short of 8.
    const dir = scratchProject(true);
    try {
      expect(process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP).toBeUndefined();
      // Inject the autonomy field as a bullet line in ## Current Status (getField
      // matches `- **Field**: value`, aidlc-lib.ts:1913). The base fixture has no
      // such field; adding it flips defaultBlockCap to 8 without changing the
      // engine's pending directive (Current Stage is unchanged).
      const statePath = seededStateFile(dir);
      const base = readFileSync(statePath, "utf-8");
      writeFileSync(
        statePath,
        base.replace(
          /^- \*\*Status\*\*: Running$/m,
          "- **Status**: Running\n- **Construction Autonomy Mode**: autonomous",
        ),
        "utf-8",
      );
      // Confirm the field landed (premise guard).
      expect(/Construction Autonomy Mode\*\*: autonomous/.test(readFileSync(statePath, "utf-8"))).toBe(
        true,
      );

      for (let call = 1; call <= 3; call++) {
        const r = runStopNoCapEnv(dir);
        expect(r.code).toBe(0);
        const out = JSON.parse(r.stdout) as { decision?: string };
        expect(`call${call}:${out.decision}`).toBe(`call${call}:block`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- Adapter respawns children via the running bun, not a PATH lookup ---
  //
  // The adapter dispatches every core lifecycle hook (runCore) and the off-band
  // utility commands by spawning a child bun process. A bare-name "bun" argv[0]
  // inherits the hook environment's $PATH; on GUI-launched apps / minimal server
  // environments that PATH often lacks the bun install dir, so the child spawn
  // fails ENOENT and the whole hook layer dies. The fix reuses the exact bun
  // running the adapter (process.execPath), which needs no PATH at all.

  test("14: session-start dispatches even when the child PATH has no bun (respawn uses process.execPath)", () => {
    // The adapter is launched via the ABSOLUTE bun (process.execPath), so it
    // starts regardless of PATH; the contract under test is that its OWN child
    // respawn (runCore) also does not need bun on PATH. Under the old bare-"bun"
    // argv[0] this session-start would ENOENT in runCore and emit nothing.
    const dir = scratchProject(true);
    try {
      const strippedEnv = envWithoutCommandOnPath("bun");
      const strippedPath = strippedEnv.PATH ?? "";
      // Premise guard: bun must genuinely be unresolvable on the stripped PATH,
      // else the test proves nothing.
      expect(strippedPath.split(delimiter).some((d) => existsSync(join(d, "bun")))).toBe(false);
      expect(Bun.which("bun", { PATH: strippedPath })).toBeNull();
      const r = spawnSync(
        process.execPath,
        [join(dir, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), "session-start"],
        {
          cwd: dir,
          input: JSON.stringify(FIXTURES.agentSpawn),
          encoding: "utf-8",
          env: { ...strippedEnv, CLAUDE_PROJECT_DIR: dir },
          timeout: 30_000,
        },
      );
      expect(r.status ?? -1).toBe(0);
      // The core hook ran (its output made it back through the child respawn).
      expect(r.stdout ?? "").toContain("AIDLC WORKFLOW ACTIVE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("15: the shipped kiro adapter source respawns via process.execPath, never a bare 'bun' argv[0]", () => {
    // Source pin (matches this suite's grep-pin style). Both shipped adapter
    // copies must spawn children via the running interpreter, so a stale
    // regeneration or a hand-edit reintroducing the bare-name respawn reds here.
    for (const adapter of [
      join(REPO_ROOT, "dist", "kiro", ".kiro", "hooks", "aidlc-kiro-adapter.ts"),
    ]) {
      const src = readFileSync(adapter, "utf-8");
      // No spawn whose argv[0] is the bare literal "bun".
      expect(/spawnSync\(\s*\[\s*"bun"/.test(src)).toBe(false);
      // The respawn seam names process.execPath.
      expect(src).toContain("process.execPath");
    }
  });
});
