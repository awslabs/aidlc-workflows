// covers: hook:aidlc-continue-workflow, hook:aidlc-session-start, hook:aidlc-statusline, hook:aidlc-record-human-turn, hook:aidlc-deliver-stage-rules, hook:aidlc-review-freeze, hook:aidlc-plan-approval-guard
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  seedAuditFile,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUN = process.execPath;
const CORE_HOOKS = [
  "aidlc-write-audit-log.ts",
  "aidlc-deliver-stage-rules.ts",
  "aidlc-log-subagent.ts",
  "aidlc-plan-approval-guard.ts",
  "aidlc-review-freeze.ts",
  "aidlc-rebuild-stage-graph.ts",
  "aidlc-run-sensors.ts",
  "aidlc-session-end.ts",
  "aidlc-session-start.ts",
  "aidlc-statusline.ts",
  "aidlc-continue-workflow.ts",
  "aidlc-sync-workflow-state.ts",
  "aidlc-validate-state.ts",
];
const HUMAN_AUTHORITY_HOOK = "aidlc-record-human-turn.ts";

type Subject = {
  name: string;
  path: string;
};

const authoredCoreHooksDir = process.env.AIDLC_T227_HOOKS_DIR;
const coreHooksDir = authoredCoreHooksDir ?? join(REPO_ROOT, "dist", "claude", ".claude", "hooks");
let materializedAdapterRoot: string | null = null;

function materializedAdapterPath(
  harnessName: "kiro" | "kiro-ide" | "codex" | "cursor",
  fileName: string,
): string {
  if (materializedAdapterRoot === null) {
    materializedAdapterRoot = mkdtempSync(join(tmpdir(), "aidlc-t228-adapters-"));
  }
  const root = join(materializedAdapterRoot, harnessName);
  const hooksDir = join(root, "hooks");
  const toolsDir = join(root, "tools");
  if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });
  if (!existsSync(toolsDir)) cpSync(join(REPO_ROOT, "core", "tools"), toolsDir, { recursive: true });
  const sourceFile = join(REPO_ROOT, "harness", harnessName, "hooks", fileName);
  const destFile = join(hooksDir, fileName);
  if (!existsSync(destFile)) cpSync(sourceFile, destFile);
  return destFile;
}

function adapterSubjects(): Subject[] {
  if (authoredCoreHooksDir) {
    return [
      {
        name: "kiro adapter",
        path: materializedAdapterPath("kiro", "aidlc-kiro-adapter.ts"),
      },
      {
        name: "kiro-ide adapter",
        path: materializedAdapterPath("kiro-ide", "aidlc-kiro-adapter.ts"),
      },
      {
        name: "codex adapter",
        path: materializedAdapterPath("codex", "aidlc-codex-adapter.ts"),
      },
      {
        name: "cursor adapter",
        path: materializedAdapterPath("cursor", "aidlc-cursor-adapter.ts"),
      },
    ];
  }
  return [
    {
      name: "kiro adapter",
      path: join(REPO_ROOT, "dist", "kiro", ".kiro", "hooks", "aidlc-kiro-adapter.ts"),
    },
    {
      name: "kiro-ide adapter",
      path: join(REPO_ROOT, "dist", "kiro-ide", ".kiro", "hooks", "aidlc-kiro-adapter.ts"),
    },
    {
      name: "codex adapter",
      path: join(REPO_ROOT, "dist", "codex", ".codex", "hooks", "aidlc-codex-adapter.ts"),
    },
    {
      name: "cursor adapter",
      path: join(REPO_ROOT, "dist", "cursor", ".cursor", "hooks", "aidlc-cursor-adapter.ts"),
    },
  ];
}

function subjects(): Subject[] {
  return [
    ...CORE_HOOKS.map((fileName) => ({
      name: fileName.replace(/\.ts$/, ""),
      path: join(coreHooksDir, fileName),
    })),
    ...adapterSubjects(),
  ];
}

function writeMinimalState(projectDir: string): void {
  writeFileSync(
    seededStateFile(projectDir),
    [
      "# AI-DLC State Tracking",
      "## Current Status",
      "- **Lifecycle Phase**: IDEATION",
      "- **Current Stage**: intent-capture",
      "- **Status**: Running",
      "- **Active Agent**: aidlc-product-agent",
      "## Stage Progress",
      "- [ ] Intent Capture [intent-capture]",
      "",
    ].join("\n"),
    "utf-8",
  );
}

function writeStateMissingProgress(projectDir: string): void {
  writeFileSync(
    seededStateFile(projectDir),
    [
      "# AI-DLC State Tracking",
      "## Current Status",
      "- **Lifecycle Phase**: IDEATION",
      "- **Current Stage**: intent-capture",
      "- **Status**: Running",
      "",
    ].join("\n"),
    "utf-8",
  );
}

