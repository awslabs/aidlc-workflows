// covers: function:broughtFilesChanged, function:holdsRecordedWrite, subcommand:aidlc-orchestrate:report
//
// A person on Codex, Copilot or opencode commits their AI-DLC setup, has work
// open past the start of Code Generation, runs `aidlc update` and `aidlc
// config`, and approves the build. The gate named AI-DLC's own skills, agents
// and AGENTS.md, rewritten by that refresh, as files the build changed, with a
// checkout that put the older release's copies back. The install record says
// which files AI-DLC wrote and what it wrote, and only AI-DLC's marked part of
// a shared file is AI-DLC's: those are left out while they hold what the
// record says. A file the build changed is still named, an AI-DLC file
// included, and so is the person's part of AGENTS.md. Without git there is no
// copy to tell which part of AGENTS.md or .gitignore changed, so each is named
// as before.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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

type Tree = "codex" | "copilot" | "opencode";
// Where each tree keeps its engine, and AI-DLC's files outside it the next
// release changes (as 2.11.2 changed skills, agents and AGENTS.md's part; a
// release often changes AI-DLC's part of .gitignore too).
const TREES: Record<Tree, { harnessDir: string; refreshed: string[] }> = {
  codex: { harnessDir: ".codex", refreshed: [".agents/skills/aidlc/SKILL.md", ".agents/skills/aidlc-session-cost/SKILL.md"] },
  copilot: { harnessDir: ".aidlc", refreshed: [".github/agents/aidlc-architect-agent.md", ".github/skills/aidlc/SKILL.md"] },
  opencode: {
    harnessDir: ".aidlc",
    refreshed: [".opencode/agents/aidlc-architect-agent.md", ".opencode/plugin/aidlc-opencode-adapter.ts"],
  },
};

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
function config(proj: string, from: string, tree: Tree): void {
  const machine = mkdtempSync(join(realpathSync(tmpdir()), "aidlc-t-refreshed-machine-"));
  created.push(machine);
  const run = spawnSync(process.execPath, [INIT, "config", "--project-dir", proj, "--from", from, "--harness", tree, "--mcp", "none", "--yes"], {
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

/**
 * The person's day: AI-DLC set up (and committed, with git), the work started
 * over their files and the build begun on this release; then the night's
 * update, a refresh from a release whose AI-DLC files differ.
 */
function builtOverUpdate(
  tree: Tree,
  options: { type?: "Greenfield" | "Brownfield"; git?: boolean; agents?: string } = {},
): string {
  const proj = createCodeGenerationProject("off", "off");
  created.push(proj);
  const stateFile = seededStateFile(proj);
  writeFileSync(stateFile, readFileSync(stateFile, "utf-8")
    .replace("- **Project Type**: Brownfield", `- **Project Type**: ${options.type ?? "Greenfield"}`)
    .replace("- [ ] code-generation", "- [-] code-generation")
    .replace(/^(- \[.\] units-generation) \u2014 EXECUTE$/m, "$1 \u2014 SKIP"), "utf-8");
  write(proj, { "README.md": README, "src/app.js": "export const greet = (name) => \"Hello \" + name;\n" });
  if (options.agents !== undefined) write(proj, { "AGENTS.md": options.agents });
  const release = join(REPO_ROOT, "dist-release", tree);
  config(proj, release, tree);
  if (options.git ?? true) {
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
  const update = mkdtempSync(join(realpathSync(tmpdir()), "aidlc-t-refreshed-release-"));
  created.push(update);
  cpSync(release, update, { recursive: true });
  const { harnessDir, refreshed } = TREES[tree];
  for (const path of [...refreshed, `${harnessDir}/tools/data/root-blocks/agents`]) appendFileSync(join(update, path), ADDED);
  appendFileSync(join(update, harnessDir, "tools", "data", "root-blocks", "gitignore"), `\n${IGNORED}\n`);
  config(proj, update, tree);
  for (const path of [...refreshed, "AGENTS.md"]) {
    expect(readFileSync(join(proj, path), "utf-8"), `the refresh rewrote ${path}`).toContain(ADDED.trim());
  }
  expect(readFileSync(join(proj, ".gitignore"), "utf-8"), "the refresh rewrote .gitignore").toContain(IGNORED);
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

  test("copilot without git: AI-DLC's refreshed files are not named; the files it shares, with no copy to tell their parts apart, are", () => {
    const proj = builtOverUpdate("copilot", { git: false });
    write(proj, { "README.md": "# Replaced\n" });
    const line = openGate(proj);
    expect(line).toContain(
      "The build changed .gitignore, AGENTS.md and README.md, files you had before this work started. " +
        "There are no committed copies to put back.",
    );
    namesNone(line, TREES.copilot.refreshed);
  });

  test("copilot without git: a build that removed the team's own text from AGENTS.md, leaving AI-DLC's part, is named", () => {
    const proj = builtOverUpdate("copilot", { git: false, agents: "# Our team's rules\n\nRun the linter first.\n" });
    const agents = readFileSync(join(proj, "AGENTS.md"), "utf-8");
    expect(agents).toContain("# Our team's rules");
    const begin = agents.indexOf("<!-- BEGIN AI-DLC:agents -->");
    expect(begin).toBeGreaterThan(0);
    write(proj, { "AGENTS.md": agents.slice(begin) });
    const line = openGate(proj);
    expect(line).toContain("The build changed .gitignore and AGENTS.md, files you had before this work started.");
    namesNone(line, TREES.copilot.refreshed);
  });
});
