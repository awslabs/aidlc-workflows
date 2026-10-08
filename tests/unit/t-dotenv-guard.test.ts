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
// The copy-channel shape: the project's own copied dispatcher, as its hooks run it.
const dispatcherIn = (project: string): string => join(project, ".claude", "tools", "aidlc.ts");
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
    const shown = spawnSync(BUN, [dispatcherIn(project), "config", "flags", "--show", "--json"], {
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
    const shown = spawnSync(BUN, [dispatcherIn(project), "config", "flags", "--show", "--json"], {
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

  test("drops AI-DLC's and the host tools' names the file assigns, keeps the person's application names", () => {
    const dir = folder({
      ".env": "AIDLC_A=1\nAWS_AIDLC_DEFAULT_SCOPE=workshop\nCLAUDE_PROJECT_DIR=/elsewhere\nGIT_CONFIG_COUNT=1\nAIDLC_MISSING=1\n",
      ".env.local": "export AWS_PROFILE=repo\nDATABASE_URL=postgres://repo\nPATH=/nowhere\nOTHER=2\n",
    });
    const env: NodeJS.ProcessEnv = {
      AIDLC_A: "1",
      AWS_AIDLC_DEFAULT_SCOPE: "workshop",
      CLAUDE_PROJECT_DIR: "/elsewhere",
      GIT_CONFIG_COUNT: "1",
      AWS_PROFILE: "mine",
      DATABASE_URL: "postgres://mine",
      PATH: "/real/bin",
      OTHER: "2",
      KEEP: "mine",
    };
    expect(dropDotenvNames(env, dir)).toEqual(["AIDLC_A", "AWS_AIDLC_DEFAULT_SCOPE", "CLAUDE_PROJECT_DIR", "GIT_CONFIG_COUNT"]);
    expect(env).toEqual({ AWS_PROFILE: "mine", DATABASE_URL: "postgres://mine", PATH: "/real/bin", OTHER: "2", KEEP: "mine" });
    expect(dropDotenvNames(env, dir)).toEqual([]);
  });

  test("keeps the declarations only the host makes, even when the file names them", () => {
    const dir = folder({ ".env": "AIDLC_UNATTENDED=1\nAIDLC_INTERNAL_HUMAN_TURN_TOKEN=x\nAIDLC_HOOK_DEBUG=1\n" });
    const env: NodeJS.ProcessEnv = { AIDLC_UNATTENDED: "1", AIDLC_INTERNAL_HUMAN_TURN_TOKEN: "host-token", AIDLC_HOOK_DEBUG: "1" };
    expect(dropDotenvNames(env, dir)).toEqual(["AIDLC_HOOK_DEBUG"]);
    expect(env).toEqual({ AIDLC_UNATTENDED: "1", AIDLC_INTERNAL_HUMAN_TURN_TOKEN: "host-token" });
  });

  test("drops nothing when Bun loaded no file: the compiled engine, or a run started with --no-env-file", () => {
    const dir = folder({ ".env": "AIDLC_A=1\n" });
    const env: NodeJS.ProcessEnv = { AIDLC_A: "from-the-host" };
    expect(dropDotenvNames(env, dir, false)).toEqual([]);
    expect(env).toEqual({ AIDLC_A: "from-the-host" });
  });
});

describe("t-dotenv-guard: a host declaration survives a .env that names it", () => {
  test("an unattended driver stays unattended when the project .env also names the flag", () => {
    const project = projectWithClaudeTree();
    writeFileSync(join(project, ".env"), "AIDLC_UNATTENDED=1\n");
    // The runner's fixture profile switches the presence checks off in the real environment; the
    // hooks-off stop needs them on to be the thing an unattended run skips.
    const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_UNATTENDED: "1" };
    for (const name of Object.keys(env)) if (/^AIDLC_(?:SKIP|DISABLE|ALLOW)_/.test(name)) delete env[name];
    const next = spawnSync(BUN, [dispatcherIn(project), "engine", "orchestrate", "next"], {
      cwd: project,
      encoding: "utf-8",
      env,
      timeout: 60_000,
    });
    const captured = `${next.stdout ?? ""}${next.stderr ?? ""}`;
    expect(next.stdout, captured).not.toBe("");
    const directive = JSON.parse(next.stdout ?? "{}") as { kind?: string; message?: string };
    // Unattended: no person to stop for, so the first `next` goes straight to the workflow answer.
    expect(directive.kind, captured).toBe("error");
    expect(directive.message, captured).toContain("No workflow state found");
  });
});
