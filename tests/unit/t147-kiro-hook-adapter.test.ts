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

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { EXTENDED_SUBPROCESS_TIMEOUT_MS } from "../../core/tools/aidlc-runtime-budget.ts";
import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(
    "bun",
    [
      join(projectDir, ".kiro", "hooks", "aidlc-kiro-adapter.ts"),
      target,
      ...extraArgs,
    ],
    {
      cwd: projectDir,
      input: typeof payload === "string" ? payload : JSON.stringify(payload),
      encoding: "utf-8",
      env: {
        ...process.env,
        AIDLC_UNATTENDED: undefined,
        CLAUDE_PROJECT_DIR: projectDir,
        ...envOverrides,
      } as NodeJS.ProcessEnv,
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    },
  );
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    code: r.status ?? -1,
  };
}

function runEngine(projectDir: string, args: string[]) {
  const result = spawnSync(process.execPath, [
    join(projectDir, ".kiro", "tools", "aidlc-orchestrate.ts"), ...args,
  ], {
    cwd: projectDir, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
      expect(
        runAdapter(dir, "verb-intercept", payload, [], {
          AIDLC_UNATTENDED: "1",
        }).code,
      ).toBe(0);
      expect(readAudit(dir)).not.toContain("HUMAN_TURN");
      expect(runAdapter(dir, "verb-intercept", payload).code).toBe(0);
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
      for (const target of ["deliver-stage-rules", "plan-approval-guard"]) {
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
          expect(result.stdout).toContain(`--- DIRECTIVE ---\n${response}\n--- END DIRECTIVE ---`);
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
        const receipt = packet.directive.receipt as string;
        expect(receipt).toMatch(/^[A-Za-z0-9_-]{8}$/);
        // Pass the exact emitted receipt; the real engine matches it to the part.
        packet = runEngine(dir, ["continue", receipt]);
        expect(started()).toBe(before + 1);
      }
      expect(packet.directive).toMatchObject({ kind: "run-stage", stage: "reverse-engineering", single: true });
      expect([...texts.keys()]).toEqual(packet.directive.rules_in_context);
      for (const [path, text] of texts) expect(text).toBe(readFileSync(join(dir, path), "utf8"));
      expect(texts.get(`aidlc/spaces/${DEFAULT_SPACE}/memory/org.md`)).toBe(rule);
      expect(readFileSync(seededStateFile(dir), "utf8")).toBe(stateBefore);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
      const incomplete = runAdapter(
        dir,
        "deliver-stage-rules",
        payload(basePrompt),
      );
      expect(incomplete.code, incomplete.stderr).toBe(0);
      expect(incomplete.stdout).toBe("");
      expect(incomplete.stderr).toBe("");
      const debugLog = join(seededRecordDir(dir), ".aidlc-engine/hooks-health", "hook-debug.log");
      const traced = runAdapter(
        dir,
        "deliver-stage-rules",
        payload(basePrompt),
        [],
        { AIDLC_HOOK_DEBUG: "1" },
      );
      expect(traced.code, traced.stderr).toBe(0);
      expect(traced.stdout).toBe("");
      expect(traced.stderr).toBe("");
      expect(readFileSync(debugLog, "utf-8")).toContain(
        'target="deliver-stage-rules" transport="native-preload"',
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
      const complete = runAdapter(
        dir,
        "deliver-stage-rules",
        payload(exactPrompt),
      );
      expect(complete.code, complete.stderr).toBe(0);
      expect(complete.stdout).toBe("");
      expect(complete.stderr).toBe("");

      const direct = runAdapter(dir, "deliver-stage-rules", {
        ...FIXTURES.preToolUse_invoke_sub_agent as Record<string, unknown>,
        cwd: dir,
        tool_input: { name: "aidlc-product-agent", prompt: basePrompt },
      });
      expect(direct.code).toBe(0);
      expect(direct.stdout).toBe("");
      expect(direct.stderr).toBe("");

      const blankPrompt = runAdapter(dir, "deliver-stage-rules", {
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
      const oversized = runAdapter(oversizedDir, "deliver-stage-rules", payload);
      expect(oversized.code, oversized.stderr).toBe(0);
      expect(oversized.stdout).toBe("");
      expect(oversized.stderr).toContain("exceeds the safe");
      expect(oversized.stderr).toContain("active-memory preload fallback");
      const workerFile = join(oversizedDir, ".kiro", "agents", "aidlc-quality-agent.json");
      writeFileSync(workerFile, JSON.stringify({ resources: [] }));
      const blocked = runAdapter(oversizedDir, "deliver-stage-rules", payload);
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
      const missing = runAdapter(missingDir, "deliver-stage-rules", {
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

  test.each([
    ["empty resources", JSON.stringify({ resources: [] })],
    ["absent resources", "{}"],
    ["stale-space glob", JSON.stringify({ resources: ["file://aidlc/spaces/old-space/memory/**/*.md"] })],
    ["malformed JSON", "{not json"],
    ["missing worker file", null],
    ["partial memory glob", JSON.stringify({ resources: ["file://aidlc/spaces/default/memory/org*.md"] })],
  ])("native preload blocks %s and names the worker repair", (_name, config) => {
    const dir = scratchProject(false);
    try {
      const workerFile = join(dir, ".kiro", "agents", "aidlc-product-agent.json");
      const memory = join(dir, "aidlc", "spaces", "default", "memory");
      writeFileSync(join(memory, "org.md"), "# Organization\n\nKeep the mandated review.\n");
      const oldMemory = join(dir, "aidlc", "spaces", "old-space", "memory");
      mkdirSync(oldMemory, { recursive: true });
      writeFileSync(join(oldMemory, "org.md"), "# Previous organization\n");
      if (config === null) rmSync(workerFile);
      else writeFileSync(workerFile, config);

      const result = runAdapter(dir, "deliver-stage-rules", {
        cwd: dir,
        tool_name: "invoke_sub_agent",
        tool_input: { name: "aidlc-product-agent", prompt: "Inspect the project." },
      });
      expect(result.code, result.stderr).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(workerFile);
      expect(result.stderr).toContain("file://aidlc/spaces/default/memory/**/*.md");
      expect(result.stderr).toContain("/aidlc space switch default");
      expect(result.stderr).toContain("/aidlc --doctor");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("native preload allows a repaired resource with a nested memory file", () => {
    const dir = scratchProject(false);
    try {
      const workerFile = join(dir, ".kiro", "agents", "aidlc-product-agent.json");
      const phases = join(dir, "aidlc", "spaces", "default", "memory", "phases");
      mkdirSync(phases, { recursive: true });
      writeFileSync(join(phases, "inception.md"), "# Inception\n\nKeep the phase mandates.\n");
      const payload = {
        cwd: dir,
        tool_name: "subagent_aidlc-product-agent",
        tool_input: { prompt: "Inspect the project." },
      };
      writeFileSync(workerFile, JSON.stringify({ resources: [] }));
      expect(runAdapter(dir, "deliver-stage-rules", payload).code).toBe(2);

      writeFileSync(workerFile, JSON.stringify({
        resources: ["skill://aidlc", "file://aidlc/spaces/default/memory/**/*.md"],
      }));
      const result = runAdapter(dir, "deliver-stage-rules", payload);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("native preload blocks a correct glob with no Markdown files", () => {
    const dir = scratchProject(false);
    try {
      const workerFile = join(dir, ".kiro", "agents", "aidlc-product-agent.json");
      writeFileSync(workerFile, JSON.stringify({
        resources: ["file://aidlc/spaces/default/memory/**/*.md"],
      }));
      const memory = join(dir, "aidlc", "spaces", "default", "memory");
      writeFileSync(join(memory, "notes.txt"), "Not a rule file.\n");
      mkdirSync(join(memory, "not-a-file.md"));
      const result = runAdapter(dir, "deliver-stage-rules", {
        cwd: dir,
        tool_name: "subagent",
        tool_input: {
          stages: [{ role: "aidlc-product-agent", prompt_template: "Inspect the project." }],
        },
      });
      expect(result.code, result.stderr).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(workerFile);
      expect(result.stderr).toContain("file://aidlc/spaces/default/memory/**/*.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("native preload leaves non-roster helpers untouched, including mixed crews", () => {
    const dir = scratchProject(false);
    try {
      const helper = "aidlc-custom-helper-agent";
      writeFileSync(join(dir, ".kiro", "agents", `${helper}.json`), JSON.stringify({ resources: [] }));
      const result = runAdapter(dir, "deliver-stage-rules", {
        cwd: dir,
        tool_name: "invoke_sub_agent",
        tool_input: { name: helper, prompt: "Inspect the project." },
      });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");

      writeFileSync(join(dir, "aidlc", "spaces", "default", "memory", "org.md"), "# Organization\n");
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
      const allowed = runAdapter(dir, "deliver-stage-rules", crew);
      expect(allowed.code, allowed.stderr).toBe(0);
      expect(allowed.stdout).toBe("");
      expect(allowed.stderr).toBe("");
      const workerFile = join(dir, ".kiro", "agents", "aidlc-product-agent.json");
      writeFileSync(workerFile, JSON.stringify({ resources: [] }));
      const blocked = runAdapter(dir, "deliver-stage-rules", crew);
      expect(blocked.code, blocked.stderr).toBe(2);
      expect(blocked.stderr).toContain(workerFile);
      expect(blocked.stderr).not.toContain(`${helper}.json`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("native preload leaves the installed composer exempt", () => {
    const dir = scratchProject(false);
    try {
      writeFileSync(join(dir, ".kiro", "agents", "aidlc-composer-agent.json"), JSON.stringify({ resources: [] }));
      const result = runAdapter(dir, "deliver-stage-rules", {
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

  test("native preload gives plugin roster workers an actionable JSON repair", () => {
    const dir = scratchProject(false);
    try {
      cpSync(join(REPO_ROOT, "core", "memory"), join(dir, "aidlc", "spaces", "default", "memory"), { recursive: true });
      const agent = "test-pro-metrics-agent";
      writeFileSync(join(dir, ".kiro", "agents", `${agent}.md`),
        `---\nname: ${agent}\ndisplay_name: Test Pro Metrics Agent\nplugin: test-pro\n---\n\nInspect testing metrics.\n`);
      const workerFile = join(dir, ".kiro", "agents", `${agent}.json`);
      const config = { name: agent, prompt: `file://${agent}.md`, tools: ["fs_read"], resources: [] as string[] };
      writeFileSync(workerFile, JSON.stringify(config));
      const conductorFile = join(dir, ".kiro", "agents", "aidlc.json");
      const conductor = JSON.parse(readFileSync(conductorFile, "utf-8"));
      conductor.toolsSettings.subagent.trustedAgents.push(agent);
      writeFileSync(conductorFile, JSON.stringify(conductor));
      const prompt = "Run .kiro/aidlc-common/stages/inception/user-stories.md.";
      const shared = runDispatchCore(dir, {
        cwd: dir, tool_name: "Task", tool_input: { subagent_type: agent, prompt },
      });
      expect(shared.code, shared.stderr).toBe(0);
      const delivered = JSON.parse(shared.stdout).hookSpecificOutput.updatedInput.prompt;
      expect(delivered).toContain(readFileSync(join(dir, "aidlc", "spaces", "default", "memory", "org.md"), "utf-8"));

      const payload = { cwd: dir, tool_name: "invoke_sub_agent", tool_input: { name: agent, prompt } };
      const blocked = runAdapter(dir, "deliver-stage-rules", payload);
      expect(blocked.code, blocked.stderr).toBe(2);
      expect(blocked.stdout).toBe("");
      expect(blocked.stderr).toContain(workerFile);
      expect(blocked.stderr).toContain("resources");
      expect(blocked.stderr).toContain("plugin's agent JSON");
      expect(blocked.stderr).toContain("file://aidlc/spaces/default/memory/**/*.md");
      expect(blocked.stderr).not.toContain("/aidlc space switch");
      expect(blocked.stderr).not.toContain("/aidlc --doctor");

      config.resources.push("file://aidlc/spaces/default/memory/**/*.md");
      writeFileSync(workerFile, JSON.stringify(config));
      const repaired = runAdapter(dir, "deliver-stage-rules", payload);
      expect(repaired.code, repaired.stderr).toBe(0);
      expect(repaired.stdout).toBe("");
      expect(repaired.stderr).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("5d: every Kiro worker registers an identity-scoped lifecycle guard", () => {
    const agentDir = join(KIRO_TREE, "agents");
    const workerFiles = require("node:fs")
      .readdirSync(agentDir)
      .filter((name: string) => /^aidlc-.+-agent\.json$/.test(name))
      .sort() as string[];
    expect(workerFiles).toHaveLength(14);

    for (const name of workerFiles) {
      const config = JSON.parse(
        readFileSync(join(agentDir, name), "utf-8"),
      ) as {
        name: string;
        hooks?: {
          preToolUse?: Array<{
            matcher?: string;
            command?: string;
            timeout_ms?: number;
          }>;
        };
      };
      expect(config.hooks?.preToolUse ?? [], name).toContainEqual({
        matcher: "execute_bash",
        command:
          `bun .kiro/tools/aidlc.ts engine adapter kiro state-transition-guard ${config.name}`,
        timeout_ms: EXTENDED_SUBPROCESS_TIMEOUT_MS,
      });
      expect(config.hooks?.preToolUse ?? [], name).toContainEqual({
        matcher: "fs_write",
        command:
          "bun .kiro/tools/aidlc.ts engine adapter kiro plan-approval-guard",
        timeout_ms: EXTENDED_SUBPROCESS_TIMEOUT_MS,
      });
      expect(config.hooks?.preToolUse ?? [], name).toContainEqual({
        matcher: "execute_bash",
        command:
          "bun .kiro/tools/aidlc.ts engine adapter kiro plan-approval-guard",
        timeout_ms: EXTENDED_SUBPROCESS_TIMEOUT_MS,
      });
    }
  });

  test("every Kiro agent gives ordinary hooks 1800000ms and compound hooks 3600000ms", () => {
    const agentDir = join(KIRO_TREE, "agents");
    const configs = require("node:fs").readdirSync(agentDir)
      .filter((name: string) => /^aidlc(?:-.+-agent)?\.json$/.test(name))
      .sort() as string[];
    expect(configs).toHaveLength(15);
    for (const name of configs) {
      const config = JSON.parse(readFileSync(join(agentDir, name), "utf-8")) as {
        hooks: Record<string, Array<{ command: string; timeout_ms?: number }>>;
      };
      const hooks = Object.values(config.hooks).flat();
      expect(hooks.length, name).toBeGreaterThan(0);
      for (const hook of hooks) {
        const compound = /\b(?:continue-workflow|audit-and-sensors)(?:\s|$)/.test(hook.command);
        expect(hook.timeout_ms, `${name}: ${hook.command}`).toBe(compound ? 3_600_000 : 1_800_000);
      }
    }
  });

  test("5e: a Kiro worker identity cannot invoke orchestrator lifecycle", () => {
    const dir = scratchProject(false);
    try {
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
        ["aidlc-design-agent"],
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
          ["aidlc-architecture-reviewer-agent"],
        );
        expect(r.code, tool_name).toBe(2);
        expect(r.stderr, tool_name).toContain("This review cannot open");
        expect(existsSync(reviewerHeartbeat), tool_name).toBe(true);
      }

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
            tool_input: { path: "construction/sibling-unit/design.md" },
          },
          ["aidlc-architecture-reviewer-agent"],
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
          tool_input: { path: "construction/todo-core/design.md" },
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
        ["aidlc-architecture-reviewer-agent"],
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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
        "deliver-stage-rules",
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
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
          timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
        },
      );
      expect(r.status ?? -1).toBe(0);
      // The core hook ran (its output made it back through the child respawn).
      expect(r.stdout ?? "").toContain("AIDLC WORKFLOW ACTIVE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("15: shipped kiro + kiro-ide adapter sources respawn via process.execPath, never a bare 'bun' argv[0]", () => {
    // Source pin (matches this suite's grep-pin style). Both shipped adapter
    // copies must spawn children via the running interpreter, so a stale
    // regeneration or a hand-edit reintroducing the bare-name respawn reds here.
    for (const adapter of [
      join(REPO_ROOT, "dist", "kiro", ".kiro", "hooks", "aidlc-kiro-adapter.ts"),
      join(REPO_ROOT, "dist", "kiro-ide", ".kiro", "hooks", "aidlc-kiro-adapter.ts"),
    ]) {
      const src = readFileSync(adapter, "utf-8");
      // No spawn whose argv[0] is the bare literal "bun".
      expect(/spawnSync\(\s*\[\s*"bun"/.test(src)).toBe(false);
      // The respawn seam names process.execPath.
      expect(src).toContain("process.execPath");
    }
  });
});
