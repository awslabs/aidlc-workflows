// t218-kiro-ide-hook-adapter: the Kiro IDE hook shim normalizes the IDE's hook
// context into the core hooks' contract. The channel changed across IDE
// generations and the adapter accepts BOTH (upstream #543/#555):
//   - IDE 1.x: JSON on STDIN, snake_case { tool_name, tool_input,
//     tool_response } — no success flag; USER_PROMPT arrives empty. PostToolUse
//     write/shell captures have empty tool_input, while later builds populate
//     some PreToolUse/delegation inputs. Read only for the three payload targets
//     plus SessionStart/Stop identity, raced against a 2s ceiling.
//   - IDE 0.12: JSON in the USER_PROMPT env var, camelCase { toolName,
//     toolArgs, toolResult, toolSuccess }; stdin was opened but never
//     written/closed. A non-empty USER_PROMPT is consumed immediately, without
//     probing stdin.
// Either way the adapter scrapes the written file path out of the result prose
// and drives the audit-tail hooks (rebuild-stage-graph, sync-workflow-state).
//
// covers: file:hooks/aidlc-sync-workflow-state.ts, file:hooks/aidlc-write-audit-log.ts, file:hooks/aidlc-rebuild-stage-graph.ts, function:markKiroIdeLegacyPlanApprovalHost, function:clearKiroIdeLegacyPlanApprovalHost, function:clearPlanApprovalViolation, function:readPlanApprovalLegacyWindows
//
// WHY SUBPROCESS. The adapter IS a subprocess shim — in-process unit testing
// would bypass the exact stdin/env/stdout/exit-code surface being contracted.
// Each case runs `bun dist/kiro-ide/.kiro/hooks/aidlc-kiro-adapter.ts <target>`
// with the context on stdin (1.x) or in USER_PROMPT (0.12) and asserts the
// observable effect.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readAllAuditShards,
  readIntentRegistry,
  writePlanApprovalLegacyOffer,
  writeActiveDirectiveMarker,
  stateDigest,
  workspaceSourceFingerprint,
} from "../../core/tools/aidlc-lib.ts";
import {
  approvalFingerprint,
  codeGenerationRecordDir,
  evaluateCodeGenerationApproval,
  renderTestingContract,
  resolveCodeGenerationAuthority,
  resolveTestingPosture,
} from "../../core/tools/aidlc-testing-posture.ts";
import {
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  intentsDirOf,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const KIRO_IDE_TREE = join(REPO_ROOT, "dist", "kiro-ide", ".kiro");

const PINNED_CLONE_ID = "testcloneid218";
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
  cpSync(
    join(KIRO_IDE_TREE, "tools", "data", "memory-seed"),
    join(dir, "aidlc", "spaces", DEFAULT_SPACE, "memory"),
    { recursive: true },
  );
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

function scratchProject(withState: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "t218-"));
  cpSync(KIRO_IDE_TREE, join(dir, ".kiro"), { recursive: true });
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

function seedCodeGenerationDirective(dir: string, unit?: string): void {
  const statePath = seededStateFile(dir);
  const state = readFileSync(statePath, "utf-8").replace(
    /^- \*\*Current Stage\*\*:.*$/m,
    "- **Current Stage**: code-generation",
  );
  writeFileSync(statePath, state);
  writeActiveDirectiveMarker(dir, {
    kind: "run-stage",
    stage: "code-generation",
    ...(unit ? { unit } : {}),
    state_sha256: stateDigest(state),
  });
}

function initGitWorkspace(dir: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "base.ts"), "export const base = true;\n");
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "tests@example.com"],
    ["config", "user.name", "AI-DLC Tests"],
    ["add", "-A"],
    ["commit", "-qm", "baseline"],
  ]) {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
    expect(result.status, result.stderr).toBe(0);
  }
}

function seedStageLevelPlanApproval(
  dir: string,
  options: { bareSection?: boolean } = {},
): string {
  const contract = resolveTestingPosture(dir);
  const authority = resolveCodeGenerationAuthority(dir, { unit: null });
  const record = codeGenerationRecordDir(dir, null);
  mkdirSync(record, { recursive: true });
  const plan = `# Plan\n\n${renderTestingContract(contract)}`;
  const instructions = "# Unit Test Instructions\n\nRun the focused test.\n";
  const fingerprint = approvalFingerprint(
    plan,
    instructions,
    contract.contract_sha256,
    authority,
  );
  const questions = join(record, "code-generation-questions.md");
  writeFileSync(join(record, "code-generation-plan.md"), plan);
  writeFileSync(join(record, "unit-test-instructions.md"), instructions);
  // The legacy channel cannot run the fingerprint command, so the adapter owns
  // both tags: it replaces a stale fingerprint and records the planned source
  // itself. A bare section (neither tag) is what a legacy planner writes.
  writeFileSync(
    questions,
    [
      "## Plan Approval",
      "",
      ...(options.bareSection ? [] : [`[Approval Fingerprint]: ${fingerprint}`]),
      "- Approve Plan",
      "- Request Changes",
      "[Answer]:",
      "",
    ].join("\n"),
  );
  return questions;
}

/** Append a STAGE_STARTED block for <slug> to the seeded audit shard. */
function appendStageStarted(dir: string, slug: string, ts: string): void {
  const shard = join(seededAuditDir(dir), pinnedShardName());
  const block = `\n## Stage Start\n**Timestamp**: ${ts}\n**Event**: STAGE_STARTED\n**Stage**: ${slug}\n**Agent**: orchestrator\n\n---\n`;
  writeFileSync(shard, readFileSync(shard, "utf-8") + block, "utf-8");
}

/** Run the IDE adapter with USER_PROMPT set (the 0.12 context channel). stdin
 *  is closed empty — the 0.12 IDE never wrote it. */
function runIde(
  projectDir: string,
  target: string,
  userPrompt: string | null,
  envOverrides: Record<string, string | undefined> = {},
): { stdout: string; stderr: string; code: number } {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_PROJECT_DIR: projectDir,
    VSCODE_IPC_HOOK: `test-ipc:${projectDir}`,
    VSCODE_PID: "218",
    ...envOverrides,
  };
  if (userPrompt === null) {
    delete env.USER_PROMPT;
  } else {
    env.USER_PROMPT = userPrompt;
  }
  const r = spawnSync(
    "bun",
    [join(projectDir, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), target],
    {
      cwd: projectDir,
      input: "",
      encoding: "utf-8",
      env: env as NodeJS.ProcessEnv,
      timeout: 30_000,
    },
  );
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    code: r.status ?? -1,
  };
}

function legacySessionId(
  projectDir: string,
  ipc = `test-ipc:${projectDir}`,
  pid = "218",
): string {
  return `kiro-ide-legacy-${
    createHash("sha256")
      .update(`${ipc}\n${pid}`, "utf-8")
      .digest("hex")
      .slice(0, 24)
  }`;
}

function seedLegacyDirectiveChoices(
  projectDir: string,
  envOverrides: Record<string, string | undefined> = {},
  unit: string | null = null,
): { approve: string; requestChanges: string } {
  const session = legacySessionId(
    projectDir,
    envOverrides.VSCODE_IPC_HOOK ?? `test-ipc:${projectDir}`,
    envOverrides.VSCODE_PID ?? "218",
  );
  const nonce = createHash("sha256")
    .update(`${projectDir}\n${unit ?? "<stage>"}`, "utf-8")
    .digest("hex")
    .slice(0, 12);
  const approve = `Approve Plan [${nonce}]`;
  const requestChanges = `Request Changes [${nonce}]`;
  const authority = resolveCodeGenerationAuthority(projectDir, { unit });
  writePlanApprovalLegacyOffer(projectDir, {
    version: 1,
    session,
    intentId: authority.intentId,
    markerRevision: authority.markerRevision,
    allowedUnits: [unit],
    options: [approve, requestChanges].map((option) =>
      createHash("sha256")
        .update(option.toLowerCase(), "utf-8")
        .digest("hex")
    ) as [string, string],
  });
  return { approve, requestChanges };
}

/** Run the IDE adapter with the context written to STDIN (the 1.x channel).
 *  USER_PROMPT is removed — 1.x delivers it empty. */
function runIdeStdin(
  projectDir: string,
  target: string,
  stdinPayload: string,
  envOverrides: NodeJS.ProcessEnv = {},
): { stdout: string; stderr: string; code: number } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AIDLC_UNATTENDED: undefined,
    CLAUDE_PROJECT_DIR: projectDir,
    ...envOverrides,
  };
  delete (env as Record<string, string | undefined>).USER_PROMPT;
  const r = spawnSync(
    "bun",
    [join(projectDir, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), target],
    {
      cwd: projectDir,
      input: stdinPayload,
      encoding: "utf-8",
      env: env as NodeJS.ProcessEnv,
      timeout: 30_000,
    },
  );
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    code: r.status ?? -1,
  };
}

/** Exercise the public `aidlc adapter kiro-ide` dispatcher route rather than
 * invoking the adapter file directly. */
function runIdeDispatcherStdin(
  projectDir: string,
  target: string,
  stdinPayload: string,
): { stdout: string; stderr: string; code: number } {
  const env: Record<string, string> = { ...process.env, CLAUDE_PROJECT_DIR: projectDir };
  delete (env as Record<string, string | undefined>).USER_PROMPT;
  const r = spawnSync(
    "bun",
    [join(projectDir, ".kiro", "tools", "aidlc.ts"), "adapter", "kiro-ide", target],
    { cwd: projectDir, input: stdinPayload, encoding: "utf-8", env, timeout: 30_000 },
  );
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    code: r.status ?? -1,
  };
}

function ctx(toolName: string, toolResult: string): string {
  return JSON.stringify({ toolName, toolArgs: {}, toolResult, toolSuccess: true });
}

/** The 1.x PostToolUse payload shape, field-verbatim from the live 1.0.165
 *  capture: snake_case, empty tool_input for write/shell, no success flag,
 *  session/cwd metadata. Later builds populate some other event inputs. */
function ctx1x(
  toolName: string,
  toolResponse: string,
  eventName = "PostToolUse",
  sessionId = "sess_t218",
): string {
  return JSON.stringify({
    session_id: sessionId,
    hook_event_name: eventName,
    cwd: "/tmp/t218",
    tool_name: toolName,
    tool_input: {},
    tool_response: toolResponse,
  });
}

