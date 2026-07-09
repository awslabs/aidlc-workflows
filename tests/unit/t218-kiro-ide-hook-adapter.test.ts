// t218-kiro-ide-hook-adapter: the Kiro IDE hook shim reads context from the
// USER_PROMPT env var (NOT stdin) and normalizes it into the core hooks'
// contract. Empirically, Kiro IDE 0.12-main delivers a JSON env var
// { toolName, toolArgs (always {}), toolResult, toolSuccess } and never writes
// stdin, so the IDE adapter scrapes the written file path out of toolResult and
// drives the payload-free hooks (runtime-compile, sync-statusline) off the
// audit tail.
//
// covers: file:hooks/aidlc-sync-statusline.ts, file:hooks/aidlc-audit-logger.ts, file:hooks/aidlc-runtime-compile.ts
//
// WHY SUBPROCESS. The adapter IS a subprocess shim — in-process unit testing
// would bypass the exact env/stdout/exit-code surface being contracted. Each
// case runs `bun dist/kiro-ide/.kiro/hooks/aidlc-kiro-adapter.ts <target>` with
// USER_PROMPT set to a captured IDE context and asserts the observable effect.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
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

/** Append a STAGE_STARTED block for <slug> to the seeded audit shard. */
function appendStageStarted(dir: string, slug: string, ts: string): void {
  const shard = join(seededAuditDir(dir), pinnedShardName());
  const block = `\n## Stage Start\n**Timestamp**: ${ts}\n**Event**: STAGE_STARTED\n**Stage**: ${slug}\n**Agent**: orchestrator\n\n---\n`;
  writeFileSync(shard, readFileSync(shard, "utf-8") + block, "utf-8");
}

/** Run the IDE adapter with USER_PROMPT set (the IDE's context channel). stdin
 *  is intentionally NOT written — the IDE never writes it. */
function runIde(
  projectDir: string,
  target: string,
  userPrompt: string | null,
): { stdout: string; code: number } {
  const env: Record<string, string> = { ...process.env, CLAUDE_PROJECT_DIR: projectDir };
  if (userPrompt === null) {
    delete (env as Record<string, string | undefined>).USER_PROMPT;
  } else {
    env.USER_PROMPT = userPrompt;
  }
  const r = spawnSync(
    "bun",
    [join(projectDir, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), target],
    { cwd: projectDir, input: "", encoding: "utf-8", env, timeout: 30_000 },
  );
  return { stdout: r.stdout ?? "", code: r.status ?? -1 };
}

function ctx(toolName: string, toolResult: string): string {
  return JSON.stringify({ toolName, toolArgs: {}, toolResult, toolSuccess: true });
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
      const r = runIde(dir, "state-sync", ctx("spec", "task updated"));
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
      const r = runIde(dir, "state-sync", ctx("spec", "task updated"));
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("7: runtime-compile dispatches off the audit tail with no command", () => {
    const dir = scratchProject(true);
    try {
      // A transition in the tail makes the core hook recompile; with no
      // transition it self-gates. Either way the adapter exits 0.
      const r = runIde(dir, "runtime-compile", ctx("execute_bash", "Output:\nok\n\nExit Code: 0"));
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("7b: runtime-compile actually compiles when the audit tail has a transition (no command needed)", () => {
    const dir = scratchProject(true);
    try {
      // Seed a STAGE_STARTED transition in the tail. The IDE never surfaces the
      // shell command, so the only way the graph compiles is the audit-tail
      // path (command filter skipped via the ide-audit-sync marker).
      appendStageStarted(dir, "intent-capture", "2026-06-30T10:00:00.000Z");
      const graphPath = join(seededRecordDir(dir), "runtime-graph.json");
      const r = runIde(dir, "runtime-compile", ctx("execute_bash", "Output:\nok\n\nExit Code: 0"));
      expect(r.code).toBe(0);
      // The compile wrote the runtime graph — proof the command filter was
      // bypassed and the audit-tail gate fired.
      expect(existsSync(graphPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

  test("9: stop blocks with a reason while the workflow has pending work", () => {
    const dir = scratchProject(true);
    try {
      const r = runIde(dir, "stop", null);
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

  test("12: the IDE adapter does NOT read stdin (no hang when stdin stays open)", () => {
    // Regression guard for the root cause: the old adapter awaited stdin and
    // hung 2s. The new one reads USER_PROMPT, so even with NO stdin written it
    // returns promptly. spawnSync with input:"" closes stdin immediately; the
    // contract we pin is "exits 0 fast off the env var".
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
      expect(readFileSync(debugLogPath(dirOn), "utf-8")).toContain("audit-logger");
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
      expect(readFileSync(debugLogPath(dir), "utf-8")).toContain("audit-logger");
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
      const r = runIde(dir, "state-sync", ctx("execute_bash", "Output:\nok\n\nExit Code: 0"));
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
      const r = runIde(dir, "state-sync", ctx("execute_bash", "Output:\nok\n\nExit Code: 0"));
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
      const r = runIde(dir, "state-sync", ctx("execute_bash", "Output:\nok\n\nExit Code: 0"));
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
      const r = runIde(dir, "state-sync", ctx("execute_bash", "Output:\nok\n\nExit Code: 0"));
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
});
