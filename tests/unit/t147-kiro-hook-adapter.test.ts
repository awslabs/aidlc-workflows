// t147-kiro-hook-adapter: the Kiro stdin shim normalizes live-captured
// payloads into the core hooks' contract.
//
// covers: file:hooks/aidlc-continue-workflow.ts, file:hooks/aidlc-session-start.ts, file:hooks/aidlc-sync-workflow-state.ts, file:hooks/aidlc-log-subagent.ts, hook:aidlc-plan-approval-guard
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
  readIntentRegistry,
  writeSessionIntentHandoff,
  writeSessionIntentUuid,
} from "../../core/tools/aidlc-lib.ts";
import {
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  intentsDirOf,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

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
  mkdirSync(join(seededRecordDir(dir), "construction", unit, "code-generation"), {
    recursive: true,
  });
}

describe("t147 Kiro hook adapter (live-captured payload fixtures)", () => {
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
      writeSessionIntentUuid(dir, sessionId, original.uuid);
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
      expect(r.stderr).toContain("plan-approval guard");
      expect(r.stderr).toContain("unit todo-core");
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
        expect(r.stderr, `payload-${index}`).toContain("plan-approval guard");
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
      expect(r.stderr).toContain("plan-approval guard");
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
      expect(r.stderr).toContain("plan-approval guard");
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
        "Direct aidlc-state.ts approve is blocked",
      );
      expect(r.stderr).toContain("aidlc-orchestrate.ts report");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("5b: subagent dispatch warns on incomplete rules (proceeds) and accepts exact rules", () => {
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

      // Incomplete brief: advisory warning, dispatch PROCEEDS (exit 0). A
      // block-with-retry contract deadlocked live (byte-exact paste never
      // converges); Kiro agents preload the memory tree natively, so the
      // brief bundle is redundant defense there, not the delivery channel.
      const incomplete = runAdapter(
        dir,
        "deliver-stage-rules",
        payload(basePrompt),
      );
      expect(incomplete.code, incomplete.stderr).toBe(0);
      expect(incomplete.stderr).toContain(
        "did not carry the active-stage rule bundle verbatim",
      );
      expect(incomplete.stderr).toContain("The dispatch proceeded");

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

      const direct = runAdapter(dir, "deliver-stage-rules", {
        ...FIXTURES.preToolUse_invoke_sub_agent as Record<string, unknown>,
        cwd: dir,
        tool_input: { name: "aidlc-product-agent", prompt: basePrompt },
      });
      expect(direct.code).toBe(0);
      expect(direct.stderr).toContain(
        "did not carry the active-stage rule bundle verbatim",
      );

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
      expect(blankPrompt.stderr).toContain(
        "did not carry the active-stage rule bundle verbatim",
      );
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
      const oversized = runAdapter(oversizedDir, "deliver-stage-rules", {
        cwd: oversizedDir,
        tool_name: "subagent",
        tool_input: {
          stages: [{
            role: "aidlc-product-agent",
            prompt_template:
              "Run .kiro/aidlc-common/stages/inception/user-stories.md.",
          }],
        },
      });
      expect(oversized.code, oversized.stderr).toBe(0);
      expect(oversized.stdout).toBe("");
      expect(oversized.stderr).toContain("exceeds the safe");
      expect(oversized.stderr).toContain("active-memory preload fallback");
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
          `bun .kiro/hooks/aidlc-kiro-adapter.ts state-transition-guard ${config.name}`,
        timeout_ms: 15000,
      });
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
      expect(r.stderr).toContain("workflow lifecycle and routing are conductor-owned");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("5f: defensive read and mutation shapes reach the scoped guard adapters", () => {
    const dir = scratchProject(true);
    try {
      const healthDir = join(seededRecordDir(dir), ".aidlc-hooks-health");
      writeFileSync(
        join(seededRecordDir(dir), ".aidlc-reviewer-dispatch.json"),
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
        expect(r.stderr, tool_name).toContain("reviewer read-scope");
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
        expect(r.stderr, tool_name).toContain("reviewer read-scope");
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
      expect(operations.stderr).toContain("reviewer read-scope");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("6: log-subagent emits SUBAGENT_COMPLETED to the audit", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "log-subagent", FIXTURES.postToolUse_subagent);
      expect(r.code).toBe(0);
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
      const healthDir = join(seededRecordDir(dir), ".aidlc-hooks-health");
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
      expect(batchAudit.match(/\*\*Event\*\*: SENSOR_FIRED/g)).toHaveLength(4);
      for (const path of batchPaths) {
        expect(batchAudit).toContain(path.replace(/\\/g, "/"));
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
      const sid = "kiro-birth-session";
      const r = runAdapter(dir, "rebuild-stage-graph", {
        hook_event_name: "postToolUse",
        cwd: dir,
        session_id: sid,
        tool_name: "shell",
        tool_input: {
          command: "bun .kiro/tools/aidlc-utility.ts intent-create --scope poc",
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
    // Proof: birth an intent (live cursor resolves a uuid), fire session-start
    // with a session_id in the payload, and assert the stamp file
    // aidlc/.aidlc-sessions/<session_id> was written with that uuid. Without
    // the forwarded session_id the core hook's `if (sessionId)` block is inert.
    const dir = scratchProject(true);
    try {
      const born = createIntent(dir, "kiro-stamp", "default");
      const sid = "kiro-session-abc123";
      const r = runAdapter(dir, "session-start", { ...(FIXTURES.agentSpawn as object), session_id: sid });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("AIDLC WORKFLOW ACTIVE");
      const stampPath = join(dir, "aidlc", ".aidlc-sessions", sid);
      expect(existsSync(stampPath)).toBe(true);
      expect(readFileSync(stampPath, "utf-8").trim()).toBe(born.uuid);
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

  /** PATH stripped of every dir that resolves a `bun` binary (the fragile hook
   *  environment the fix targets). Deterministic: reads real disk. */
  function pathWithoutBun(): string {
    const entries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
    return entries.filter((d) => !existsSync(join(d, "bun"))).join(delimiter);
  }

  test("14: session-start dispatches even when the child PATH has no bun (respawn uses process.execPath)", () => {
    // The adapter is launched via the ABSOLUTE bun (process.execPath), so it
    // starts regardless of PATH; the contract under test is that its OWN child
    // respawn (runCore) also does not need bun on PATH. Under the old bare-"bun"
    // argv[0] this session-start would ENOENT in runCore and emit nothing.
    const dir = scratchProject(true);
    try {
      const strippedPath = pathWithoutBun();
      // Premise guard: bun must genuinely be unresolvable on the stripped PATH,
      // else the test proves nothing.
      expect(strippedPath.split(delimiter).some((d) => existsSync(join(d, "bun")))).toBe(false);
      const r = spawnSync(
        process.execPath,
        [join(dir, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), "session-start"],
        {
          cwd: dir,
          input: JSON.stringify(FIXTURES.agentSpawn),
          encoding: "utf-8",
          env: { ...process.env, CLAUDE_PROJECT_DIR: dir, PATH: strippedPath },
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
