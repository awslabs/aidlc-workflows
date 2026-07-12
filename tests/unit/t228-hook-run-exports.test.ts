// covers: hook:aidlc-stop, hook:aidlc-session-start, hook:aidlc-statusline, hook:aidlc-mint-presence
import { afterAll, describe, expect, test } from "bun:test";
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

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUN = process.execPath;
const CORE_HOOKS = [
  "aidlc-audit-logger.ts",
  "aidlc-log-subagent.ts",
  "aidlc-mint-presence.ts",
  "aidlc-runtime-compile.ts",
  "aidlc-sensor-fire.ts",
  "aidlc-session-end.ts",
  "aidlc-session-start.ts",
  "aidlc-statusline.ts",
  "aidlc-stop.ts",
  "aidlc-sync-statusline.ts",
  "aidlc-validate-state.ts",
];

type Subject = {
  name: string;
  path: string;
};

const authoredCoreHooksDir = process.env.AIDLC_T227_HOOKS_DIR;
const coreHooksDir = authoredCoreHooksDir ?? join(REPO_ROOT, "dist", "claude", ".claude", "hooks");
let materializedAdapterRoot: string | null = null;

function materializedAdapterPath(harnessName: "kiro" | "kiro-ide" | "codex", fileName: string): string {
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
        const healthDir = join(seededRecordDir(projectDir), ".aidlc-hooks-health");
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
      expect(existsSync(join(seededRecordDir(projectDir), ".aidlc-hooks-health", "session-end.last"))).toBe(true);
    } finally {
      cleanupTestProject(projectDir);
    }
  });

  test("mint-presence exits zero and appends HUMAN_TURN when state exists", () => {
    const projectDir = createTestProject();
    try {
      writeMinimalState(projectDir);
      seedAuditFile(projectDir);
      const result = spawnHook(
        join(coreHooksDir, "aidlc-mint-presence.ts"),
        projectDir,
        JSON.stringify({ hook_event_name: "UserPromptSubmit" }),
      );
      expect(result.code).toBe(0);
      expect(readAudit(projectDir)).toContain("**Event**: HUMAN_TURN");
    } finally {
      cleanupTestProject(projectDir);
    }
  });
});
