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
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeBlock, sha256Bytes, sha256Matching } from "../../core/tools/aidlc-distribution.ts";
import {
  frameworkFilesDoctorCheck,
  instructionFileDoctorCheck,
} from "../../core/tools/aidlc-config-diagnostics.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { typedHarnessName } from "../../core/tools/aidlc-runtime-paths.ts";

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
    "--harness", typedHarnessName(harness), "--mcp", "none", ...extra,
  ], { cwd: project, encoding: "utf-8", timeout: NATIVE_STARTUP_TIMEOUT_MS });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

type Plan = { counts: Record<string, number>; actions: Array<{ path: string; action: string; detail?: string }> };
type Manifest = { files: Record<string, string>; rootContributions: Record<string, { hash: string }> };

function porcelain(project: string): string[] {
  const result = spawnSync("git", ["-c", "core.autocrlf=true", "status", "--porcelain"], { cwd: project, encoding: "utf-8" });
  if (result.error) throw result.error;
  return (result.stdout ?? "").split("\n").filter(Boolean);
}

function dryRun(project: string, harness: string): { status: number; plan: Plan; text: string } {
  const result = config(project, harness, ["--dry-run", "--json"]);
  const parsed = JSON.parse(result.stdout) as { data?: Plan };
  expect(parsed.data?.counts, result.stdout + result.stderr).toBeDefined();
  return { status: result.status, plan: parsed.data as Plan, text: result.stdout };
}

