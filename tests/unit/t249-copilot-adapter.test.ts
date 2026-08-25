// t249-copilot-adapter: the Copilot stdin shim normalizes live-captured
// payloads into the core hooks' contract.
//
// covers: file:hooks/aidlc-continue-workflow.ts, file:hooks/aidlc-session-start.ts, file:hooks/aidlc-write-audit-log.ts, file:hooks/aidlc-log-subagent.ts, file:hooks/aidlc-session-end.ts, file:hooks/aidlc-deliver-stage-rules.ts, file:hooks/aidlc-plan-approval-guard.ts, file:hooks/aidlc-review-freeze.ts, function:invalidateActiveDirectiveContext, function:recordCopilotHumanSequence, function:claimCopilotCommand, function:settleCopilotCommand, function:copilotStopEvidence, function:consumeCopilotConversation, function:settleCopilotIntentBoundary, function:updateCopilotStopCount
//
// WHAT. Each case pipes a fixture from tests/fixtures/copilot-hook-payloads/
// (field-verbatim captures off Copilot CLI 1.0.74, sanitized for publication) into
// the generated Copilot adapter inside a scratch project carrying an active
// workflow state, then asserts the observable core-hook effect:
//   continue-workflow → block fields at top level for CLI and under
//                    hookSpecificOutput for VS Code; silent with no state.
//   session-start  → additionalContext at top level for CLI and under
//                    hookSpecificOutput for VS Code.
//   guard-tool-call deny → a guard block (core exit 2 + stderr) converts to the
//                    {"hookSpecificOutput":{"permissionDecision":"deny"}}
//                    stdout JSON with exit 0 — Copilot's only deny channel.
//   guard-tool-call remap → Copilot's `path` file-tool key reaches the core hooks
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
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
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
}, 30000);

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

function overlayAuthoredCopilotSources(dir: string): void {
  for (const [source, target] of [
    [join(REPO_ROOT, "core", "tools", "aidlc-lib.ts"), join(dir, ".aidlc", "tools", "aidlc-lib.ts")],
    [join(REPO_ROOT, "core", "tools", "aidlc-orchestrate.ts"), join(dir, ".aidlc", "tools", "aidlc-orchestrate.ts")],
    [join(REPO_ROOT, "core", "tools", "aidlc-utility.ts"), join(dir, ".aidlc", "tools", "aidlc-utility.ts")],
    [join(REPO_ROOT, "core", "hooks", "aidlc-continue-workflow.ts"), join(dir, ".aidlc", "hooks", "aidlc-continue-workflow.ts")],
    [join(REPO_ROOT, "core", "hooks", "aidlc-validate-state.ts"), join(dir, ".aidlc", "hooks", "aidlc-validate-state.ts")],
    [join(REPO_ROOT, "harness", "copilot", "hooks", "aidlc-copilot-adapter.ts"), join(dir, ".aidlc", "hooks", "aidlc-copilot-adapter.ts")],
  ]) cpSync(source, target);
}

function scratchProject(withState: boolean): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "t249-")));
  scratchProjects.add(dir);
  cpSync(COPILOT_TREE, join(dir, ".aidlc"), { recursive: true });
  overlayAuthoredCopilotSources(dir);
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

function orchestrationProject(): string {
  const dir = scratchProject(true);
  cpSync(join(REPO_ROOT, "dist", "copilot", "aidlc"), join(dir, "aidlc"), { recursive: true });
  return dir;
}

function compiledBinary(): string | null {
  const explicit = process.env.AIDLC_TEST_COMPILED_EXECUTABLE;
  if (explicit && existsSync(explicit)) return realpathSync(explicit);
  const results = join(REPO_ROOT, "build", "binaries", "build-results.json");
  if (!existsSync(results)) return null;
  const doc = JSON.parse(readFileSync(results, "utf-8")) as { results?: Array<{ name?: string; artifact?: string }> };
  const artifact = doc.results?.find((entry) => entry.name === "native")?.artifact;
  return artifact && existsSync(artifact) ? realpathSync(artifact) : null;
}
const COMPILED_BINARY = compiledBinary();

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
        AIDLC_COMPILED_EXECUTABLE: COMPILED_BINARY ?? undefined,
      } as NodeJS.ProcessEnv,
      timeout: 30_000,
    },
  );
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1 };
}

async function runAdapterAsync(projectDir: string, target: string, payload: unknown) {
  const proc = Bun.spawn([process.execPath, join(projectDir, ".aidlc", "hooks", "aidlc-copilot-adapter.ts"), target], {
    cwd: projectDir,
    stdin: Buffer.from(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, AIDLC_PROJECT_DIR: undefined, CLAUDE_PROJECT_DIR: undefined },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { stdout, stderr, code };
}

type CommandForm = "direct" | "source" | "compiled";
function commandSpec(dir: string, form: CommandForm, args: string[]) {
  if (form === "direct") return {
    text: `bun .aidlc/tools/aidlc-orchestrate.ts ${args.map((arg) => JSON.stringify(arg)).join(" ")}`,
    executable: process.execPath,
    argv: [join(dir, ".aidlc", "tools", "aidlc-orchestrate.ts"), ...args],
  };
  if (form === "source") return {
    text: `bun .aidlc/tools/aidlc.ts ${args.map((arg) => JSON.stringify(arg)).join(" ")}`,
    executable: process.execPath,
    argv: [join(dir, ".aidlc", "tools", "aidlc.ts"), ...args],
  };
  if (!COMPILED_BINARY) throw new Error("compiled coverage requires: bun scripts/build-binaries.ts");
  return {
    text: `${JSON.stringify(COMPILED_BINARY)} ${args.map((arg) => JSON.stringify(arg)).join(" ")}`,
    executable: COMPILED_BINARY,
    argv: args,
  };
}

function commandPayload(dir: string, session: string, command: string, attempt?: string, post = false, output?: string) {
  return {
    hook_event_name: post ? "PostToolUse" : "PreToolUse",
    session_id: session,
    ...(attempt ? { tool_use_id: attempt } : {}),
    cwd: dir,
    tool_name: "Bash",
    tool_input: { command },
    ...(post ? {
      tool_result: output === undefined
        ? { result_type: "failure", text_result_for_llm: "missing" }
        : { result_type: "success", text_result_for_llm: `${output.trim()}\n<shellId: test completed with exit code 0>` },
    } : {}),
  };
}

function rewrittenCommand(pre: { stdout: string }): string {
  return (JSON.parse(pre.stdout) as { modifiedArgs?: { command?: string } }).modifiedArgs?.command ?? "";
}

function runLifecycle(dir: string, session: string, form: CommandForm, args: string[], attempt: string) {
  const spec = commandSpec(dir, form, args);
  const pre = runAdapter(dir, "guard-tool-call", commandPayload(dir, session, spec.text, attempt));
  const rewritten = rewrittenCommand(pre);
  expect(rewritten, `${form}: ${spec.text}`).toContain(`--aidlc-attempt-id ${attempt}`);
  const executed = spawnSync("/bin/sh", ["-c", rewritten], { cwd: dir, encoding: "utf-8", timeout: 30_000 });
  expect(executed.status, executed.stderr).toBe(0);
  const post = runAdapter(dir, "post-tool", commandPayload(dir, session, rewritten, attempt, true, executed.stdout));
  return { directive: JSON.parse(executed.stdout.trim()) as Record<string, unknown>, post, spec };
}

function noIdClaim(dir: string, session: string, spec: ReturnType<typeof commandSpec>, dialect: "cli" | "vscode" = "cli") {
  const pre = runAdapter(dir, "guard-tool-call", commandPayload(dir, session, spec.text));
  const output = JSON.parse(pre.stdout) as {
    modifiedArgs?: { command?: string };
    hookSpecificOutput?: { updatedInput?: { command?: string } };
  };
  const cli = output.modifiedArgs?.command ?? "";
  const vscode = output.hookSpecificOutput?.updatedInput?.command ?? "";
  expect(cli).toBe(vscode);
  const updated = dialect === "cli" ? cli : vscode;
  const attemptId = updated.match(/--aidlc-attempt-id\s+([0-9a-f-]{36})/)?.[1] ?? "";
  expect(attemptId).not.toBe("");
  return { updated, attemptId, cli, vscode };
}

function executeNoId(
  dir: string,
  session: string,
  _spec: ReturnType<typeof commandSpec>,
  claim: ReturnType<typeof noIdClaim>,
) {
  const executed = spawnSync("/bin/sh", ["-c", claim.updated], {
    cwd: dir, encoding: "utf-8", timeout: 30_000,
  });
  expect(executed.status, executed.stderr).toBe(0);
  runAdapter(dir, "post-tool", commandPayload(dir, session, claim.updated, undefined, true, executed.stdout));
  return executed;
}

function marker(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(seededRecordDir(dir), ".aidlc-active-directive.json"), "utf-8"));
}

