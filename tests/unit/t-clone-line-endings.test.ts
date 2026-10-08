// covers: tool:aidlc-init, function:sha256Matching, function:mergeBlock, function:instructionFileDoctorCheck, function:frameworkFilesDoctorCheck
//
// #2057: Git for Windows checks text files out with CRLF line endings (its
// default core.autocrlf=true), so a clone, branch switch, stash pop or new
// worktree of a configured project rewrites every file AI-DLC wrote with LF.
// The content is the same, so none of that is the person's change:
//   - config plans no conflict for such a copy, on every harness, and a refresh
//     goes through, leaving an unchanged file as it is;
//   - a real edit is still a conflict, and doctor names the files config will
//     refuse with the two ways forward config itself offers;
//   - a managed block recorded from a CRLF file still belongs to AI-DLC in an
//     LF checkout, so a release that changed it replaces it.
// The clone uses real git with core.autocrlf=true, which converts on Linux and
// macOS too, so this runs the reporter's steps on every OS.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Bytes, sha256Matching } from "../../core/tools/aidlc-distribution.ts";
import {
  frameworkFilesDoctorCheck,
  instructionFileDoctorCheck,
} from "../../core/tools/aidlc-config-diagnostics.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUN = process.execPath;
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const HARNESS_DIRS = {
  claude: ".claude",
  kiro: ".kiro",
  "kiro-ide": ".kiro",
  codex: ".codex",
  cursor: ".cursor",
  opencode: ".aidlc",
  copilot: ".aidlc",
} as const;
const AGENT = ".claude/agents/aidlc-developer-agent.md";

const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

function temp(prefix: string): string {
  const path = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  temporary.push(path);
  return path;
}

function git(cwd: string, args: string[], autocrlf = false): void {
  const result = spawnSync("git", [
    "-c", "user.name=t2057",
    "-c", "user.email=t2057@example.invalid",
    "-c", "init.defaultBranch=main",
    "-c", "commit.gpgsign=false",
    "-c", `core.autocrlf=${autocrlf}`,
    ...args,
  ], { cwd, encoding: "utf-8" });
  if (result.error) throw result.error;
  expect(result.status, `git ${args.join(" ")}: ${result.stderr}`).toBe(0);
}