// A copy install's own tool (what a teammate runs in a clone): config from the
// project's tree, so nothing differs between the two runs but the checkout.
function copyConfig(project: string, harness: string, extra: string[]): { status: number; stdout: string; stderr: string } {
  const harnessDir = HARNESS_DIRS[harness as keyof typeof HARNESS_DIRS];
  const result = spawnSync(BUN, [
    join(project, harnessDir, "tools", "aidlc.ts"), "config", "--from", join(REPO_ROOT, "dist", harness),
    "--harness", typedHarnessName(harness), "--mcp", "none", ...extra,
  ], { cwd: project, encoding: "utf-8", timeout: NATIVE_STARTUP_TIMEOUT_MS });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// The same steps on a copy install: copy the release tree in, configure, commit, clone with CRLF checkouts.
function copiedClone(harness: string): { clone: string } {
  const root = temp(`aidlc-t2057-copy-${harness}-`);
  const project = join(root, "proj");
  const clone = join(root, "clone");
  git(root, ["init", "-q", project]);
  cpSync(join(REPO_ROOT, "dist", harness), project, { recursive: true });
  const configured = copyConfig(project, harness, ["--yes"]);
  expect(configured.status, configured.stdout + configured.stderr).toBe(0);
  git(project, ["add", "-A"]);
  git(project, ["commit", "-q", "-m", "aidlc config"]);
  git(root, ["clone", "-q", project, clone], true);
  git(clone, ["config", "core.autocrlf", "true"]);
  return { clone };
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

  // A teammate's CRLF clone, refreshed on the release it was committed with:
  // AI-DLC's record and the team's files stay as committed, so git shows
  // nothing changed (the parts, Codex's config.toml and Kiro CLI's mcp.json
  // each recorded a CRLF hash, and opencode.json was rewritten with LF).
  for (const harness of ["codex", "kiro", "opencode"] as const) {
    test(`${harness}: a refresh in a CRLF clone keeps the committed record and leaves git clean`, () => {
      const { clone } = copiedClone(harness);
      const manifestPath = join(clone, HARNESS_DIRS[harness], "tools", "data", "aidlc-manifest.json");
      const committed = JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest;
      const opencodeJson = harness === "opencode" ? readFileSync(join(clone, "opencode.json")) : null;
      if (opencodeJson) expect(opencodeJson.includes("\r\n")).toBe(true);
      const applied = copyConfig(clone, harness, ["--yes"]);
      expect(applied.status, applied.stdout + applied.stderr).toBe(0);
      const refreshed = JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest;
      expect(refreshed.files).toEqual(committed.files);
      expect(refreshed.rootContributions).toEqual(committed.rootContributions);
      if (opencodeJson) expect(readFileSync(join(clone, "opencode.json")).equals(opencodeJson)).toBe(true);
      expect(porcelain(clone)).toEqual([]);
    });
  }

  test("copilot: a CRLF clone whose AI-DLC part carries the team's own title line keeps it, and its record", () => {
    const { clone } = copiedClone("copilot");
    const agents = join(clone, "AGENTS.md");
    const shipped = readFileSync(agents, "utf-8");
    expect(shipped).toContain("# AI-DLC\r\n");
    const own = shipped.replace("# AI-DLC\r\n", "# Order Totals\r\n");
    writeFileSync(agents, own);
    git(clone, ["commit", "-q", "-am", "our title"], true);
    const manifestPath = join(clone, ".aidlc", "tools", "data", "aidlc-manifest.json");
    const committed = JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest;
    const planned = JSON.parse(copyConfig(clone, "copilot", ["--dry-run", "--json"]).stdout) as { data: Plan };
    expect(planned.data.actions.find((item) => item.path === "AGENTS.md")?.action).toBe("preserve");
    const applied = copyConfig(clone, "copilot", ["--yes"]);
    expect(applied.status, applied.stdout + applied.stderr).toBe(0);
    expect(readFileSync(agents, "utf-8")).toBe(own);
    expect((JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest).rootContributions)
      .toEqual(committed.rootContributions);
    expect(porcelain(clone)).toEqual([]);
  });

  test("a part's own record wins over another harness's record of it in other line endings", () => {
    const lf = "# BEGIN AI-DLC:gitignore\nfoo/\n# END AI-DLC:gitignore";
    const crlf = lf.replaceAll("\n", "\r\n");
    const [lfHash, crlfHash] = [sha256Bytes(lf), sha256Bytes(crlf)];
    const inCrlf = mergeBlock(".gitignore", `${crlf}\r\n`, "foo/\n", "gitignore", [], [lfHash, crlfHash]);
    expect([inCrlf.currentHash, inCrlf.nextHash]).toEqual([lfHash, lfHash]);
    const inLf = mergeBlock(".gitignore", `${lf}\n`, "foo/\n", "gitignore", [], [crlfHash, lfHash]);
    expect([inLf.currentHash, inLf.nextHash]).toEqual([crlfHash, crlfHash]);
  });

  // Each harness keeps its own record of a part the harnesses share, whatever
  // line endings another harness recorded it in (a Windows teammate's refresh
  // from before this fix left Claude Code's record in the CRLF form).
  test("codex beside Claude Code: a CRLF clone keeps Codex's record of the shared .gitignore part, and git clean", () => {
    const root = temp("aidlc-t2057-two-");
    const project = join(root, "proj");
    const clone = join(root, "clone");
    git(root, ["init", "-q", project]);
    for (const harness of ["claude", "codex", "claude"]) {
      cpSync(join(REPO_ROOT, "dist", harness), project, { recursive: true });
      const configured = copyConfig(project, harness, ["--yes"]);
      expect(configured.status, configured.stdout + configured.stderr).toBe(0);
    }
    const block = /# BEGIN AI-DLC:gitignore\n[\s\S]*?# END AI-DLC:gitignore/.exec(readFileSync(join(project, ".gitignore"), "utf-8"))?.[0] ?? "";
    const claudeManifest = join(project, ".claude", "tools", "data", "aidlc-manifest.json");
    const claude = JSON.parse(readFileSync(claudeManifest, "utf-8")) as Manifest;
    expect(claude.rootContributions[".gitignore"].hash).toBe(sha256Bytes(block));
    claude.rootContributions[".gitignore"].hash = sha256Bytes(block.replaceAll("\n", "\r\n"));
    writeFileSync(claudeManifest, `${JSON.stringify(claude, null, 2)}\n`);
    git(project, ["add", "-A"]);
    git(project, ["commit", "-q", "-m", "two harnesses"]);
    git(root, ["clone", "-q", project, clone], true);
    git(clone, ["config", "core.autocrlf", "true"]);
    const codexManifest = join(clone, ".codex", "tools", "data", "aidlc-manifest.json");
    const committed = JSON.parse(readFileSync(codexManifest, "utf-8")) as Manifest;
    expect(committed.rootContributions[".gitignore"].hash).toBe(sha256Bytes(block));
    const applied = copyConfig(clone, "codex", ["--yes"]);
    expect(applied.status, applied.stdout + applied.stderr).toBe(0);
    expect((JSON.parse(readFileSync(codexManifest, "utf-8")) as Manifest).rootContributions)
      .toEqual(committed.rootContributions);
    expect(porcelain(clone)).toEqual([]);
  });

  test("codex: in a CRLF clone a part the release changed is still refreshed, with the record of what it wrote", () => {
    const { clone } = copiedClone("codex");
    const gitignore = join(clone, ".gitignore");
    const current = readFileSync(gitignore, "utf-8");
    expect(current).toContain("aidlc/diagnostics/\r\n");
    // The part an earlier release wrote lacked a line; its record is that part's LF hash.
    const earlier = current.replace("aidlc/diagnostics/\r\n", "");
    writeFileSync(gitignore, earlier);
    const earlierBlock = /# BEGIN AI-DLC:gitignore\r\n[\s\S]*?# END AI-DLC:gitignore/.exec(earlier)?.[0] ?? "";
    expect(earlierBlock).not.toBe("");
    const manifestPath = join(clone, ".codex", "tools", "data", "aidlc-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest;
    manifest.rootContributions[".gitignore"].hash = sha256Bytes(earlierBlock.replaceAll("\r\n", "\n"));
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`.replaceAll("\n", "\r\n"));
    const applied = copyConfig(clone, "codex", ["--yes"]);
    expect(applied.status, applied.stdout + applied.stderr).toBe(0);
    const refreshed = readFileSync(gitignore, "utf-8");
    expect(refreshed).toBe(current);
    const block = /# BEGIN AI-DLC:gitignore\r\n[\s\S]*?# END AI-DLC:gitignore/.exec(refreshed)?.[0] ?? "";
    const recorded = (JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest).rootContributions[".gitignore"].hash;
    expect(recorded).toBe(sha256Bytes(block));
    expect(sha256Matching(block.replaceAll("\r\n", "\n"), [recorded])).toBe(recorded);
  });

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
