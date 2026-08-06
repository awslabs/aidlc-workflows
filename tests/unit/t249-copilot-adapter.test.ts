// t249-copilot-adapter: the Copilot stdin shim normalizes live-captured
// payloads into the core hooks' contract.
//
// covers: file:hooks/aidlc-stop.ts, file:hooks/aidlc-session-start.ts, file:hooks/aidlc-audit-logger.ts, file:hooks/aidlc-log-subagent.ts, file:hooks/aidlc-session-end.ts, file:hooks/aidlc-dispatch-rules.ts
//
// WHAT. Each case pipes a fixture from tests/fixtures/copilot-hook-payloads/
// (field-verbatim captures off Copilot CLI 1.0.74, sanitized for publication) into
// the generated Copilot adapter inside a scratch project carrying an active
// workflow state, then asserts the observable core-hook effect:
//   stop           → block fields at top level for CLI and under
//                    hookSpecificOutput for VS Code; silent with no state.
//   session-start  → additionalContext at top level for CLI and under
//                    hookSpecificOutput for VS Code.
//   pre-tool deny  → a guard block (core exit 2 + stderr) converts to the
//                    {"hookSpecificOutput":{"permissionDecision":"deny"}}
//                    stdout JSON with exit 0 — Copilot's only deny channel.
//   pre-tool remap → Copilot's `path` file-tool key reaches the core hooks
//                    as `file_path` (the shim re-keys).
//   post-tool      → a Write into the record lands ARTIFACT_CREATED in the
//                    audit; a foreign tool_name is a no-op (self-filtering
//                    replaces matchers — VS Code ignores them).
//   log-subagent   → SUBAGENT_COMPLETED in the audit, agent_name (snake) or
//                    agentName (camel — the live SubagentStart quirk) both
//                    resolving to agent_type.
//   session-start  → reconcile a prior session as inferred SESSION_ENDED.
//   malformed stdin → fail-open exit 0 (advisory contract).
//
// WHY SUBPROCESS. The adapter IS a subprocess shim — in-process unit testing
// would bypass the exact stdin/stdout/exit-code surface being contracted.
// (Same idiom as codex's t149.)

import { createHash } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  intentsDirOf,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const COPILOT_TREE = join(REPO_ROOT, "dist", "copilot", ".aidlc");
const FIXTURES = JSON.parse(
  readFileSync(
    join(REPO_ROOT, "tests", "fixtures", "copilot-hook-payloads", "payloads.json"),
    "utf-8",
  ),
) as Record<string, Record<string, unknown>>;

const PINNED_CLONE_ID = "testcloneid249";
const scratchProjects = new Set<string>();

function ledgerPath(projectDir: string): string {
  return join(
    tmpdir(),
    `aidlc-copilot-subagents-${createHash("sha256").update(projectDir).digest("hex").slice(0, 16)}.json`,
  );
}

afterAll(() => {
  for (const projectDir of scratchProjects) {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(ledgerPath(projectDir), { force: true });
    rmSync(`${ledgerPath(projectDir)}.lock`, { recursive: true, force: true });
  }
});

function pinnedShardName(): string {
  const host =
    hostname()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "host";
  return `${host}-${PINNED_CLONE_ID}.md`;
}

