// covers: tool:aidlc-sensor, tool:aidlc-swarm, tool:aidlc-validate
//
// Seam: tool entrypoint exports for the future single CLI dispatcher.
// Mechanism: spawn fresh bun processes, dynamically import each shipped tool,
// and assert import is inert while exposing main(argv). This pins the
// process-boundary contract without invoking the dispatcher that will consume it.
//
// The default tools dir is dist/claude/.claude/tools so the shipped copies are
// what CI pins after packaging. AIDLC_T226_TOOLS_DIR is an explicit test seam
// used by slice verification to point the same assertions at core/tools before
// dist is regenerated.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const BUN = process.execPath;
const TOOLS_DIR =
  process.env.AIDLC_T226_TOOLS_DIR ??
  fileURLToPath(new URL("../../dist/claude/.claude/tools", import.meta.url));

const TOOL_FILES = [
  "aidlc-audit.ts",
  "aidlc-bolt.ts",
  "aidlc-graph.ts",
  "aidlc-jump.ts",
  "aidlc-learnings.ts",
  "aidlc-log.ts",
  "aidlc-orchestrate.ts",
  "aidlc-runner-gen.ts",
  "aidlc-runtime.ts",
  "aidlc-sensor-linter.ts",
  "aidlc-sensor-type-check.ts",
  "aidlc-state.ts",
  "aidlc-utility.ts",
  "aidlc-worktree.ts",
  "aidlc-sensor.ts",
  "aidlc-swarm.ts",
  "aidlc-validate.ts",
  "aidlc-sensor-required-sections.ts",
  "aidlc-sensor-upstream-coverage.ts",
] as const;

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "aidlc-t227-"));
}

function toolPath(file: string): string {
  return join(TOOLS_DIR, file);
}

function childEnv(projectDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_PROJECT_DIR: projectDir,
  };
  delete env.AIDLC_SENSORS_DIR;
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  return env;
}

function listEntries(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = statSync(abs);
    if (st.isDirectory()) {
      out.push(`${rel}/`);
      out.push(...listEntries(abs, rel));
    } else {
      out.push(rel);
    }
  }
  return out.sort();
}

function runImportProbe(file: string, projectDir: string) {
  const moduleUrl = pathToFileURL(toolPath(file)).href;
  return spawnSync(
    BUN,
    [
      "--eval",
      [
        `const m = await import(${JSON.stringify(moduleUrl)});`,
        'if (typeof m.main !== "function") {',
        '  console.error("missing-main");',
        "  process.exit(2);",
        "}",
      ].join("\n"),
    ],
    {
      cwd: projectDir,
      encoding: "utf-8",
      env: childEnv(projectDir),
      timeout: 5000,
    },
  );
}

function runTool(file: string, args: string[], projectDir: string) {
  return spawnSync(BUN, [toolPath(file), ...args], {
    cwd: projectDir,
    encoding: "utf-8",
    env: childEnv(projectDir),
    timeout: 5000,
  });
}

describe("t227 tool entrypoint exports", () => {
  for (const file of TOOL_FILES) {
    test(`${file} exports main(argv) and has no import side effects`, () => {
      const projectDir = makeProject();
      try {
        const result = runImportProbe(file, projectDir);
        const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;

        expect({
          status: result.status,
          signal: result.signal,
          error: result.error?.message,
          entries: listEntries(projectDir),
        }).toEqual({
          status: 0,
          signal: null,
          error: undefined,
          entries: [],
        });
        expect(combined).not.toMatch(/Usage:|unknown subcommand|\berror\b/i);
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });
  }

  test("aidlc-state dev path with no args still emits the usage/error envelope", () => {
    const projectDir = makeProject();
    try {
      const result = runTool("aidlc-state.ts", [], projectDir);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr ?? "").toContain("Unknown subcommand");
      expect(result.stderr ?? "").toContain("Valid: get, set");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("aidlc-graph dev path with no args still emits its usage shape", () => {
    const projectDir = makeProject();
    try {
      const result = runTool("aidlc-graph.ts", [], projectDir);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr ?? "").toContain("Usage: aidlc-graph <subcommand>");
      expect(result.stderr ?? "").toContain("Valid:");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("aidlc-sensor dev path list still reads sensors for a temp project", () => {
    const projectDir = makeProject();
    try {
      const result = runTool("aidlc-sensor.ts", ["list"], projectDir);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout ?? "").toContain("required-sections\tdeterministic");
      expect(result.stdout ?? "").toContain("upstream-coverage\tdeterministic");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