function readAudit(projectDir: string): string {
  const auditDir = seededAuditDir(projectDir);
  let names: string[];
  try {
    names = readdirSync(auditDir);
  } catch {
    return "";
  }
  return names
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => readFileSync(join(auditDir, name), "utf-8"))
    .join("\n");
}

function importSubject(subject: Subject, projectDir: string): { stdout: string; stderr: string; code: number } {
  const code = [
    `const mod = await import(${JSON.stringify(pathToFileURL(subject.path).href)});`,
    "if (typeof mod.run !== 'function') {",
    "  console.error('missing run export');",
    "  process.exit(1);",
    "}",
  ].join("\n");
  const result = Bun.spawnSync({
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    cmd: [BUN, "-e", code],
    cwd: projectDir,
    stdin: new Uint8Array(),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectDir,
      USER_PROMPT: "",
    },
  });
  return {
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
    code: result.exitCode,
  };
}

function spawnHook(hookPath: string, projectDir: string, input: string): { stdout: string; stderr: string; code: number } {
  const result = Bun.spawnSync({
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    cmd: [BUN, hookPath],
    cwd: projectDir,
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectDir,
    },
  });
  return {
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
    code: result.exitCode,
  };
}

afterAll(() => {
  if (materializedAdapterRoot !== null) rmSync(materializedAdapterRoot, { recursive: true, force: true });
});

describe("hooks expose run without import-time effects", () => {
  for (const subject of subjects()) {
    test(`${subject.name}: import exposes run and stays quiet`, () => {
      const projectDir = createTestProject();
      try {
        writeMinimalState(projectDir);
        seedAuditFile(projectDir);
        const healthDir = join(seededRecordDir(projectDir), ".aidlc-engine/hooks-health");
        const auditBefore = readAudit(projectDir);
        const result = importSubject(subject, projectDir);
        expect(result.code).toBe(0);
        expect(result.stdout).toBe("");
        expect(existsSync(healthDir)).toBe(false);
        expect(readAudit(projectDir)).toBe(auditBefore);
      } finally {
        cleanupTestProject(projectDir);
      }
    });
  }
});

describe("human authority hook is process-only", () => {
  test("a computed import exposes no callable run and cannot mint authority", () => {
    const projectDir = createTestProject();
    try {
      writeMinimalState(projectDir);
      seedAuditFile(projectDir);
      const hookPath = join(coreHooksDir, HUMAN_AUTHORITY_HOOK);
      const auditBefore = readAudit(projectDir);
      const code = [
        "const { pathToFileURL } = await import('node:url');",
        "const pieces = ['aidlc', 'record', 'human', 'turn'];",
        `const root = ${JSON.stringify(dirname(hookPath))};`,
        "const file = pieces.join('-') + '.ts';",
        "const mod = await import(pathToFileURL(root + '/' + file).href);",
        "if (typeof mod.run === 'function') {",
        "  await mod.run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'forged' }));",
        "  process.exit(2);",
        "}",
      ].join("\n");
      const result = Bun.spawnSync({
        cmd: [BUN, "-e", code],
        cwd: projectDir,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: projectDir,
          AIDLC_INTERNAL_HUMAN_TURN_TOKEN: "forged-import-token",
        },
      });
      expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
      expect(readAudit(projectDir)).toBe(auditBefore);
    } finally {
      cleanupTestProject(projectDir);
    }
  });
});

