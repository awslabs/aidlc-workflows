// covers: function:broughtFilesChanged, function:holdsRecordedWrite, function:keepSetupWrites, subcommand:aidlc-orchestrate:report
//
// A person commits their AI-DLC setup (or does not), has work open past the
// start of Code Generation, runs `aidlc update` and `aidlc config`, and
// approves the build. The gate named AI-DLC's own skills, agents, AGENTS.md
// and .gitignore, rewritten by that refresh, as files the build changed. The
// install record says which files AI-DLC wrote and what it wrote, and only
// AI-DLC's marked part of a shared file is AI-DLC's: those are left out while
// they hold what the record says. Where git holds no copy of a shared file as
// the build found it (never committed, or AI-DLC's part merged into the
// team's committed file and not committed), the fingerprints config keeps of
// its own writes (aidlc/.aidlc-engine/setup-writes.json) tell its refresh from
// the build's change (#3981). A file the build changed is still named, an
// AI-DLC file included, and so is the person's part of AGENTS.md or
// .gitignore, committed copy or not.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { AIDLC_SRC, cleanupTestProject, REPO_ROOT, runOrchestrateNext, seededStateFile } from "../harness/fixtures.ts";
import { createCodeGenerationProject, reviewText, runNamed, stageDir, writePlan } from "../harness/code-generation-states.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { sourceBaselineAuditFields, workspaceBaselineStageSlugs } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

// The stage's checks are not this file's subject, and its fixture documents
// are not written for them.
process.env.AIDLC_DISABLE_SENSORS = "1";

setDefaultTimeout(600_000);
const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const REVIEWER = "aidlc-architecture-reviewer-agent";
const CHAT = "01995000-7a11-7000-8000-0000000c0001";
const README = "# Greeter\n\nSays hello.\n";
const ADDED = "\nA line the next release adds.\n";
// An ignore line the next release adds to AI-DLC's part of .gitignore.
const IGNORED = "aidlc/.aidlc-next-release/";

type Tree = "claude" | "codex" | "copilot" | "opencode";
// Where each tree keeps its engine, AI-DLC's files outside it the next release
// changes (as 2.11.2 changed skills, agents and AGENTS.md's part; a release
// often changes AI-DLC's part of .gitignore too), and whether AI-DLC has a
// part in AGENTS.md there.
const TREES: Record<Tree, { harnessDir: string; refreshed: string[]; agents: boolean }> = {
  claude: {
    harnessDir: ".claude",
    refreshed: [".claude/agents/aidlc-architect-agent.md", ".claude/skills/aidlc-session-cost/SKILL.md"],
    agents: false,
  },
  codex: {
    harnessDir: ".codex",
    refreshed: [".agents/skills/aidlc/SKILL.md", ".agents/skills/aidlc-session-cost/SKILL.md"],
    agents: true,
  },
  copilot: { harnessDir: ".aidlc", refreshed: [".github/agents/aidlc-architect-agent.md", ".github/skills/aidlc/SKILL.md"], agents: true },
  opencode: {
    harnessDir: ".aidlc",
    refreshed: [".opencode/agents/aidlc-architect-agent.md", ".opencode/plugin/aidlc-opencode-adapter.ts"],
    agents: true,
  },
};
// The fingerprints config keeps of its own writes.
const SETUP_WRITES = join("aidlc", ".aidlc-engine", "setup-writes.json");

function chat(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { AIDLC_SESSION_OVERRIDE: CHAT, AIDLC_SESSION_OVERRIDE_SOURCE: "payload", ...extra };
}

function git(proj: string, args: string[]): string {
  const run = spawnSync("git", args, {
    cwd: proj, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    env: { ...process.env, GIT_AUTHOR_NAME: "Person", GIT_AUTHOR_EMAIL: "person@example.com", GIT_COMMITTER_NAME: "Person", GIT_COMMITTER_EMAIL: "person@example.com" },
  });
  expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
  return run.stdout;
}

