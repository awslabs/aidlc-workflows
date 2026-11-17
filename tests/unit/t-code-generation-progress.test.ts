// covers: function:codeGenerationProgressLine, function:codeGenerationStartNarration, hook:aidlc-write-audit-log
//
// t-code-generation-progress - the person sees the build move. A Code
// Generation build runs as one long developer dispatch, and the only line the
// person heard was "This may take several minutes ... I'll show a summary when
// complete." The developer ticks each plan step's box as it finishes it, so the
// write-audit-log PostToolUse hook turns a newly ticked box into one progress
// line, shown on the harnesses whose PostToolUse output reaches the person.
//
// WHAT THIS PINS
//   1. The line (in-process): said once per newly ticked step, never for an
//      edit that ticks nothing new; a reset plan counts again; grouped plans
//      count tasks and name the heading; step text is one plain short line;
//      only a Code Generation plan path counts.
//   2. The shipped hook (subprocess): a tick prints one `systemMessage` line on
//      Claude Code, and nothing on Kiro CLI, which has no such channel; the
//      audit row is still written. The opencode adapter turns it into an
//      information toast.
//   3. The start line says a line shows per step only where it will.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { docsRoot } from "../../core/tools/aidlc-lib.ts";
import adapterPlugin, { type EngineErrorToast, type PluginInput } from "../../harness/opencode/plugin/aidlc-opencode-adapter.ts";
import {
  codeGenerationProgressLine,
  codeGenerationRecordDir,
  codeGenerationStartNarration,
} from "../../core/tools/aidlc-testing-posture.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  seedStateFile,
  seededAuditDir,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");
const HOOK_TEST_DRIVER = [BUN, join(REPO_ROOT, "tests", "harness", "aidlc-hook-driver.ts")] as const;
const HOOK = join(AIDLC_SRC, "hooks", "aidlc-write-audit-log.ts");
const UNIT = "u1-auth";
const PLAN_REL = `construction/${UNIT}/code-generation/code-generation-plan.md`;
const PINNED_CLONE_ID = "testcloneprog1";

let proj: string;
let recordRoot: string;
let planPath: string;

function plan(ticks: string): string {
  const [a, b, c] = ticks.split("");
  return [
    "# Code Generation Plan",
    "",
    "## Summary",
    "",
    "- Builds: login",
    "",
    "## Steps",
    "",
    `- [${a}] Step 1: Add the **user** model in \`src/user.ts\``,
    `- [${b}] Step 2: Add the login endpoint`,
    `- [${c}] Step 3: Unit tests for login`,
    "",
  ].join("\n");
}

function tick(ticks: string): string | null {
  writeFileSync(planPath, plan(ticks), "utf-8");
  return codeGenerationProgressLine(proj, PLAN_REL, planPath);
}

function seedShard(p: string): string {
  writeFileSync(join(p, "aidlc", ".aidlc-clone-id"), `${PINNED_CLONE_ID}\n`, "utf-8");
  const host =
    hostname().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "host";
  const auditDir = seededAuditDir(p);
  mkdirSync(auditDir, { recursive: true });
  writeFileSync(join(auditDir, `${host}-${PINNED_CLONE_ID}.md`), "", "utf-8");
  return auditDir;
}