function rewriteMarker(dir: string, update: (value: Record<string, unknown>) => void): void {
  const path = join(seededRecordDir(dir), ".aidlc-active-directive.json");
  const value = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  update(value);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function driveToRunStage(dir: string, session: string) {
  const forms: CommandForm[] = ["direct", "source"];
  const tokens: string[] = [];
  let result = runLifecycle(dir, session, forms[0] ?? "direct", ["next"], `${session}-next`);
  for (let part = 0; result.directive.kind === "load-steering"; part++) {
    const token = String(result.directive.continue_token);
    tokens.push(token);
    expect(marker(dir).continue_token_sha256).toBe(createHash("sha256").update(token).digest("hex"));
    result = runLifecycle(dir, session, forms[(part + 1) % forms.length] ?? "direct", ["continue", token], `${session}-continue-${part}`);
    if (part > 20) throw new Error("steering did not converge");
  }
  expect(result.directive.kind).toBe("run-stage");
  return { ...result, tokens };
}

describe("t249 Copilot hook adapter (live-captured payload fixtures)", () => {
  test("1: stop with active workflow blocks in both CLI and VS Code output shapes", () => {
    const dir = scratchProject(true);
    const r = runAdapter(dir, "continue-workflow", withCwd(FIXTURES.stop, dir));
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
    const r = runAdapter(dir, "continue-workflow", withCwd(FIXTURES.stop, dir));
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  test("2a: stop stays silent while a numbered non-gate question awaits the human", () => {
    const dir = scratchProject(true);
    appendInteractionEvent(dir, "STAGE_STARTED", "requirements-analysis");
    appendInteractionEvent(dir, "DECISION_RECORDED", "requirements-analysis");

    const waiting = runAdapter(dir, "continue-workflow", withCwd(FIXTURES.stop, dir));
    expect(waiting.code).toBe(0);
    expect(waiting.stdout.trim()).toBe("");

    appendInteractionEvent(dir, "QUESTION_ANSWERED", "requirements-analysis");
    const resolved = runAdapter(dir, "continue-workflow", withCwd(FIXTURES.stop, dir));
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

  test("4: guard-tool-call block converts to the permissionDecision deny JSON", () => {
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
    const r = runAdapter(dir, "guard-tool-call", payload);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    expect(parsed.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput?.permissionDecisionReason?.length ?? 0).toBeGreaterThan(0);
  });

  test("5: guard-tool-call allows an ordinary command silently", () => {
    const dir = scratchProject(true);
    const r = runAdapter(dir, "guard-tool-call", withCwd(FIXTURES.preToolUse_bash, dir));
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
    const first = runAdapter(dir, "guard-tool-call", {
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

    const camel = runAdapter(dir, "guard-tool-call", {
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

    const idempotent = runAdapter(dir, "guard-tool-call", {
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
    const result = runAdapter(dir, "guard-tool-call", {
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
    // must re-key it to file_path for the core write-audit-log hook.
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
    const r = runAdapter(dir, "guard-tool-call", {
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
    const after = runAdapter(dir, "guard-tool-call", {
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
    const r = runAdapter(dir, "guard-tool-call", {
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

  test("17a: apply_patch Add File is audited as an artifact creation", () => {
    const dir = scratchProject(true);
    const added = join(
      seededRecordDir(dir),
      "construction",
      "U01",
      "code",
      "added.ts",
    );
    mkdirSync(dirname(added), { recursive: true });
    writeFileSync(added, "export const added = true;\n", "utf-8");

    const result = runAdapter(dir, "post-tool", {
      hook_event_name: "PostToolUse",
      cwd: dir,
      tool_name: "apply_patch",
      tool_input: {
        input:
          `*** Begin Patch\n*** Add File: ${added}\n` +
          "+export const added = true;\n*** End Patch\n",
      },
    });

    expect(result.code).toBe(0);
    const audit = readAudit(dir);
    expect(audit).toContain("ARTIFACT_CREATED");
    expect(audit).toContain("added.ts");
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
    const blocked = runAdapter(dir, "guard-tool-call", {
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

    const allowed = runAdapter(dir, "guard-tool-call", {
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
    const result = runAdapter(dir, "guard-tool-call", {
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
      runAdapter(dir, "guard-tool-call", {
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
      'zsh -o NO_RCS -c "bun .aidlc/tools/aidlc-state.ts unpark"',
      'dash -c "bun .aidlc/tools/aidlc-orchestrate.ts continue steering-token"',
      "echo \"$(bun .aidlc/tools/aidlc-state.ts unpark)\"",
      ">/tmp/aidlc-output aidlc next --resume",
      "if aidlc next --resume; then :; fi",
      "bun .aidlc/tools/aidlc.ts --resume",
      "bun .aidlc/tools/aidlc.ts --project-dir /tmp next --resume",
      "bun .aidlc/tools/aidlc.ts intent other-intent",
      "bun .aidlc/tools/aidlc.ts space other-space",
      "bun .aidlc/tools/aidlc-utility.ts intent other-intent",
      "bun .aidlc/tools/aidlc-utility.ts space other-space",
      "bun .aidlc/tools/aidlc-utility.ts space-create other-space",
    ]) {
      const blocked = runAdapter(dir, "guard-tool-call", {
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
      expect(blocked.stdout, command).toContain(
        command.includes("--project-dir /tmp") ? "different physical project" : "conductor-owned",
      );
    }

    for (const command of [
      "bun .aidlc/tools/aidlc.ts intent list",
      "bun .aidlc/tools/aidlc.ts space list",
      "bun .aidlc/tools/aidlc-utility.ts intent list",
      "bun .aidlc/tools/aidlc-utility.ts space list",
      "bun .aidlc/tools/aidlc-utility.ts --project-dir /tmp space list",
    ]) {
      const allowed = runAdapter(dir, "guard-tool-call", {
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
    const conductor = runAdapter(dir, "guard-tool-call", {
      hook_event_name: "PreToolUse",
      session_id: identity.session_id,
      cwd: dir,
      toolName: "runTerminalCommand",
      toolInput: {
        command: "bun .aidlc/tools/aidlc-orchestrate.ts next --resume",
      },
    });
    const conductorOutput = JSON.parse(conductor.stdout) as {
      modifiedArgs?: { command?: string };
      hookSpecificOutput?: { updatedInput?: { command?: string } };
    };
    expect(conductorOutput.modifiedArgs?.command).toBe(
      conductorOutput.hookSpecificOutput?.updatedInput?.command,
    );
    expect(conductorOutput.modifiedArgs?.command).toContain("--aidlc-attempt-id");
  }, 30000);

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

    const blocked = runAdapter(dir, "guard-tool-call", {
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

  test("12: record-human-turn records HUMAN_TURN only when workflow state exists", () => {
    const withStateDir = scratchProject(true);
    runAdapter(withStateDir, "record-human-turn", withCwd(FIXTURES.userPromptSubmit, withStateDir));
    expect(readAudit(withStateDir)).toContain("HUMAN_TURN");

    const noStateDir = scratchProject(false);
    const r = runAdapter(noStateDir, "record-human-turn", withCwd(FIXTURES.userPromptSubmit, noStateDir));
    expect(r.code).toBe(0);
    expect(readAudit(noStateDir)).toBe("");
  });

  test("21: real adjacent signed parts reset the cap and direct/source continuation reaches retained run-stage", () => {
    const dir = orchestrationProject();
    const session = "bounded-transport-owner";
    appendFileSync(
      join(dir, "aidlc", "spaces", "default", "memory", "org.md"),
      Array.from({ length: 20 }, (_, index) => `\n## Multipart ${index}\n${"x".repeat(1500)}\n`).join(""),
    );
    let routed = runLifecycle(dir, session, "direct", ["next"], "part-1");
    expect(routed.directive).toMatchObject({ kind: "load-steering", part: 1 });
    const token1 = String(routed.directive.continue_token);
    const stop1 = runAdapter(dir, "continue-workflow", { ...FIXTURES.stop, cwd: dir, session_id: session });
    expect((JSON.parse(stop1.stdout) as { decision?: string }).decision).toBe("block");
    const steeringReason = (JSON.parse(stop1.stdout) as { reason: string }).reason;
    expect(steeringReason).toContain("Apply every path/text entry from its already-delivered `rules_content`");
    expect(steeringReason).toContain(`continue "${token1}"`);
    expect(steeringReason).toContain("every returned load-steering part until `run-stage`");
    expect(steeringReason).toContain("do not summarise or narrate rule chunks");

    routed = runLifecycle(dir, session, "source", ["continue", token1], "part-2");
    expect(routed.directive).toMatchObject({ kind: "load-steering", part: 2 });
    const token2 = String(routed.directive.continue_token);
    let prefix = 0;
    while (prefix < Math.min(token1.length, token2.length) && token1[prefix] === token2[prefix]) prefix++;
    expect(prefix).toBeGreaterThan(24);
    const stop2 = runAdapter(dir, "continue-workflow", { ...FIXTURES.stop, cwd: dir, session_id: session, stop_hook_active: true });
    expect((JSON.parse(stop2.stdout) as { decision?: string }).decision).toBe("block");
    expect(marker(dir).stop_count).toBe(1);

    for (let part = 2; routed.directive.kind === "load-steering"; part++) {
      const token = String(routed.directive.continue_token);
      routed = runLifecycle(dir, session, part % 2 ? "direct" : "source", ["continue", token], `part-${part + 1}`);
    }
    expect(routed.directive.kind).toBe("run-stage");
    for (const form of ["direct", "source"] as const) {
      const spec = commandSpec(dir, form, ["continue", token1]);
      const pre = runAdapter(dir, "guard-tool-call", commandPayload(dir, session, spec.text, `reuse-${form}`));
      const rewritten = rewrittenCommand(pre);
      const replay = spawnSync("/bin/sh", ["-c", rewritten], { cwd: dir, encoding: "utf-8" });
      expect(replay.status, replay.stderr).toBe(0);
      expect(JSON.parse(replay.stdout)).toMatchObject({ kind: "error" });
      expect(replay.stdout).toContain("no longer current");
      runAdapter(dir, "post-tool", commandPayload(dir, session, rewritten, `reuse-${form}`, true, replay.stdout));
    }
    const active = marker(dir);
    expect(active.kind).toBe("run-stage");
    expect(active.delivery).toBe("delivered");
    expect((active.active_attempt as Record<string, unknown>).status).toBe("failed");
    expect(JSON.stringify(active)).not.toContain("rules_content");
    expect(JSON.stringify(active)).not.toContain("text_result_for_llm");
    const stopped = runAdapter(dir, "continue-workflow", { ...FIXTURES.stop, cwd: dir, session_id: session });
    const reason = (JSON.parse(stopped.stdout) as { reason: string }).reason;
    expect(reason).toContain("exact delivered AIDLC run-stage");
    expect(reason).toContain("Complete that exact stage");
    expect(reason).toContain("use `report` for the real outcome");
    expect(reason).toContain("use `park` for a clean pause");
    expect(reason).toContain("Never rubber-stamp approval or revision gates");
    expect(reason).not.toContain("restart at part 1");
    expect(reason).not.toContain("orchestrate.ts next");
    const beforeForeign = marker(dir).revision;
    const foreign = runAdapter(dir, "continue-workflow", { ...FIXTURES.stop, cwd: dir, session_id: "foreign-stop" });
    expect(foreign.stdout).toBe("");
    expect(marker(dir).revision).toBe(beforeForeign);
    expect(existsSync(join(seededRecordDir(dir), ".aidlc-stop-hook", "block-count.json"))).toBe(false);

    const parked = orchestrationProject();
    driveToRunStage(parked, "park-owner");
    const park = runLifecycle(parked, "park-owner", "source", ["park"], "park-result");
    expect(park.directive.kind).toBe("parked");
    expect(marker(parked)).toMatchObject({ kind: "parked", delivery: "delivered" });
    expect(runAdapter(parked, "continue-workflow", { ...FIXTURES.stop, cwd: parked, session_id: "park-owner" }).stdout).toBe("");

    const reported = orchestrationProject();
    driveToRunStage(reported, "report-owner");
    runAdapter(reported, "record-human-turn", {
      ...FIXTURES.userPromptSubmit,
      cwd: reported,
      session_id: "report-owner",
      prompt: "Request changes",
    });
    const report = runLifecycle(
      reported, "report-owner", "source",
      ["report", "--stage", "requirements-analysis", "--result", "rejected", "--reason", "test rejection"], "report-result",
    );
    expect(report.directive.kind).toBe("print");
    expect(marker(reported)).toMatchObject({ kind: "print", delivery: "superseded" });

    const terminal = orchestrationProject();
    writeFileSync(seededStateFile(terminal), readFileSync(join(REPO_ROOT, "tests", "fixtures", "state-completed.md"), "utf-8"));
    runLifecycle(terminal, "terminal-report-owner", "direct", ["next"], "terminal-next");
    const terminalReport = runLifecycle(
      terminal, "terminal-report-owner", "source",
      ["report", "--stage", "feedback-optimization", "--result", "completed"], "terminal-report",
    );
    expect(terminalReport.directive.kind).toBe("done");
    expect(marker(terminal)).toMatchObject({ kind: "done", delivery: "delivered" });
    expect(runAdapter(terminal, "continue-workflow", { ...FIXTURES.stop, cwd: terminal, session_id: "terminal-report-owner" }).stdout).toBe("");

    const takeover = orchestrationProject();
    driveToRunStage(takeover, "owner-a");
    const epoch = Number(marker(takeover).owner_epoch);
    rewriteMarker(takeover, (value) => { value.stop_count = 5; value.stop_fingerprint = "old-owner"; });
    runLifecycle(takeover, "owner-b", "source", ["next"], "takeover-next");
    expect(marker(takeover)).toMatchObject({ owner_session: "owner-b", owner_epoch: epoch + 1, stop_count: 0 });
    expect(marker(takeover).stop_fingerprint).toBeUndefined();
    expect((JSON.parse(runAdapter(takeover, "continue-workflow", { ...FIXTURES.stop, cwd: takeover, session_id: "owner-b" }).stdout) as { decision?: string }).decision).toBe("block");
    expect(String(marker(takeover).stop_fingerprint)).toContain(`|owner-b|${epoch + 1}`);

    const repeated = orchestrationProject();
    runLifecycle(repeated, "same-owner", "direct", ["next"], "same-owner-first");
    const sameEpoch = marker(repeated).owner_epoch;
    expect((JSON.parse(runAdapter(repeated, "continue-workflow", { ...FIXTURES.stop, cwd: repeated, session_id: "same-owner" }).stdout) as { decision?: string }).decision).toBe("block");
    runLifecycle(repeated, "same-owner", "source", ["next"], "same-owner-second");
    expect(marker(repeated).owner_epoch).toBe(sameEpoch);
    expect(runAdapter(repeated, "continue-workflow", { ...FIXTURES.stop, cwd: repeated, session_id: "same-owner", stop_hook_active: true }).stdout).toBe("");
    expect(marker(repeated).stop_count).toBe(2);
  }, 60000);

  test.skipIf(COMPILED_BINARY === null)("21b: real compiled dispatcher normalizes next/continue and --resume shorthand", () => {
    const dir = orchestrationProject();
    const session = "real-compiled-owner";
    const resumed = runLifecycle(dir, session, "compiled", ["--resume"], "compiled-resume");
    expect(resumed.directive.kind).toBe("load-steering");
    expect(resumed.directive.stage).toBe("requirements-analysis");

    const routedDir = orchestrationProject();
    const first = runLifecycle(routedDir, session, "compiled", ["next"], "compiled-next");
    expect(first.directive.kind).toBe("load-steering");
    const continued = runLifecycle(routedDir, session, "compiled", ["continue", String(first.directive.continue_token)], "compiled-continue");
    expect(["load-steering", "run-stage"]).toContain(String(continued.directive.kind));
  }, 30000);

  test("21c: exact claim ownership failures deny while pre-claim correlation absence stays untracked", () => {
    const foreignSession = orchestrationProject();
    const owner = "claim-owner";
    const first = runLifecycle(foreignSession, owner, "direct", ["next"], "claim-owner-next");
    const token = String(first.directive.continue_token);
    const spec = commandSpec(foreignSession, "source", ["continue", token]);
    const before = readFileSync(join(seededRecordDir(foreignSession), ".aidlc-active-directive.json"), "utf-8");
    const deniedForeign = runAdapter(foreignSession, "guard-tool-call", commandPayload(
      foreignSession, "different-session", spec.text, "foreign-session-attempt",
    ));
    expect(deniedForeign.code).toBe(0);
    expect(deniedForeign.stdout).toContain('"permissionDecision":"deny"');
    expect(deniedForeign.stdout).toContain("another Copilot session");
    expect(readFileSync(join(seededRecordDir(foreignSession), ".aidlc-active-directive.json"), "utf-8")).toBe(before);

    const noCorrelation = commandPayload(foreignSession, "", spec.text);
    delete (noCorrelation as { session_id?: string }).session_id;
    const untracked = runAdapter(foreignSession, "guard-tool-call", noCorrelation);
    expect(untracked.code).toBe(0);
    expect(untracked.stdout).toBe("");
    expect(readFileSync(join(seededRecordDir(foreignSession), ".aidlc-active-directive.json"), "utf-8")).toBe(before);

    const stateDrift = orchestrationProject();
    const stateOwner = "state-owner";
    const stateFirst = runLifecycle(stateDrift, stateOwner, "direct", ["next"], "state-owner-next");
    appendFileSync(seededStateFile(stateDrift), "\n<!-- claim drift -->\n");
    const deniedState = runAdapter(stateDrift, "guard-tool-call", commandPayload(
      stateDrift,
      stateOwner,
      commandSpec(stateDrift, "direct", ["continue", String(stateFirst.directive.continue_token)]).text,
      "state-drift-attempt",
    ));
    expect(deniedState.stdout).toContain('"permissionDecision":"deny"');
    expect(deniedState.stdout).toContain("workflow state changed");

    const projectDrift = orchestrationProject();
    const projectOwner = "project-owner";
    const projectFirst = runLifecycle(projectDrift, projectOwner, "direct", ["next"], "project-owner-next");
    rewriteMarker(projectDrift, (value) => { value.project_sha256 = "0".repeat(64); });
    const deniedProject = runAdapter(projectDrift, "guard-tool-call", commandPayload(
      projectDrift,
      projectOwner,
      commandSpec(projectDrift, "direct", ["continue", String(projectFirst.directive.continue_token)]).text,
      "project-drift-attempt",
    ));
    expect(deniedProject.stdout).toContain('"permissionDecision":"deny"');
    expect(deniedProject.stdout).toContain("could not match");
  }, 30000);

  test("21d: stale tracked fresh-next execution cannot replace a newer owner's cursor in either order", () => {
    for (const order of ["stale-before-owner", "stale-after-owner"] as const) {
      const dir = orchestrationProject();
      const spec = commandSpec(dir, "direct", ["next"]);
      const attemptA = `${order}-attempt-a`;
      const attemptB = `${order}-attempt-b`;
      const commandA = rewrittenCommand(runAdapter(
        dir, "guard-tool-call", commandPayload(dir, "session-a", spec.text, attemptA),
      ));
      const claimedA = marker(dir);
      expect(claimedA).toMatchObject({
        owner_session: "session-a",
        active_attempt: {
          id: attemptA,
          status: "pending",
          claim_revision: claimedA.revision,
          command_sha256: createHash("sha256").update(JSON.stringify(["next"])).digest("hex"),
        },
      });
      const commandB = rewrittenCommand(runAdapter(
        dir, "guard-tool-call", commandPayload(dir, "session-b", spec.text, attemptB),
      ));
      const claimedB = marker(dir);
      const claimedBBytes = readFileSync(join(seededRecordDir(dir), ".aidlc-active-directive.json"), "utf-8");
      const claimedBRevision = Number(claimedB.revision);
      expect(claimedB).toMatchObject({
        owner_session: "session-b",
        owner_epoch: Number(claimedA.owner_epoch) + 1,
        delivery: "superseded",
        active_attempt: {
          id: attemptB,
          session_id: "session-b",
          status: "pending",
          owner_epoch: Number(claimedA.owner_epoch) + 1,
          context_epoch: claimedB.context_epoch,
          claim_revision: claimedB.revision,
        },
      });

      const executeStaleA = (expectedBytes: string): void => {
        for (let duplicate = 0; duplicate < 2; duplicate++) {
          const delayed = spawnSync("/bin/sh", ["-c", commandA], { cwd: dir, encoding: "utf-8" });
          expect(delayed.status, delayed.stderr).toBe(0);
          expect(JSON.parse(delayed.stdout)).toMatchObject({ kind: "error" });
          expect(delayed.stdout).toContain("stale or superseded");
          expect(readFileSync(join(seededRecordDir(dir), ".aidlc-active-directive.json"), "utf-8")).toBe(expectedBytes);
        }
      };
      if (order === "stale-before-owner") executeStaleA(claimedBBytes);

      const executedB = spawnSync("/bin/sh", ["-c", commandB], { cwd: dir, encoding: "utf-8" });
      expect(executedB.status, executedB.stderr).toBe(0);
      const directiveB = JSON.parse(executedB.stdout) as Record<string, unknown>;
      expect(directiveB.kind).toBe("load-steering");
      const tokenB = String(directiveB.continue_token);
      const issuedB = marker(dir);
      expect(issuedB).toMatchObject({
        revision: claimedBRevision + 1,
        owner_session: "session-b",
        delivery: "issued",
        continue_token_sha256: createHash("sha256").update(tokenB).digest("hex"),
        active_attempt: {
          id: attemptB,
          status: "pending",
          result_revision: claimedBRevision + 1,
        },
      });
      runAdapter(dir, "post-tool", commandPayload(dir, "session-b", commandB, attemptB, true, executedB.stdout));
      const deliveredB = marker(dir);
      const deliveredBBytes = readFileSync(join(seededRecordDir(dir), ".aidlc-active-directive.json"), "utf-8");
      expect(deliveredB).toMatchObject({
        revision: claimedBRevision + 2,
        owner_session: "session-b",
        delivery: "delivered",
        continue_token_sha256: createHash("sha256").update(tokenB).digest("hex"),
        active_attempt: { id: attemptB, status: "settled" },
      });
      if (order === "stale-after-owner") executeStaleA(deliveredBBytes);

      const continueSpec = commandSpec(dir, "source", ["continue", tokenB]);
      const continueAttempt = `${order}-continue-b`;
      const continueCommand = rewrittenCommand(runAdapter(
        dir,
        "guard-tool-call",
        commandPayload(dir, "session-b", continueSpec.text, continueAttempt),
      ));
      const continueClaim = marker(dir);
      const continueClaimRevision = Number(continueClaim.revision);
      expect(continueClaim).toMatchObject({
        revision: Number(deliveredB.revision) + 1,
        delivery: "delivered",
        active_attempt: {
          id: continueAttempt,
          command_kind: "continue",
          status: "pending",
          claim_revision: continueClaim.revision,
        },
      });
      const continued = spawnSync("/bin/sh", ["-c", continueCommand], { cwd: dir, encoding: "utf-8" });
      expect(continued.status, continued.stderr).toBe(0);
      const continuedDirective = JSON.parse(continued.stdout) as Record<string, unknown>;
      expect(["load-steering", "run-stage"]).toContain(String(continuedDirective.kind));
      const continuedIssued = marker(dir);
      expect(continuedIssued).toMatchObject({
        revision: continueClaimRevision + 1,
        delivery: "issued",
        active_attempt: {
          id: continueAttempt,
          status: "pending",
          result_revision: continueClaimRevision + 1,
        },
      });
      runAdapter(dir, "post-tool", commandPayload(
        dir, "session-b", continueCommand, continueAttempt, true, continued.stdout,
      ));
      expect(marker(dir)).toMatchObject({
        revision: continueClaimRevision + 2,
        delivery: "delivered",
        active_attempt: { id: continueAttempt, status: "settled" },
      });
    }
  }, 60000);

  test("21e: untracked fresh next fails a stale pending candidate and stays undelivered", () => {
    const dir = orchestrationProject();
    const spec = commandSpec(dir, "direct", ["next"]);
    rewrittenCommand(runAdapter(
      dir, "guard-tool-call", commandPayload(dir, "tracked-owner", spec.text, "pending-tracked-next"),
    ));
    const pendingRevision = Number(marker(dir).revision);
    const untracked = spawnSync("/bin/sh", ["-c", spec.text], { cwd: dir, encoding: "utf-8" });
    expect(untracked.status, untracked.stderr).toBe(0);
    const directive = JSON.parse(untracked.stdout) as Record<string, unknown>;
    expect(directive.kind).toBe("load-steering");
    const token = String(directive.continue_token);
    const issued = marker(dir);
    expect(issued).toMatchObject({
      revision: pendingRevision + 1,
      owner_session: "tracked-owner",
      delivery: "issued",
      continue_token_sha256: createHash("sha256").update(token).digest("hex"),
      active_attempt: {
        id: "pending-tracked-next",
        status: "failed",
      },
    });
    expect((issued.active_attempt as Record<string, unknown>).result_sha256).toBeUndefined();
    expect((issued.active_attempt as Record<string, unknown>).result_revision).toBeUndefined();
    const issuedBytes = readFileSync(join(seededRecordDir(dir), ".aidlc-active-directive.json"), "utf-8");
    runAdapter(dir, "post-tool", commandPayload(dir, "tracked-owner", spec.text, undefined, true, untracked.stdout));
    expect(readFileSync(join(seededRecordDir(dir), ".aidlc-active-directive.json"), "utf-8")).toBe(issuedBytes);
    expect(marker(dir).delivery).toBe("issued");
  }, 30000);

  test("21f: conflicting host-correlated duplicate continue is denied without replacing the first candidate", () => {
    for (const firstAttempt of ["host-attempt-a", "host-attempt-b"] as const) {
      const secondAttempt = firstAttempt === "host-attempt-a" ? "host-attempt-b" : "host-attempt-a";
      const dir = orchestrationProject();
      const session = `host-duplicate-${firstAttempt}`;
      const seeded = runLifecycle(dir, session, "direct", ["next"], `${firstAttempt}-seed`);
      const token = String(seeded.directive.continue_token);
      const direct = commandSpec(dir, "direct", ["continue", token]);
      const source = commandSpec(dir, "source", ["continue", token]);
      const firstSpec = firstAttempt === "host-attempt-a" ? direct : source;
      const secondSpec = firstAttempt === "host-attempt-a" ? source : direct;
      const firstCommand = rewrittenCommand(runAdapter(
        dir, "guard-tool-call", commandPayload(dir, session, firstSpec.text, firstAttempt),
      ));
      const survivingBytes = readFileSync(join(seededRecordDir(dir), ".aidlc-active-directive.json"), "utf-8");
      const duplicate = runAdapter(
        dir, "guard-tool-call", commandPayload(dir, session, secondSpec.text, secondAttempt),
      );
      expect(duplicate.code).toBe(0);
      expect(duplicate.stdout).toContain('"permissionDecision":"deny"');
      expect(duplicate.stdout).toContain("already pending");
      expect(readFileSync(join(seededRecordDir(dir), ".aidlc-active-directive.json"), "utf-8")).toBe(survivingBytes);
      expect(marker(dir)).toMatchObject({
        active_attempt: { id: firstAttempt, command_kind: "continue", status: "pending" },
      });
      const winner = spawnSync("/bin/sh", ["-c", firstCommand], { cwd: dir, encoding: "utf-8" });
      expect(winner.status, winner.stderr).toBe(0);
      runAdapter(dir, "post-tool", commandPayload(dir, session, firstCommand, firstAttempt, true, winner.stdout));
      const deliveredBytes = readFileSync(join(seededRecordDir(dir), ".aidlc-active-directive.json"), "utf-8");
      runAdapter(dir, "post-tool", commandPayload(
        dir, session, secondSpec.text, secondAttempt, true, '{"kind":"error","message":"duplicate"}',
      ));
      expect(readFileSync(join(seededRecordDir(dir), ".aidlc-active-directive.json"), "utf-8")).toBe(deliveredBytes);
      expect(marker(dir)).toMatchObject({ delivery: "delivered", active_attempt: { id: firstAttempt, status: "settled" } });
    }
  }, 60000);

  test("21g: reusable duplicate continue has one engine winner and one deliverable result in both operation orders", () => {
    const scenarios = [
      { pre: ["direct", "source"] as const, engine: "first", post: "winner-first" },
      { pre: ["source", "direct"] as const, engine: "second", post: "loser-first" },
    ] as const;
    for (const scenario of scenarios) {
      const dir = orchestrationProject();
      const session = `reused-${scenario.engine}`;
      const seeded = runLifecycle(dir, session, "direct", ["next"], `seed-${scenario.engine}`);
      const token = String(seeded.directive.continue_token);
      const first = noIdClaim(dir, session, commandSpec(dir, scenario.pre[0], ["continue", token]));
      const firstClaimRevision = Number(marker(dir).revision);
      const second = noIdClaim(dir, session, commandSpec(dir, scenario.pre[1], ["continue", token]), "vscode");
      expect(second.attemptId).toBe(first.attemptId);
      const shared = marker(dir);
      const claimedRevision = Number(shared.revision);
      expect(shared).toMatchObject({
        revision: firstClaimRevision + 1,
        active_attempt: {
          id: first.attemptId,
          command_kind: "continue",
          status: "pending",
          shared_attempt: true,
          claim_revision: shared.revision,
        },
      });
      const sharedBytes = readFileSync(join(seededRecordDir(dir), ".aidlc-active-directive.json"), "utf-8");
      const third = noIdClaim(dir, session, commandSpec(dir, scenario.pre[0], ["continue", token]));
      expect(third.attemptId).toBe(first.attemptId);
      expect(readFileSync(join(seededRecordDir(dir), ".aidlc-active-directive.json"), "utf-8")).toBe(sharedBytes);

      const firstRun = () => spawnSync("/bin/sh", ["-c", first.updated], { cwd: dir, encoding: "utf-8" });
      const secondRun = () => spawnSync("/bin/sh", ["-c", second.updated], { cwd: dir, encoding: "utf-8" });
      const runs = scenario.engine === "first" ? [firstRun(), secondRun()] : [secondRun(), firstRun()];
      for (const run of runs) expect(run.status, run.stderr).toBe(0);
      const winner = runs.find((run) => (JSON.parse(run.stdout) as { kind: string }).kind !== "error");
      const loser = runs.find((run) => (JSON.parse(run.stdout) as { kind: string }).kind === "error");
      expect([winner, loser].filter(Boolean)).toHaveLength(2);
      expect(runs.filter((run) => (JSON.parse(run.stdout) as { kind: string }).kind !== "error")).toHaveLength(1);
      expect(runs.filter((run) => (JSON.parse(run.stdout) as { kind: string }).kind === "error")).toHaveLength(1);
      expect(loser?.stdout).toContain("no longer current");
      const winnerDirective = JSON.parse(winner?.stdout ?? "{}") as Record<string, unknown>;
      const resultSha256 = createHash("sha256").update((winner?.stdout ?? "").trim()).digest("hex");
      const issued = marker(dir);
      expect(issued).toMatchObject({
        revision: claimedRevision + 1,
        delivery: "issued",
        active_attempt: {
          id: first.attemptId,
          status: "pending",
          result_sha256: resultSha256,
          result_revision: claimedRevision + 1,
        },
      });
      if (winnerDirective.kind === "load-steering") {
        expect(issued.continue_token_sha256).toBe(
          createHash("sha256").update(String(winnerDirective.continue_token)).digest("hex"),
        );
      } else {
        expect(issued.continue_token_sha256).toBeUndefined();
      }
      const winnerCommand = scenario.engine === "first" ? first.updated : second.updated;
      const loserCommand = scenario.engine === "first" ? second.updated : first.updated;
      const postWinner = () => runAdapter(
        dir, "post-tool", commandPayload(dir, session, winnerCommand, undefined, true, winner?.stdout),
      );
      const postLoser = () => runAdapter(
        dir, "post-tool", commandPayload(dir, session, loserCommand, undefined, true, loser?.stdout),
      );
      if (scenario.post === "winner-first") {
        postWinner();
        postLoser();
      } else {
        postLoser();
        expect(marker(dir)).toMatchObject({ delivery: "issued", active_attempt: { status: "pending" } });
        postWinner();
      }
      const deliveredRevision = claimedRevision + 2;
      expect(marker(dir)).toMatchObject({
        revision: deliveredRevision,
        delivery: "delivered",
        active_attempt: { id: first.attemptId, status: "settled", result_sha256: resultSha256 },
      });
      postWinner();
      postLoser();
      expect(marker(dir).revision).toBe(deliveredRevision);
      const retainedKind = marker(dir).kind;
      const retainedToken = marker(dir).continue_token_sha256;
      const stopped = runAdapter(dir, "continue-workflow", { ...FIXTURES.stop, cwd: dir, session_id: session });
      expect((JSON.parse(stopped.stdout) as { decision?: string }).decision).toBe("block");
      const retained = marker(dir);
      expect(retained).toMatchObject({
        kind: retainedKind,
        delivery: "delivered",
        active_attempt: { id: first.attemptId, status: "settled" },
      });
      expect(retained.continue_token_sha256).toBe(retainedToken);
    }
  }, 60000);

  test("21h: failed duplicate Post cannot cancel the candidate that later wins", () => {
    const dir = orchestrationProject();
    const session = "duplicate-failure-owner";
    const seeded = runLifecycle(dir, session, "direct", ["next"], "duplicate-failure-seed");
    const token = String(seeded.directive.continue_token);
    const first = noIdClaim(dir, session, commandSpec(dir, "direct", ["continue", token]));
    const second = noIdClaim(dir, session, commandSpec(dir, "source", ["continue", token]));
    expect(second.attemptId).toBe(first.attemptId);
    const pendingBytes = readFileSync(join(seededRecordDir(dir), ".aidlc-active-directive.json"), "utf-8");
    const failed = spawnSync("/definitely/missing-aidlc-engine", [], { cwd: dir, encoding: "utf-8" });
    expect(failed.status).not.toBe(0);
    runAdapter(dir, "post-tool", commandPayload(dir, session, second.updated, undefined, true));
    expect(readFileSync(join(seededRecordDir(dir), ".aidlc-active-directive.json"), "utf-8")).toBe(pendingBytes);
    const winner = spawnSync("/bin/sh", ["-c", first.updated], { cwd: dir, encoding: "utf-8" });
    expect(winner.status, winner.stderr).toBe(0);
    runAdapter(dir, "post-tool", commandPayload(dir, session, first.updated, undefined, true, winner.stdout));
    expect(marker(dir)).toMatchObject({
      delivery: "delivered",
      active_attempt: { id: first.attemptId, status: "settled" },
    });
  }, 30000);

  test("22: Post settles only its active attempt across duplicate, reorder, compaction, and malformed result", () => {
    const dir = orchestrationProject();
    const session = "bounded-attempt-owner";
    const first = commandSpec(dir, "direct", ["next"]);
    const firstCommand = rewrittenCommand(runAdapter(dir, "guard-tool-call", commandPayload(dir, session, first.text, "attempt-a")));
    const firstRun = spawnSync("/bin/sh", ["-c", firstCommand], { cwd: dir, encoding: "utf-8" });
    const second = commandSpec(dir, "source", ["next"]);
    const secondCommand = rewrittenCommand(runAdapter(dir, "guard-tool-call", commandPayload(dir, session, second.text, "attempt-b")));
    const secondRun = spawnSync("/bin/sh", ["-c", secondCommand], { cwd: dir, encoding: "utf-8" });
    runAdapter(dir, "post-tool", commandPayload(dir, session, firstCommand, "attempt-a", true, firstRun.stdout));
    expect((marker(dir).active_attempt as Record<string, unknown>).id).toBe("attempt-b");
    runAdapter(dir, "post-tool", commandPayload(dir, session, secondCommand, "attempt-b", true, secondRun.stdout));
    const settled = marker(dir);
    const revision = Number(settled.revision);
    runAdapter(dir, "post-tool", commandPayload(dir, session, secondCommand, "attempt-b", true, secondRun.stdout));
    expect(marker(dir).revision).toBe(revision);
    runAdapter(dir, "validate-state", { cwd: dir, session_id: session });
    expect(marker(dir)).toMatchObject({ context_epoch: 1, delivery: "superseded", needs_rehydrate: true });

    const third = commandSpec(dir, "direct", ["next"]);
    const thirdCommand = rewrittenCommand(runAdapter(dir, "guard-tool-call", commandPayload(dir, session, third.text, "attempt-c")));
    const thirdRun = spawnSync("/bin/sh", ["-c", thirdCommand], { cwd: dir, encoding: "utf-8" });
    const beforeCompact = Number(marker(dir).context_epoch);
    expect(runAdapter(dir, "guard-tool-call", commandPayload(dir, "copied-id-foreign", third.text, "attempt-c")).stdout)
      .toContain('"permissionDecision":"deny"');
    runAdapter(dir, "validate-state", { cwd: dir, session_id: "foreign-compact" });
    expect(marker(dir).context_epoch).toBe(beforeCompact);
    runAdapter(dir, "validate-state", { cwd: dir, session_id: session });
    expect(marker(dir).context_epoch).toBe(beforeCompact + 1);
    expect(runAdapter(dir, "guard-tool-call", commandPayload(dir, session, third.text, "attempt-c")).stdout)
      .toContain('"permissionDecision":"deny"');
    runAdapter(dir, "post-tool", commandPayload(dir, session, thirdCommand, "attempt-c", true, thirdRun.stdout));
    expect(marker(dir)).toMatchObject({ delivery: "superseded", needs_rehydrate: true });

    const recovery = commandSpec(dir, "direct", ["next"]);
    const recoveryD = rewrittenCommand(runAdapter(dir, "guard-tool-call", commandPayload(dir, session, recovery.text, "attempt-d")));
    runAdapter(dir, "post-tool", commandPayload(dir, session, recoveryD, "attempt-d", true));
    expect(marker(dir)).toMatchObject({ delivery: "superseded", needs_rehydrate: true });
    rewrittenCommand(runAdapter(dir, "guard-tool-call", commandPayload(dir, session, recovery.text, "attempt-e")));
    const recoveryF = rewrittenCommand(runAdapter(dir, "guard-tool-call", commandPayload(dir, session, recovery.text, "attempt-f")));
    runAdapter(dir, "post-tool", commandPayload(
      dir,
      session,
      recoveryF,
      "attempt-f",
      true,
      '{"kind":"run-stage","stage":"requirements-analysis"}\n{"kind":"done"}',
    ));
    expect(marker(dir)).toMatchObject({ delivery: "superseded", needs_rehydrate: true });
  }, 30000);

  test("22b: adapter-carried no-ID attempt supports normal, duplicate, stale-old, compaction, recovery, and new epoch", () => {
    const dir = orchestrationProject();
    const session = "no-id-owner";
    const spec = commandSpec(dir, "direct", ["next"]);
    const first = noIdClaim(dir, session, spec);
    const firstRun = executeNoId(dir, session, spec, first);
    expect(marker(dir).active_attempt).toMatchObject({ id: first.attemptId, status: "settled" });
    const duplicateRevision = marker(dir).revision;
    runAdapter(dir, "post-tool", commandPayload(dir, session, first.updated, undefined, true, firstRun.stdout));
    expect(marker(dir).revision).toBe(duplicateRevision);

    const second = noIdClaim(dir, session, spec, "vscode");
    expect(second.attemptId).not.toBe(first.attemptId);
    const pendingRevision = marker(dir).revision;
    runAdapter(dir, "post-tool", commandPayload(dir, session, first.updated, undefined, true, firstRun.stdout));
    expect(marker(dir)).toMatchObject({ revision: pendingRevision, active_attempt: { id: second.attemptId, status: "pending" } });
    executeNoId(dir, session, spec, second);
    expect(marker(dir).active_attempt).toMatchObject({ id: second.attemptId, status: "settled" });

    const compacted = noIdClaim(dir, session, spec);
    runAdapter(dir, "validate-state", { cwd: dir, session_id: session });
    const compactedBytes = readFileSync(join(seededRecordDir(dir), ".aidlc-active-directive.json"), "utf-8");
    const compactedRun = spawnSync("/bin/sh", ["-c", compacted.updated], { cwd: dir, encoding: "utf-8" });
    expect(JSON.parse(compactedRun.stdout)).toMatchObject({ kind: "error" });
    expect(compactedRun.stdout).toContain("stale or superseded");
    runAdapter(dir, "post-tool", commandPayload(dir, session, compacted.updated, undefined, true, compactedRun.stdout));
    expect(readFileSync(join(seededRecordDir(dir), ".aidlc-active-directive.json"), "utf-8")).toBe(compactedBytes);
    expect(marker(dir)).toMatchObject({ delivery: "superseded", active_attempt: { id: compacted.attemptId, status: "pending" } });

    const recovered = noIdClaim(dir, session, spec);
    executeNoId(dir, session, spec, recovered);
    expect(marker(dir).active_attempt).toMatchObject({ id: recovered.attemptId, status: "settled" });
    rmSync(join(seededRecordDir(dir), ".aidlc-active-directive.json"));
    const recoveryStop = runAdapter(dir, "continue-workflow", { ...FIXTURES.stop, cwd: dir, session_id: session });
    expect((JSON.parse(recoveryStop.stdout) as { decision?: string }).decision).toBe("block");
    const afterRecovery = noIdClaim(dir, session, spec, "vscode");
    executeNoId(dir, session, spec, afterRecovery);
    expect(marker(dir).active_attempt).toMatchObject({ id: afterRecovery.attemptId, status: "settled" });
  }, 30000);

  test("22b-envelope: each explicit dialect fails toward recovery when its rewritten command is missing or wrong", () => {
    const wrongAttempt = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    for (const dialect of ["cli", "vscode"] as const) {
      for (const shape of ["missing", "wrong"] as const) {
        const dir = orchestrationProject();
        const session = `${dialect}-${shape}-owner`;
        const spec = commandSpec(dir, "direct", ["next"]);
        const claim = noIdClaim(dir, session, spec, dialect);
        const claimedBytes = readFileSync(join(seededRecordDir(dir), ".aidlc-active-directive.json"), "utf-8");
        const command = shape === "missing" ? spec.text : `${spec.text} --aidlc-attempt-id ${wrongAttempt}`;
        const argv = shape === "missing" ? spec.argv : [...spec.argv, "--aidlc-attempt-id", wrongAttempt];
        const executed = spawnSync(spec.executable, argv, { cwd: dir, encoding: "utf-8" });
        expect(executed.status, executed.stderr).toBe(0);
        runAdapter(dir, "post-tool", commandPayload(dir, session, command, undefined, true, executed.stdout));
        if (shape === "missing") {
          expect(JSON.parse(executed.stdout)).toMatchObject({ kind: "load-steering" });
          expect(marker(dir)).toMatchObject({
            delivery: "issued",
            active_attempt: { id: claim.attemptId, status: "failed" },
          });
        } else {
          expect(JSON.parse(executed.stdout)).toMatchObject({ kind: "error" });
          expect(executed.stdout).toContain("stale or superseded");
          expect(readFileSync(join(seededRecordDir(dir), ".aidlc-active-directive.json"), "utf-8")).toBe(claimedBytes);
          expect(marker(dir)).toMatchObject({ active_attempt: { id: claim.attemptId, status: "pending" } });
        }
        const stopped = runAdapter(dir, "continue-workflow", { ...FIXTURES.stop, cwd: dir, session_id: session });
        expect((JSON.parse(stopped.stdout) as { decision?: string }).decision).toBe("block");
        expect(runAdapter(dir, "guard-tool-call", commandPayload(dir, session, spec.text)).stdout).not.toContain('"permissionDecision":"deny"');
      }
    }
  }, 30000);

  test("22c: VS Code tool_response settles the same bounded directive envelope", () => {
    const dir = orchestrationProject();
    const session = "vscode-result-owner";
    const spec = commandSpec(dir, "source", ["next"]);
    const rewritten = rewrittenCommand(runAdapter(dir, "guard-tool-call", commandPayload(dir, session, spec.text, "vscode-attempt")));
    const executed = spawnSync("/bin/sh", ["-c", rewritten], { cwd: dir, encoding: "utf-8" });
    runAdapter(dir, "post-tool", {
      hook_event_name: "PostToolUse", session_id: session, tool_use_id: "vscode-attempt", cwd: dir,
      toolName: "runTerminalCommand", toolInput: { command: rewritten }, tool_response: executed.stdout,
    });
    expect(marker(dir)).toMatchObject({ kind: "load-steering", delivery: "delivered" });
  }, 30000);

  test("22d: canonical script identity includes symlink aliases and still rejects replay", () => {
    const dir = orchestrationProject();
    const session = "symlink-owner";
    const dispatcherAlias = join(dir, ".aidlc", "tools", "aidlc-alias.ts");
    const directAlias = join(dir, ".aidlc", "tools", "orchestrate-alias.ts");
    symlinkSync("aidlc.ts", dispatcherAlias);
    symlinkSync("aidlc-orchestrate.ts", directAlias);
    const nextCommand = "bun .aidlc/tools/aidlc-alias.ts next";
    const rewrittenNext = rewrittenCommand(runAdapter(dir, "guard-tool-call", commandPayload(dir, session, nextCommand, "alias-next")));
    const next = spawnSync("/bin/sh", ["-c", rewrittenNext], { cwd: dir, encoding: "utf-8" });
    expect(next.status, next.stderr).toBe(0);
    runAdapter(dir, "post-tool", commandPayload(dir, session, rewrittenNext, "alias-next", true, next.stdout));
    const nextDirective = JSON.parse(next.stdout) as { kind?: string; continue_token?: string };
    expect(nextDirective.kind).toBe("load-steering");
    const token = String(nextDirective.continue_token);
    const continueCommand = `bun .aidlc/tools/orchestrate-alias.ts continue ${JSON.stringify(token)}`;
    const rewrittenContinue = rewrittenCommand(runAdapter(dir, "guard-tool-call", commandPayload(dir, session, continueCommand, "alias-continue")));
    const continued = spawnSync("/bin/sh", ["-c", rewrittenContinue], { cwd: dir, encoding: "utf-8" });
    expect(continued.status, continued.stderr).toBe(0);
    runAdapter(dir, "post-tool", commandPayload(dir, session, rewrittenContinue, "alias-continue", true, continued.stdout));
    const replay = rewrittenCommand(runAdapter(dir, "guard-tool-call", commandPayload(dir, session, continueCommand, "alias-replay")));
    const replayed = spawnSync("/bin/sh", ["-c", replay], { cwd: dir, encoding: "utf-8" });
    expect(replayed.stdout).toContain("no longer current");
    expect(runAdapter(dir, "guard-tool-call", commandPayload(dir, session, "bun .aidlc/tools/aidlc.ts-missing next", "lookalike")).stdout)
      .toBe("");
  }, 30000);

  test("23: explicit Resume continues directly and does not arm a resume marker", () => {
    const dir = orchestrationProject();
    const resumed = runLifecycle(dir, "resume-direct-owner", "direct", ["next", "--resume"], "resume-direct");
    expect(resumed.directive.kind).toBe("load-steering");
    expect(resumed.directive.stage).toBe("requirements-analysis");
    expect(marker(dir).resume).toBeUndefined();
  }, 30000);

  test("23a: bare next remains allowed after explicit Resume continuation", () => {
    const dir = orchestrationProject();
    const session = "resume-followup-owner";
    runLifecycle(dir, session, "direct", ["next", "--resume"], "resume-first");
    const followup = runLifecycle(dir, session, "source", ["next"], "resume-followup");
    expect(["load-steering", "run-stage"]).toContain(String(followup.directive.kind));
    expect(followup.directive.stage).toBe("requirements-analysis");
    expect(marker(dir).resume).toBeUndefined();
  }, 30000);

  test("23b: session-menu Resume reports are plain reports and return per-choice prints", () => {
    const cases = [
      ["1", "Re-run `next`"],
      ["2", "--direction redo"],
      ["3", "next --stage"],
      ["4", "--new-intent"],
    ] as const;
    for (const [choice, expected] of cases) {
      const dir = orchestrationProject();
      const session = `resume-report-${choice}`;
      runLifecycle(dir, session, "direct", ["next", "--resume"], `resume-report-route-${choice}`);
      const reported = runLifecycle(
        dir,
        session,
        "source",
        ["report", "--result", "resumed", "--user-input", choice],
        `resume-report-choice-${choice}`,
      );
      expect(reported.directive.kind).toBe("print");
      expect(String(reported.directive.message)).toContain(expected);
      expect(marker(dir).resume).toBeUndefined();
    }
  }, 60000);

  test("23c: explicit Resume supersedes legacy waiting and selected markers", () => {
    for (const status of ["waiting", "selected"] as const) {
      const dir = orchestrationProject();
      const session = `legacy-resume-${status}`;
      driveToRunStage(dir, session);
      rewriteMarker(dir, (value) => {
        value.kind = "ask";
        value.delivery = "issued";
        value.needs_rehydrate = false;
        delete value.continue_token;
        delete value.continue_token_sha256;
        value.resume = {
          status,
          ...(status === "selected" ? { action: "resume" } : {}),
          issuing_stage: "requirements-analysis",
          issuing_state_sha256: value.state_sha256,
          issuing_session: session,
          issuing_intent_uuid: value.intent_uuid,
        };
      });

      const resumed = runLifecycle(
        dir,
        session,
        "direct",
        ["next", "--resume"],
        `legacy-${status}-resume`,
      );
      expect(resumed.directive.kind).toBe("load-steering");
      expect(resumed.directive.stage).toBe("requirements-analysis");
      expect(marker(dir).resume).toMatchObject({ status: "superseded" });
    }
  }, 60000);

  test("24: Copilot conversational ordering, concurrent Stop count, unit fingerprint, and marker recovery are bounded", async () => {
    const dir = orchestrationProject();
    const session = "bounded-stop-owner";
    driveToRunStage(dir, session);
    const beforeForeign = marker(dir).human_sequence;
    runAdapter(dir, "record-human-turn", { ...FIXTURES.userPromptSubmit, cwd: dir, session_id: "foreign-prompt" });
    expect(marker(dir).human_sequence).toBe(beforeForeign);
    runAdapter(dir, "record-human-turn", { ...FIXTURES.userPromptSubmit, cwd: dir, session_id: session });
    expect(runAdapter(dir, "continue-workflow", { ...FIXTURES.stop, cwd: dir, session_id: session }).stdout).toBe("");
    const second = runAdapter(dir, "continue-workflow", { ...FIXTURES.stop, cwd: dir, session_id: session });
    expect((JSON.parse(second.stdout) as { decision?: string }).decision).toBe("block");
    appendFileSync(join(seededAuditDir(dir), pinnedShardName()), "\n## OBSERVABILITY_ONLY\n---\n");
    expect(runAdapter(dir, "continue-workflow", { ...FIXTURES.stop, cwd: dir, session_id: session }).stdout).toBe("");
    expect(marker(dir).stop_count).toBe(2);

    rewriteMarker(dir, (value) => { value.stop_count = 0; value.stop_fingerprint = ""; value.unit = "unit-a"; });
    const stops = await Promise.all([
      runAdapterAsync(dir, "continue-workflow", { ...FIXTURES.stop, cwd: dir, session_id: session }),
      runAdapterAsync(dir, "continue-workflow", { ...FIXTURES.stop, cwd: dir, session_id: session }),
    ]);
    expect(stops.filter((result) => result.stdout.includes('"decision":"block"'))).toHaveLength(1);
    expect(marker(dir).stop_count).toBe(2);
    rewriteMarker(dir, (value) => { value.unit = "unit-b"; });
    expect((JSON.parse(runAdapter(dir, "continue-workflow", { ...FIXTURES.stop, cwd: dir, session_id: session }).stdout) as { decision?: string }).decision).toBe("block");
    expect(marker(dir).stop_count).toBe(1);

    for (const shape of ["missing", "corrupt", "legacy"] as const) {
      const recovery = orchestrationProject();
      driveToRunStage(recovery, `recovery-${shape}`);
      const path = join(seededRecordDir(recovery), ".aidlc-active-directive.json");
      if (shape === "missing") rmSync(path);
      if (shape === "corrupt") writeFileSync(path, "{bad-json\n");
      if (shape === "legacy") {
        const state = readFileSync(seededStateFile(recovery), "utf-8");
        writeFileSync(path, JSON.stringify({ version: 1, stage: "requirements-analysis", state_sha256: createHash("sha256").update(state).digest("hex") }));
      }
      const stopped = runAdapter(recovery, "continue-workflow", { ...FIXTURES.stop, cwd: recovery, session_id: `recovery-${shape}` });
      const reason = (JSON.parse(stopped.stdout) as { reason: string }).reason;
      expect(reason.match(/orchestrate\.ts next/g)).toHaveLength(1);
      expect(reason).not.toContain("orchestrate.ts continue");
      expect(runAdapter(recovery, "continue-workflow", { ...FIXTURES.stop, cwd: recovery, session_id: `recovery-${shape}` }).stdout).toBe("");
      expect(marker(recovery)).toMatchObject({ owner_session: `recovery-${shape}`, stop_count: 2 });
      expect(existsSync(join(seededRecordDir(recovery), ".aidlc-stop-hook", "block-count.json"))).toBe(false);
    }
    const activeRecovery = orchestrationProject();
    driveToRunStage(activeRecovery, "active-recovery");
    rmSync(join(seededRecordDir(activeRecovery), ".aidlc-active-directive.json"));
    expect(runAdapter(activeRecovery, "continue-workflow", { ...FIXTURES.stop, cwd: activeRecovery, session_id: "active-recovery", stop_hook_active: true }).stdout).toBe("");
    expect(marker(activeRecovery).stop_count).toBe(2);
  }, 60000);

  test("24b: a no-tool human prompt is consume-once conversational without prior valid v2 coordination", () => {
    for (const shape of ["missing", "malformed", "v1"] as const) {
      const dir = orchestrationProject();
      const session = `human-${shape}`;
      const path = join(seededRecordDir(dir), ".aidlc-active-directive.json");
      if (shape === "malformed") writeFileSync(path, "{bad-json\n");
      if (shape === "v1") {
        const state = readFileSync(seededStateFile(dir), "utf-8");
        writeFileSync(path, `${JSON.stringify({
          version: 1,
          stage: "requirements-analysis",
          state_sha256: createHash("sha256").update(state).digest("hex"),
        })}\n`);
      }
      const human = runAdapter(dir, "record-human-turn", {
        ...FIXTURES.userPromptSubmit,
        cwd: dir,
        session_id: session,
        prompt: "private conversational prompt must not enter coordination",
      });
      expect(human.code, shape).toBe(0);
      const coordinated = marker(dir);
      expect(coordinated, shape).toMatchObject({
        version: 2,
        owner_session: session,
        human_sequence: 1,
      });
      expect(JSON.stringify(coordinated)).not.toContain("private conversational prompt");
      const first = runAdapter(dir, "continue-workflow", { ...FIXTURES.stop, cwd: dir, session_id: session });
      expect(first.code, shape).toBe(0);
      expect(first.stdout, shape).toBe("");
      const second = runAdapter(dir, "continue-workflow", { ...FIXTURES.stop, cwd: dir, session_id: session });
      expect((JSON.parse(second.stdout) as { decision?: string }).decision, shape).toBe("block");
    }
  }, 30000);

  test("25: execution-shaped classification allows inspection, wrappers, and one terminal redirect", () => {
    const dir = orchestrationProject();
    for (const command of [
      'bash -lc "bun .aidlc/tools/aidlc-orchestrate.ts next"',
      "env AIDLC_TEST=1 bun .aidlc/tools/aidlc.ts next",
      "AIDLC_TEST=1 aidlc next",
      "cat .aidlc/tools/aidlc.ts | head -50",
      "printf aidlc | wc -c",
      'echo "aidlc next"',
      "echo unrelated",
      "git status",
      'aidlc next --scope "$SCOPE"',
      "aidlc next src/*.ts",
      "aidlc next ~/scope",
      "aidlc next src/{a,b}.ts",
    ]) {
      const allowed = runAdapter(dir, "guard-tool-call", commandPayload(dir, "wrapper-owner", command, command));
      expect(allowed.code, command).toBe(0);
      expect(allowed.stdout, command).toBe("");
    }
    const crashed = spawnSync(
      process.execPath,
      [join(dir, ".aidlc", "hooks", "missing-copilot-adapter.ts"), "guard-tool-call"],
      {
        cwd: dir,
        input: JSON.stringify(commandPayload(dir, "wrapper-owner", "cat .aidlc/tools/aidlc.ts | head -50")),
        encoding: "utf-8",
      },
    );
    expect(crashed.stdout).toBe("");
    expect(crashed.status).not.toBe(0);
    for (const command of [
      "bun .aidlc/tools/aidlc.ts next && echo compound",
      "aidlc next > /tmp/result",
      "aidlc next 2>&1 | tee /tmp/result",
    ]) {
      expect(runAdapter(dir, "guard-tool-call", commandPayload(dir, "wrapper-owner", command, command)).stdout, command).toContain('"permissionDecision":"deny"');
    }
    const redirected = commandPayload(
      dir,
      "redirect-owner",
      "bun .aidlc/tools/aidlc-orchestrate.ts next 2>&1",
      "redirect-attempt",
    );
    const pre = runAdapter(dir, "guard-tool-call", redirected);
    const rewritten = (JSON.parse(pre.stdout) as { modifiedArgs?: { command?: string } }).modifiedArgs?.command ?? "";
    expect(rewritten).toEndWith("--aidlc-attempt-id redirect-attempt 2>&1");
    const executed = spawnSync("/bin/sh", ["-c", rewritten], { cwd: dir, encoding: "utf-8" });
    expect(executed.status, executed.stderr).toBe(0);
    runAdapter(dir, "post-tool", commandPayload(dir, "redirect-owner", rewritten, "redirect-attempt", true, executed.stdout));
    expect(marker(dir)).toMatchObject({ delivery: "delivered", active_attempt: { id: "redirect-attempt" } });

    for (const [command, attempt] of [
      ["aidlc next --scope '`literal`'", "literal-backtick-attempt"],
      ["aidlc next --scope 'src/{a,b}.ts'", "literal-brace-attempt"],
      ["aidlc next --scope src/\\{a,b\\}.ts", "escaped-brace-attempt"],
    ]) {
      const literal = runAdapter(
        dir,
        "guard-tool-call",
        commandPayload(dir, "literal-owner", command, attempt),
      );
      expect(literal.stdout, command).not.toContain('"permissionDecision":"deny"');
      expect(
        (JSON.parse(literal.stdout) as { modifiedArgs?: { command?: string } })
          .modifiedArgs?.command,
        command,
      ).toContain(`--aidlc-attempt-id ${attempt}`);
    }

    const directCore = spawnSync(process.execPath, [join(dir, ".aidlc", "hooks", "aidlc-continue-workflow.ts")], {
      cwd: dir,
      input: JSON.stringify({ session_id: "plain-non-copilot", stop_hook_active: false }),
      encoding: "utf-8",
      env: { ...process.env, AIDLC_PROJECT_DIR: dir, CLAUDE_PROJECT_DIR: dir, AIDLC_COPILOT_SESSION_ID: undefined } as NodeJS.ProcessEnv,
    });
    expect((JSON.parse(directCore.stdout) as { decision?: string }).decision).toBe("block");
  }, 30000);

  test("25b: claim lock contention tells the caller to retry the exact command", () => {
    const dir = orchestrationProject();
    const lockDir = join(
      seededRecordDir(dir),
      ".aidlc-active-directive.lock",
    );
    const lockToken = "live-claim-owner";
    mkdirSync(join(lockDir, lockToken), { recursive: true });
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        startedAtMs: Math.floor(performance.timeOrigin + performance.now()),
        reapLiveOwnerAfterStale: true,
        token: lockToken,
      }),
    );

    const blocked = runAdapter(
      dir,
      "guard-tool-call",
      commandPayload(dir, "contention-owner", "aidlc next", "contention-attempt"),
    );
    expect(blocked.stdout).toContain('"permissionDecision":"deny"');
    expect(blocked.stdout).toContain("Retry this exact command");
    expect(blocked.stdout).not.toContain("Run a fresh");
    expect(blocked.stdout).not.toContain("do not reuse");
  });

  test("26: direct and source foreign projects are denied before claim or Post can mutate either marker", () => {
    const current = orchestrationProject();
    const foreign = orchestrationProject();
    const session = "foreign-project-owner";
    runLifecycle(current, session, "direct", ["next"], "local-next");
    runLifecycle(foreign, "foreign-project-session", "source", ["next"], "foreign-next");
    const currentMarkerPath = join(seededRecordDir(current), ".aidlc-active-directive.json");
    const foreignMarkerPath = join(seededRecordDir(foreign), ".aidlc-active-directive.json");
    const currentBefore = readFileSync(currentMarkerPath, "utf-8");
    const foreignBefore = readFileSync(foreignMarkerPath, "utf-8");
    for (const form of ["direct", "source"] as const) {
      const spec = commandSpec(current, form, ["next", "--project-dir", foreign]);
      const denied = runAdapter(current, "guard-tool-call", commandPayload(current, session, spec.text, `foreign-${form}`));
      expect(denied.code, form).toBe(0);
      expect(denied.stdout, form).toContain('"permissionDecision":"deny"');
      expect(denied.stdout, form).toContain("different physical project");
      expect(readFileSync(currentMarkerPath, "utf-8"), `${form} current Pre`).toBe(currentBefore);
      expect(readFileSync(foreignMarkerPath, "utf-8"), `${form} foreign Pre`).toBe(foreignBefore);
      runAdapter(current, "post-tool", commandPayload(current, session, spec.text, `foreign-${form}`, true, '{"kind":"done"}'));
      runAdapter(foreign, "post-tool", commandPayload(foreign, session, spec.text, `foreign-${form}`, true, '{"kind":"done"}'));
      expect(readFileSync(currentMarkerPath, "utf-8"), `${form} current Post`).toBe(currentBefore);
      expect(readFileSync(foreignMarkerPath, "utf-8"), `${form} foreign Post`).toBe(foreignBefore);
    }
  }, 30000);

  test.skipIf(COMPILED_BINARY === null)("26b: the real compiled foreign-project branch cannot claim or settle either marker", () => {
    const current = orchestrationProject();
    const foreign = orchestrationProject();
    const session = "compiled-foreign-owner";
    runLifecycle(current, session, "direct", ["next"], "compiled-local-next");
    runLifecycle(foreign, "compiled-foreign-session", "source", ["next"], "compiled-foreign-next");
    const currentMarkerPath = join(seededRecordDir(current), ".aidlc-active-directive.json");
    const foreignMarkerPath = join(seededRecordDir(foreign), ".aidlc-active-directive.json");
    const currentBefore = readFileSync(currentMarkerPath, "utf-8");
    const foreignBefore = readFileSync(foreignMarkerPath, "utf-8");
    const spec = commandSpec(current, "compiled", ["next", "--project-dir", foreign]);
    const denied = runAdapter(current, "guard-tool-call", commandPayload(current, session, spec.text, "compiled-foreign"));
    expect(denied.code).toBe(0);
    expect(denied.stdout).toContain('"permissionDecision":"deny"');
    expect(denied.stdout).toContain("different physical project");
    runAdapter(current, "post-tool", commandPayload(current, session, spec.text, "compiled-foreign", true, '{"kind":"done"}'));
    runAdapter(foreign, "post-tool", commandPayload(foreign, session, spec.text, "compiled-foreign", true, '{"kind":"done"}'));
    expect(readFileSync(currentMarkerPath, "utf-8")).toBe(currentBefore);
    expect(readFileSync(foreignMarkerPath, "utf-8")).toBe(foreignBefore);
  }, 30000);
});