// `aidlc config` from a release tree, with a machine folder of its own.
function config(proj: string, from: string, tree: Tree, extra: string[] = []): void {
  const machine = mkdtempSync(join(realpathSync(tmpdir()), "aidlc-t-refreshed-machine-"));
  created.push(machine);
  const run = spawnSync(process.execPath, [INIT, "config", "--project-dir", proj, "--from", from, "--harness", tree, "--mcp", "none", "--yes", ...extra], {
    cwd: proj, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    env: { ...process.env, AIDLC_INSTALL_ROOT: join(machine, "share", "aidlc"), AIDLC_BIN_DIR: join(machine, "bin") },
  });
  expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
}

function next(proj: string): Record<string, unknown> {
  const result = runOrchestrateNext(join(AIDLC_SRC, "tools/aidlc-orchestrate.ts"), proj, [], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0", ...chat() },
  });
  expect(result.directive, result.out).not.toBeNull();
  return result.directive as Record<string, unknown>;
}

function write(proj: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(proj, path)), { recursive: true });
    writeFileSync(join(proj, path), text, "utf-8");
  }
}

// The line the next release adds to AI-DLC's files, and to its part of
// .gitignore, in the person's nth update.
function added(n: number): string {
  return n === 1 ? ADDED : `\nA line release ${n} adds.\n`;
}
function ignored(n: number): string {
  return n === 1 ? IGNORED : `aidlc/.aidlc-release-${n}/`;
}

// The nth update: a release whose AI-DLC files differ, and the refresh from it
// for each tree (`extra` passed to config, `--dry-run` for one).
function refresh(proj: string, trees: readonly Tree[], n: number, extra: string[] = []): void {
  for (const tree of trees) {
    const update = mkdtempSync(join(realpathSync(tmpdir()), "aidlc-t-refreshed-release-"));
    created.push(update);
    cpSync(join(REPO_ROOT, "dist-release", tree), update, { recursive: true });
    const { harnessDir, refreshed, agents } = TREES[tree];
    for (const path of [...refreshed, ...(agents ? [`${harnessDir}/tools/data/root-blocks/agents`] : [])]) {
      appendFileSync(join(update, path), added(n));
    }
    appendFileSync(join(update, harnessDir, "tools", "data", "root-blocks", "gitignore"), `\n${ignored(n)}\n`);
    config(proj, update, tree, extra);
  }
}

interface Day {
  type?: "Greenfield" | "Brownfield";
  // When the person commits: after setup, everything (the default); before it,
  // only their own files, leaving what setup wrote uncommitted; or never.
  git?: "after" | "before" | false;
  // The team's own AGENTS.md and .gitignore before setup.
  agents?: string;
  gitignore?: string;
  // Setup by a release that kept no fingerprints of its writes (2.11.4 and earlier).
  olderSetup?: boolean;
  // What the build does before the refresh, which comes while its approval waits.
  build?: (proj: string) => void;
  refreshes?: number;
}

/**
 * The person's day: AI-DLC set up (and committed, with git, as `git` says),
 * the work started over their files and the build begun on this release; then
 * the night's update, a refresh from a release whose AI-DLC files differ.
 */
