/**
 * AI-DLC Extension for Pi
 *
 * Consolidates the 10 Claude Code hooks into Pi's lifecycle event system.
 * Each handler delegates to the existing Bun CLI tools for state management,
 * audit logging, sensor firing, and forwarding-loop enforcement.
 *
 * Mapping from Claude Code hooks to Pi events:
 *   SessionStart        → session_start
 *   SessionEnd          → session_shutdown
 *   PostToolUse(Write|Edit) → tool_result (filter by tool name)
 *   PostToolUse(Bash)   → tool_result (filter by tool name)
 *   PostToolUse(TaskUpdate) → tool_result (filter by tool name)
 *   PreCompact          → before_agent_start (with compaction context)
 *   SubagentStop        → turn_end (subagent context)
 *   Stop                → turn_end (flow-altering: may block)
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Types matching Pi's extension API
// ---------------------------------------------------------------------------

interface ExtensionAPI {
  on(event: string, handler: (...args: any[]) => void | Promise<void>): void;
  registerTool(tool: any): void;
  registerCommand(cmd: any): void;
  exec(command: string, args?: string[], opts?: any): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  sendMessage(msg: string): void;
  sendUserMessage(msg: string): void;
}

interface ExtensionContext {
  cwd: string;
  mode: string;
  model: string;
  signal: AbortSignal;
  ui: {
    notify(msg: string): void;
    confirm(msg: string): Promise<boolean>;
    select(msg: string, options: string[]): Promise<string>;
    setStatus(status: string): void;
  };
  compact(): Promise<void>;
  getSystemPrompt(): string;
  getContextUsage(): { used: number; total: number };
  abort(): void;
  shutdown(): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoTimestamp(): string {
  return new Date().toISOString();
}

function resolveProjectDir(ctx: ExtensionContext): string {
  return ctx.cwd;
}

function stateFilePath(projectDir: string): string {
  return join(projectDir, "aidlc-docs", "aidlc-state.md");
}

function auditFilePath(projectDir: string): string {
  return join(projectDir, "aidlc-docs", "audit.md");
}

function enginePath(projectDir: string): string {
  return join(projectDir, ".pi", "tools", "aidlc-orchestrate.ts");
}

function sensorPath(projectDir: string): string {
  return join(projectDir, ".pi", "tools", "aidlc-sensor.ts");
}

function getField(content: string, field: string): string | null {
  // Matches both canonical format "- **Field**: value" and relaxed formats
  // like "Field: value" or "*Field*: value" for robustness.
  // Canonical format is enforced by aidlc-lib.ts; this is intentionally more
  // permissive to handle hand-edited state files during session resume.
  const regex = new RegExp(`^-\\s*\\*{0,2}${field}\\*{0,2}:?\\s*\`?([^\\\n\`]*)\`?`, "m");
  const match = content.match(regex);
  return match?.[1]?.trim() ?? null;
}

function appendAuditEntry(
  eventType: string,
  details: Record<string, string>,
  projectDir: string,
): void {
  const auditFile = auditFilePath(projectDir);
  if (!existsSync(auditFile)) return;

  const timestamp = isoTimestamp();
  const detailStr = Object.entries(details)
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");

  const entry = `\n### ${eventType}\n**Timestamp**: ${timestamp}\n${detailStr ? `**Details**: ${detailStr}\n` : ""}`;

  try {
    writeFileSync(auditFile, entry, { flag: "a" });
  } catch {
    // Non-fatal
  }
}

function recordHookDrop(projectDir: string, hookName: string, error: string): void {
  try {
    const healthDir = join(projectDir, "aidlc-docs", ".aidlc-hooks-health");
    mkdirSync(healthDir, { recursive: true });
    const dropFile = join(healthDir, `${hookName}.drops`);
    writeFileSync(dropFile, `${isoTimestamp()} ${error}\n`, { flag: "a" });
  } catch {
    // Non-fatal
  }
}

function writeHealthHeartbeat(projectDir: string, hookName: string): void {
  try {
    const healthDir = join(projectDir, "aidlc-docs", ".aidlc-hooks-health");
    mkdirSync(healthDir, { recursive: true });
    writeFileSync(join(healthDir, `${hookName}.last`), isoTimestamp(), "utf-8");
  } catch {
    // Non-fatal
  }
}

// ---------------------------------------------------------------------------
// Engine consultation (for the stop/turn_end handler)
// ---------------------------------------------------------------------------

function runEngineNextKind(projectDir: string): string | null {
  const engine = enginePath(projectDir);
  if (!existsSync(engine)) return null;

  const ENGINE_TIMEOUT_MS = 10_000;

  try {
    const result = spawnSync("bun", [engine, "next", "--project-dir", projectDir], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: ENGINE_TIMEOUT_MS,
    });

    if (result.status !== 0) return null;
    const stdout = new TextDecoder().decode(result.stdout).trim();
    if (stdout.length === 0) return null;

    const parsed: unknown = JSON.parse(stdout);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "kind" in parsed &&
      typeof (parsed as { kind: unknown }).kind === "string"
    ) {
      return (parsed as { kind: string }).kind;
    }
  } catch {
    // Engine unavailable or unparseable — fail open
  }
  return null;
}

// ---------------------------------------------------------------------------
// Recursion guard (for stop hook)
// ---------------------------------------------------------------------------

interface GuardRecord {
  signature: string;
  count: number;
}

function guardFilePath(projectDir: string): string {
  return join(projectDir, "aidlc-docs", ".aidlc-stop-hook", "block-count.json");
}

function progressSignature(_projectDir: string, stateContent: string): string {
  // Use stage + checkbox digest. The audit line count was previously used but
  // never changes between consecutive turn_end calls (nothing writes to audit.md
  // in between), making it dead weight. A hash of the checkbox states is a
  // content-based signature that changes whenever the conductor completes work.
  const stageMatch = stateContent.match(/Current Stage\*{0,2}:?\s*`?([^\n`]*)`?/);
  const stage = (stageMatch?.[1] ?? "").trim();
  const checkboxSection = stateContent.match(/## Stage Progress[\s\S]*?(?=## |$)/);
  const digest = checkboxSection
    ? simpleHash(checkboxSection[0])
    : "no-progress";
  return `${stage}::${digest}`;
}

function simpleHash(input: string): string {
  // FNV-1a — fast, non-crypto, sufficient for change detection
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function readGuard(projectDir: string): GuardRecord | null {
  try {
    const path = guardFilePath(projectDir);
    if (!existsSync(path)) return null;
    const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (
      raw !== null &&
      typeof raw === "object" &&
      "signature" in raw &&
      typeof (raw as { signature: unknown }).signature === "string" &&
      "count" in raw &&
      typeof (raw as { count: unknown }).count === "number"
    ) {
      return raw as GuardRecord;
    }
  } catch {
    // Corrupt guard file
  }
  return null;
}

function writeGuard(projectDir: string, record: GuardRecord): void {
  try {
    const dir = join(projectDir, "aidlc-docs", ".aidlc-stop-hook");
    mkdirSync(dir, { recursive: true });
    writeFileSync(guardFilePath(projectDir), JSON.stringify(record), "utf-8");
  } catch {
    // Non-fatal
  }
}

function resetGuard(projectDir: string): void {
  writeGuard(projectDir, { signature: "", count: 0 });
}

function blockCap(): number {
  const raw = process.env.PI_STOP_HOOK_BLOCK_CAP ?? process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP;
  if (!raw) return 8;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 8;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function aidlcExtension(pi: ExtensionAPI) {
  // ctx is provided to each event handler callback, not the factory
  function getProjectDir(ctx: ExtensionContext): string {
    return ctx.cwd;
  }

  // Guard: no-op if no active workflow
  function hasActiveWorkflow(ctx: ExtensionContext): boolean {
    return existsSync(stateFilePath(getProjectDir(ctx)));
  }

  // =====================================================================
  // session_start — Maps to Claude Code's SessionStart hook
  // Emits SESSION_STARTED / SESSION_RESUMED and injects workflow context
  // =====================================================================
  pi.on("session_start", (event: any, ctx: ExtensionContext) => {
    if (!hasActiveWorkflow(ctx)) return;
    if (event?.source === "compact") return; // compact is owned by before_agent_start/precompact hook

    const projectDir = getProjectDir(ctx);
    writeHealthHeartbeat(projectDir, "session-start");

    // Determine source — emit SESSION_STARTED or SESSION_RESUMED accordingly
    const source: string = event?.source ?? "startup";
    const eventType = source === "resume" ? "SESSION_RESUMED" : "SESSION_STARTED";
    try {
      appendAuditEntry(eventType, { Source: source }, projectDir);
    } catch (e) {
      recordHookDrop(projectDir, "session-start", String(e));
    }

    // Read state and inject context
    try {
      const content = readFileSync(stateFilePath(projectDir), "utf-8");
      const phase = getField(content, "Lifecycle Phase") ?? "unknown";
      const stage = getField(content, "Current Stage") ?? "unknown";
      const status = getField(content, "Status") ?? "unknown";
      const last = getField(content, "Last Completed Stage") ?? "none";
      const next = getField(content, "Next Action") ?? "resume current stage";
      const agent = getField(content, "Active Agent") ?? "unknown";
      const scope = getField(content, "Scope") ?? "unknown";

      const recoveryFile = join(projectDir, "aidlc-docs", ".aidlc-recovery.md");
      const recovery = existsSync(recoveryFile)
        ? "NOTE: A compaction recovery breadcrumb exists at .aidlc-recovery.md — check if state was preserved correctly.\n"
        : "";

      const context = `AIDLC WORKFLOW ACTIVE
Scope: ${scope}
Lifecycle Phase: ${phase}
Current Stage: ${stage}
Status: ${status}
Active Agent: ${agent}
Last Completed: ${last}
Next Action: ${next}
${recovery}On resume: offer the user the standard resume options (Resume / Redo / Jump / Start Fresh). Check aidlc-docs/aidlc-state.md for full context.`;

      ctx.ui.notify(context);
    } catch {
      // Non-fatal
    }
  });

  // =====================================================================
  // session_shutdown — Maps to Claude Code's SessionEnd hook
  // =====================================================================
  pi.on("session_shutdown", (event: any, ctx: ExtensionContext) => {
    if (!hasActiveWorkflow(ctx)) return;

    const projectDir = getProjectDir(ctx);
    writeHealthHeartbeat(projectDir, "session-end");

    try {
      appendAuditEntry("SESSION_ENDED", { Reason: event?.reason ?? "unknown" }, projectDir);
    } catch {
      // Non-fatal
    }
  });

  // =====================================================================
  // tool_result — Maps to PostToolUse hooks
  // Handles: audit-logger, sensor-fire, runtime-compile, sync-statusline
  // =====================================================================
  pi.on("tool_result", (event: any, ctx: ExtensionContext) => {
    if (!hasActiveWorkflow(ctx)) return;

    const projectDir = getProjectDir(ctx);
    const toolName = event?.tool_name ?? event?.name ?? "";
    const toolInput = event?.tool_input ?? event?.input ?? {};
    const filePath: string = toolInput?.file_path ?? toolInput?.file ?? "";
    if (toolName === "Write" || toolName === "Edit") {
      if (filePath.includes("aidlc-docs/") || filePath.includes("aidlc-docs\\")) {
        if (!filePath.endsWith("/audit.md") && !filePath.endsWith("\\audit.md")) {
          const auditFile = auditFilePath(projectDir);
          if (existsSync(auditFile)) {
            try {
              // Determine CREATED vs UPDATED: for Edit it's always UPDATE;
              // for Write, check if the file is brand-new (birthtime ≈ mtime
              // within 10 ms) to avoid misclassifying overwrites.
              let eventType: string;
              if (toolName === "Edit") {
                eventType = "ARTIFACT_UPDATED";
              } else {
                try {
                  const st = statSync(filePath);
                  const deltaMs = Math.abs(st.mtimeMs - st.birthtimeMs);
                  eventType = deltaMs < 10 ? "ARTIFACT_CREATED" : "ARTIFACT_UPDATED";
                } catch {
                  eventType = "ARTIFACT_CREATED";
                }
              }
              const aidlcIdxPosix = filePath.indexOf("aidlc-docs/");
              const aidlcIdxWin = filePath.indexOf("aidlc-docs\\");
              const aidlcIdx = aidlcIdxPosix >= 0 ? aidlcIdxPosix : aidlcIdxWin;
              const context = aidlcIdx >= 0
                ? filePath.slice(aidlcIdx + "aidlc-docs/".length).replace(/[/\\]/g, " > ")
                : filePath;
              appendAuditEntry(eventType, {
                Tool: toolName,
                File: filePath,
                Context: context,
              }, projectDir);
            } catch (e) {
              recordHookDrop(projectDir, "audit-logger", String(e));
            }
          }
        }
      }

      // --- Sensor Fire (Write|Edit) ---
      writeHealthHeartbeat(projectDir, "audit-logger");
      try {
        const statePath = stateFilePath(projectDir);
        if (!existsSync(statePath)) return;
        const stateContent = readFileSync(statePath, "utf-8");
        const testRunMode = (getField(stateContent, "Test Run Mode") ?? "").toLowerCase() === "true";
        if (testRunMode) {
          // Track skipped sensor fires in test-run mode
          try {
            const healthDir = join(projectDir, "aidlc-docs", ".aidlc-hooks-health");
            mkdirSync(healthDir, { recursive: true });
            writeFileSync(join(healthDir, "sensor-fire.skipped"), isoTimestamp(), "utf-8");
          } catch { /* Non-fatal */ }
          return;
        }

        writeHealthHeartbeat(projectDir, "sensor-fire");
        const currentStage = getField(stateContent, "Current Stage") ?? "";
        if (!currentStage || currentStage === "none") return;

        // Recursion guard: skip sensor fire for .aidlc-sensors/ detail files
        if (filePath.includes(".aidlc-sensors/")) return;

        // Load stage graph and find applicable sensors
        const graphPath = join(projectDir, ".pi", "tools", "data", "stage-graph.json");
        if (!existsSync(graphPath)) return;
        const graph: any[] = JSON.parse(readFileSync(graphPath, "utf-8"));
        const stageNode = graph.find((s: any) => s.slug === currentStage);
        if (!stageNode) return;

        const applicableSensors = stageNode.sensors_applicable ?? [];
        if (applicableSensors.length === 0) return;

        const sensor = sensorPath(projectDir);
        for (const entry of applicableSensors) {
          if (!entry.matches) continue;
          const glob = new Bun.Glob(entry.matches);
          if (!glob.match(filePath)) continue;

          try {
            const result = spawnSync("bun", [sensor, "fire", entry.id, "--stage", currentStage, "--output-path", filePath], {
              cwd: projectDir,
              timeout: 90_000,
              stdio: ["ignore", "pipe", "pipe"],
            });
            // First-fire banner: write marker on first successful sensor fire
            if (result.status === 0) {
              const firstFiredPath = join(projectDir, "aidlc-docs", ".aidlc-sensors", ".first-fired");
              if (!existsSync(firstFiredPath)) {
                try {
                  mkdirSync(join(projectDir, "aidlc-docs", ".aidlc-sensors"), { recursive: true });
                  writeFileSync(firstFiredPath, isoTimestamp(), "utf-8");
                  console.error(`[aidlc-hooks] First sensor fire: ${entry.id} on ${currentStage}`);
                } catch { /* Non-fatal */ }
              }
            }
            // Error classification on non-zero exit
            if (result.status !== 0) {
              const stderr = new TextDecoder().decode(result.stderr).slice(0, 200);
              recordHookDrop(projectDir, "sensor-fire", `${entry.id}: exit=${result.status} stderr=${stderr}`);
            }
          } catch (e: any) {
            const msg = String(e);
            if (e?.code === "ETIMEDOUT" || msg.includes("SIGTERM")) {
              recordHookDrop(projectDir, "sensor-fire", `${entry.id}: timeout`);
            } else if (e?.code === "ENOENT") {
              recordHookDrop(projectDir, "sensor-fire", `${entry.id}: spawn failure (ENOENT)`);
            } else {
              recordHookDrop(projectDir, "sensor-fire", `${entry.id}: ${msg}`);
            }
          }
        }
      } catch {
        // Non-fatal
      }
    }

    // --- Runtime Compile (Bash) ---
    if (toolName === "Bash") {
      try {
        const command: string = toolInput?.command ?? "";

        // Recursion guard: exclude aidlc-runtime.ts itself
        const aidlcRuntimeRef = /\bbun\b.*\.pi\/tools\/aidlc-runtime\.ts\b/;
        if (aidlcRuntimeRef.test(command)) return;

        // Allowlist: only fire for state-transition tools
        const aidlcInvoke = /\bbun\b.*\.pi\/tools\/aidlc-(state|jump|bolt|utility)\.ts\b/;
        if (!aidlcInvoke.test(command)) return;

        writeHealthHeartbeat(projectDir, "runtime-compile");

        // Event-class filter: only re-compile on transition-class audit events
        const auditFile = auditFilePath(projectDir);
        if (existsSync(auditFile)) {
          try {
            const audit = readFileSync(auditFile, "utf-8").replace(/\r\n/g, "\n");
            const blocks = audit.split(/\n---\n/);
            const last3 = blocks.slice(-3);
            const transitionRegex = /^\*\*Event\*\*:\s*(GATE_APPROVED|STAGE_STARTED|STAGE_AWAITING_APPROVAL|AUDIT_MERGED|WORKFLOW_COMPLETED)\s*$/m;
            const hasTransition = last3.some((b) => transitionRegex.test(b));
            if (!hasTransition) return;

            // Extract test-run mode from audit tail
            const testRunRegex = /^\*\*Test-Run\*\*:\s*true\s*$/m;
            const testRun = last3.some((b) => testRunRegex.test(b));

            const runtimePath = join(projectDir, ".pi", "tools", "aidlc-runtime.ts");
            if (existsSync(runtimePath)) {
              const args = [runtimePath, "compile", "--project-dir", projectDir];
              if (testRun) args.push("--test-run");
              const result = spawnSync("bun", args, {
                cwd: projectDir,
                timeout: 30_000,
                stdio: ["ignore", "pipe", "pipe"],
              });
              if (result.status !== 0 || result.error) {
                recordHookDrop(projectDir, "runtime-compile", `exit=${result.status} err=${String(result.error ?? "")}`);
              }
            }
          } catch {
            // Non-fatal — audit read failure
          }
        }
      } catch {
        // Non-fatal
      }
    }
  });

  // =====================================================================
  // turn_end — Maps to Stop hook (flow-altering) and SubagentStop
  // This is the critical handler that enforces the forwarding loop
  // =====================================================================
  pi.on("turn_end", (event: any, ctx: ExtensionContext) => {
    if (!hasActiveWorkflow(ctx)) return;

    const projectDir = getProjectDir(ctx);

    // --- SubagentStop: emit SUBAGENT_COMPLETED and return (no forwarding loop) ---
    const agentType = event?.agent_type;
    if (agentType) {
      const agentId: string = event?.agent_id ?? "";
      const agentMessage: string = (event?.last_assistant_message ?? "").slice(0, 200);
      const fields: Record<string, string> = { "Agent Type": agentType };
      if (agentId) fields["Agent ID"] = agentId;
      if (agentMessage) fields.Message = agentMessage;
      writeHealthHeartbeat(projectDir, "log-subagent");
      try {
        appendAuditEntry("SUBAGENT_COMPLETED", fields, projectDir);
      } catch (e) {
        recordHookDrop(projectDir, "log-subagent", String(e));
      }
      return; // SubagentStop does not participate in forwarding loop
    }

    const statePath = stateFilePath(projectDir);
    let stateContent: string;
    try {
      stateContent = readFileSync(statePath, "utf-8");
    } catch {
      return; // Fail open
    }

    writeHealthHeartbeat(projectDir, "stop");

    // Consult the engine
    const kind = runEngineNextKind(projectDir);
    if (kind === null) { recordHookDrop(projectDir, "stop", "engine returned null"); return; }
    if (kind === "done") {
      resetGuard(projectDir);
      return; // Allow stop
    }

    // Recursion guard with stop_hook_active seeding
    const cap = blockCap();
    const signature = progressSignature(projectDir, stateContent);
    const prior = readGuard(projectDir);
    const sameSignature = prior !== null && prior.signature === signature;

    const stopHookActive = event?.stop_hook_active === true;

    let nextCount: number;
    if (sameSignature) {
      nextCount = prior.count + 1;
    } else if (prior === null && stopHookActive) {
      // No prior record, but this is a post-block stop: seed at 2
      // (joining a sequence already in flight)
      nextCount = 2;
    } else {
      nextCount = 1;
    }

    writeGuard(projectDir, { signature, count: nextCount });

    if (nextCount >= cap) {
      recordHookDrop(projectDir, "stop", "recursion guard released");
      resetGuard(projectDir);
      return; // Release — stuck loop must let go
    }

    // Block the stop — inject continuation reason
    const stageMatch = stateContent.match(/Current Stage\*{0,2}:?\s*`?([^\n`]*)`?/);
    const stage = (stageMatch?.[1] ?? "").trim();
    const where = stage.length > 0 ? ` for "${stage}"` : "";
    const reason =
      `The AIDLC workflow has a pending step (a ${kind} directive${where}). ` +
      "You haven't finished the forwarding loop yet. Run " +
      "`bun .pi/tools/aidlc-orchestrate.ts next`, act on the directive it " +
      "emits, then run `aidlc-orchestrate report --result <outcome>` to commit " +
      "the transition. Repeat until the engine answers `done`.";
    ctx.ui.notify(`[AIDLC] Workflow pending: ${reason}`);
  });
  // =====================================================================
  // before_agent_start — Maps to PreCompact hook
  // Validates state and writes recovery breadcrumb
  // =====================================================================
  pi.on("before_agent_start", (event: any, ctx: ExtensionContext) => {
    if (!hasActiveWorkflow(ctx)) return;

    const projectDir = getProjectDir(ctx);
    const statePath = stateFilePath(projectDir);

    // Write health heartbeat
    try {
      const healthDir = join(projectDir, "aidlc-docs", ".aidlc-hooks-health");
      mkdirSync(healthDir, { recursive: true });
      writeFileSync(join(healthDir, "validate-state.last"), isoTimestamp(), "utf-8");
    } catch {
      // Non-fatal
    }

    if (!existsSync(statePath)) return;

    const content = readFileSync(statePath, "utf-8");

    // Validate state file has required sections
    const missing: string[] = [];
    if (!content.includes("## Stage Progress")) missing.push("Stage Progress");
    if (!content.includes("## Current Status")) missing.push("Current Status");

    if (missing.length > 0) {
      console.error(`WARNING: aidlc-state.md missing sections: ${missing.join(", ")}`);
    }

    // Write recovery breadcrumb
    const currentStage = getField(content, "Current Stage") ?? "";
    const timestamp = isoTimestamp();
    const recoveryFile = join(projectDir, "aidlc-docs", ".aidlc-recovery.md");
    try {
      writeFileSync(
        recoveryFile,
        `# AIDLC Recovery Breadcrumb\n**Last validated**: ${timestamp}\n**Current stage**: ${currentStage}\n**State file**: ${missing.length > 0 ? "INVALID" : "valid"}\n`,
        "utf-8",
      );
    } catch {
      // Non-fatal
    }

    // Emit SESSION_COMPACTED
    const auditFile = auditFilePath(projectDir);
    if (existsSync(auditFile)) {
      try {
        appendAuditEntry("SESSION_COMPACTED", {
          "Current Stage": currentStage,
          "State Validity": missing.length > 0 ? "invalid" : "valid",
        }, projectDir);
      } catch (e) {
        recordHookDrop(projectDir, "validate-state", String(e));
      }
    }
  });
}