function config(
  project: string,
  harness: string,
  extra: string[],
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(BUN, [
    INIT, "config", "--project-dir", project, "--from", join(REPO_ROOT, "dist-release", harness),
    "--harness", harness, "--mcp", "none", ...extra,
  ], { cwd: project, encoding: "utf-8", timeout: NATIVE_STARTUP_TIMEOUT_MS });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

type Plan = { counts: Record<string, number>; actions: Array<{ path: string; action: string; detail?: string }> };

function dryRun(project: string, harness: string): { status: number; plan: Plan; text: string } {
  const result = config(project, harness, ["--dry-run", "--json"]);
  const parsed = JSON.parse(result.stdout) as { data?: Plan };
  expect(parsed.data?.counts, result.stdout + result.stderr).toBeDefined();
  return { status: result.status, plan: parsed.data as Plan, text: result.stdout };
}

// The reporter's steps: configure, commit, clone with CRLF checkouts.
function configuredClone(harness: string): { project: string; clone: string } {
  const root = temp(`aidlc-t2057-${harness}-`);
  const project = join(root, "proj");
  const clone = join(root, "clone");
  git(root, ["init", "-q", project]);
  const configured = config(project, harness, ["--yes"]);
  expect(configured.status, configured.stdout + configured.stderr).toBe(0);
  git(project, ["add", "-A"]);
  git(project, ["commit", "-q", "-m", "aidlc config"]);
  git(root, ["clone", "-q", project, clone], true);
  git(clone, ["config", "core.autocrlf", "true"]);
  return { project, clone };
}

describe("#2057 line endings Git rewrites are not the person's change", () => {
  test("a hash matches the known hash it equals once line endings are set aside", () => {
    const lf = "one\ntwo\n";
    const crlf = "one\r\ntwo\r\n";
    expect(sha256Matching(crlf, [sha256Bytes(lf)])).toBe(sha256Bytes(lf));
    expect(sha256Matching(Buffer.from(lf), [undefined, sha256Bytes(crlf)])).toBe(sha256Bytes(crlf));
    expect(sha256Matching(lf, [sha256Bytes(lf)])).toBe(sha256Bytes(lf));
    // Any other byte is a real change: the value keeps its own hash.
    expect(sha256Matching("one\r\ntwo!\r\n", [sha256Bytes(lf)])).toBe(sha256Bytes("one\r\ntwo!\r\n"));
    expect(sha256Matching(crlf, [])).toBe(sha256Bytes(crlf));
  });

  for (const [harness, harnessDir] of Object.entries(HARNESS_DIRS)) {
    test(`${harness}: a CRLF clone of a configured project plans no conflict, and doctor agrees`, () => {
      const { project, clone } = configuredClone(harness);
      // The fixture really holds CRLF copies, as Git for Windows writes them.
      const manifest = readFileSync(join(clone, harnessDir, "tools", "data", "aidlc-projection.json"), "utf-8");
      expect(manifest).toContain("\r\n");
      const { status, plan, text } = dryRun(clone, harness);
      expect(plan.actions.filter((item) => item.action === "conflict"), text.slice(0, 2000)).toEqual([]);
      expect(status).toBe(0);
      expect(plan.counts.conflict).toBe(0);
      for (const tree of [project, clone]) {
        const instructions = instructionFileDoctorCheck(tree, harnessDir);
        expect(instructions.pass, instructions.label).toBe(true);
        const files = frameworkFilesDoctorCheck(tree, harnessDir);
        expect(files.pass, files.label).toBe(true);
      }
      if (harness === "kiro-ide") {
        // The engine writes this steering copy from the project's memory at
        // session start; it is not committed, so a clone starts without it.
        writeFileSync(join(clone, ".kiro", "steering", "aidlc-active-memory.md"), "project memory\r\n");
        expect(frameworkFilesDoctorCheck(clone, harnessDir).pass).toBe(true);
        expect(dryRun(clone, harness).plan.counts.conflict).toBe(0);
      }
    });
  }

  test("claude: the refresh goes through, keeps an unchanged copy as it is, and doctor agrees", () => {
    const { clone } = configuredClone("claude");
    const before = readFileSync(join(clone, AGENT));
    expect(before.includes("\r\n")).toBe(true);
    const applied = config(clone, "claude", ["--yes"]);
    expect(applied.status, applied.stdout + applied.stderr).toBe(0);
    expect(readFileSync(join(clone, AGENT)).equals(before)).toBe(true);
    const again = dryRun(clone, "claude");
    expect(again.plan.counts.conflict).toBe(0);
    expect(instructionFileDoctorCheck(clone, ".claude").pass).toBe(true);
    const files = frameworkFilesDoctorCheck(clone, ".claude");
    expect(files.pass, files.label).toBe(true);
  });

  test("claude: a real edit in a CRLF clone is still refused, and doctor names exactly what config refuses", () => {
    const { clone } = configuredClone("claude");
    const shipped = readFileSync(join(clone, AGENT), "utf-8");
    writeFileSync(join(clone, AGENT), `${shipped}my own notes\r\n`);
    // A runner file config writes again itself is never the person's to move.
    const runner = join(clone, ".claude", "skills", "aidlc-bugfix", "SKILL.md");
    expect(readFileSync(runner, "utf-8")).toContain("generated-by: aidlc-runner-gen");
    writeFileSync(runner, `${readFileSync(runner, "utf-8")}\r\nnotes\r\n`);
    const { status, plan } = dryRun(clone, "claude");
    expect(status).toBe(4);
    expect(plan.actions.filter((item) => item.action === "conflict")).toEqual([
      { path: AGENT, action: "conflict", detail: "locally modified or unowned" },
    ]);
    const row = frameworkFilesDoctorCheck(clone, ".claude");
    expect(row.pass).toBe(false);
    expect(row.severity).toBe("warn");
    expect(row.label).toContain(AGENT);
    expect(row.label).not.toContain("aidlc-bugfix");
    expect(row.fix).toMatch(
      /^to keep your version, move \.claude\/agents\/aidlc-developer-agent\.md somewhere else, then run `[^`]*config`; to take the shipped version over it, run `[^`]*config --force`$/,
    );

    // The instruction row names an edited CLAUDE.md; the AI-DLC files row does not repeat it.
    const onboarding = join(clone, ".claude", "CLAUDE.md");
    writeFileSync(onboarding, `${readFileSync(onboarding, "utf-8")}my own line\r\n`);
    const instructions = instructionFileDoctorCheck(clone, ".claude");
    expect(instructions.pass).toBe(false);
    // The way forward works: config refuses, so it never says only "run config".
    expect(instructions.fix).toMatch(
      /^to keep your version, move \.claude\/CLAUDE\.md somewhere else, then run `[^`]*config`; to take the shipped version over it, run `[^`]*config --force`$/,
    );
    const both = frameworkFilesDoctorCheck(clone, ".claude");
    expect(both.label).not.toContain("CLAUDE.md");
    expect(dryRun(clone, "claude").plan.counts.conflict).toBe(2);
  });

  test("a managed block recorded from a CRLF file is still AI-DLC's in an LF checkout", () => {
    // Configured on Windows by an earlier release whose .gitignore part lacked
    // a line, with the team's .gitignore in CRLF: its record is the CRLF form.
    // A teammate's LF checkout then refreshes onto the release that adds it.
    const project = temp("aidlc-t2057-block-");
    git(project, ["init", "-q", "."]);
    expect(config(project, "claude", ["--yes"]).status).toBe(0);
    const gitignore = join(project, ".gitignore");
    const text = readFileSync(gitignore, "utf-8");
    const earlier = text.replace("aidlc/diagnostics/\n", "");
    expect(earlier).not.toBe(text);
    writeFileSync(gitignore, earlier);
    const block = /# BEGIN AI-DLC:gitignore\n[\s\S]*?# END AI-DLC:gitignore/.exec(earlier)?.[0] ?? "";
    expect(block).not.toBe("");
    const manifestPath = join(project, ".claude", "tools", "data", "aidlc-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      rootContributions: Record<string, { hash: string }>;
    };
    manifest.rootContributions[".gitignore"].hash = sha256Bytes(block.replaceAll("\n", "\r\n"));
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const { status, plan } = dryRun(project, "claude");
    expect(plan.actions.find((item) => item.path === ".gitignore")).toEqual({ path: ".gitignore", action: "merge" });
    expect(status).toBe(0);
  });
});