function seedShell(dir: string): void {
  const intentsDir = intentsDirOf(dir, DEFAULT_SPACE);
  mkdirSync(join(dir, "aidlc", "spaces", DEFAULT_SPACE, "memory"), { recursive: true });
  mkdirSync(seededRecordDir(dir), { recursive: true });
  writeFileSync(join(dir, "aidlc", "active-space"), `${DEFAULT_SPACE}\n`, "utf-8");
  writeFileSync(join(intentsDir, "active-intent"), `${DEFAULT_RECORD_DIR}\n`, "utf-8");
  writeFileSync(
    join(intentsDir, "intents.json"),
    `${JSON.stringify(
      [
        {
          uuid: "00000000-0000-7000-8000-000000000001",
          slug: DEFAULT_RECORD_DIR.replace(/-[0-9a-f]+$/, ""),
          status: "in-flight",
        },
      ],
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

function scratchProject(withState: boolean): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "t249-")));
  scratchProjects.add(dir);
  cpSync(COPILOT_TREE, join(dir, ".aidlc"), { recursive: true });
  seedShell(dir);
  if (withState) {
    writeFileSync(
      seededStateFile(dir),
      readFileSync(join(REPO_ROOT, "tests", "fixtures", "state-brownfield-feature.md"), "utf-8"),
    );
    writeFileSync(join(dir, "aidlc", ".aidlc-clone-id"), `${PINNED_CLONE_ID}\n`, "utf-8");
    const auditDir = seededAuditDir(dir);
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(join(auditDir, pinnedShardName()), "# AI-DLC Audit Log\n");
  }
  return dir;
}

function readAudit(dir: string): string {
  const auditDir = seededAuditDir(dir);
  let names: string[];
  try {
    names = readdirSync(auditDir);
  } catch {
    return "";
  }
  return names
    .filter((n) => n.endsWith(".md"))
    .sort()
    .map((n) => readFileSync(join(auditDir, n), "utf-8"))
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
      `**Timestamp**: 2026-08-03T18:57:53Z\n` +
      `**Event**: ${event}\n` +
      `**Stage**: ${stage}\n\n---\n`,
    "utf-8",
  );
}

function withCwd(payload: Record<string, unknown>, dir: string): Record<string, unknown> {
  return { ...payload, cwd: dir };
}

function runAdapter(
  projectDir: string,
  target: string,
  payload: unknown,
): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(
    "bun",
    [join(projectDir, ".aidlc", "hooks", "aidlc-copilot-adapter.ts"), target],
    {
      cwd: projectDir,
      input: typeof payload === "string" ? payload : JSON.stringify(payload),
      encoding: "utf-8",
      env: {
        ...process.env,
        AIDLC_PROJECT_DIR: undefined,
        CLAUDE_PROJECT_DIR: undefined,
      } as NodeJS.ProcessEnv,
      timeout: 30_000,
    },
  );
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1 };
}

describe("t249 Copilot hook adapter (live-captured payload fixtures)", () => {
  test("1: stop with active workflow blocks in both CLI and VS Code output shapes", () => {
    const dir = scratchProject(true);
    const r = runAdapter(dir, "stop", withCwd(FIXTURES.stop, dir));
    const parsed = JSON.parse(r.stdout) as {
      decision?: string;
      reason?: string;
      hookSpecificOutput?: { hookEventName?: string; decision?: string; reason?: string };
    };
    expect(parsed.decision).toBe("block");
    expect(parsed.reason?.length ?? 0).toBeGreaterThan(0);
    expect(parsed.hookSpecificOutput?.hookEventName).toBe("Stop");
    expect(parsed.hookSpecificOutput?.decision).toBe("block");
    expect(parsed.hookSpecificOutput?.reason).toBe(parsed.reason);
  });

  test("2: stop without workflow state is a silent allow", () => {
    const dir = scratchProject(false);
    const r = runAdapter(dir, "stop", withCwd(FIXTURES.stop, dir));
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  test("2a: stop stays silent while a numbered non-gate question awaits the human", () => {
    const dir = scratchProject(true);
    appendInteractionEvent(dir, "STAGE_STARTED", "requirements-analysis");
    appendInteractionEvent(dir, "DECISION_RECORDED", "requirements-analysis");

    const waiting = runAdapter(dir, "stop", withCwd(FIXTURES.stop, dir));
    expect(waiting.code).toBe(0);
    expect(waiting.stdout.trim()).toBe("");

    appendInteractionEvent(dir, "QUESTION_ANSWERED", "requirements-analysis");
    const resolved = runAdapter(dir, "stop", withCwd(FIXTURES.stop, dir));
    expect(resolved.code).toBe(0);
    expect(
      (JSON.parse(resolved.stdout) as { decision?: string }).decision,
    ).toBe("block");
  });

  test("3: session-start context emits both CLI and VS Code output shapes", () => {
    const dir = scratchProject(true);
    const r = runAdapter(dir, "session-start", withCwd(FIXTURES.sessionStart, dir));
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      additionalContext?: unknown;
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: unknown };
    };
    expect(typeof parsed.additionalContext).toBe("string");
    expect(parsed.hookSpecificOutput?.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput?.additionalContext).toBe(parsed.additionalContext);
  });

  test("4: pre-tool guard block converts to the permissionDecision deny JSON", () => {
    const dir = scratchProject(true);
    // A direct lifecycle call on aidlc-state.ts is exactly what the
    // state-transition guard refuses (exit 2 + reason on stderr in core).
    const payload = withCwd(
      {
        ...FIXTURES.preToolUse_bash,
        tool_input: { command: "bun .aidlc/tools/aidlc-state.ts approve" },
      },
      dir,
    );
    const r = runAdapter(dir, "pre-tool", payload);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    expect(parsed.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput?.permissionDecisionReason?.length ?? 0).toBeGreaterThan(0);
  });

  test("5: pre-tool allows an ordinary command silently", () => {
    const dir = scratchProject(true);
    const r = runAdapter(dir, "pre-tool", withCwd(FIXTURES.preToolUse_bash, dir));
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  test("5a: custom-agent dispatch carries the exact active-stage rules once", () => {
    const dir = scratchProject(true);
    cpSync(join(REPO_ROOT, "dist", "copilot", "aidlc"), join(dir, "aidlc"), {
      recursive: true,
    });
    const originalInput = {
      agent: "aidlc-product-agent",
      prompt:
        "Run .aidlc/aidlc-common/stages/inception/user-stories.md and write the contribution.",
    };
    const first = runAdapter(dir, "pre-tool", {
      hook_event_name: "PreToolUse",
      cwd: dir,
      tool_name: "agent",
      tool_input: originalInput,
    });
    expect(first.code, first.stderr).toBe(0);
    const output = JSON.parse(first.stdout) as {
      hookSpecificOutput?: {
        hookEventName?: string;
        updatedInput?: Record<string, unknown>;
      };
    };
    expect(output.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
    const updated = output.hookSpecificOutput?.updatedInput ?? {};
    const prompt = String(updated.prompt ?? "");
    expect(prompt).toContain("AIDLC_DISPATCH_RULES_BEGIN");
    expect(prompt).toContain("first-class");
    expect(prompt).toContain("Given/When/Then");
    expect(prompt.match(/AIDLC_DISPATCH_RULES_BEGIN/g)?.length).toBe(1);
    expect(updated.agent).toBe("aidlc-product-agent");

    const camel = runAdapter(dir, "pre-tool", {
      hook_event_name: "PreToolUse",
      cwd: dir,
      toolName: "Agent",
      toolInput: {
        agent_type: "aidlc-product-agent",
        prompt: originalInput.prompt,
      },
    });
    expect(camel.code, camel.stderr).toBe(0);
    const camelUpdated = (
      JSON.parse(camel.stdout) as {
        hookSpecificOutput?: { updatedInput?: Record<string, unknown> };
      }
    ).hookSpecificOutput?.updatedInput ?? {};
    expect(camelUpdated.agent_type).toBe("aidlc-product-agent");
    expect(String(camelUpdated.prompt ?? "")).toContain(
      "AIDLC_DISPATCH_RULES_BEGIN",
    );

    const idempotent = runAdapter(dir, "pre-tool", {
      hook_event_name: "PreToolUse",
      cwd: dir,
      toolName: "Agent",
      toolInput: camelUpdated,
    });
    expect(idempotent.code, idempotent.stderr).toBe(0);
    expect(idempotent.stdout).toBe("");
  });

  test("5b: unloadable dispatch rules convert core exit 2 to Copilot deny", () => {
    const dir = scratchProject(true);
    cpSync(join(REPO_ROOT, "dist", "copilot", "aidlc"), join(dir, "aidlc"), {
      recursive: true,
    });
    rmSync(join(dir, "aidlc", "spaces", "default", "memory", "org.md"));
    const result = runAdapter(dir, "pre-tool", {
      hook_event_name: "PreToolUse",
      cwd: dir,
      tool_name: "agent",
      tool_input: {
        agent: "aidlc-product-agent",
        prompt:
          "Run .aidlc/aidlc-common/stages/inception/user-stories.md and write the contribution.",
      },
    });
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as {
      hookSpecificOutput?: {
        permissionDecision?: string;
        permissionDecisionReason?: string;
      };
    };
    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput?.permissionDecisionReason).toContain(
      "Cannot load required stage rule",
    );
  });

  test("6: post-tool Write into the record lands ARTIFACT_CREATED (path re-keyed)", () => {
    const dir = scratchProject(true);
    const artifact = join(seededRecordDir(dir), "ideation", "intent-capture", "intent.md");
    mkdirSync(dirname(artifact), { recursive: true });
    writeFileSync(artifact, "# Intent\n", "utf-8");
    // The live capture's tool_input carries Copilot's `path` key — the shim
    // must re-key it to file_path for the core audit-logger.
    const payload = withCwd(
      { ...FIXTURES.preToolUse_write, tool_input: { path: artifact, file_text: "# Intent\n" } },
      dir,
    );
    const r = runAdapter(dir, "post-tool", payload);
    expect(r.code).toBe(0);
    expect(readAudit(dir)).toContain("ARTIFACT_CREATED");
  });

  test("7: post-tool with a foreign tool_name is a no-op (self-filtering, no matchers)", () => {
    const dir = scratchProject(true);
    const before = readAudit(dir);
    const payload = withCwd({ ...FIXTURES.preToolUse_write, tool_name: "Agent" }, dir);
    const r = runAdapter(dir, "post-tool", payload);
    expect(r.code).toBe(0);
    expect(readAudit(dir)).toBe(before);
  });

  test("8: log-subagent lands SUBAGENT_COMPLETED from the snake_case capture", () => {
    const dir = scratchProject(true);
    const r = runAdapter(dir, "log-subagent", withCwd(FIXTURES.subagentStop, dir));
    expect(r.code).toBe(0);
    const audit = readAudit(dir);
    expect(audit).toContain("SUBAGENT_COMPLETED");
    expect(audit).toContain(String(FIXTURES.subagentStop.agent_name));
  });

  test("9: subagent-start accepts the camelCase live capture (the CLI quirk)", () => {
    const dir = scratchProject(true);
    // subagentStart is delivered camelCase (agentName/sessionId) on the CLI
    // while every other PascalCase-registered event is snake_case.
    const r = runAdapter(dir, "subagent-start", withCwd(FIXTURES.subagentStart, dir));
    expect(r.code).toBe(0);
  });

  test("11: malformed stdin fails open (advisory contract)", () => {
    const dir = scratchProject(true);
    const r = runAdapter(dir, "post-tool", "{not json");
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  test("13: reviewer-scope forwarding blocks a sibling read via the ledger identity", () => {
    const dir = scratchProject(true);
    const cliHostSessionId = String(FIXTURES.subagentStart.sessionId);
    // 12a step-1 dispatch record: the architecture reviewer is scoped to U01.
    const record = seededRecordDir(dir);
    mkdirSync(record, { recursive: true });
    writeFileSync(
      join(record, ".aidlc-reviewer-dispatch.json"),
      JSON.stringify({
        reviewer: "aidlc-architecture-reviewer-agent",
        stage: "functional-design",
        unit: "U01",
        exempt: [],
      }),
      "utf-8",
    );
    // SubagentStart brackets the delegation (camelCase, the live CLI quirk).
    runAdapter(dir, "subagent-start", {
      ...FIXTURES.subagentStart,
      cwd: dir,
      sessionId: cliHostSessionId,
      agentName: "aidlc-architecture-reviewer-agent",
    });
    // A sibling-unit read from inside the delegation: subagent-originated
    // calls carry a toolu_* id as session_id (live-verified in the compat
    // spike, T6b/T12). The ledger must resolve the identity and the core
    // reviewer-scope hook must convert the block to the deny JSON.
    const sibling = join(record, "construction", "U02", "functional-design", "design.md");
    const r = runAdapter(dir, "pre-tool", {
      hook_event_name: "PreToolUse",
      session_id: "toolu_test0000000000000001",
      cwd: dir,
      toolName: "readFile",
      toolInput: { filePath: sibling },
    });
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      hookSpecificOutput?: { permissionDecision?: string };
    };
    expect(parsed.hookSpecificOutput?.permissionDecision).toBe("deny");

    // SubagentStop pops the ledger; the same call afterwards is ambiguous
    // (no active entry) and fails open — the documented identity contract.
    runAdapter(dir, "log-subagent", {
      ...FIXTURES.subagentStop,
      cwd: dir,
      session_id: cliHostSessionId,
      agent_name: "aidlc-architecture-reviewer-agent",
    });
    const after = runAdapter(dir, "pre-tool", {
      hook_event_name: "PreToolUse",
      session_id: "toolu_test0000000000000002",
      cwd: dir,
      tool_name: "Read",
      tool_input: { path: sibling },
    });
    expect(after.code).toBe(0);
    expect(after.stdout.trim()).toBe("");
  });

  test("14: documented VS Code tool names normalize to the core contract", () => {
    const dir = scratchProject(true);
    // VS Code's documented shell tool name with a blocked lifecycle command:
    // the alias table must canonicalize runTerminalCommand -> Bash.
    const r = runAdapter(dir, "pre-tool", {
      hook_event_name: "PreToolUse",
      session_id: "11111111-2222-4333-8444-555555555555",
      cwd: dir,
      toolName: "runTerminalCommand",
      toolInput: { command: "bun .aidlc/tools/aidlc-state.ts approve" },
    });
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      hookSpecificOutput?: { permissionDecision?: string };
    };
    expect(parsed.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("17: createFile/filePath and editFiles/files reach audit and sensors", () => {
    const dir = scratchProject(true);
    const first = join(seededRecordDir(dir), "construction", "U01", "code", "first.ts");
    const second = join(seededRecordDir(dir), "construction", "U01", "code", "second.ts");
    mkdirSync(dirname(first), { recursive: true });
    writeFileSync(first, "export const first = true;\n", "utf-8");
    writeFileSync(second, "export const second = true;\n", "utf-8");

    const create = runAdapter(dir, "post-tool", {
      hook_event_name: "PostToolUse",
      cwd: dir,
      toolName: "createFile",
      toolInput: { filePath: first },
    });
    const edit = runAdapter(dir, "post-tool", {
      hook_event_name: "PostToolUse",
      cwd: dir,
      toolName: "editFiles",
      toolInput: { files: [{ filePath: first }, { filePath: second }] },
    });

    expect(create.code).toBe(0);
    expect(edit.code).toBe(0);
    const audit = readAudit(dir);
    expect(audit).toContain("ARTIFACT_CREATED");
    expect(audit).toContain("first.ts");
    expect(audit).toContain("second.ts");
  });

  test("18: VS Code agent_type/agent_id populate and clear reviewer identity", () => {
    const dir = scratchProject(true);
    const hostSessionId = "11111111-2222-4333-8444-555555555555";
    const record = seededRecordDir(dir);
    mkdirSync(record, { recursive: true });
    writeFileSync(
      join(record, ".aidlc-reviewer-dispatch.json"),
      JSON.stringify({
        reviewer: "aidlc-architecture-reviewer-agent",
        stage: "functional-design",
        unit: "U01",
        exempt: [],
      }),
      "utf-8",
    );
    const identity = {
      session_id: hostSessionId,
      agent_type: "aidlc-architecture-reviewer-agent",
      agent_id: "vscode-agent-1",
    };
    runAdapter(dir, "subagent-start", {
      hook_event_name: "SubagentStart",
      cwd: dir,
      ...identity,
    });

    const sibling = join(record, "construction", "U02", "functional-design", "design.md");
    const blocked = runAdapter(dir, "pre-tool", {
      hook_event_name: "PreToolUse",
      session_id: hostSessionId,
      cwd: dir,
      toolName: "readFile",
      toolInput: { filePath: sibling },
    });
    expect(
      (JSON.parse(blocked.stdout) as {
        hookSpecificOutput?: { permissionDecision?: string };
      }).hookSpecificOutput?.permissionDecision,
    ).toBe("deny");

    runAdapter(dir, "log-subagent", {
      hook_event_name: "SubagentStop",
      cwd: dir,
      ...identity,
    });
    expect(readAudit(dir)).toContain("aidlc-architecture-reviewer-agent");

    const allowed = runAdapter(dir, "pre-tool", {
      hook_event_name: "PreToolUse",
      session_id: hostSessionId,
      cwd: dir,
      toolName: "readFile",
      toolInput: { filePath: sibling },
    });
    expect(allowed.stdout.trim()).toBe("");
  });

  test("18a: apply_patch cannot mutate a sibling unit through its input envelope", () => {
    const dir = scratchProject(true);
    const hostSessionId = "11111111-2222-4333-8444-555555555556";
    const record = seededRecordDir(dir);
    mkdirSync(record, { recursive: true });
    writeFileSync(
      join(record, ".aidlc-reviewer-dispatch.json"),
      JSON.stringify({
        reviewer: "aidlc-architecture-reviewer-agent",
        stage: "functional-design",
        unit: "U01",
        exempt: [],
      }),
      "utf-8",
    );
    runAdapter(dir, "subagent-start", {
      hook_event_name: "SubagentStart",
      cwd: dir,
      session_id: hostSessionId,
      agent_type: "aidlc-architecture-reviewer-agent",
      agent_id: "vscode-agent-patch",
    });

    const sibling = join(record, "construction", "U02", "code", "sibling.ts");
    const result = runAdapter(dir, "pre-tool", {
      hook_event_name: "PreToolUse",
      session_id: hostSessionId,
      cwd: dir,
      tool_name: "apply_patch",
      tool_input: {
        input: `*** Begin Patch\n*** Update File: ${sibling}\n@@\n*** End Patch\n`,
      },
    });
    expect(
      (JSON.parse(result.stdout) as {
        hookSpecificOutput?: { permissionDecision?: string };
      }).hookSpecificOutput?.permissionDecision,
    ).toBe("deny");
  });

  test("18b: file_search query maps to scoped Glob.pattern enforcement", () => {
    const dir = scratchProject(true);
    const hostSessionId = "11111111-2222-4333-8444-555555555557";
    const record = seededRecordDir(dir);
    mkdirSync(record, { recursive: true });
    writeFileSync(
      join(record, ".aidlc-reviewer-dispatch.json"),
      JSON.stringify({
        reviewer: "aidlc-architecture-reviewer-agent",
        stage: "functional-design",
        unit: "U01",
        exempt: [],
      }),
      "utf-8",
    );
    runAdapter(dir, "subagent-start", {
      hook_event_name: "SubagentStart",
      cwd: dir,
      session_id: hostSessionId,
      agent_type: "aidlc-architecture-reviewer-agent",
      agent_id: "vscode-agent-search",
    });

    const search = (query: string) =>
      runAdapter(dir, "pre-tool", {
        hook_event_name: "PreToolUse",
        session_id: hostSessionId,
        cwd: dir,
        tool_name: "file_search",
        tool_input: { query },
      });
    const currentUnit = search(join(record, "construction", "U01", "**", "*.ts"));
    expect(currentUnit.stdout.trim()).toBe("");

    for (const query of [
      join(record, "construction", "U02", "**", "*.ts"),
      join(record, "construction", "*", "**", "*.ts"),
      "**/*",
    ]) {
      const blocked = search(query);
      expect(
        (JSON.parse(blocked.stdout) as {
          hookSpecificOutput?: { permissionDecision?: string };
        }).hookSpecificOutput?.permissionDecision,
        query,
      ).toBe("deny");
    }
  });

  test("19: correlated support agents cannot conduct workflow lifecycle", () => {
    const dir = scratchProject(true);
    const identity = {
      session_id: "22222222-3333-4444-8555-666666666666",
      agent_type: "aidlc-design-agent",
      agent_id: "vscode-support-1",
    };
    runAdapter(dir, "subagent-start", {
      hook_event_name: "SubagentStart",
      cwd: dir,
      ...identity,
    });

    for (const command of [
      "bun .aidlc/tools/aidlc-orchestrate.ts next --resume",
      "bun .aidlc/tools/aidlc-state.ts unpark",
      'bash -lc "bun .aidlc/tools/aidlc-orchestrate.ts next --resume"',
      'sh -c "bun .aidlc/tools/aidlc-state.ts unpark"',
      "bun .aidlc/tools/aidlc.ts --resume",
      "bun .aidlc/tools/aidlc.ts intent other-intent",
      "bun .aidlc/tools/aidlc.ts space other-space",
      "bun .aidlc/tools/aidlc-utility.ts intent other-intent",
      "bun .aidlc/tools/aidlc-utility.ts space other-space",
    ]) {
      const blocked = runAdapter(dir, "pre-tool", {
        hook_event_name: "PreToolUse",
        session_id: identity.session_id,
        cwd: dir,
        toolName: "runTerminalCommand",
        toolInput: { command },
      });
      expect(
        (JSON.parse(blocked.stdout) as {
          hookSpecificOutput?: {
            permissionDecision?: string;
            permissionDecisionReason?: string;
          };
        }).hookSpecificOutput?.permissionDecision,
        command,
      ).toBe("deny");
      expect(blocked.stdout, command).toContain("conductor-owned");
    }

    for (const command of [
      "bun .aidlc/tools/aidlc.ts intent list",
      "bun .aidlc/tools/aidlc.ts space list",
      "bun .aidlc/tools/aidlc-utility.ts intent list",
      "bun .aidlc/tools/aidlc-utility.ts space list",
    ]) {
      const allowed = runAdapter(dir, "pre-tool", {
        hook_event_name: "PreToolUse",
        session_id: identity.session_id,
        cwd: dir,
        toolName: "runTerminalCommand",
        toolInput: { command },
      });
      expect(allowed.stdout.trim(), command).toBe("");
    }

    runAdapter(dir, "log-subagent", {
      hook_event_name: "SubagentStop",
      cwd: dir,
      ...identity,
    });
    const conductor = runAdapter(dir, "pre-tool", {
      hook_event_name: "PreToolUse",
      session_id: identity.session_id,
      cwd: dir,
      toolName: "runTerminalCommand",
      toolInput: {
        command: "bun .aidlc/tools/aidlc-orchestrate.ts next --resume",
      },
    });
    expect(conductor.stdout.trim()).toBe("");
  });

  test("20: parallel Copilot workers remain lifecycle-blocked when exact attribution is ambiguous", () => {
    const dir = scratchProject(true);
    const hostSession = "33333333-4444-4555-8666-777777777777";
    for (const [agent_type, agent_id] of [
      ["aidlc-design-agent", "vscode-support-1"],
      ["aidlc-quality-agent", "vscode-support-2"],
    ]) {
      runAdapter(dir, "subagent-start", {
        hook_event_name: "SubagentStart",
        cwd: dir,
        session_id: hostSession,
        agent_type,
        agent_id,
      });
    }

    const blocked = runAdapter(dir, "pre-tool", {
      hook_event_name: "PreToolUse",
      session_id: hostSession,
      cwd: dir,
      toolName: "runTerminalCommand",
      toolInput: { command: "aidlc report --result approved" },
    });
    expect(
      (JSON.parse(blocked.stdout) as {
        hookSpecificOutput?: { permissionDecision?: string };
      }).hookSpecificOutput?.permissionDecision,
    ).toBe("deny");
    expect(blocked.stdout).toContain("aidlc-delegated-agent");
  });

  test("15: fresh-session source 'new' maps to startup (SESSION_STARTED lands)", () => {
    const dir = scratchProject(true);
    const r = runAdapter(dir, "session-start", withCwd(FIXTURES.sessionStart, dir));
    expect(r.code).toBe(0);
    // The live capture carries source: "new"; unmapped it emits NOTHING
    // (review P1-2). The mapped forward must land the audit row.
    expect(String(FIXTURES.sessionStart.source)).toBe("new");
    expect(readAudit(dir)).toContain("SESSION_STARTED");
  });

  test("16: session reconcile emits inferred SESSION_ENDED on the current layout", () => {
    const dir = scratchProject(true);
    // Session A starts (writes the heartbeat), session B starts with a
    // different id: the reconcile must emit the inferred SESSION_ENDED —
    // on the aidlc/ workspace layout, NOT the extinct aidlc-docs/ root
    // (review P1-3).
    runAdapter(dir, "session-start", {
      ...FIXTURES.sessionStart,
      cwd: dir,
      session_id: "aaaaaaaa-0000-4000-8000-000000000001",
    });
    const before = readAudit(dir);
    expect(before).not.toContain("SESSION_ENDED");
    runAdapter(dir, "session-start", {
      ...FIXTURES.sessionStart,
      cwd: dir,
      session_id: "bbbbbbbb-0000-4000-8000-000000000002",
    });
    expect(readAudit(dir)).toContain("SESSION_ENDED");
  });

  test("12: mint records HUMAN_TURN only when workflow state exists", () => {
    const withStateDir = scratchProject(true);
    runAdapter(withStateDir, "mint", withCwd(FIXTURES.userPromptSubmit, withStateDir));
    expect(readAudit(withStateDir)).toContain("HUMAN_TURN");

    const noStateDir = scratchProject(false);
    const r = runAdapter(noStateDir, "mint", withCwd(FIXTURES.userPromptSubmit, noStateDir));
    expect(r.code).toBe(0);
    expect(readAudit(noStateDir)).toBe("");
  });
});