function builtOverUpdate(trees: Tree | readonly Tree[], options: Day = {}): string {
  const all: readonly Tree[] = typeof trees === "string" ? [trees] : trees;
  const proj = createCodeGenerationProject("off", "off");
  created.push(proj);
  const stateFile = seededStateFile(proj);
  writeFileSync(stateFile, readFileSync(stateFile, "utf-8")
    .replace("- **Project Type**: Brownfield", `- **Project Type**: ${options.type ?? "Greenfield"}`)
    .replace("- [ ] code-generation", "- [-] code-generation")
    .replace(/^(- \[.\] units-generation) \u2014 EXECUTE$/m, "$1 \u2014 SKIP"), "utf-8");
  write(proj, { "README.md": README, "src/app.js": "export const greet = (name) => \"Hello \" + name;\n" });
  if (options.agents !== undefined) write(proj, { "AGENTS.md": options.agents });
  if (options.gitignore !== undefined) write(proj, { ".gitignore": options.gitignore });
  const gitMode = options.git ?? "after";
  if (gitMode === "before") {
    git(proj, ["init", "-q"]);
    const own = ["README.md", "src", ...(options.agents !== undefined ? ["AGENTS.md"] : []), ...(options.gitignore !== undefined ? [".gitignore"] : [])];
    git(proj, ["add", "--", ...own]);
    git(proj, ["commit", "-qm", "Start the project"]);
  }
  for (const tree of all) config(proj, join(REPO_ROOT, "dist-release", tree), tree);
  if (options.olderSetup && existsSync(join(proj, SETUP_WRITES))) unlinkSync(join(proj, SETUP_WRITES));
  if (gitMode === "after") {
    git(proj, ["init", "-q"]);
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "AI-DLC setup"]);
  }
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "poc", ...sourceBaselineAuditFields(proj, workspaceBaselineStageSlugs()) }, proj);
  appendAuditEntry("STAGE_STARTED", { Stage: "code-generation", ...sourceBaselineAuditFields(proj, "code-generation") }, proj);
  next(proj);
  writePlan(proj);
  const step = next(proj);
  expect(step.kind, JSON.stringify(step).slice(0, 600)).toBe("run-stage");
  options.build?.(proj);
  const refreshes = options.refreshes ?? 1;
  for (let n = 1; n <= refreshes; n++) refresh(proj, all, n);
  for (const tree of all) {
    for (const path of [...TREES[tree].refreshed, ...(TREES[tree].agents ? ["AGENTS.md"] : [])]) {
      expect(readFileSync(join(proj, path), "utf-8"), `the refresh rewrote ${path}`).toContain(added(refreshes).trim());
    }
  }
  expect(readFileSync(join(proj, ".gitignore"), "utf-8"), "the refresh rewrote .gitignore").toContain(ignored(refreshes));
  return proj;
}

// The build's own outputs, its review READY, and the gate opened as the agent opens it.
function openGate(proj: string): string {
  const env = chat();
  write(proj, { "src/greet.test.js": "// the build's test\n" });
  writeFileSync(join(stageDir(proj), "traceability.json"), "{}\n", "utf-8");
  writeFileSync(join(stageDir(proj), "code-summary.md"), "# Code Summary\n", "utf-8");
  const review = `bun .claude/tools/aidlc.ts engine log review --stage code-generation --reviewer ${REVIEWER} --iteration 1`;
  const requested = runNamed(proj, review, env);
  const reviewFile = (JSON.parse(requested.stdout || "{}") as { reviewFile?: string }).reviewFile;
  expect(reviewFile, requested.stdout + requested.stderr).toBeTruthy();
  mkdirSync(dirname(join(proj, reviewFile!)), { recursive: true });
  writeFileSync(join(proj, reviewFile!), reviewText(REVIEWER), "utf-8");
  expect(runNamed(proj, `${review} --verdict READY`, env).status).toBe(0);
  const ran = runNamed(proj, "bun .claude/tools/aidlc.ts engine orchestrate report --stage code-generation --result awaiting-approval", env);
  const step = JSON.parse(ran.stdout.trim().split("\n").at(-1) || "{}") as Record<string, unknown>;
  expect(step.kind, ran.stdout + ran.stderr).toBe("print");
  return String(step.narration ?? "");
}

function namesNone(line: string, paths: readonly string[]): void {
  for (const path of paths) expect(line, path).not.toContain(path);
}