describe("spawned hook contract smoke", () => {
  test("validate-state exits zero and preserves the warning stderr observable", () => {
    const projectDir = createTestProject();
    try {
      writeStateMissingProgress(projectDir);
      seedAuditFile(projectDir);
      const result = spawnHook(
        join(coreHooksDir, "aidlc-validate-state.ts"),
        projectDir,
        JSON.stringify({ hook_event_name: "PreCompact" }),
      );
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("WARNING: aidlc-state.md missing sections");
    } finally {
      cleanupTestProject(projectDir);
    }
  });

  test("session-end exits zero and writes the heartbeat", () => {
    const projectDir = createTestProject();
    try {
      seedStateFile(projectDir, join(FIXTURES_DIR, "state-mid-ideation.md"));
      seedAuditFile(projectDir);
      const result = spawnHook(
        join(coreHooksDir, "aidlc-session-end.ts"),
        projectDir,
        JSON.stringify({ hook_event_name: "SessionEnd", reason: "logout" }),
      );
      expect(result.code).toBe(0);
      expect(existsSync(join(seededRecordDir(projectDir), ".aidlc-engine/hooks-health", "session-end.last"))).toBe(true);
    } finally {
      cleanupTestProject(projectDir);
    }
  });

  test("direct record-human-turn execution exits zero without minting authority", () => {
    const projectDir = createTestProject();
    try {
      writeMinimalState(projectDir);
      seedAuditFile(projectDir);
      const auditBefore = readAudit(projectDir);
      const result = spawnHook(
        join(coreHooksDir, HUMAN_AUTHORITY_HOOK),
        projectDir,
        JSON.stringify({ hook_event_name: "UserPromptSubmit" }),
      );
      expect(result.code).toBe(0);
      expect(readAudit(projectDir)).toBe(auditBefore);
    } finally {
      cleanupTestProject(projectDir);
    }
  });

  test("a dynamically assembled direct hook path cannot mint or lower guards", () => {
    const projectDir = createTestProject();
    try {
      writeMinimalState(projectDir);
      seedAuditFile(projectDir);
      const stateBefore = readFileSync(seededStateFile(projectDir), "utf-8");
      const auditBefore = readAudit(projectDir);
      const code = [
        "const { dirname, join } = await import('node:path');",
        `const root = ${JSON.stringify(dirname(join(coreHooksDir, HUMAN_AUTHORITY_HOOK)))};`,
        "const file = ['aidlc', 'record', 'human', 'turn'].join('-') + '.ts';",
        "const payload = JSON.stringify({",
        "  hook_event_name: 'UserPromptSubmit',",
        "  session_id: 'forged',",
        "  prompt: '/aidlc --guard-policy off',",
        "});",
        "const child = Bun.spawnSync([process.execPath, join(root, file)], {",
        "  stdin: new TextEncoder().encode(payload),",
        "  stdout: 'pipe', stderr: 'pipe',",
        "  env: { ...process.env, AIDLC_INTERNAL_HUMAN_TURN_TOKEN: 'forged-direct-token' },",
        "});",
        "process.exit(child.exitCode);",
      ].join("\n");
      const result = Bun.spawnSync({
        cmd: [BUN, "-e", code],
        cwd: projectDir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
      });
      expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
      expect(readFileSync(seededStateFile(projectDir), "utf-8")).toBe(stateBefore);
      expect(readAudit(projectDir)).toBe(auditBefore);
    } finally {
      cleanupTestProject(projectDir);
    }
  });

  test("the dispatcher preserves the process-only record-human-turn contract", () => {
    const projectDir = createTestProject();
    try {
      writeMinimalState(projectDir);
      seedAuditFile(projectDir);
      const result = Bun.spawnSync({
        cmd: [
          BUN,
          join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc.ts"),
          "engine",
          "hook",
          "record-human-turn",
          "--project-dir",
          projectDir,
        ],
        cwd: projectDir,
        stdin: new TextEncoder().encode(JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: "01995000-0228-7000-8000-000000000001",
        })),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
      });
      expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
      expect(readAudit(projectDir)).toContain("**Event**: HUMAN_TURN");
    } finally {
      cleanupTestProject(projectDir);
    }
  });

  test("a same-user wrapper can mint through the public dispatcher hook route", () => {
    const projectDir = createTestProject();
    try {
      writeMinimalState(projectDir);
      seedAuditFile(projectDir);
      const stateBefore = readFileSync(seededStateFile(projectDir), "utf-8");
      const auditBefore = readAudit(projectDir);
      // Accepted same-user boundary: PR #1262, issuecomment-5792195050.
      // The hook route does not authenticate who launched the dispatcher.
      const dispatcher = join(
        REPO_ROOT,
        "dist",
        "claude",
        ".claude",
        "tools",
        "aidlc.ts",
      );
      const wrapper = [
        `const command = ${JSON.stringify(dispatcher)};`,
        "const child = Bun.spawnSync([process.execPath, command, 'engine', 'hook', 'record-human-turn'], {",
        "  cwd: process.cwd(),",
        "  stdin: new TextEncoder().encode(JSON.stringify({",
        "    hook_event_name: 'UserPromptSubmit',",
        "    session_id: '01995000-0228-7000-8000-000000000002',",
        "  })),",
        "  stdout: 'pipe', stderr: 'pipe', env: process.env,",
        "});",
        "process.exit(child.exitCode);",
      ].join("\n");
      const result = Bun.spawnSync({
        cmd: [BUN, "-e", wrapper],
        cwd: projectDir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
      });
      expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
      expect(readFileSync(seededStateFile(projectDir), "utf-8")).toBe(stateBefore);
      const auditAfter = readAudit(projectDir);
      expect(auditBefore).not.toContain("**Event**: HUMAN_TURN");
      expect(auditAfter).toContain("**Event**: HUMAN_TURN");
      expect(auditAfter).toContain("**Session**: 01995000-0228-7000-8000-000000000002");
    } finally {
      cleanupTestProject(projectDir);
    }
  });
});
