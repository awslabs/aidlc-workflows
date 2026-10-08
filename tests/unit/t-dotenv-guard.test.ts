// covers: file:core/tools/aidlc-dotenv.ts, function:dropDotenvNames, function:dotenvAssignedNames, function:setByDotenvFile, tool:aidlc
//
// Bun loads a project's `.env` files into the environment of every Bun process
// started in that folder, hooks and tools included. A repository the person
// clones must not steer the engine that way: a name a `.env` assigns never
// reaches a read, in the dispatcher or in the tools it spawns.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUN_DOTENV_FILES,
  dotenvAssignedNames,
  dropDotenvNames,
  setByDotenvFile,
} from "../../core/tools/aidlc-dotenv.ts";
import { createTestProject, REPO_ROOT } from "../harness/fixtures.ts";

const BUN = process.execPath;
const DISPATCHER = join(REPO_ROOT, "core", "tools", "aidlc.ts");
const projects: string[] = [];

afterEach(() => {
  for (const project of projects.splice(0)) rmSync(project, { recursive: true, force: true });
});

function projectWithClaudeTree(): string {
  const project = createTestProject();
  projects.push(project);
  cpSync(join(REPO_ROOT, "dist", "claude", ".claude"), join(project, ".claude"), { recursive: true });
  return project;
}

describe("t-dotenv-guard: a project .env never reaches the engine", () => {
  test("a setting a project .env assigns is read as the shipped default, not as the environment", () => {
    const project = projectWithClaudeTree();
    writeFileSync(join(project, ".env"), "AWS_AIDLC_DEFAULT_SCOPE=workshop\n");
    const env = { ...process.env };
    delete env.AWS_AIDLC_DEFAULT_SCOPE;
    const shown = spawnSync(BUN, [DISPATCHER, "config", "flags", "--show", "--json"], {
      cwd: project,
      encoding: "utf-8",
      env,
      timeout: 60_000,
    });
    const captured = `${shown.stdout ?? ""}${shown.stderr ?? ""}`;
    expect(shown.error, captured).toBeUndefined();
    expect(shown.status, captured).toBe(0);
    const doc = JSON.parse(shown.stdout ?? "") as { data: { sources: Record<string, string> } };
    expect(doc.data.sources.AWS_AIDLC_DEFAULT_SCOPE, captured).toBe("shipped default");
  });

  test("the same name set in the real environment is still the person's setting", () => {
    const project = projectWithClaudeTree();
    writeFileSync(join(project, ".env"), "AIDLC_UNRELATED_NAME=1\n");
    const shown = spawnSync(BUN, [DISPATCHER, "config", "flags", "--show", "--json"], {
      cwd: project,
      encoding: "utf-8",
      env: { ...process.env, AWS_AIDLC_DEFAULT_SCOPE: "workshop" },
      timeout: 60_000,
    });
    const captured = `${shown.stdout ?? ""}${shown.stderr ?? ""}`;
    expect(shown.status, captured).toBe(0);
    const doc = JSON.parse(shown.stdout ?? "") as { data: { sources: Record<string, string> } };
    expect(doc.data.sources.AWS_AIDLC_DEFAULT_SCOPE, captured).toBe("env");
  });
});

describe("t-dotenv-guard: the module", () => {
  function folder(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "aidlc-dotenv-"));
    projects.push(dir);
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return dir;
  }

  test("reads the names Bun's eight dotenv files assign, in every form Bun accepts", () => {
    const dir = folder({
      ".env": "# comment\nAIDLC_A=1\nexport AIDLC_B=\"two\"\n  AIDLC_C = 3 \nNOT_AN_ASSIGNMENT\n",
      ".env.local": "aidlc_d=4\n",
      ".env.test.local": "AIDLC_E=\n",
    });
    expect(BUN_DOTENV_FILES).toHaveLength(8);
    expect(dotenvAssignedNames(dir)).toEqual(["AIDLC_A", "AIDLC_B", "AIDLC_C", "aidlc_d", "AIDLC_E"]);
    expect(setByDotenvFile("AIDLC_D", dir)).toBe(true);
    expect(setByDotenvFile("AIDLC_Z", dir)).toBe(false);
    expect(dotenvAssignedNames(folder({}))).toEqual([]);
  });

  test("drops the assigned names from the environment, keeps PATH and every other name", () => {
    const dir = folder({ ".env": "AIDLC_A=1\nPATH=/nowhere\nAIDLC_MISSING=1\n", ".env.local": "export OTHER=2\n" });
    const env: NodeJS.ProcessEnv = { AIDLC_A: "from-file", PATH: "/real/bin", OTHER: "2", KEEP: "mine" };
    expect(dropDotenvNames(env, dir)).toEqual(["AIDLC_A", "OTHER"]);
    expect(env).toEqual({ PATH: "/real/bin", KEEP: "mine" });
    expect(dropDotenvNames(env, dir)).toEqual([]);
  });
});