function fireHook(harness: string): { exitCode: number; stdout: string } {
  const r = Bun.spawnSync({
    cmd: [BUN, HOOK],
    stdin: new TextEncoder().encode(JSON.stringify({ tool_name: "Edit", tool_input: { file_path: planPath } })),
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: undefined, AIDLC_HARNESS_NAME: harness },
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { exitCode: r.exitCode, stdout: r.stdout.toString() };
}

beforeEach(() => {
  proj = createTestProject();
  seedStateFile(proj, join(FIXTURES_DIR, "state-construction.md"));
  recordRoot = docsRoot(proj);
  planPath = join(recordRoot, PLAN_REL);
  mkdirSync(dirname(planPath), { recursive: true });
});

afterEach(() => {
  cleanupTestProject(proj);
});

describe("t-code-generation-progress: the line for a newly ticked step", () => {
  test("an unticked plan says nothing; each new tick says one line; the last says all done", () => {
    expect(tick("   ")).toBeNull();
    expect(tick("x  ")).toBe(
      `Code generation for ${UNIT}: 1 of 3 plan steps done, latest "Step 1: Add the user model in \`src/user.ts\`". ` +
        `Next: "Step 2: Add the login endpoint".`,
    );
    expect(tick("xx ")).toBe(
      `Code generation for ${UNIT}: 2 of 3 plan steps done, latest "Step 2: Add the login endpoint". ` +
        `Next: "Step 3: Unit tests for login".`,
    );
    expect(tick("xxx")).toBe(`Code generation for ${UNIT}: all 3 plan steps done.`);
  });

  test("an edit that ticks nothing new says nothing", () => {
    expect(tick("x  ")).not.toBeNull();
    expect(tick("x  ")).toBeNull();
    writeFileSync(planPath, `${plan("x  ")}\n## Notes\n\nmore text\n`, "utf-8");
    expect(codeGenerationProgressLine(proj, PLAN_REL, planPath)).toBeNull();
  });

  test("several steps ticked in one write say one line with the count", () => {
    expect(tick("xx ")).toContain("2 of 3 plan steps done");
  });

  test("a plan whose boxes were reset counts again from there", () => {
    expect(tick("xx ")).not.toBeNull();
    expect(tick("   ")).toBeNull();
    expect(tick("x  ")).toContain("1 of 3 plan steps done");
  });

  test("a zero-Unit plan names no Unit", () => {
    const rel = "construction/code-generation/code-generation-plan.md";
    const path = join(recordRoot, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, plan("x  "), "utf-8");
    expect(codeGenerationProgressLine(proj, rel, path)).toStartWith("Code generation: 1 of 3 plan steps done");
  });

  test("a plan grouped under Step headings counts tasks and names the heading of the next", () => {
    const grouped = [
      "## Step 1: Model",
      "",
      "- [x] Write the user model",
      "- [ ] Write the user repository",
      "",
      "## Step 2: API",
      "",
      "- [ ] Write the login route",
      "",
    ].join("\n");
    writeFileSync(planPath, grouped, "utf-8");
    expect(codeGenerationProgressLine(proj, PLAN_REL, planPath)).toBe(
      `Code generation for ${UNIT}: 1 of 3 tasks done, latest "Write the user model". ` +
        `Next: "Write the user repository" (Step 1).`,
    );
  });

  test("a long step is cut to one short line", () => {
    writeFileSync(planPath, `- [x] ${"a".repeat(200)}\n- [ ] next\n`, "utf-8");
    const line = codeGenerationProgressLine(proj, PLAN_REL, planPath) ?? "";
    expect(line).toContain(`"${"a".repeat(87)}..."`);
    expect(line).not.toContain("\n");
  });

  test("only a Code Generation plan counts", () => {
    writeFileSync(planPath, plan("x  "), "utf-8");
    expect(codeGenerationProgressLine(proj, `construction/${UNIT}/functional-design/code-generation-plan.md`, planPath)).toBeNull();
    expect(codeGenerationProgressLine(proj, `construction/${UNIT}/code-generation/code-summary.md`, planPath)).toBeNull();
  });
});

describe("t-code-generation-progress: the shipped hook", () => {
  test("Claude Code: a tick prints one systemMessage line and the audit row is still written", () => {
    const auditDir = seedShard(proj);
    writeFileSync(planPath, plan("x  "), "utf-8");
    const r = fireHook("claude");
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      systemMessage:
        `Code generation for ${UNIT}: 1 of 3 plan steps done, latest "Step 1: Add the user model in \`src/user.ts\`". ` +
        `Next: "Step 2: Add the login endpoint".`,
    });
    const audit = readdirSync(auditDir).map((name) => readFileSync(join(auditDir, name), "utf-8")).join("");
    expect(audit).toContain("ARTIFACT_UPDATED");
    // The same write delivered again says nothing.
    expect(fireHook("claude").stdout).toBe("");
  });

  test("Kiro CLI: no PostToolUse channel reaches the person, so nothing is printed", () => {
    seedShard(proj);
    writeFileSync(planPath, plan("x  "), "utf-8");
    const r = fireHook("kiro");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });
});

describe("t-code-generation-progress: the opencode adapter", () => {
  test("a tick in the plan shows the line as an information toast", async () => {
    cpSync(join(REPO_ROOT, "dist", "opencode", ".aidlc"), join(proj, ".aidlc"), { recursive: true });
    seedShard(proj);
    writeFileSync(planPath, plan("x  "), "utf-8");
    const toasts: EngineErrorToast[] = [];
    const client: PluginInput["client"] = {
      session: { get: async () => ({ data: {} }), prompt: async () => undefined },
      tui: { showToast: async ({ body }) => { toasts.push(body); } },
    };
    const adapter = await adapterPlugin.server({ client, directory: proj, aidlcCommand: HOOK_TEST_DRIVER });
    await adapter["tool.execute.after"](
      { tool: "edit", sessionID: "main", callID: "call-edit", args: { filePath: planPath } },
      { output: "" },
    );
    expect(toasts).toEqual([
      {
        title: "AI-DLC",
        message:
          `Code generation for ${UNIT}: 1 of 3 plan steps done, latest "Step 1: Add the user model in \`src/user.ts\`". ` +
          `Next: "Step 2: Add the login endpoint".`,
        variant: "info",
      },
    ]);
  });
});

describe("t-code-generation-progress: the start line", () => {
  function startLine(harness: string): string | null {
    const previous = process.env.AIDLC_HARNESS_NAME;
    process.env.AIDLC_HARNESS_NAME = harness;
    try {
      const path = join(codeGenerationRecordDir(proj, UNIT), "code-generation-plan.md");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, plan("   "), "utf-8");
      return codeGenerationStartNarration(proj, UNIT);
    } finally {
      if (previous === undefined) delete process.env.AIDLC_HARNESS_NAME;
      else process.env.AIDLC_HARNESS_NAME = previous;
    }
  }

  test("says a line shows per step where the hook shows one", () => {
    for (const harness of ["claude", "codex", "opencode"]) {
      expect(startLine(harness)).toEndWith("A line shows as each step is done, and I'll show a summary when complete.");
    }
  });

  test("keeps the summary-only promise where no line is shown", () => {
    for (const harness of ["kiro", "kiro-ide", "copilot", "cursor"]) {
      expect(startLine(harness)).toEndWith("complexity. I'll show a summary when complete.");
    }
  });
});