function installPlainTextUtility(dir: string): string {
  const countPath = join(dir, "terminal-utility-count");
  writeFileSync(
    join(dir, ".kiro", "tools", "aidlc-utility.ts"),
    [
      'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
      `const countPath = ${JSON.stringify(countPath)};`,
      "const count = existsSync(countPath)",
      '  ? Number.parseInt(readFileSync(countPath, "utf-8"), 10) || 0',
      "  : 0;",
      'writeFileSync(countPath, String(count + 1) + "\\n", "utf-8");',
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
  return countPath;
}

function installArgvUtility(dir: string): string {
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
  return argvPath;
}

describe("t218 Kiro IDE hook adapter (USER_PROMPT env context)", () => {
  test("1: audit-and-sensors resolves a RELATIVE toolResult path (real IDE shape) and logs CREATE", () => {
    const dir = scratchProject(true);
    try {
      const file = join(seededRecordDir(dir), "ideation", "intent-capture", "intent.md");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "# intent\n");
      // Kiro IDE reports the path RELATIVE to the workspace root (the bug that
      // made audit-logger's absolute-recordRoot gate reject every write). The
      // adapter must resolve it against the project dir before forwarding.
      const relPath = relative(dir, file);
      expect(isAbsolute(relPath)).toBe(false); // premise: this is a relative path
      const r = runIde(dir, "audit-and-sensors", ctx("fs_write", `Created the ${relPath} file.`));
      expect(r.code).toBe(0);
      const audit = readAudit(dir);
      expect(audit).toContain("ARTIFACT_CREATED");
      expect(audit).toContain("intent-capture");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("2: audit-and-sensors extracts the path from a str_replace toolResult (UPDATE)", () => {
    const dir = scratchProject(true);
    try {
      const file = join(seededRecordDir(dir), "ideation", "intent-capture", "intent.md");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "# intent edited\n");
      const r = runIde(dir, "audit-and-sensors", ctx("str_replace", `Replaced text in ${file}`));
      expect(r.code).toBe(0);
      expect(readAudit(dir)).toContain("ARTIFACT_UPDATED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("3: audit-and-sensors extracts the path from a fs_append toolResult", () => {
    const dir = scratchProject(true);
    try {
      const file = join(seededRecordDir(dir), "ideation", "intent-capture", "intent.md");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "# intent appended\n");
      const r = runIde(dir, "audit-and-sensors", ctx("fs_append", `Appended the text to the ${file} file.`));
      expect(r.code).toBe(0);
      expect(readAudit(dir)).toContain("ARTIFACT_");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("4: audit-and-sensors fails open on an unrecognized toolResult wording", () => {
    const dir = scratchProject(true);
    try {
      const before = readAudit(dir);
      const r = runIde(dir, "audit-and-sensors", ctx("fs_write", "Wrote something somewhere"));
      expect(r.code).toBe(0);
      expect(readAudit(dir)).toBe(before); // no ARTIFACT_* row added
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("5: state-sync derives Current Stage from the audit tail (no payload)", () => {
    const dir = scratchProject(true);
    try {
      // Seed a later STAGE_STARTED than the fixture's Current Stage.
      appendStageStarted(dir, "user-stories", "2026-06-30T10:00:00.000Z");
      const r = runIde(dir, "sync-workflow-state", ctx("spec", "task updated"));
      expect(r.code).toBe(0);
      expect(/\*\*Current Stage\*\*:\s*user-stories/.test(readFileSync(seededStateFile(dir), "utf-8"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("6: state-sync is a clean no-op when the audit tail matches Current Stage", () => {
    const dir = scratchProject(true);
    try {
      const current = (readFileSync(seededStateFile(dir), "utf-8").match(/\*\*Current Stage\*\*:\s*([a-z0-9-]+)/) ?? [])[1];
      expect(current).toBeDefined();
      appendStageStarted(dir, current as string, "2026-06-30T10:00:00.000Z");
      const r = runIde(dir, "sync-workflow-state", ctx("spec", "task updated"));
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("7: rebuild-stage-graph dispatches off the audit tail with no command", () => {
    const dir = scratchProject(true);
    try {
      // A transition in the tail makes the core hook recompile; with no
      // transition it self-gates. Either way the adapter exits 0.
      const r = runIde(dir, "rebuild-stage-graph", ctx("execute_bash", "Output:\nok\n\nExit Code: 0"));
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("7b: rebuild-stage-graph actually compiles when the audit tail has a transition (no command needed)", () => {
    const dir = scratchProject(true);
    try {
      // Seed a STAGE_STARTED transition in the tail. The IDE never surfaces the
      // shell command, so the only way the graph compiles is the audit-tail
      // path (command filter skipped via the ide-audit-sync marker).
      appendStageStarted(dir, "intent-capture", "2026-06-30T10:00:00.000Z");
      const graphPath = join(seededRecordDir(dir), "runtime-graph.json");
      const r = runIde(dir, "rebuild-stage-graph", ctx("execute_bash", "Output:\nok\n\nExit Code: 0"));
      expect(r.code).toBe(0);
      // The compile wrote the runtime graph — proof the command filter was
      // bypassed and the audit-tail gate fired.
      expect(existsSync(graphPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("7c: modern session identity survives second-intent handoff into payload-free Stop and SessionEnd", () => {
    const dir = scratchProject(true);
    try {
      const sessionId = "sess_t218";
      const originalUuid = readIntentRegistry(dir)[0]?.uuid;
      const start = runIdeStdin(
        dir,
        "session-start",
        ctx1x("", "", "SessionStart"),
      );
      expect(start.code).toBe(0);
      expect(
        readFileSync(
          join(dir, "aidlc", ".aidlc-sessions", ".kiro-ide-current-session"),
          "utf-8",
        ).trim(),
      ).toBe(sessionId);

      expect(originalUuid).toBeDefined();
      expect(
        readFileSync(
          join(dir, "aidlc", ".aidlc-sessions", sessionId),
          "utf-8",
        ).trim(),
      ).toBe(originalUuid);

      const create = spawnSync(
        "bun",
        [
          join(dir, ".kiro", "tools", "aidlc-utility.ts"),
          "intent-create",
          "--scope",
          "bugfix",
          "--arguments",
          "new handoff work",
          "--project-dir",
          dir,
        ],
        {
          cwd: dir,
          encoding: "utf-8",
          env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
          timeout: 30_000,
        },
      );
      expect(create.status).toBe(0);
      const result = `Output:\n${create.stdout}\n\nExit Code: 0`;
      const bind = runIdeDispatcherStdin(
        dir,
        "rebuild-stage-graph",
        ctx1x("execute_bash", result),
      );
      expect(bind.code).toBe(0);
      const createdIntent = readIntentRegistry(dir).find(
        (intent) => intent.uuid !== originalUuid,
      );
      const createdUuid = createdIntent?.uuid;
      expect(createdUuid).toBeDefined();
      expect(createdIntent?.dirName).toBeDefined();
      if (!createdUuid || !createdIntent?.dirName) {
        throw new Error("intent-create did not produce a resolvable session handoff target");
      }
      expect(
        readFileSync(
          join(dir, "aidlc", ".aidlc-sessions", sessionId),
          "utf-8",
        ).trim(),
      ).toBe(createdUuid);
      const handoffPath = join(
        dir,
        "aidlc",
        ".aidlc-sessions",
        `${sessionId}.handoff.json`,
      );
      expect(JSON.parse(readFileSync(handoffPath, "utf-8"))).toMatchObject({
        fromIntentUuid: originalUuid,
        toIntentUuid: createdUuid,
      });

      const stop = runIde(dir, "continue-workflow", null);
      expect(stop.code).toBe(0);
      expect(stop.stdout.trim()).toBe("");
      expect(existsSync(handoffPath)).toBe(false);

      const before =
        readAllAuditShards(dir, createdIntent.dirName, DEFAULT_SPACE)
          .split("SESSION_ENDED").length - 1;
      const end = runIde(dir, "session-end", null);
      expect(end.code).toBe(0);
      const after =
        readAllAuditShards(dir, createdIntent.dirName, DEFAULT_SPACE)
          .split("SESSION_ENDED").length - 1;
      expect(after - before).toBe(1);
      expect(
        existsSync(
          join(
            intentsDirOf(dir, DEFAULT_SPACE),
            createdIntent.dirName,
            ".aidlc-hooks-health",
            "session-end.last",
          ),
        ),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("7d: legacy intent creation binds through the remembered synthetic session identity", () => {
    const dir = scratchProject(false);
    try {
      rmSync(intentsDirOf(dir, DEFAULT_SPACE), { recursive: true, force: true });
      const sessionId = legacySessionId(dir);
      expect(runIde(dir, "session-start", null).code).toBe(0);

      const create = spawnSync(
        "bun",
        [
          join(dir, ".kiro", "tools", "aidlc-utility.ts"),
          "intent-create",
          "--scope",
          "bugfix",
          "--arguments",
          "legacy create work",
          "--project-dir",
          dir,
        ],
        {
          cwd: dir,
          encoding: "utf-8",
          env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
          timeout: 30_000,
        },
      );
      expect(create.status).toBe(0);
      const bind = runIde(
        dir,
        "rebuild-stage-graph",
        ctx("execute_bash", `Output:\n${create.stdout}\n\nExit Code: 0`),
      );
      expect(bind.code).toBe(0);

      const createdUuid = readIntentRegistry(dir)[0]?.uuid;
      expect(createdUuid).toBeDefined();
      expect(
        readFileSync(
          join(dir, "aidlc", ".aidlc-sessions", sessionId),
          "utf-8",
        ).trim(),
      ).toBe(createdUuid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("7e: Stop prefers its event session identity over the latest SessionStart", () => {
    for (const entry of [
      { label: "direct", run: runIdeStdin },
      { label: "dispatcher", run: runIdeDispatcherStdin },
    ]) {
      const dir = scratchProject(true);
      try {
        const sessionOne = "sess_t218_one";
        const sessionTwo = "sess_t218_two";
        const originalUuid = readIntentRegistry(dir)[0]?.uuid;
        expect(originalUuid, entry.label).toBeDefined();
        expect(
          runIdeStdin(
            dir,
            "session-start",
            ctx1x("", "", "SessionStart", sessionOne),
          ).code,
          entry.label,
        ).toBe(0);

        const create = spawnSync(
          "bun",
          [
            join(dir, ".kiro", "tools", "aidlc-utility.ts"),
            "intent-create",
            "--scope",
            "bugfix",
            "--arguments",
            "session one handoff",
            "--project-dir",
            dir,
          ],
          {
            cwd: dir,
            encoding: "utf-8",
            env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
            timeout: 30_000,
          },
        );
        expect(create.status, entry.label).toBe(0);
        expect(
          runIdeStdin(
            dir,
            "rebuild-stage-graph",
            ctx1x(
              "execute_bash",
              `Output:\n${create.stdout}\n\nExit Code: 0`,
              "PostToolUse",
              sessionOne,
            ),
          ).code,
          entry.label,
        ).toBe(0);

        const handoffPath = join(
          dir,
          "aidlc",
          ".aidlc-sessions",
          `${sessionOne}.handoff.json`,
        );
        expect(existsSync(handoffPath), entry.label).toBe(true);

        expect(
          runIdeStdin(
            dir,
            "session-start",
            ctx1x("", "", "SessionStart", sessionTwo),
          ).code,
          entry.label,
        ).toBe(0);
        expect(
          readFileSync(
            join(dir, "aidlc", ".aidlc-sessions", ".kiro-ide-current-session"),
            "utf-8",
          ).trim(),
          entry.label,
        ).toBe(sessionTwo);

        const stop = entry.run(
          dir,
          "continue-workflow",
          JSON.stringify({
            session_id: sessionOne,
            hook_event_name: "Stop",
            cwd: dir,
          }),
        );
        expect(stop.code, entry.label).toBe(0);
        expect(stop.stdout.trim(), entry.label).toBe("");
        expect(existsSync(handoffPath), entry.label).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 15_000);

  test("8: session-start emits plain-text context, not the JSON wrapper", () => {
    const dir = scratchProject(true);
    try {
      const r = runIde(dir, "session-start", null);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("AIDLC WORKFLOW ACTIVE");
      expect(r.stdout).not.toContain("additionalContext");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("8b: session-start forwards modern session_id and derives a legacy host identity", () => {
    const dir = scratchProject(true);
    try {
      const modern = runIdeStdin(
        dir,
        "session-start",
        ctx1x("", "", "SessionStart"),
      );
      expect(modern.code).toBe(0);
      expect(
        readFileSync(join(dir, "aidlc", ".aidlc-sessions", "sess_t218"), "utf-8").trim(),
      ).toBe("00000000-0000-7000-8000-000000000001");

      const dispatcherPayload = JSON.stringify({
        session_id: "sess_t218_dispatcher",
        hook_event_name: "SessionStart",
      });
      const dispatcher = runIdeDispatcherStdin(
        dir,
        "session-start",
        dispatcherPayload,
      );
      expect(dispatcher.code).toBe(0);
      expect(
        readFileSync(
          join(dir, "aidlc", ".aidlc-sessions", "sess_t218_dispatcher"),
          "utf-8",
        ).trim(),
      ).toBe("00000000-0000-7000-8000-000000000001");

      const legacy = runIde(
        dir,
        "session-start",
        JSON.stringify({ prompt: "continue" }),
      );
      expect(legacy.code).toBe(0);
      expect(
        readFileSync(
          join(dir, "aidlc", ".aidlc-sessions", legacySessionId(dir)),
          "utf-8",
        ).trim(),
      ).toBe("00000000-0000-7000-8000-000000000001");
      const legacyHostMarker = join(
        dir,
        "aidlc",
        ".aidlc-sessions",
        `.kiro-ide-legacy-plan-approval-${legacySessionId(dir)}.json`,
      );
      expect(
        JSON.parse(readFileSync(legacyHostMarker, "utf-8")).session,
      ).toBe(legacySessionId(dir));

      expect(
        runIdeStdin(
          dir,
          "session-start",
          ctx1x("", "", "SessionStart"),
          {
            VSCODE_IPC_HOOK: `test-ipc:${dir}`,
            VSCODE_PID: "218",
          },
        ).code,
      ).toBe(0);
      expect(existsSync(legacyHostMarker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("8c: modern prompt interception preserves UTF-8 and strips terminal controls", () => {
    const dir = scratchProject(true);
    try {
      const countPath = installPlainTextUtility(dir);
      const r = runIdeStdin(
        dir,
        "verb-intercept",
        JSON.stringify({
          session_id: "sess_terminal_modern",
          hook_event_name: "UserPromptSubmit",
          cwd: dir,
          prompt: "/aidlc --status",
        }),
      );
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
      expect(readFileSync(countPath, "utf-8").trim()).toBe("1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("8d: empty-prompt IDEs intercept execute_pwsh once and preserve exit-2 refusal semantics", () => {
    const dir = scratchProject(true);
    try {
      const countPath = installPlainTextUtility(dir);
      const prompt = runIdeStdin(
        dir,
        "verb-intercept",
        JSON.stringify({
          session_id: "sess_terminal_legacy_prompt",
          hook_event_name: "UserPromptSubmit",
          cwd: dir,
          prompt: "",
        }),
      );
      expect(prompt.code).toBe(0);
      expect(prompt.stdout).toBe("");

      const payload = JSON.stringify({
        session_id: "sess_terminal_legacy_prompt",
        hook_event_name: "PreToolUse",
        cwd: dir,
        tool_name: "execute_pwsh",
        tool_input: {
          command: "bun .kiro/tools/aidlc-orchestrate.ts next --status",
          cwd: dir,
          run_in_background: false,
          timeout: null,
        },
      });
      const first = runIdeStdin(dir, "terminal-command-guard", payload);
      expect(first.code).toBe(2);
      expect(first.stdout).toBe("");
      expect(first.stderr).toContain("Unicode: ─ ✓ █▒ ⇄");
      expect(first.stderr).toContain("OUTPUT (exit 7)");
      expect(first.stderr).not.toContain("\u001b");
      expect(first.stderr).not.toContain("Cwd=C:\\shell\\noise");
      expect(readFileSync(countPath, "utf-8").trim()).toBe("1");

      const retry = runIdeDispatcherStdin(
        dir,
        "terminal-command-guard",
        payload,
      );
      expect(retry.code).toBe(2);
      expect(retry.stderr).toContain("already run inside the hook");
      expect(readFileSync(countPath, "utf-8").trim()).toBe("1");

      const nextTurn = runIdeStdin(
        dir,
        "verb-intercept",
        JSON.stringify({
          session_id: "sess_terminal_legacy_prompt",
          hook_event_name: "UserPromptSubmit",
          prompt: "/aidlc --stage requirements-analysis",
        }),
      );
      expect(nextTurn.code).toBe(0);
      const nonTerminal = runIdeStdin(
        dir,
        "terminal-command-guard",
        JSON.stringify({
          session_id: "sess_terminal_legacy_prompt",
          hook_event_name: "PreToolUse",
          tool_name: "execute_pwsh",
          tool_input: {
            command:
              "bun .kiro/tools/aidlc-orchestrate.ts next --stage requirements-analysis",
          },
        }),
      );
      expect(nonTerminal.code).toBe(0);
      expect(nonTerminal.stderr).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("8e: concurrent modern sessions keep terminal turns and output isolated", () => {
    const dir = scratchProject(true);
    try {
      const commandLog = join(dir, "terminal-commands.log");
      writeFileSync(
        join(dir, ".kiro", "tools", "aidlc-utility.ts"),
        [
          'import { appendFileSync } from "node:fs";',
          `const log = ${JSON.stringify(commandLog)};`,
          'appendFileSync(log, process.argv[2] + "\\n", "utf-8");',
          'process.stdout.write("UTILITY=" + process.argv[2] + "\\n");',
        ].join("\n"),
        "utf-8",
      );
      const prompt = (sessionId: string) =>
        runIdeStdin(
          dir,
          "verb-intercept",
          JSON.stringify({
            session_id: sessionId,
            hook_event_name: "UserPromptSubmit",
            prompt: "",
          }),
        );
      const guard = (sessionId: string, flag: string) =>
        runIdeStdin(
          dir,
          "terminal-command-guard",
          JSON.stringify({
            session_id: sessionId,
            hook_event_name: "PreToolUse",
            tool_name: "execute_pwsh",
            tool_input: {
              command:
                `bun .kiro/tools/aidlc-orchestrate.ts next ${flag}`,
            },
          }),
        );

      expect(prompt("session-A").code).toBe(0);
      expect(prompt("session-B").code).toBe(0);

      const status = guard("session-A", "--status");
      const doctor = guard("session-B", "--doctor");
      expect(status.code).toBe(2);
      expect(status.stderr).toContain("UTILITY=status");
      expect(status.stderr).not.toContain("UTILITY=doctor");
      expect(doctor.code).toBe(2);
      expect(doctor.stderr).toContain("UTILITY=doctor");
      expect(doctor.stderr).not.toContain("UTILITY=status");
      expect(readFileSync(commandLog, "utf-8").trim().split("\n")).toEqual([
        "status",
        "doctor",
      ]);

      const retry = guard("session-A", "--status");
      expect(retry.code).toBe(2);
      expect(retry.stderr).toContain("UTILITY=status");
      expect(readFileSync(commandLog, "utf-8").trim().split("\n")).toEqual([
        "status",
        "doctor",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("8f: newer raw prompt payloads keep terminal interception working", () => {
    const dir = scratchProject(true);
    try {
      const countPath = installPlainTextUtility(dir);
      const r = runIde(dir, "verb-intercept", "/aidlc --status");
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Unicode: ─ ✓ █▒ ⇄");
      expect(r.stdout).not.toContain("\u001b");
      expect(readFileSync(countPath, "utf-8").trim()).toBe("1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("8g: legacy camelCase USER_PROMPT falls back through toolArgs.command", () => {
    const dir = scratchProject(true);
    try {
      const countPath = installPlainTextUtility(dir);
      const prompt = runIde(
        dir,
        "verb-intercept",
        JSON.stringify({
          toolName: "",
          toolArgs: {},
          toolResult: "",
          toolSuccess: true,
        }),
      );
      expect(prompt.code).toBe(0);
      expect(prompt.stdout).toBe("");

      const guard = runIde(
        dir,
        "terminal-command-guard",
        JSON.stringify({
          toolName: "execute_bash",
          toolArgs: {
            command: "bun .kiro/tools/aidlc-orchestrate.ts next --status",
          },
          toolResult: "",
          toolSuccess: true,
        }),
      );
      expect(guard.code).toBe(2);
      expect(guard.stderr).toContain("Unicode: ─ ✓ █▒ ⇄");
      expect(guard.stderr).not.toContain("\u001b");
      expect(readFileSync(countPath, "utf-8").trim()).toBe("1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("8h: prompt and pre-tool interception preserve native Windows output paths", () => {
    const dir = scratchProject(true);
    try {
      const argvPath = installArgvUtility(dir);
      for (const [index, prompt, expected] of [
        [
          1,
          String.raw`/aidlc --doctor --export --output C:\temp\diag`,
          String.raw`C:\temp\diag`,
        ],
        [
          2,
          String.raw`/aidlc --doctor --export --output "C:\Program Files\diag"`,
          String.raw`C:\Program Files\diag`,
        ],
        [
          3,
          String.raw`/aidlc --doctor --export --output \\server\share\diag`,
          String.raw`\\server\share\diag`,
        ],
      ] as const) {
        const r = runIdeStdin(
          dir,
          "verb-intercept",
          JSON.stringify({
            session_id: `path-session-${index}`,
            hook_event_name: "UserPromptSubmit",
            prompt,
          }),
        );
        expect(r.code, prompt).toBe(0);
        expect(
          JSON.parse(readFileSync(argvPath, "utf-8")),
          prompt,
        ).toEqual(["doctor", "--export", "--output", expected]);
      }

      expect(
        runIdeStdin(
          dir,
          "verb-intercept",
          JSON.stringify({
            session_id: "path-fallback",
            hook_event_name: "UserPromptSubmit",
            prompt: "",
          }),
        ).code,
      ).toBe(0);
      const fallback = runIdeStdin(
        dir,
        "terminal-command-guard",
        JSON.stringify({
          session_id: "path-fallback",
          hook_event_name: "PreToolUse",
          tool_name: "execute_pwsh",
          tool_input: {
            command:
              String.raw`bun .kiro/tools/aidlc-orchestrate.ts next --doctor --export --output C:\fallback\diag`,
          },
        }),
      );
      expect(fallback.code).toBe(2);
      expect(JSON.parse(readFileSync(argvPath, "utf-8"))).toEqual([
        "doctor",
        "--export",
        "--output",
        String.raw`C:\fallback\diag`,
      ]);

      for (const [index, prompt, expected] of [
        [
          1,
          '/aidlc --doctor --output "C:\\" --export',
          "C:\\",
        ],
        [
          2,
          '/aidlc --doctor --output "C:\\Program Files\\diag\\" --export',
          "C:\\Program Files\\diag\\",
        ],
        [
          3,
          '/aidlc --doctor --output "out\\" --export',
          "out\\",
        ],
      ] as const) {
        const r = runIdeStdin(
          dir,
          "verb-intercept",
          JSON.stringify({
            session_id: `path-trailing-${index}`,
            hook_event_name: "UserPromptSubmit",
            prompt,
          }),
        );
        expect(r.code, prompt).toBe(0);
        expect(
          JSON.parse(readFileSync(argvPath, "utf-8")),
          prompt,
        ).toEqual(["doctor", "--output", expected, "--export"]);
      }

      expect(
        runIdeStdin(
          dir,
          "verb-intercept",
          JSON.stringify({
            session_id: "path-relative-fallback",
            hook_event_name: "UserPromptSubmit",
            prompt: "",
          }),
        ).code,
      ).toBe(0);
      const relativeFallback = runIdeStdin(
        dir,
        "terminal-command-guard",
        JSON.stringify({
          session_id: "path-relative-fallback",
          hook_event_name: "PreToolUse",
          tool_name: "execute_pwsh",
          tool_input: {
            command:
              String.raw`bun .kiro/tools/aidlc-orchestrate.ts next --doctor --output .\diag\ --export`,
          },
        }),
      );
      expect(relativeFallback.code).toBe(2);
      expect(JSON.parse(readFileSync(argvPath, "utf-8"))).toEqual([
        "doctor",
        "--output",
        ".\\diag\\",
        "--export",
      ]);

      expect(
        runIdeStdin(
          dir,
          "verb-intercept",
          JSON.stringify({
            session_id: "path-single-relative",
            hook_event_name: "UserPromptSubmit",
            prompt:
              String.raw`/aidlc --doctor --output out\ --export`,
          }),
        ).code,
      ).toBe(0);
      expect(JSON.parse(readFileSync(argvPath, "utf-8"))).toEqual([
        "doctor",
        "--output",
        "out\\",
        "--export",
      ]);

      const escapedSpacePrompt = runIdeStdin(
        dir,
        "verb-intercept",
        JSON.stringify({
          session_id: "path-posix-space",
          hook_event_name: "UserPromptSubmit",
          prompt:
            String.raw`/aidlc --doctor --export --output /tmp/report\ dir`,
        }),
      );
      expect(escapedSpacePrompt.code).toBe(0);
      expect(JSON.parse(readFileSync(argvPath, "utf-8"))).toEqual([
        "doctor",
        "--export",
        "--output",
        "/tmp/report dir",
      ]);

      expect(
        runIdeStdin(
          dir,
          "verb-intercept",
          JSON.stringify({
            session_id: "path-posix-space-fallback",
            hook_event_name: "UserPromptSubmit",
            prompt: "",
          }),
        ).code,
      ).toBe(0);
      const escapedSpaceFallback = runIdeStdin(
        dir,
        "terminal-command-guard",
        JSON.stringify({
          session_id: "path-posix-space-fallback",
          hook_event_name: "PreToolUse",
          tool_name: "execute_bash",
          tool_input: {
            command:
              String.raw`bun .kiro/tools/aidlc-orchestrate.ts next --doctor --export --output reports\ 2026`,
          },
        }),
      );
      expect(escapedSpaceFallback.code).toBe(2);
      expect(JSON.parse(readFileSync(argvPath, "utf-8"))).toEqual([
        "doctor",
        "--export",
        "--output",
        "reports 2026",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("9: stop blocks with a reason while the workflow has pending work", () => {
    const dir = scratchProject(true);
    try {
      const r = runIde(dir, "continue-workflow", null);
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout) as { decision?: string };
      expect(out.decision).toBe("block");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("10: a missing USER_PROMPT fails open (exit 0) on payload targets", () => {
    const dir = scratchProject(true);
    try {
      for (const target of ["audit-and-sensors"]) {
        const r = runIde(dir, target, null);
        expect(`${target}:${r.code}`).toBe(`${target}:0`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("11: malformed USER_PROMPT fails open (exit 0)", () => {
    const dir = scratchProject(true);
    try {
      const r = runIde(dir, "audit-and-sensors", "{not json");
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("12: an empty (closed) stdin falls back to USER_PROMPT — the 0.12 channel keeps working", () => {
    // The payload targets now read stdin FIRST (the 1.x channel), raced
    // against a timeout. With stdin closed empty (spawnSync input:"") the read
    // resolves instantly and the adapter falls back to USER_PROMPT — the 0.12
    // contract this test pins.
    const dir = scratchProject(true);
    try {
      const file = join(seededRecordDir(dir), "ideation", "intent-capture", "intent.md");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "# intent\n");
      const r = runIde(dir, "audit-and-sensors", ctx("fs_write", `Created the ${file} file.`));
      expect(r.code).toBe(0);
      expect(readAudit(dir)).toContain("ARTIFACT_CREATED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });


  test("13: hook-debug.log is OPT-IN — absent without AIDLC_HOOK_DEBUG, present with it", () => {
    const debugLogPath = (dir: string) =>
      join(seededRecordDir(dir), ".aidlc-hooks-health", "hook-debug.log");
    const fire = (dir: string, withFlag: boolean) => {
      const file = join(seededRecordDir(dir), "ideation", "intent-capture", "intent.md");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "# intent\n");
      const env: Record<string, string> = { ...process.env, CLAUDE_PROJECT_DIR: dir };
      env.USER_PROMPT = ctx("fs_write", `Created the ${file} file.`);
      if (withFlag) env.AIDLC_HOOK_DEBUG = "1";
      else delete (env as Record<string, string | undefined>).AIDLC_HOOK_DEBUG;
      spawnSync("bun", [join(dir, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), "audit-and-sensors"], {
        cwd: dir,
        input: "",
        encoding: "utf-8",
        env,
        timeout: 30_000,
      });
    };

    // Off by default: USER_PROMPT alone must NOT enable debug logging.
    const dirOff = scratchProject(true);
    try {
      fire(dirOff, false);
      expect(existsSync(debugLogPath(dirOff))).toBe(false);
    } finally {
      rmSync(dirOff, { recursive: true, force: true });
    }

    // On with the flag: the decision trace is written.
    const dirOn = scratchProject(true);
    try {
      fire(dirOn, true);
      expect(existsSync(debugLogPath(dirOn))).toBe(true);
      expect(readFileSync(debugLogPath(dirOn), "utf-8")).toContain("write-audit-log");
    } finally {
      rmSync(dirOn, { recursive: true, force: true });
    }
  });

  test("13b: the filesystem marker aidlc/.aidlc-hook-debug enables logging (no env var)", () => {
    const debugLogPath = (dir: string) =>
      join(seededRecordDir(dir), ".aidlc-hooks-health", "hook-debug.log");
    const dir = scratchProject(true);
    try {
      // touch the marker; do NOT set AIDLC_HOOK_DEBUG.
      writeFileSync(join(dir, "aidlc", ".aidlc-hook-debug"), "", "utf-8");
      const file = join(seededRecordDir(dir), "ideation", "intent-capture", "intent.md");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "# intent\n");
      const env: Record<string, string> = { ...process.env, CLAUDE_PROJECT_DIR: dir };
      env.USER_PROMPT = ctx("fs_write", `Created the ${file} file.`);
      delete (env as Record<string, string | undefined>).AIDLC_HOOK_DEBUG;
      spawnSync("bun", [join(dir, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), "audit-and-sensors"], {
        cwd: dir,
        input: "",
        encoding: "utf-8",
        env,
        timeout: 30_000,
      });
      expect(existsSync(debugLogPath(dir))).toBe(true);
      expect(readFileSync(debugLogPath(dir), "utf-8")).toContain("write-audit-log");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// The IDE 1.x stdin channel (upstream #543/#555): snake_case JSON on stdin,
// USER_PROMPT empty. Payload acquisition is raced against a 2s timeout and
// GATED to the two payload-dependent targets — every other target must never
// touch stdin (block fires on EVERY PreToolUse).
// ============================================================

/** Spawn the adapter with stdin OPENED BUT NEVER WRITTEN/CLOSED (the 0.12
 *  stdin shape that hangs a bare read). Resolves with the exit code, or
 *  code:null if the adapter was still running after killAfterMs. */
interface OpenStdinRun {
  code: number | null;
  elapsedMs: number;
  stdout: string;
  timedOut: boolean;
}

/** The stdin ceiling raised far above any plausible CI scheduling delay. The
 *  latency cases assert "this path never probed stdin" by requiring the process
 *  to finish well inside this window: probing a held-open stdin would park for
 *  the full RAISED_STDIN_TIMEOUT_MS, while the env-channel path returns in
 *  milliseconds. That keeps the discriminator deterministic under load instead
 *  of resting on a tight millisecond budget near the production 2s ceiling. */
const RAISED_STDIN_TIMEOUT_MS = 15_000;
const NO_STDIN_PROBE_BUDGET_MS = 8_000;

async function runIdeOpenStdin(
  projectDir: string,
  target: string,
  userPrompt: string | null,
  killAfterMs: number,
  extraEnv: Record<string, string> = {},
): Promise<OpenStdinRun> {
  return await runOpenStdinCommand(
    projectDir,
    [join(projectDir, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), target],
    userPrompt,
    killAfterMs,
    extraEnv,
  );
}

async function runIdeDispatcherOpenStdin(
  projectDir: string,
  target: string,
  userPrompt: string | null,
  killAfterMs: number,
  extraEnv: Record<string, string> = {},
): Promise<OpenStdinRun> {
  return await runOpenStdinCommand(
    projectDir,
    [join(projectDir, ".kiro", "tools", "aidlc.ts"), "adapter", "kiro-ide", target],
    userPrompt,
    killAfterMs,
    extraEnv,
  );
}

async function runOpenStdinCommand(
  projectDir: string,
  args: string[],
  userPrompt: string | null,
  killAfterMs: number,
  extraEnv: Record<string, string> = {},
): Promise<OpenStdinRun> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_PROJECT_DIR: projectDir,
    ...extraEnv,
  };
  if (userPrompt === null) delete env.USER_PROMPT;
  else env.USER_PROMPT = userPrompt;
  const started = Date.now();
  const proc = Bun.spawn({
    cmd: ["bun", ...args],
    cwd: projectDir,
    stdin: "pipe", // held open: never written, never closed
    stdout: "pipe",
    stderr: "ignore",
    env,
  });
  const timedOutMarker = Symbol("timedOut");
  const outcome = await Promise.race([
    proc.exited,
    new Promise((settle) => setTimeout(() => settle(timedOutMarker), killAfterMs)),
  ]);
  const elapsedMs = Date.now() - started;
  if (outcome === timedOutMarker) {
    proc.kill();
    await proc.exited;
    return { code: null, elapsedMs, stdout: "", timedOut: true };
  }
  const stdout = await new Response(proc.stdout).text();
  return { code: proc.exitCode, elapsedMs, stdout, timedOut: false };
}

describe("t218 Kiro IDE plan-approval enforcement", () => {
  test("populated 1.x PreToolUse write and dispatch payloads are blocked before approval", () => {
    const dir = scratchProject(true);
    try {
      seedCodeGenerationDirective(dir);
      const write = runIdeStdin(
        dir,
        "plan-approval-guard",
        JSON.stringify({
          hook_event_name: "PreToolUse",
          cwd: dir,
          tool_name: "fs_write",
          tool_input: { path: join(dir, "src", "blocked.ts") },
        }),
      );
      expect(write.code).toBe(2);

      const dispatch = runIdeStdin(
        dir,
        "plan-approval-guard",
        JSON.stringify({
          hook_event_name: "PreToolUse",
          cwd: dir,
          tool_name: "subagent_aidlc-developer-agent",
          tool_input: {
            prompt:
              "AIDLC-STAGE: code-generation\n" +
              `AIDLC-TESTING-CONTRACT: sha256:${"a".repeat(64)}`,
          },
        }),
      );
      expect(dispatch.code).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("legacy 0.12 consumes directive-issued choices while PostToolUse stays silent", () => {
    const dir = scratchProject(true);
    try {
      const registration = JSON.parse(
        readFileSync(
          join(KIRO_IDE_TREE, "hooks", "aidlc-record-human-turn.kiro.hook"),
          "utf-8",
        ),
      ) as {
        when?: { type?: string };
        then?: { command?: string };
      };
      expect(registration.when?.type).toBe("promptSubmit");
      expect(registration.then?.command).toContain(
        "aidlc-kiro-adapter.ts record-human-turn",
      );
      initGitWorkspace(dir);
      seedCodeGenerationDirective(dir);
      const choices = seedLegacyDirectiveChoices(dir);
      expect(runIde(dir, "session-start", null).code).toBe(0);

      // Kiro IDE 0.12 names the tool in USER_PROMPT but supplies no arguments.
      // Planning writes remain possible before the exact approval prompt.
      expect(
        runIde(
          dir,
          "plan-approval-guard",
          JSON.stringify({ toolName: "fs_write", toolArgs: {} }),
        ).code,
      ).toBe(0);
      for (const toolName of [
        "execute_bash",
        "fs_append",
        "create_file",
        "edit_file",
      ]) {
        expect(
          runIde(
            dir,
            "plan-approval-guard",
            JSON.stringify({ toolName, toolArgs: {} }),
          ).code,
          toolName,
        ).toBe(2);
      }

      const questions = seedStageLevelPlanApproval(dir);
      const decision = runIde(
        dir,
        "audit-and-sensors",
        ctx("fs_write", `Created the ${relative(dir, questions)} file.`),
      );
      expect(decision.code).toBe(0);
      expect(decision.stdout.trim()).toBe("");
      expect(readAudit(dir)).toContain("DECISION_RECORDED");
      expect(readFileSync(questions, "utf-8")).not.toMatch(
        /Approve Plan \[[0-9a-f]{8}\]/,
      );

      // Once the prompt is recorded, opaque legacy calls hard-stop until the
      // human answers.
      expect(
        runIde(
          dir,
          "plan-approval-guard",
          JSON.stringify({ toolName: "execute_bash", toolArgs: {} }),
        ).code,
      ).toBe(2);
      expect(runIde(dir, "plan-approval-guard", null).code).toBe(2);

      // A plain label from any same-host chat is not the directive capability
      // and receives no secret in return.
      const foreignReply = runIde(
        dir,
        "record-human-turn",
        JSON.stringify({ prompt: "Approve Plan" }),
      );
      expect(foreignReply.code).toBe(0);
      expect(foreignReply.stdout.trim()).toBe("");
      expect(
        runIde(
          dir,
          "record-human-turn",
          JSON.stringify({ prompt: choices.approve }),
        ).code,
      ).toBe(0);
      expect(
        runIde(
          dir,
          "plan-approval-guard",
          JSON.stringify({ toolName: "fs_write", toolArgs: {} }),
        ).code,
      ).toBe(0);

      // A source mutation made anywhere in that opaque window cannot be
      // legitimized by the later approval receipt.
      writeFileSync(join(dir, "src", "base.ts"), "export const base = false;\n");
      writeFileSync(
        questions,
        readFileSync(questions, "utf-8").replace(
          "[Answer]:",
          "[Answer]: Approve Plan",
        ),
      );
      // The refusal is visible: the answer's mediation surfaces its reason on
      // stderr with exit 2 instead of a silent hook drop, and the receipt is
      // never written.
      const driftedAnswer = runIde(
        dir,
        "audit-and-sensors",
        ctx("fs_write", `Created the ${relative(dir, questions)} file.`),
      );
      expect(driftedAnswer.code).toBe(2);
      expect(driftedAnswer.stderr).toContain(
        "Legacy Plan Approval mediation did not complete",
      );
      expect(driftedAnswer.stderr).toContain("Workspace source changed");
      expect(evaluateCodeGenerationApproval(dir, { unit: null }).ok).toBe(false);
      expect(
        runIde(
          dir,
          "plan-approval-guard",
          JSON.stringify({ toolName: "execute_bash", toolArgs: {} }),
        ).code,
      ).toBe(2);
      expect(readAudit(dir)).not.toContain(
        "**Event**: PLAN_APPROVAL_RECORDED",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  test("legacy file-tool mediation injects the contract and records a valid human approval", () => {
    const dir = scratchProject(true);
    try {
      initGitWorkspace(dir);
      seedCodeGenerationDirective(dir);
      const choices = seedLegacyDirectiveChoices(dir);
      expect(runIde(dir, "session-start", null).code).toBe(0);
      expect(
        runIde(
          dir,
          "plan-approval-guard",
          JSON.stringify({ toolName: "fs_write", toolArgs: {} }),
        ).code,
      ).toBe(0);
      const questions = seedStageLevelPlanApproval(dir);
      const plan = join(
        seededRecordDir(dir),
        "construction",
        "code-generation",
        "code-generation-plan.md",
      );
      writeFileSync(plan, "# Plan\n\n## Steps\n\n- [ ] Implement\n", "utf-8");
      expect(
        runIde(
          dir,
          "audit-and-sensors",
          ctx("fs_write", `Created the ${relative(dir, plan)} file.`),
        ).code,
      ).toBe(0);
      expect(readFileSync(plan, "utf-8")).toContain("## Testing Contract");
      const decision = runIde(
        dir,
        "audit-and-sensors",
        ctx("fs_write", `Created the ${relative(dir, questions)} file.`),
      );
      expect(decision.code).toBe(0);
      expect(decision.stdout.trim()).toBe("");
      expect(readAudit(dir)).toContain("DECISION_RECORDED");
      expect(readFileSync(questions, "utf-8")).not.toMatch(
        /Approve Plan \[[0-9a-f]{8}\]/,
      );
      expect(
        runIde(
          dir,
          "record-human-turn",
          JSON.stringify({ prompt: choices.approve }),
        ).code,
      ).toBe(0);
      writeFileSync(
        questions,
        readFileSync(questions, "utf-8").replace(
          "[Answer]:",
          "[Answer]: Approve Plan",
        ),
      );
      expect(
        runIde(
          dir,
          "audit-and-sensors",
          ctx("fs_write", `Created the ${relative(dir, questions)} file.`),
        ).code,
      ).toBe(0);
      expect(evaluateCodeGenerationApproval(dir, { unit: null }).ok).toBe(true);
      expect(
        runIde(
          dir,
          "plan-approval-guard",
          JSON.stringify({ toolName: "execute_bash", toolArgs: {} }),
        ).code,
      ).toBe(0);
      expect(runIde(dir, "plan-approval-guard", null).code).toBe(0);
      writeFileSync(
        join(dir, "src", "legacy-generated.ts"),
        "export const generated = true;\n",
      );
      expect(runIde(dir, "plan-approval-guard", null).code).toBe(0);
      expect(
        runIde(
          dir,
          "plan-approval-guard",
          JSON.stringify({ toolName: "execute_bash", toolArgs: {} }),
        ).code,
      ).toBe(0);
      expect(evaluateCodeGenerationApproval(dir, { unit: null }).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  test("legacy mediation records both approval tags from a section that carries neither", () => {
    const dir = scratchProject(true);
    try {
      initGitWorkspace(dir);
      seedCodeGenerationDirective(dir);
      const choices = seedLegacyDirectiveChoices(dir);
      expect(runIde(dir, "session-start", null).code).toBe(0);
      expect(
        runIde(
          dir,
          "plan-approval-guard",
          JSON.stringify({ toolName: "fs_write", toolArgs: {} }),
        ).code,
      ).toBe(0);
      const questions = seedStageLevelPlanApproval(dir, { bareSection: true });
      const before = readFileSync(questions, "utf-8");
      expect(before).not.toContain("[Approval Fingerprint]:");
      expect(before).not.toContain("[Planned Source]:");

      const decision = runIde(
        dir,
        "audit-and-sensors",
        ctx("fs_write", `Created the ${relative(dir, questions)} file.`),
      );
      expect(decision.code, decision.stderr).toBe(0);
      expect(decision.stdout.trim()).toBe("");
      const after = readFileSync(questions, "utf-8");
      expect(after).toMatch(/^\[Approval Fingerprint\]: sha256:v3:[0-9a-f]{64}$/m);
      expect(after).toMatch(
        new RegExp(
          `^\\[Planned Source\\]: ${workspaceSourceFingerprint(dir) ?? "unbindable"}$`,
          "m",
        ),
      );
      // Both tags sit inside the section, above the answer line the human fills.
      expect(after.indexOf("[Approval Fingerprint]:")).toBeLessThan(
        after.indexOf("[Answer]:"),
      );
      expect(after.indexOf("[Planned Source]:")).toBeLessThan(
        after.indexOf("[Answer]:"),
      );
      expect(readAudit(dir)).toContain("DECISION_RECORDED");

      // The adapter-recorded planned source is the one core accepts: the human
      // answer completes to a valid approval with no hand-seeded tag anywhere.
      expect(
        runIde(
          dir,
          "record-human-turn",
          JSON.stringify({ prompt: choices.approve }),
        ).code,
      ).toBe(0);
      writeFileSync(
        questions,
        readFileSync(questions, "utf-8").replace(
          "[Answer]:",
          "[Answer]: Approve Plan",
        ),
      );
      const answer = runIde(
        dir,
        "audit-and-sensors",
        ctx("fs_write", `Created the ${relative(dir, questions)} file.`),
      );
      expect(answer.code, answer.stderr).toBe(0);
      expect(evaluateCodeGenerationApproval(dir, { unit: null }).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  test("legacy same-host chats cannot consume or overwrite another challenge", () => {
    const dir = scratchProject(true);
    const sharedHost = {
      VSCODE_IPC_HOOK: `shared-chat-host:${dir}`,
      VSCODE_PID: "301",
    };
    try {
      initGitWorkspace(dir);
      seedCodeGenerationDirective(dir);
      const choices = seedLegacyDirectiveChoices(dir, sharedHost);
      expect(runIde(dir, "session-start", null, sharedHost).code).toBe(0);
      const questions = seedStageLevelPlanApproval(dir);
      const plan = join(
        seededRecordDir(dir),
        "construction",
        "code-generation",
        "code-generation-plan.md",
      );
      writeFileSync(plan, "# Plan\n\n## Steps\n\n- [ ] Implement\n");
      expect(
        runIde(
          dir,
          "audit-and-sensors",
          ctx("fs_write", `Created the ${relative(dir, plan)} file.`),
          sharedHost,
        ).code,
      ).toBe(0);
      const decisionA = runIde(
        dir,
        "audit-and-sensors",
        ctx("fs_write", `Created the ${relative(dir, questions)} file.`),
        sharedHost,
      );
      expect(decisionA.code).toBe(0);
      expect(decisionA.stdout.trim()).toBe("");

      // A second decision write from the same host while the first challenge is
      // live is refused by the decision tool. The refusal is visible (exit 2 and
      // its reason on stderr), and nothing about the live challenge changes.
      const overwrite = runIde(
        dir,
        "audit-and-sensors",
        ctx("fs_write", `Created the ${relative(dir, questions)} file.`),
        sharedHost,
      );
      expect(overwrite.code).toBe(2);
      expect(overwrite.stdout.trim()).toBe("");
      expect(overwrite.stderr).toContain(
        "Legacy Plan Approval mediation did not complete",
      );

      expect(readFileSync(questions, "utf-8")).not.toContain(choices.approve);
      expect(readAudit(dir)).not.toContain(choices.approve);
      const foreignReply = runIde(
        dir,
        "record-human-turn",
        JSON.stringify({ prompt: "Approve Plan" }),
        sharedHost,
      );
      expect(foreignReply.code).toBe(0);
      expect(foreignReply.stdout.trim()).toBe("");
      writeFileSync(
        questions,
        readFileSync(questions, "utf-8").replace(
          "[Answer]:",
          "[Answer]: Approve Plan",
        ),
      );
      // No capability was consumed, so the answer cannot be recorded. The
      // refusal is visible (exit 2 with its reason), and no receipt exists.
      const unconsumed = runIde(
        dir,
        "audit-and-sensors",
        ctx("fs_write", `Created the ${relative(dir, questions)} file.`),
        sharedHost,
      );
      expect(unconsumed.code).toBe(2);
      expect(unconsumed.stderr).toContain(
        "Legacy Plan Approval mediation did not complete",
      );
      expect(evaluateCodeGenerationApproval(dir, { unit: null }).ok).toBe(false);

      expect(
        runIde(
          dir,
          "record-human-turn",
          JSON.stringify({ prompt: choices.approve }),
          sharedHost,
        ).code,
      ).toBe(0);
      expect(
        runIde(
          dir,
          "audit-and-sensors",
          ctx("fs_write", `Created the ${relative(dir, questions)} file.`),
          sharedHost,
        ).code,
      ).toBe(0);
      expect(evaluateCodeGenerationApproval(dir, { unit: null }).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test("legacy noncanonical writes stay poisoned unless human recovery preserves the source floor", () => {
    for (const target of [
      "record",
      "harness",
      "external",
      "unresolved",
    ] as const) {
      const dir = scratchProject(true);
      try {
        initGitWorkspace(dir);
        seedCodeGenerationDirective(dir);
        expect(
          runIde(
            dir,
            "plan-approval-guard",
            JSON.stringify({ toolName: "fs_write", toolArgs: {} }),
          ).code,
        ).toBe(0);
        const path =
          target === "record"
            ? join(seededRecordDir(dir), "construction", "unexpected.md")
            : target === "harness"
              ? join(dir, ".kiro", "hooks", "unexpected.ts")
              : `${dir}-external-write.txt`;
        if (target !== "unresolved") {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, "unexpected\n", "utf-8");
        }
        const result =
          target === "unresolved"
            ? "Wrote a file successfully"
            : `Created the ${path} file.`;
        expect(
          runIde(
            dir,
            "audit-and-sensors",
            ctx("fs_write", result),
          ).code,
          target,
        ).toBe(0);
        expect(
          runIde(
            dir,
            "plan-approval-guard",
            JSON.stringify({ toolName: "fs_write", toolArgs: {} }),
          ).code,
          target,
        ).toBe(2);
        const recovery = runIde(
          dir,
          "plan-approval-guard",
          JSON.stringify({ toolName: "execute_bash", toolArgs: {} }),
        );
        expect(recovery.code, target).toBe(2);
        expect(recovery.stderr, target).toContain(
          "recovery requires a human response",
        );
        expect(
          runIde(
            dir,
            "plan-approval-guard",
            JSON.stringify({ toolName: "fs_write", toolArgs: {} }),
          ).code,
          target,
        ).toBe(2);
        expect(
          runIde(
            dir,
            "record-human-turn",
            JSON.stringify({ prompt: "continue" }),
          ).code,
          target,
        ).toBe(0);
        const noisyRecovery = runIde(
          dir,
          "plan-approval-guard",
          JSON.stringify({ toolName: "execute_bash", toolArgs: {} }),
        );
        expect(noisyRecovery.code, target).toBe(2);
        expect(noisyRecovery.stderr, target).toContain(
          "recovery requires a human response",
        );
        expect(
          runIde(
            dir,
            "record-human-turn",
            JSON.stringify({ prompt: "Recover Plan Approval" }),
          ).code,
          target,
        ).toBe(0);
        const recovered = runIde(
          dir,
          "plan-approval-guard",
          JSON.stringify({ toolName: "execute_bash", toolArgs: {} }),
        );
        expect(recovered.code, target).toBe(2);
        expect(recovered.stderr, target).toContain(
          "recovery issued a fresh directive",
        );
        const afterRecovery = runIde(
          dir,
          "plan-approval-guard",
          JSON.stringify({ toolName: "fs_write", toolArgs: {} }),
        );
        expect(afterRecovery.code, target).toBe(target === "harness" ? 2 : 0);
      } finally {
        rmSync(`${dir}-external-write.txt`, { force: true });
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 120_000);

  test("legacy offer corruption or deletion requires exact human recovery before replacement", () => {
    for (const mode of ["corrupt", "delete"] as const) {
      const dir = scratchProject(true);
      try {
        initGitWorkspace(dir);
        seedCodeGenerationDirective(dir);
        seedLegacyDirectiveChoices(dir);
        expect(
          runIde(
            dir,
            "plan-approval-guard",
            JSON.stringify({ toolName: "fs_write", toolArgs: {} }),
          ).code,
          mode,
        ).toBe(0);
        const offerPath = join(
          dir,
          "aidlc",
          ".aidlc-sessions",
          "plan-approval",
          `legacy-offer-${legacySessionId(dir)}.json`,
        );
        if (mode === "delete") {
          rmSync(offerPath, { force: true });
        } else {
          writeFileSync(offerPath, "corrupted offer\n");
        }
        expect(
          runIde(
            dir,
            "audit-and-sensors",
            ctx(
              "fs_write",
              mode === "delete"
                ? `Deleted the ${offerPath} file.`
                : `Created the ${offerPath} file.`,
            ),
          ).code,
          mode,
        ).toBe(0);

        const recovery = runIde(
          dir,
          "plan-approval-guard",
          JSON.stringify({ toolName: "execute_bash", toolArgs: {} }),
        );
        expect(recovery.code, mode).toBe(2);
        expect(recovery.stderr, mode).toContain(
          "recovery requires a human response",
        );
        expect(
          runIde(
            dir,
            "plan-approval-guard",
            JSON.stringify({ toolName: "fs_write", toolArgs: {} }),
          ).code,
          mode,
        ).toBe(2);
        expect(
          runIde(
            dir,
            "record-human-turn",
            JSON.stringify({ prompt: "Recover Plan Approval" }),
          ).code,
          mode,
        ).toBe(0);
        const recovered = runIde(
          dir,
          "plan-approval-guard",
          JSON.stringify({ toolName: "execute_bash", toolArgs: {} }),
        );
        expect(recovered.code, mode).toBe(2);
        expect(recovered.stderr, mode).toContain(
          "recovery issued a fresh directive",
        );
        expect(
          runIde(
            dir,
            "plan-approval-guard",
            JSON.stringify({ toolName: "fs_write", toolArgs: {} }),
          ).code,
          mode,
        ).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 60000);

  test("interrupted legacy authority write requires recovery without PostToolUse", () => {
    const dir = scratchProject(true);
    const ownerHost = {
      VSCODE_IPC_HOOK: `interrupted-owner:${dir}`,
      VSCODE_PID: "401",
    };
    const recoveryHost = {
      VSCODE_IPC_HOOK: `interrupted-recovery:${dir}`,
      VSCODE_PID: "402",
    };
    try {
      initGitWorkspace(dir);
      seedCodeGenerationDirective(dir);
      seedLegacyDirectiveChoices(dir, ownerHost);
      expect(
        runIde(
          dir,
          "plan-approval-guard",
          JSON.stringify({ toolName: "fs_write", toolArgs: {} }),
          ownerHost,
        ).code,
      ).toBe(0);
      const offerPath = join(
        dir,
        "aidlc",
        ".aidlc-sessions",
        "plan-approval",
        `legacy-offer-${legacySessionId(
          dir,
          ownerHost.VSCODE_IPC_HOOK,
          ownerHost.VSCODE_PID,
        )}.json`,
      );
      rmSync(offerPath, { force: true });

      expect(
        runIde(
          dir,
          "plan-approval-guard",
          JSON.stringify({ toolName: "fs_write", toolArgs: {} }),
          recoveryHost,
        ).code,
      ).toBe(2);
      const recovery = runIde(
        dir,
        "plan-approval-guard",
        JSON.stringify({ toolName: "execute_bash", toolArgs: {} }),
        recoveryHost,
      );
      expect(recovery.code).toBe(2);
      expect(recovery.stderr).toContain(
        "recovery requires a human response",
      );
      expect(
        runIde(
          dir,
          "record-human-turn",
          JSON.stringify({ prompt: "Recover Plan Approval" }),
          recoveryHost,
        ).code,
      ).toBe(0);
      const recovered = runIde(
        dir,
        "plan-approval-guard",
        JSON.stringify({ toolName: "execute_bash", toolArgs: {} }),
        recoveryHost,
      );
      expect(recovered.code).toBe(2);
      expect(recovered.stderr).toContain(
        "recovery issued a fresh directive",
      );
      expect(
        runIde(
          dir,
          "plan-approval-guard",
          JSON.stringify({ toolName: "fs_write", toolArgs: {} }),
          recoveryHost,
        ).code,
      ).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test("failed write cleanup cannot erase another host's interrupted-write latch", () => {
    const dir = scratchProject(true);
    const hostA = {
      VSCODE_IPC_HOOK: `concurrent-a:${dir}`,
      VSCODE_PID: "501",
    };
    const hostB = {
      VSCODE_IPC_HOOK: `concurrent-b:${dir}`,
      VSCODE_PID: "502",
    };
    try {
      initGitWorkspace(dir);
      seedCodeGenerationDirective(dir);
      seedLegacyDirectiveChoices(dir, hostA);
      expect(
        runIde(
          dir,
          "plan-approval-guard",
          JSON.stringify({ toolName: "fs_write", toolArgs: {} }),
          hostA,
        ).code,
      ).toBe(0);
      expect(
        runIde(
          dir,
          "plan-approval-guard",
          JSON.stringify({ toolName: "str_replace", toolArgs: {} }),
          hostB,
        ).code,
      ).toBe(2);
      expect(
        runIde(
          dir,
          "audit-and-sensors",
          JSON.stringify({
            toolName: "str_replace",
            toolArgs: {},
            toolResult: "replacement failed",
            toolSuccess: false,
          }),
          hostB,
        ).code,
      ).toBe(0);
      rmSync(
        join(
          dir,
          "aidlc",
          ".aidlc-sessions",
          "plan-approval",
          `legacy-offer-${legacySessionId(
            dir,
            hostA.VSCODE_IPC_HOOK,
            hostA.VSCODE_PID,
          )}.json`,
        ),
        { force: true },
      );

      const recovery = runIde(
        dir,
        "plan-approval-guard",
        JSON.stringify({ toolName: "execute_bash", toolArgs: {} }),
        hostB,
      );
      expect(recovery.code).toBe(2);
      expect(recovery.stderr).toContain(
        "recovery requires a human response",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test("foreign host cannot bypass an interrupted write after durable state deletion", () => {
    const dir = scratchProject(true);
    const hostA = {
      VSCODE_IPC_HOOK: `state-loss-a:${dir}`,
      VSCODE_PID: "601",
    };
    const hostB = {
      VSCODE_IPC_HOOK: `state-loss-b:${dir}`,
      VSCODE_PID: "602",
    };
    try {
      initGitWorkspace(dir);
      seedCodeGenerationDirective(dir);
      expect(
        runIde(
          dir,
          "plan-approval-guard",
          JSON.stringify({ toolName: "fs_write", toolArgs: {} }),
          hostA,
        ).code,
      ).toBe(0);
      rmSync(seededStateFile(dir), { force: true });

      const modernEnv = {
        VSCODE_IPC_HOOK: `state-loss-modern:${dir}`,
        VSCODE_PID: "603",
      };
      expect(
        runIdeStdin(
          dir,
          "plan-approval-guard",
          JSON.stringify({
            hook_event_name: "PreToolUse",
            session_id: "modern-state-loss",
            tool_name: "execute_bash",
            tool_input: { command: "echo bypass" },
          }),
          modernEnv,
        ).code,
      ).toBe(2);
      expect(
        runIdeStdin(
          dir,
          "plan-approval-guard",
          JSON.stringify({
            hook_event_name: "PreToolUse",
            session_id: "modern-state-loss",
            tool_name: "fs_write",
            tool_input: {
              path: join(dir, "src", "modern-bypass.ts"),
              content: "export const bypass = true;\n",
            },
          }),
          modernEnv,
        ).code,
      ).toBe(2);
      for (const toolName of ["execute_bash", "fs_write"]) {
        expect(
          runIdeStdin(
            dir,
            "plan-approval-guard",
            JSON.stringify({
              hook_event_name: "PreToolUse",
              session_id: "modern-state-loss",
              tool_name: toolName,
              tool_input: [],
            }),
            modernEnv,
          ).code,
          toolName,
        ).toBe(2);
      }

      expect(
        runIde(
          dir,
          "plan-approval-guard",
          JSON.stringify({ toolName: "fs_write", toolArgs: {} }),
          hostB,
        ).code,
      ).toBe(2);
      const shell = runIde(
        dir,
        "plan-approval-guard",
        JSON.stringify({ toolName: "execute_bash", toolArgs: {} }),
        hostB,
      );
      expect(shell.code).toBe(2);
      expect(shell.stderr).toContain("Legacy Plan Approval recovery");
      expect(
        runIde(
          dir,
          "plan-approval-guard",
          JSON.stringify({ toolName: "fs_write", toolArgs: {} }),
          hostB,
        ).code,
      ).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test("legacy writes that destroy state or marker authority remain poisoned before PostToolUse", () => {
    for (const target of [
      "state-corrupt",
      "state-delete",
      "marker-corrupt",
      "marker-delete",
    ] as const) {
      const dir = scratchProject(true);
      try {
        initGitWorkspace(dir);
        seedCodeGenerationDirective(dir);
        expect(
          runIde(
            dir,
            "plan-approval-guard",
            JSON.stringify({ toolName: "fs_write", toolArgs: {} }),
          ).code,
          target,
        ).toBe(0);
        const path = target.startsWith("state")
          ? seededStateFile(dir)
          : join(seededRecordDir(dir), ".aidlc-active-directive.json");
        if (target.endsWith("delete")) {
          rmSync(path, { force: true });
        } else {
          writeFileSync(path, "corrupted authority\n");
        }
        expect(
          runIde(
            dir,
            "audit-and-sensors",
            ctx(
              "fs_write",
              target.endsWith("delete")
                ? `Deleted the ${path} file.`
                : `Created the ${path} file.`,
            ),
          ).code,
          target,
        ).toBe(0);
        expect(
          runIde(
            dir,
            "plan-approval-guard",
            JSON.stringify({ toolName: "fs_write", toolArgs: {} }),
          ).code,
          target,
        ).toBe(2);
        const recovery = runIde(
          dir,
          "plan-approval-guard",
          JSON.stringify({ toolName: "execute_bash", toolArgs: {} }),
        );
        expect(recovery.code, target).toBe(2);
        if (target.startsWith("marker")) {
          expect(recovery.stderr).toContain(
            "recovery issued a fresh directive",
          );
          expect(
            runIde(
              dir,
              "plan-approval-guard",
              JSON.stringify({ toolName: "fs_write", toolArgs: {} }),
            ).code,
          ).toBe(0);
        } else {
          expect(recovery.stderr).toContain("recovery failed closed");
          expect(
            runIde(
              dir,
              "plan-approval-guard",
              JSON.stringify({ toolName: "fs_write", toolArgs: {} }),
            ).code,
          ).toBe(2);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 30000);

  test("partial and custom mutation payloads fail closed while reads remain available", () => {
    const dir = scratchProject(true);
    try {
      seedCodeGenerationDirective(dir);
      for (const toolName of [
        "delete_file",
        "apply_patch",
        "custom_write_tool",
        "fs_append",
        "fs_write",
        "move_file",
        "rename_file",
        "save_file",
        "touch",
        "truncate",
        "shell",
        "provider_specific_action",
      ]) {
        expect(
          runIdeStdin(
            dir,
            "plan-approval-guard",
            JSON.stringify({
              hook_event_name: "PreToolUse",
              tool_name: toolName,
              tool_input: { content: "opaque" },
            }),
          ).code,
          toolName,
        ).toBe(2);
      }
      expect(
        runIdeStdin(
          dir,
          "plan-approval-guard",
          JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "fs_read",
            tool_input: { path: "README.md" },
          }),
        ).code,
      ).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test("malformed Plan Approval payloads fail closed during active Code Generation", () => {
    const dir = scratchProject(true);
    try {
      seedCodeGenerationDirective(dir);
      for (const payload of [
        "{broken",
        JSON.stringify([]),
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: 42,
          tool_input: {},
        }),
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "fs_write",
          tool_input: [],
        }),
      ]) {
        expect(
          runIdeStdin(dir, "plan-approval-guard", payload).code,
          payload,
        ).toBe(2);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test("malformed payloads fail closed when the active directive is Code Generation but the durable stage differs", () => {
    const dir = scratchProject(true);
    try {
      seedCodeGenerationDirective(dir);
      const statePath = seededStateFile(dir);
      const state = readFileSync(statePath, "utf-8").replace(
        "- **Current Stage**: code-generation",
        "- **Current Stage**: functional-design",
      );
      writeFileSync(statePath, state);
      writeActiveDirectiveMarker(dir, {
        kind: "run-stage",
        stage: "code-generation",
        state_sha256: stateDigest(state),
      });
      expect(
        runIdeStdin(
          dir,
          "plan-approval-guard",
          JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "fs_write",
            tool_input: [],
          }),
        ).code,
      ).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("malformed Plan Approval payloads remain advisory outside Code Generation", () => {
    for (const withState of [false, true]) {
      const dir = scratchProject(withState);
      try {
        expect(
          runIdeStdin(
            dir,
            "plan-approval-guard",
            JSON.stringify({
              hook_event_name: "PreToolUse",
              tool_name: "fs_write",
              tool_input: [],
            }),
          ).code,
          withState ? "non-Code-Generation state" : "no workflow state",
        ).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

describe("t218 IDE 1.x stdin channel (snake_case payload, USER_PROMPT empty)", () => {
  test("N1: audit-and-sensors resolves a RELATIVE tool_response path from stdin and logs CREATE", () => {
    const dir = scratchProject(true);
    try {
      const file = join(seededRecordDir(dir), "ideation", "intent-capture", "intent.md");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "# intent\n");
      const relPath = relative(dir, file);
      expect(isAbsolute(relPath)).toBe(false);
      const r = runIdeStdin(dir, "audit-and-sensors", ctx1x("fs_write", `Created the ${relPath} file.`));
      expect(r.code).toBe(0);
      const audit = readAudit(dir);
      expect(audit).toContain("ARTIFACT_CREATED");
      expect(audit).toContain("intent-capture");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("N2: a str_replace tool_response with NO success flag is audited as UPDATE (#417 guard only drops explicit false)", () => {
    const dir = scratchProject(true);
    try {
      const file = join(seededRecordDir(dir), "ideation", "intent-capture", "intent.md");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "# intent edited\n");
      const r = runIdeStdin(dir, "audit-and-sensors", ctx1x("str_replace", `Replaced text in ${file}`));
      expect(r.code).toBe(0);
      expect(readAudit(dir)).toContain("ARTIFACT_UPDATED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("N3: a camelCase (0.12-shaped) payload arriving on stdin parses too", () => {
    const dir = scratchProject(true);
    try {
      const file = join(seededRecordDir(dir), "ideation", "intent-capture", "intent.md");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "# intent\n");
      const r = runIdeStdin(dir, "audit-and-sensors", ctx("fs_write", `Created the ${file} file.`));
      expect(r.code).toBe(0);
      expect(readAudit(dir)).toMatch(
        /\*\*Event\*\*: ARTIFACT_(?:CREATED|UPDATED)/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("N4: a non-empty USER_PROMPT identifies 0.12 and wins without probing stdin", () => {
    const dir = scratchProject(true);
    try {
      const stageDir = join(seededRecordDir(dir), "ideation", "intent-capture");
      mkdirSync(stageDir, { recursive: true });
      const fromStdin = join(stageDir, "from-stdin.md");
      const fromEnv = join(stageDir, "from-env.md");
      writeFileSync(fromStdin, "# stdin\n");
      writeFileSync(fromEnv, "# env\n");
      const env: Record<string, string> = {
        ...process.env,
        CLAUDE_PROJECT_DIR: dir,
        USER_PROMPT: ctx("fs_write", `Created the ${fromEnv} file.`),
      };
      const r = spawnSync(
        "bun",
        [join(dir, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), "audit-and-sensors"],
        {
          cwd: dir,
          input: ctx1x("fs_write", `Created the ${fromStdin} file.`),
          encoding: "utf-8",
          env,
          timeout: 30_000,
        },
      );
      expect(r.status).toBe(0);
      const audit = readAudit(dir);
      expect(audit).toContain("from-env.md");
      expect(audit).not.toContain("from-stdin.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("N5a: log-subagent falls back to the captured subagent_<agent> tool name", () => {
    const dir = scratchProject(true);
    try {
      const result = "Implementation complete. All files written and tests pass.";
      const r = runIdeStdin(
        dir,
        "log-subagent",
        ctx1x("subagent_aidlc-developer-agent", result),
      );
      expect(r.code).toBe(0);
      const audit = readAudit(dir);
      expect(audit).toContain("SUBAGENT_COMPLETED");
      expect(audit).toContain("**Agent Type**: aidlc-developer-agent");
      expect(audit).not.toContain("**Agent Type**: unknown");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("N5b: log-subagent keeps invoke_sub_agent compatibility and excludes subagent_response", () => {
    const dir = scratchProject(true);
    try {
      const result = "**Agent:** aidlc-developer-agent\n\nImplementation complete";
      expect(runIdeStdin(dir, "log-subagent", ctx1x("invoke_sub_agent", result)).code).toBe(0);
      expect(readAudit(dir)).toContain("aidlc-developer-agent");
      const beforeResponse = readAudit(dir);
      expect(
        runIdeStdin(dir, "log-subagent", ctx1x("subagent_response", "Response recorded.")).code,
      ).toBe(0);
      expect(readAudit(dir)).toBe(beforeResponse);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("N6: legacy human-response USER_PROMPT never probes a held-open stdin", async () => {
    // The stdin ceiling is raised to 15s for this run, so "never probed stdin"
    // is decided by a wide margin rather than a tight budget near the 2s
    // production ceiling: gating mint onto the read would park it for the full
    // raised window (or hang outright on a bare read), while the skip path
    // returns in milliseconds even on a loaded machine.
    const dir = scratchProject(true);
    try {
      const r = await runIdeOpenStdin(
        dir,
        "record-human-turn",
        JSON.stringify({ prompt: "Approve Plan" }),
        30_000,
        {
          AIDLC_IDE_STDIN_TIMEOUT_MS: String(RAISED_STDIN_TIMEOUT_MS),
        },
      );
      expect(r.timedOut).toBe(false);
      expect(r.code).toBe(0);
      expect(r.elapsedMs).toBeLessThan(NO_STDIN_PROBE_BUDGET_MS);
      expect(readAudit(dir)).toContain("HUMAN_TURN");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);

  test("N6b: unattended record-human-turn exits cleanly without minting presence", () => {
    const dir = scratchProject(true);
    try {
      expect(
        runIdeStdin(dir, "record-human-turn", "", {
          AIDLC_UNATTENDED: "1",
        }).code,
      ).toBe(0);
      expect(readAudit(dir)).not.toContain("HUMAN_TURN");
      expect(runIdeStdin(dir, "record-human-turn", "").code).toBe(0);
      expect(readAudit(dir)).toContain("HUMAN_TURN");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("N7: a 0.12 payload target consumes USER_PROMPT without probing held-open stdin", async () => {
    // The #543 0.12 shape: USER_PROMPT carries the payload while stdin is opened
    // and never closed. With the ceiling raised to 15s, probing stdin first
    // would be unmistakable; finishing inside the budget proves the env channel
    // is consumed directly (the mandatory-2s-delay regression).
    const dir = scratchProject(true);
    try {
      const file = join(seededRecordDir(dir), "ideation", "intent-capture", "intent.md");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "# intent\n");
      const r = await runIdeOpenStdin(
        dir,
        "audit-and-sensors",
        ctx("fs_write", `Created the ${file} file.`),
        30_000,
        { AIDLC_IDE_STDIN_TIMEOUT_MS: String(RAISED_STDIN_TIMEOUT_MS) },
      );
      expect(r.timedOut).toBe(false);
      expect(r.code).toBe(0);
      expect(r.elapsedMs).toBeLessThan(NO_STDIN_PROBE_BUDGET_MS);
      expect(readAudit(dir)).toContain("ARTIFACT_CREATED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);

  test("N7b: the dispatcher route also consumes USER_PROMPT without probing held-open stdin", async () => {
    const dir = scratchProject(true);
    try {
      const file = join(seededRecordDir(dir), "ideation", "intent-capture", "intent.md");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "# intent\n");
      const r = await runIdeDispatcherOpenStdin(
        dir,
        "audit-and-sensors",
        ctx("fs_write", `Created the ${file} file.`),
        30_000,
        { AIDLC_IDE_STDIN_TIMEOUT_MS: String(RAISED_STDIN_TIMEOUT_MS) },
      );
      expect(r.timedOut).toBe(false);
      expect(r.code).toBe(0);
      expect(r.elapsedMs).toBeLessThan(NO_STDIN_PROBE_BUDGET_MS);
      expect(readAudit(dir)).toContain("ARTIFACT_CREATED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);

  test("N8: the public aidlc adapter dispatcher forwards the 1.x stdin payload", () => {
    const dir = scratchProject(true);
    try {
      const result = "**Reviewer:** aidlc-product-lead-agent\n\nVerdict: READY";
      const r = runIdeDispatcherStdin(
        dir,
        "log-subagent",
        ctx1x("subagent_aidlc-product-lead-agent", result),
      );
      expect(r.code).toBe(0);
      const audit = readAudit(dir);
      expect(audit).toContain("SUBAGENT_COMPLETED");
      expect(audit).toContain("aidlc-product-lead-agent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("N9: dispatcher broken-channel timeout releases held-open stdin and exits", async () => {
    // Both channels empty: the dispatcher must fall through the ceiling and
    // exit rather than staying alive on the pending read. Pinned with a SHORT
    // override so the case stays fast while still proving the release.
    const dir = scratchProject(true);
    try {
      const r = await runIdeDispatcherOpenStdin(dir, "audit-and-sensors", null, 20_000, {
        AIDLC_IDE_STDIN_TIMEOUT_MS: "500",
      });
      expect(r.timedOut).toBe(false);
      expect(r.code).toBe(0);
      expect(r.elapsedMs).toBeLessThan(NO_STDIN_PROBE_BUDGET_MS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("N10: an empty context on either payload target records a VISIBLE hook drop", async () => {
    // Both channels empty means a broken channel, not a no-op. Keep both
    // payload-dependent legs in the same regression so their diagnostics
    // cannot drift apart again.
    for (const target of ["audit-and-sensors", "log-subagent"] as const) {
      const dir = scratchProject(true);
      try {
        const r = await runIdeOpenStdin(dir, target, null, 20_000, {
          AIDLC_IDE_STDIN_TIMEOUT_MS: "500",
        });
        expect(`${target}:timedOut=${r.timedOut}`).toBe(`${target}:timedOut=false`);
        expect(`${target}:code=${r.code}`).toBe(`${target}:code=0`);
        const dropFile = join(seededRecordDir(dir), ".aidlc-hooks-health", "kiro-adapter.drops");
        expect(`${target}:drops=${existsSync(dropFile)}`).toBe(`${target}:drops=true`);
        expect(readFileSync(dropFile, "utf-8")).toContain(`${target}: empty hook context`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 30_000);

  test("N11: agentStop targets survive an empty USER_PROMPT with stdin held open (#639)", async () => {
    // Restores the coverage deleted with 12b. The live IDE agentStop shape is a
    // ZERO-LENGTH USER_PROMPT plus an open-but-never-written stdin, which hung
    // stop and session-end forever. Each variant is asserted on its own effect
    // so one cannot silently no-op behind the other. Use a fresh project per
    // variant: SESSION_ENDED is audit-only traffic and intentionally no longer
    // resets the shared Stop-hook no-progress streak.
    for (const userPrompt of ["", null] as const) {
      const dir = scratchProject(true);
      // The payload-free legacy agentStop path uses one synthetic session id.
      // Seed its ownership through the matching legacy SessionStart first;
      // UUID-backed SessionEnd intentionally refuses an unstamped cursor
      // fallback because another concurrent session may own that cursor.
      try {
        expect(runIde(dir, "session-start", null).code).toBe(0);
        const label = userPrompt === null ? "absent" : "empty";
        const stop = await runIdeOpenStdin(dir, "continue-workflow", userPrompt, 30_000);
        expect(`stop/${label}:timedOut=${stop.timedOut}`).toBe(`stop/${label}:timedOut=false`);
        expect(`stop/${label}:code=${stop.code}`).toBe(`stop/${label}:code=0`);
        const decision = JSON.parse(stop.stdout) as { decision?: string };
        expect(`stop/${label}:decision=${decision.decision}`).toBe(`stop/${label}:decision=block`);

        const before = readAudit(dir).split("SESSION_ENDED").length - 1;
        const end = await runIdeOpenStdin(dir, "session-end", userPrompt, 30_000);
        expect(`end/${label}:timedOut=${end.timedOut}`).toBe(`end/${label}:timedOut=false`);
        expect(`end/${label}:code=${end.code}`).toBe(`end/${label}:code=0`);
        const after = readAudit(dir).split("SESSION_ENDED").length - 1;
        expect(`end/${label}:delta=${after - before}`).toBe(`end/${label}:delta=1`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 90_000);

  test("N12: non-string tool names fail open on both channels and entry paths", () => {
    const result = "Implementation complete.";
    const snakeCasePayload = JSON.stringify({
      tool_name: 7,
      tool_input: {},
      tool_response: result,
    });
    const camelCasePayload = JSON.stringify({
      toolName: ["subagent_aidlc-developer-agent"],
      toolArgs: {},
      toolResult: result,
      toolSuccess: true,
    });
    const scenarios = [
      {
        label: "1.x direct",
        invoke: (dir: string) => runIdeStdin(dir, "log-subagent", snakeCasePayload),
      },
      {
        label: "1.x dispatcher",
        invoke: (dir: string) => runIdeDispatcherStdin(dir, "log-subagent", snakeCasePayload),
      },
      {
        label: "0.12 direct",
        invoke: (dir: string) => runIde(dir, "log-subagent", camelCasePayload),
      },
    ];

    for (const scenario of scenarios) {
      const dir = scratchProject(true);
      try {
        const r = scenario.invoke(dir);
        expect(`${scenario.label}:code=${r.code}`).toBe(`${scenario.label}:code=0`);
        expect(readAudit(dir)).not.toContain("SUBAGENT_COMPLETED");
        const dropFile = join(seededRecordDir(dir), ".aidlc-hooks-health", "kiro-adapter.drops");
        expect(`${scenario.label}:drops=${existsSync(dropFile)}`).toBe(
          `${scenario.label}:drops=true`,
        );
        expect(readFileSync(dropFile, "utf-8")).toContain(
          "malformed hook context fields (toolName)",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

// ============================================================
// PR-review fixes (findings 1, 2, 3, 4). These pin the forward-only /
// idempotent / robust-extraction behaviour the review flagged.
// ============================================================

/** Read a `- **Field**: value` line from the seeded state file. */
function stateField(dir: string, field: string): string {
  const content = readFileSync(seededStateFile(dir), "utf-8");
  const m = content.match(new RegExp(`^- \\*\\*${field}\\*\\*:\\s*(.+)$`, "m"));
  return m ? m[1].trim() : "";
}

/** Overwrite a `- **Field**: value` line in the seeded state file. */
function setStateField(dir: string, field: string, value: string): void {
  const path = seededStateFile(dir);
  const content = readFileSync(path, "utf-8");
  writeFileSync(
    path,
    content.replace(new RegExp(`^(- \\*\\*${field}\\*\\*:\\s*).+$`, "m"), `$1${value}`),
    "utf-8",
  );
}

/** Append a single-stage-run STAGE_STARTED (synthetic Workflow id). */
function appendSingleStageStarted(dir: string, slug: string, ts: string): void {
  const shard = join(seededAuditDir(dir), pinnedShardName());
  const block = `\n## Stage Start\n**Timestamp**: ${ts}\n**Event**: STAGE_STARTED\n**Workflow**: single-stage:${slug}\n**Stage**: ${slug}\n**Agent**: orchestrator\n\n---\n`;
  writeFileSync(shard, readFileSync(shard, "utf-8") + block, "utf-8");
}

describe("t218 forward-only sync-statusline (finding 1: no state resurrection)", () => {
  test("F1a: does NOT resurrect a Completed workflow", () => {
    const dir = scratchProject(true);
    try {
      // Simulate a finished workflow: the last STAGE_STARTED is the stage that
      // just completed, but state has moved on to Completed / none.
      appendStageStarted(dir, "requirements-analysis", "2026-06-30T10:00:00.000Z");
      setStateField(dir, "Status", "Completed");
      setStateField(dir, "Current Stage", "none");
      const r = runIde(dir, "sync-workflow-state", ctx("execute_bash", "Output:\nok\n\nExit Code: 0"));
      expect(r.code).toBe(0);
      // State must NOT be dragged back to Running / requirements-analysis.
      expect(stateField(dir, "Status")).toBe("Completed");
      expect(stateField(dir, "Current Stage")).toBe("none");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("F1b: does NOT sync backward to an already-completed stage", () => {
    const dir = scratchProject(true);
    try {
      // Audit tail's newest STAGE_STARTED is an EARLIER stage that is already
      // [x] complete; state legitimately sits on a later stage. Must not rewind.
      // Mark requirements-analysis completed, keep Current Stage ahead of it.
      const path = seededStateFile(dir);
      const content = readFileSync(path, "utf-8").replace(
        "- [-] requirements-analysis — EXECUTE",
        "- [x] requirements-analysis — EXECUTE",
      );
      writeFileSync(path, content, "utf-8");
      setStateField(dir, "Current Stage", "user-stories");
      appendStageStarted(dir, "requirements-analysis", "2026-06-30T10:00:00.000Z");
      const r = runIde(dir, "sync-workflow-state", ctx("execute_bash", "Output:\nok\n\nExit Code: 0"));
      expect(r.code).toBe(0);
      expect(stateField(dir, "Current Stage")).toBe("user-stories");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("F1c: DOES sync forward when state is genuinely behind the audit", () => {
    const dir = scratchProject(true);
    try {
      // Audit advanced to user-stories (in-flight), state still on
      // requirements-analysis → a legitimate forward nudge.
      const path = seededStateFile(dir);
      let content = readFileSync(path, "utf-8");
      if (!content.includes("user-stories")) {
        content = content.replace(
          "- [-] requirements-analysis — EXECUTE",
          "- [-] requirements-analysis — EXECUTE\n- [ ] user-stories — EXECUTE",
        );
      }
      writeFileSync(path, content, "utf-8");
      appendStageStarted(dir, "user-stories", "2026-06-30T10:00:00.000Z");
      const r = runIde(dir, "sync-workflow-state", ctx("execute_bash", "Output:\nok\n\nExit Code: 0"));
      expect(r.code).toBe(0);
      expect(stateField(dir, "Current Stage")).toBe("user-stories");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("t218 latestStartedStageSlug filters single-stage rows (finding 2)", () => {
  test("F2: a --single STAGE_STARTED does not rewrite the main pointer", () => {
    const dir = scratchProject(true);
    try {
      // State on requirements-analysis; a single-stage run of user-stories
      // appended a synthetic STAGE_STARTED. The sync must ignore it.
      appendSingleStageStarted(dir, "user-stories", "2026-06-30T10:00:00.000Z");
      const before = stateField(dir, "Current Stage");
      const r = runIde(dir, "sync-workflow-state", ctx("execute_bash", "Output:\nok\n\nExit Code: 0"));
      expect(r.code).toBe(0);
      expect(stateField(dir, "Current Stage")).toBe(before); // unchanged
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("t218 extractWrittenPath robustness (finding 4)", () => {
  test("F4a: trailing newline in a Created result still extracts the path", () => {
    const dir = scratchProject(true);
    try {
      const file = join(seededRecordDir(dir), "ideation", "intent-capture", "intent.md");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "# intent\n");
      const rel = relative(dir, file);
      // Note the trailing newline after the wording.
      const r = runIde(dir, "audit-and-sensors", ctx("fs_write", `Created the ${rel} file.\n`));
      expect(r.code).toBe(0);
      expect(readAudit(dir)).toContain("ARTIFACT_CREATED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("F4b: a str_replace suffix ' (N occurrences)' does not pollute the path", () => {
    const dir = scratchProject(true);
    try {
      const file = join(seededRecordDir(dir), "ideation", "intent-capture", "intent.md");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "# edited\n");
      const rel = relative(dir, file);
      const r = runIde(dir, "audit-and-sensors", ctx("str_replace", `Replaced text in ${rel} (2 occurrences)`));
      expect(r.code).toBe(0);
      const audit = readAudit(dir);
      expect(audit).toContain("ARTIFACT_UPDATED");
      // The audited File must be the clean path, not "...intent.md (2 occurrences)".
      expect(audit).not.toContain("(2 occurrences)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("F4c: an unrecognized write result records a visible hook-drop", () => {
    const dir = scratchProject(true);
    try {
      const r = runIde(dir, "audit-and-sensors", ctx("fs_write", "Wrote something somewhere"));
      expect(r.code).toBe(0);
      // No audit row, but a drop is recorded for --doctor to surface.
      const dropFile = join(seededRecordDir(dir), ".aidlc-hooks-health", "kiro-adapter.drops");
      expect(existsSync(dropFile)).toBe(true);
      expect(readFileSync(dropFile, "utf-8")).toContain("no extractable path");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // F4d/F4e — CLASSIFY BEFORE LOGGING. Two very different situations reach the
  // "no extractable path" branch, and conflating them made `--doctor` report
  // hook degradation on workspaces whose hooks were working perfectly:
  //
  //   FAILED write    -> no artifact exists, so declining to forward it is
  //                      CORRECT. Must NOT be recorded as decay.
  //   SUCCEEDED write
  //   with unknown
  //   wording         -> the invisible decay this log exists to surface.
  //                      Must still be recorded.
  //
  // The 1.x stdin channel carries no success flag, so the `toolSuccess === false`
  // guard (#417, T1 above) cannot catch the first case — the failure arrives only
  // as error prose. These two cases sit together deliberately: the CONTRAST is
  // the contract, and pinning them apart would let a reordered guard or a
  // tightened regex regress one while the other kept passing.
  // =========================================================================
  test("F4d: a FAILED write (error prose, 1.x channel) records NO drop", () => {
    const dir = scratchProject(true);
    try {
      // Verbatim prose captured live on IDE 1.x: a str_replace whose old string
      // matched more than once. The tool correctly refused; there is nothing to
      // audit and nothing degraded.
      const failure =
        "Caught an error while replacing string String '[Answer]:' found multiple times in the file";
      const r = runIdeStdin(
        dir,
        "audit-and-sensors",
        ctx1x("str_replace", failure),
      );
      expect(r.code).toBe(0); // still fail-open
      const dropFile = join(seededRecordDir(dir), ".aidlc-hooks-health", "kiro-adapter.drops");
      expect(existsSync(dropFile)).toBe(false); // NOT decay
      expect(readAudit(dir)).not.toContain("ARTIFACT_UPDATED"); // and never audited
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("F4e: the paired contrast — an unknown SUCCESS wording still records a drop", () => {
    const dir = scratchProject(true);
    try {
      // Same branch, opposite verdict. Held beside F4d so the distinction cannot
      // silently collapse in one direction.
      const r = runIdeStdin(
        dir,
        "audit-and-sensors",
        ctx1x("str_replace", "Swapped the text over there"),
      );
      expect(r.code).toBe(0);
      const dropFile = join(seededRecordDir(dir), ".aidlc-hooks-health", "kiro-adapter.drops");
      expect(existsSync(dropFile)).toBe(true);
      expect(readFileSync(dropFile, "utf-8")).toContain("no extractable path");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("F4f: explicit toolSuccess=true outranks defensive failure-prose guesses", () => {
    const dir = scratchProject(true);
    try {
      // Legacy IDE 0.12 supplies an authoritative success boolean. Even if an
      // unrecognised success message starts with a defensive failure prefix,
      // the missing path remains visible as harness decay.
      const r = runIde(
        dir,
        "audit-and-sensors",
        ctx("str_replace", "Failed to preserve file mode; requested text was replaced"),
      );
      expect(r.code).toBe(0);
      const dropFile = join(seededRecordDir(dir), ".aidlc-hooks-health", "kiro-adapter.drops");
      expect(existsSync(dropFile)).toBe(true);
      expect(readFileSync(dropFile, "utf-8")).toContain("no extractable path");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("t218 log-subagent identity extraction (#459)", () => {
  test("S1: a **Reviewer:** first line is recorded as the Agent Type", () => {
    const dir = scratchProject(true);
    try {
      const result = "**Reviewer:** aidlc-product-lead-agent\n\nVerdict: READY\nAll findings resolved.";
      const r = runIde(dir, "log-subagent", ctx("invoke_sub_agent", result));
      expect(r.code).toBe(0);
      const audit = readAudit(dir);
      expect(audit).toContain("SUBAGENT_COMPLETED");
      expect(audit).toContain("aidlc-product-lead-agent");
      // The default placeholder must NOT be recorded when identity is present.
      expect(audit).not.toContain("Agent Type: unknown");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("S2: an **Agent:** first line is recorded, and the result text is forwarded as the Message", () => {
    const dir = scratchProject(true);
    try {
      const result = "**Agent:** aidlc-architecture-reviewer-agent\n\nThe design is sound.";
      const r = runIde(dir, "log-subagent", ctx("invoke_sub_agent", result));
      expect(r.code).toBe(0);
      const audit = readAudit(dir);
      expect(audit).toContain("SUBAGENT_COMPLETED");
      expect(audit).toContain("aidlc-architecture-reviewer-agent");
      // The result prose is forwarded (core hook records it as Message).
      expect(audit).toContain("The design is sound.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("S3: a result with no self-identifying line falls back to unknown (no crash)", () => {
    const dir = scratchProject(true);
    try {
      const r = runIde(dir, "log-subagent", ctx("invoke_sub_agent", "Just some output with no identity marker."));
      expect(r.code).toBe(0);
      const audit = readAudit(dir);
      expect(audit).toContain("SUBAGENT_COMPLETED");
      expect(audit).toContain("unknown");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("S4: a conflicting prose marker cannot override the structured subagent_<agent> identity", () => {
    // AUDIT INTEGRITY. The result prose is agent-authored and can be wrong or
    // prompt-injected; `subagent_<agent>` is platform-provided. When the two
    // disagree, the row must be attributed to the tool name, never to the prose.
    const dir = scratchProject(true);
    try {
      const result = "**Agent:** aidlc-product-lead-agent\n\nDone";
      const r = runIdeStdin(
        dir,
        "log-subagent",
        ctx1x("subagent_aidlc-developer-agent", result),
      );
      expect(r.code).toBe(0);
      const audit = readAudit(dir);
      expect(audit).toContain("SUBAGENT_COMPLETED");
      expect(audit).toContain("**Agent Type**: aidlc-developer-agent");
      expect(audit).not.toContain("**Agent Type**: aidlc-product-lead-agent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("S5: a degenerate subagent_ with an empty suffix still falls back to the prose marker", () => {
    // The tool name only wins when it actually carries an identity; an empty
    // suffix is no identity, so the 0.12-era prose contract still applies.
    const dir = scratchProject(true);
    try {
      const r = runIdeStdin(
        dir,
        "log-subagent",
        ctx1x("subagent_", "**Reviewer:** aidlc-product-lead-agent\n\nVerdict: READY"),
      );
      expect(r.code).toBe(0);
      const audit = readAudit(dir);
      expect(audit).toContain("SUBAGENT_COMPLETED");
      expect(audit).toContain("**Agent Type**: aidlc-product-lead-agent");
      expect(audit).not.toContain("**Agent Type**: unknown");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("t218 failed tool calls are not audited as writes (#417)", () => {
  test("T1: toolSuccess=false on a write is dropped (no ARTIFACT_ row)", () => {
    const dir = scratchProject(true);
    try {
      const file = join(seededRecordDir(dir), "ideation", "intent-capture", "intent.md");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "# intent\n");
      const rel = relative(dir, file);
      // A failed write: the IDE sets toolSuccess=false. Even though the prose
      // matches the Created pattern, the failure guard must drop it.
      const failedCtx = JSON.stringify({
        toolName: "fs_write",
        toolArgs: {},
        toolResult: `Created the ${rel} file.`,
        toolSuccess: false,
      });
      const r = runIde(dir, "audit-and-sensors", failedCtx);
      expect(r.code).toBe(0);
      expect(readAudit(dir)).not.toContain("ARTIFACT_");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("T1b: guarded legacy write failures clear the pre-write latch for retry", () => {
    for (const entry of [
      {
        toolName: "fs_write",
        result: "Write failed before creating the file",
        toolSuccess: false as boolean | undefined,
      },
      {
        toolName: "str_replace",
        result:
          "Caught an error while replacing string String '[Answer]:' found multiple times in the file",
        toolSuccess: undefined,
      },
    ]) {
      const dir = scratchProject(true);
      try {
        initGitWorkspace(dir);
        seedCodeGenerationDirective(dir);
        expect(
          runIde(
            dir,
            "plan-approval-guard",
            JSON.stringify({ toolName: entry.toolName, toolArgs: {} }),
          ).code,
          entry.toolName,
        ).toBe(0);
        const payload: Record<string, unknown> = {
          toolName: entry.toolName,
          toolArgs: {},
          toolResult: entry.result,
        };
        if (entry.toolSuccess !== undefined) {
          payload.toolSuccess = entry.toolSuccess;
        }
        expect(
          runIde(
            dir,
            "audit-and-sensors",
            JSON.stringify(payload),
          ).code,
          entry.toolName,
        ).toBe(0);
        expect(
          runIde(
            dir,
            "plan-approval-guard",
            JSON.stringify({ toolName: entry.toolName, toolArgs: {} }),
          ).code,
          entry.toolName,
        ).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 30000);

  test("T2: toolSuccess=true on the same write IS audited (guard is not over-broad)", () => {
    const dir = scratchProject(true);
    try {
      const file = join(seededRecordDir(dir), "ideation", "intent-capture", "intent.md");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "# intent\n");
      const rel = relative(dir, file);
      const r = runIde(dir, "audit-and-sensors", ctx("fs_write", `Created the ${rel} file.`));
      expect(r.code).toBe(0);
      expect(readAudit(dir)).toContain("ARTIFACT_CREATED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("T3: present non-boolean success flags fail open without auditing the write", () => {
    const scenarios = [
      {
        label: "1.x string false",
        invoke: (dir: string, file: string) =>
          runIdeStdin(
            dir,
            "audit-and-sensors",
            JSON.stringify({
              tool_name: "fs_write",
              tool_input: {},
              tool_response: `Created the ${file} file.`,
              tool_success: "false",
            }),
          ),
      },
      {
        label: "0.12 numeric false",
        invoke: (dir: string, file: string) =>
          runIde(
            dir,
            "audit-and-sensors",
            JSON.stringify({
              toolName: "fs_write",
              toolArgs: {},
              toolResult: `Created the ${file} file.`,
              toolSuccess: 0,
            }),
          ),
      },
    ];

    for (const scenario of scenarios) {
      const dir = scratchProject(true);
      try {
        const file = join(seededRecordDir(dir), "ideation", "intent-capture", "intent.md");
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, "# intent\n");
        const r = scenario.invoke(dir, file);
        expect(`${scenario.label}:code=${r.code}`).toBe(`${scenario.label}:code=0`);
        expect(readAudit(dir)).not.toContain("ARTIFACT_");
        const dropFile = join(seededRecordDir(dir), ".aidlc-hooks-health", "kiro-adapter.drops");
        expect(`${scenario.label}:drops=${existsSync(dropFile)}`).toBe(
          `${scenario.label}:drops=true`,
        );
        expect(readFileSync(dropFile, "utf-8")).toContain(
          "malformed hook context fields (toolSuccess)",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("T4: a null success flag follows the existing absent-value contract", () => {
    const scenarios = [
      {
        label: "1.x null",
        invoke: (dir: string, file: string) =>
          runIdeStdin(
            dir,
            "audit-and-sensors",
            JSON.stringify({
              tool_name: "fs_write",
              tool_input: {},
              tool_response: `Created the ${file} file.`,
              tool_success: null,
            }),
          ),
      },
      {
        label: "0.12 null",
        invoke: (dir: string, file: string) =>
          runIde(
            dir,
            "audit-and-sensors",
            JSON.stringify({
              toolName: "fs_write",
              toolArgs: {},
              toolResult: `Created the ${file} file.`,
              toolSuccess: null,
            }),
          ),
      },
    ];

    for (const scenario of scenarios) {
      const dir = scratchProject(true);
      try {
        const file = join(seededRecordDir(dir), "ideation", "intent-capture", "intent.md");
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, "# intent\n");
        const r = scenario.invoke(dir, file);
        expect(`${scenario.label}:code=${r.code}`).toBe(`${scenario.label}:code=0`);
        expect(readAudit(dir)).toContain("ARTIFACT_CREATED");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