describe("t-gate-skips-refreshed-own-files", () => {
  for (const tree of Object.keys(TREES) as Tree[]) {
    test(`${tree}: after the update and refresh, the gate names the README the build replaced and none of AI-DLC's refreshed files`, () => {
      const proj = builtOverUpdate(tree);
      if (tree === "copilot") {
        expect(readFileSync(join(proj, "AGENTS.md"), "utf-8").startsWith("<!-- BEGIN AI-DLC:agents -->")).toBe(true);
      }
      write(proj, { "README.md": "# Greeter\n\nRun npm start.\n" });
      const line = openGate(proj);
      expect(line).toContain(
        "The build changed README.md, a file you had before this work started. To put it back, run `git checkout HEAD -- README.md`.",
      );
      namesNone(line, [...TREES[tree].refreshed, "AGENTS.md", ".gitignore"]);
    });
  }

  test("opencode, existing code (the finding's own path): the build changed only its code, and the gate says nothing of files", () => {
    const proj = builtOverUpdate("opencode", { type: "Brownfield" });
    write(proj, { "src/app.js": "export const greet = (name) => \"Hello, \" + name + \"!\";\n" });
    expect(openGate(proj)).not.toContain("you had before this work started");
  });

  test("codex: an AI-DLC skill the build itself edited after the refresh is still named", () => {
    const proj = builtOverUpdate("codex");
    write(proj, { "README.md": "# Replaced\n" });
    appendFileSync(join(proj, ".agents/skills/aidlc/composer.md"), "\nThe build's note.\n");
    const line = openGate(proj);
    expect(line).toContain(
      "The build changed README.md and .agents/skills/aidlc/composer.md, files you had before this work started.",
    );
    namesNone(line, TREES.codex.refreshed);
  });

  test("copilot: a line the build added to AGENTS.md outside AI-DLC's part is named", () => {
    const proj = builtOverUpdate("copilot");
    write(proj, { "README.md": "# Replaced\n" });
    appendFileSync(join(proj, "AGENTS.md"), "\n# Our team's rules\n\nRun the linter first.\n");
    const line = openGate(proj);
    expect(line).toContain("The build changed AGENTS.md and README.md, files you had before this work started.");
    namesNone(line, TREES.copilot.refreshed);
  });

  for (const olderSetup of [false, true]) {
    test(`copilot without git${olderSetup ? ", set up by a release that kept no fingerprints" : ""}: neither AI-DLC's refreshed files nor the files it shares are named`, () => {
      const proj = builtOverUpdate("copilot", { git: false, olderSetup });
      write(proj, { "README.md": "# Replaced\n" });
      const line = openGate(proj);
      expect(line).toContain("The build changed README.md, a file you had before this work started. There is no committed copy to put back.");
      namesNone(line, [...TREES.copilot.refreshed, "AGENTS.md", ".gitignore"]);
    });
  }

  test("copilot without git: a build that removed the team's own text from AGENTS.md, leaving AI-DLC's part, is named", () => {
    const proj = builtOverUpdate("copilot", { git: false, agents: "# Our team's rules\n\nRun the linter first.\n" });
    const agents = readFileSync(join(proj, "AGENTS.md"), "utf-8");
    expect(agents).toContain("# Our team's rules");
    const begin = agents.indexOf("<!-- BEGIN AI-DLC:agents -->");
    expect(begin).toBeGreaterThan(0);
    write(proj, { "AGENTS.md": agents.slice(begin) });
    const line = openGate(proj);
    expect(line).toContain("The build changed AGENTS.md, a file you had before this work started. There is no committed copy to put back.");
    namesNone(line, [...TREES.copilot.refreshed, ".gitignore"]);
  });

  test("copilot without git: a line the build added to AGENTS.md before the refresh is named", () => {
    const proj = builtOverUpdate("copilot", {
      git: false,
      build: (dir) => appendFileSync(join(dir, "AGENTS.md"), "\n# Our team's rules\n\nRun the linter first.\n"),
    });
    const line = openGate(proj);
    expect(line).toContain("The build changed AGENTS.md, a file you had before this work started. There is no committed copy to put back.");
    namesNone(line, [...TREES.copilot.refreshed, ".gitignore"]);
  });

  test("claude, the reported path: set up by an older release, .gitignore never committed, the build changed README.md, then the upgrade", () => {
    const proj = builtOverUpdate("claude", {
      git: "before",
      olderSetup: true,
      build: (dir) => write(dir, { "README.md": "# Greeter\n\nRun npm start.\n" }),
    });
    expect(git(proj, ["status", "--porcelain", "--", ".gitignore"])).toContain("?? .gitignore");
    const line = openGate(proj);
    expect(line).toContain(
      "The build changed README.md, a file you had before this work started. To put it back, run `git checkout HEAD -- README.md`.",
    );
    namesNone(line, [...TREES.claude.refreshed, ".gitignore"]);
  });

  test("copilot without git: two refreshes while the approval waits leave AI-DLC's files unnamed", () => {
    const proj = builtOverUpdate("copilot", { git: false, refreshes: 2 });
    write(proj, { "README.md": "# Replaced\n" });
    const line = openGate(proj);
    expect(line).toContain("The build changed README.md, a file you had before this work started. There is no committed copy to put back.");
    namesNone(line, [...TREES.copilot.refreshed, "AGENTS.md", ".gitignore"]);
  });

  test("claude, an existing project: the team's .gitignore committed, AI-DLC's part merged into it and not committed; the refresh is not the build's", () => {
    const proj = builtOverUpdate("claude", { git: "before", gitignore: "node_modules/\n" });
    expect(git(proj, ["status", "--porcelain", "--", ".gitignore"])).toContain(" M .gitignore");
    write(proj, { "README.md": "# Replaced\n" });
    const line = openGate(proj);
    expect(line).toContain(
      "The build changed README.md, a file you had before this work started. To put it back, run `git checkout HEAD -- README.md`.",
    );
    namesNone(line, [...TREES.claude.refreshed, ".gitignore"]);
    expect(readFileSync(join(proj, ".gitignore"), "utf-8")).toContain("node_modules/");
  });

  test("claude and codex sharing .gitignore's part, both refreshed: neither shared file is named", () => {
    const proj = builtOverUpdate(["claude", "codex"], { git: "before" });
    write(proj, { "README.md": "# Replaced\n" });
    const line = openGate(proj);
    expect(line).toContain(
      "The build changed README.md, a file you had before this work started. To put it back, run `git checkout HEAD -- README.md`.",
    );
    namesNone(line, [...TREES.claude.refreshed, ...TREES.codex.refreshed, "AGENTS.md", ".gitignore"]);
  });

  test("copilot without git: the team's .gitignore in CRLF line endings, refreshed: not named", () => {
    const proj = builtOverUpdate("copilot", { git: false, gitignore: "node_modules/\r\ndist/\r\n" });
    expect(readFileSync(join(proj, ".gitignore"), "utf-8")).toContain("node_modules/\r\n");
    write(proj, { "README.md": "# Replaced\n" });
    const line = openGate(proj);
    expect(line).toContain("The build changed README.md, a file you had before this work started. There is no committed copy to put back.");
    namesNone(line, [...TREES.copilot.refreshed, "AGENTS.md", ".gitignore"]);
  });

  test("claude: the record stays out of git, and once git holds the file as config finds it, its fingerprints go", () => {
    const proj = builtOverUpdate("claude", { git: "before", gitignore: "node_modules/\n" });
    const record = join(proj, SETUP_WRITES);
    const runs = JSON.parse(readFileSync(record, "utf-8")) as Record<string, string[]>;
    expect(runs[".gitignore"]?.length, JSON.stringify(runs)).toBe(2);
    expect(spawnSync("git", ["check-ignore", "-q", SETUP_WRITES], { cwd: proj }).status).toBe(0);
    git(proj, ["add", "--", ".gitignore"]);
    git(proj, ["commit", "-qm", "AI-DLC's part"]);
    refresh(proj, ["claude"], 2);
    expect(Object.keys(JSON.parse(readFileSync(record, "utf-8")) as object)).not.toContain(".gitignore");
  });

  test("claude: a record that cannot be read is none, and the README the build changed is still named", () => {
    const proj = builtOverUpdate("claude", { git: "before" });
    writeFileSync(join(proj, SETUP_WRITES), "{", "utf-8");
    write(proj, { "README.md": "# Replaced\n" });
    expect(openGate(proj)).toContain("To put README.md back, run `git checkout HEAD -- README.md`");
  });

  test("claude: a change the build made to the team's .gitignore and committed, then the refresh, is named", () => {
    const proj = builtOverUpdate("claude", {
      git: "before",
      gitignore: "node_modules/\n",
      build: (dir) => {
        appendFileSync(join(dir, ".gitignore"), "build-output/\n");
        git(dir, ["add", "--", ".gitignore"]);
        git(dir, ["commit", "-qm", "Ignore the build's output"]);
      },
    });
    expect(openGate(proj)).toContain("The build changed .gitignore, a file you had before this work started.");
  });

  test("claude: a dry run leaves the record as it was", () => {
    const proj = builtOverUpdate("claude", { git: "before" });
    const record = join(proj, SETUP_WRITES);
    const before = readFileSync(record, "utf-8");
    const gitignore = readFileSync(join(proj, ".gitignore"), "utf-8");
    refresh(proj, ["claude"], 2, ["--dry-run"]);
    expect(readFileSync(record, "utf-8")).toBe(before);
    expect(readFileSync(join(proj, ".gitignore"), "utf-8")).toBe(gitignore);
  });
});
