// covers: function:isGitRepo, subcommand:aidlc-orchestrate:report, subcommand:aidlc-orchestrate:next, cli:aidlc-utility(intent-create)
//
// t-no-git-said-once: in a project with no git, AI-DLC says once, in one line, that it cannot undo the changes it
// makes to the person's files and how git gives them an undo (Arden, "Warn once instead"). Without git the Code
// Generation gate can only say there is no committed copy to put back, after the build changed the file (the 11-03
// nightly, P182, the person's README on a poc project). The line rides the first gate the person is shown, as a line
// they must hear: every shipped scope gates before Code Generation, and a gate step is one the agent says, where the
// step after creation's lines went unsaid on Claude Code (P639). It is never said again for that project; an
// unattended run's gate keeps it for the person who takes over; a project in git, or a workspace whose repo is in
// git, never hears it. No new step: the gate is the same gate with or without the line.
//
// Mechanism: cli over the answers corpus Requirements Analysis gate (the real report and next), and the compiled
// scope grid and stage graph every shipped scope compiles to.
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { STAGE } from "../harness/aidlc-answers-corpus.ts";
import { env, exec, next, ORCHESTRATE, reviewedStage } from "../harness/aidlc-input-corpus.ts";
import { artifactFilename, findStageBySlug } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  createTestProject,
  REPO_ROOT,
  runOrchestrateNext,
  seedAidlcMemory,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const NO_GIT = "This project has no git, so AI-DLC can't undo the changes it makes to your files; " +
  "to get an undo, run `git init` and commit them.";
const SAID = join("aidlc", ".aidlc-sessions", "no-git-said");
const BUN = process.execPath;
const AIDLC = join(AIDLC_SRC, "tools", "aidlc.ts");
const SESSION = "01995000-7a11-7000-8000-00000000a0b1";

const projects: string[] = [];
afterEach(() => {
  for (const proj of projects.splice(0)) cleanupTestProject(proj);
});

interface Directive {
  kind?: string;
  stage?: string;
  gate_only?: boolean;
  next_stage?: string | null;
  question_id?: string;
  message?: string;
  narration?: string;
  change_notices?: string[];
  change_notices_note?: string;
}

function insideGit(dir: string): boolean {
  const res = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: dir, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return res.stdout?.trim() === "true";
}

function gitInit(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const made = spawnSync("git", ["init", "-q"], {
    cwd: dir, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(made.status, made.stderr).toBe(0);
}

function project(): string {
  const proj = createOrchestrationTestProject();
  projects.push(proj);
  // The fixture lives in the temp folder, which no git holds; a box that puts it inside one cannot run this file.
  expect(insideGit(proj), `${proj} is inside a git work tree`).toBe(false);
  // The fixture shell records the line as heard (so other tests' gates are main's); this project has not heard it.
  rmSync(join(proj, SAID), { force: true });
  return proj;
}

async function reportGate(proj: string, extraEnv: Record<string, string> = {}): Promise<{ out: string; directive: Directive | null }> {
  const res = await exec([BUN, ORCHESTRATE, "report", "--stage", STAGE, "--result", "awaiting-approval", "--project-dir", proj], {
    cwd: proj, env: env(proj, { env: extraEnv }),
  });
  let directive: Directive | null = null;
  try {
    directive = JSON.parse(res.stdout.trim().split("\n").at(-1) ?? "") as Directive;
  } catch {
    directive = null;
  }
  return { out: `${res.stdout}${res.stderr}`, directive };
}

const said = (step: Directive | null): string[] => (step?.change_notices ?? []).filter((line) => line === NO_GIT);
const heard = (step: Directive | null): string =>
  [...(step?.change_notices ?? []), step?.narration ?? "", step?.message ?? ""].join("\n");

// A project at its Requirements Analysis gate, as a run leaves it before the gate's report.
async function atGate(setup?: (proj: string) => void): Promise<string> {
  const proj = project();
  setup?.(proj);
  await reviewedStage(proj, []);
  return proj;
}

describe("t-no-git-said-once: a project with no git hears once, at its first gate, that AI-DLC cannot undo changes", () => {
  test("every shipped scope shows a gate before Code Generation, so the line comes before the build", () => {
    const shipped = readdirSync(join(REPO_ROOT, "core", "scopes"))
      .filter((name) => /^aidlc-.+\.md$/.test(name))
      .map((name) => name.slice("aidlc-".length, -".md".length))
      .sort();
    const data = join(AIDLC_SRC, "tools", "data");
    const grid = JSON.parse(readFileSync(join(data, "scope-grid.json"), "utf-8")) as Record<string, { stages: Record<string, string> }>;
    const graph = JSON.parse(readFileSync(join(data, "stage-graph.json"), "utf-8")) as Array<{ slug: string; phase: string }>;
    expect(Object.keys(grid).sort()).toEqual(shipped);
    for (const scope of shipped) {
      // Every planned stage past Initialization opens a gate (computeGate); only the first Construction stage's
      // skeleton gate can be left out, and it is never before Code Generation.
      const gated = graph.filter((stage) => grid[scope].stages[stage.slug] === "EXECUTE" && stage.phase !== "initialization");
      const build = gated.findIndex((stage) => stage.phase === "construction" || stage.phase === "operation");
      // An empty folder drops Reverse Engineering, so the next gate must come before the build too.
      for (const first of [gated[0], gated.filter((stage) => stage.slug !== "reverse-engineering")[0]]) {
        expect(first, scope).toBeDefined();
        expect(["ideation", "inception"], `${scope}: ${first?.slug}`).toContain(first?.phase);
        expect(gated.indexOf(first), scope).toBeLessThan(build === -1 ? gated.length : build);
      }
    }
    const poc = graph.filter((stage) => grid.poc.stages[stage.slug] === "EXECUTE" && stage.phase !== "initialization")
      .map((stage) => stage.slug);
    expect(poc.slice(0, 4)).toEqual(["intent-capture", "reverse-engineering", "requirements-analysis", "code-generation"]);
  });

  test("the first gate says it once, as a line the person must hear; the gate shown again does not", async () => {
    const proj = await atGate();
    const opened = await reportGate(proj);
    expect(opened.directive?.kind, opened.out).toBe("print");
    expect(said(opened.directive), JSON.stringify(opened.directive?.change_notices)).toHaveLength(1);
    expect(opened.directive?.change_notices_note, opened.out).toStartWith("Say each change_notices line to the person once");
    expect(String(opened.directive?.narration ?? "")).not.toContain("no git");
    expect(existsSync(join(proj, SAID))).toBe(true);
    const again = await next(proj, []);
    expect((again.directive as Directive | null)?.gate_only, again.out).toBe(true);
    expect(heard(again.directive as Directive | null)).not.toContain("no git");
  });

  test("an unattended run's gate says it and keeps it for the person who takes over", async () => {
    const proj = await atGate();
    const opened = await reportGate(proj, { AIDLC_UNATTENDED: "1" });
    expect(said(opened.directive), opened.out).toHaveLength(1);
    expect(existsSync(join(proj, SAID))).toBe(false);
    const shown = await next(proj, []);
    expect((shown.directive as Directive | null)?.gate_only, shown.out).toBe(true);
    expect(said(shown.directive as Directive | null), shown.out).toHaveLength(1);
    expect(existsSync(join(proj, SAID))).toBe(true);
    expect(heard((await next(proj, [])).directive as Directive | null)).not.toContain("no git");
  });

  // The open gate shown on `next` with no report before it (a new chat at a gate a teammate left, as t331 builds
  // it) comes after rules parts when the rules are large: the line rides each part and the step, and counts as heard
  // only once the step is written (a part's `continue` rebuilds the step, which must still carry it).
  test("a gate shown after rules parts says it with the step, and the record waits for that step", () => {
    const dir = createTestProject();
    projects.push(dir);
    seedAidlcMemory(dir);
    cpSync(AIDLC_SRC, join(dir, ".claude"), { recursive: true });
    seedStateFile(dir, "state-brownfield-feature.md");
    const statePath = seededStateFile(dir);
    writeFileSync(statePath, readFileSync(statePath, "utf-8").replace("[-] requirements-analysis", "[?] requirements-analysis"));
    rmSync(join(dir, SAID), { force: true });
    writeFileSync(join(dir, "aidlc", "spaces", "default", "memory", "org.md"),
      Array.from({ length: 180 }, (_, i) => `## Rule ${i}\n\n${"x".repeat(320)}\n`).join("\n"));
    const stage = findStageBySlug("requirements-analysis")!;
    const output = join(seededRecordDir(dir), stage.phase, stage.slug);
    mkdirSync(output, { recursive: true });
    for (const name of stage.produces ?? []) writeFileSync(join(output, artifactFilename(name)), `# ${name}\n`);
    const base = { ...process.env, AIDLC_PROJECT_DIR: dir, CLAUDE_PROJECT_DIR: dir };
    const log = (args: string[]): { reviewFile: string } => {
      const res = spawnSync(BUN, [join(dir, ".claude", "tools", "aidlc-log.ts"), ...args], {
        cwd: dir, encoding: "utf-8", env: { ...base, AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1" },
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
      expect(res.status, `${res.stdout}${res.stderr}`).toBe(0);
      return JSON.parse(res.stdout.trim()) as { reviewFile: string };
    };
    const review = ["review", "--stage", stage.slug, "--reviewer", stage.reviewer!, "--iteration", "1"];
    const requested = log(review);
    mkdirSync(dirname(join(dir, requested.reviewFile)), { recursive: true });
    writeFileSync(join(dir, requested.reviewFile), [
      "## Review", "", "**Verdict:** READY", `**Reviewer:** ${stage.reviewer}`, "**Iteration:** 1", "", "### Findings", "",
      "No outstanding findings.", "",
    ].join("\n"));
    log([...review, "--verdict", "READY"]);
    const next = () => runOrchestrateNext(join(dir, ".claude", "tools", "aidlc-orchestrate.ts"), dir, [], {
      cwd: dir,
      env: { ...base, AIDLC_SKIP_ARTIFACT_GUARD: "0", AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1", AIDLC_SKIP_REVIEWER_GATE_GUARD: "0" },
    });
    const shown = next();
    expect(shown.status, shown.out).toBe(0);
    expect(shown.steering.length, shown.out.slice(0, 600)).toBeGreaterThan(1);
    expect((shown.directive as Directive | null)?.gate_only).toBe(true);
    expect(said(shown.directive as Directive | null)).toHaveLength(1);
    expect(existsSync(join(dir, SAID))).toBe(true);
    expect(heard(next().directive as Directive | null)).not.toContain("no git");
  });

  test("a project in git, and a workspace whose repo is in git, never hear it", async () => {
    const inGit = await atGate((proj) => gitInit(proj));
    const opened = await reportGate(inGit);
    expect(opened.directive?.kind, opened.out).toBe("print");
    expect(heard(opened.directive)).not.toContain("no git");
    expect(existsSync(join(inGit, SAID))).toBe(false);

    const workspace = await atGate((proj) => gitInit(join(proj, "app")));
    const shown = await reportGate(workspace);
    expect(shown.directive?.kind, shown.out).toBe("print");
    expect(heard(shown.directive)).not.toContain("no git");
  });

  test("no new step: the gate is the same gate with or without the line", async () => {
    const noGit = await atGate();
    const inGit = await atGate((proj) => gitInit(proj));
    const a = (await reportGate(noGit)).directive;
    const b = (await reportGate(inGit)).directive;
    expect(said(a)).toHaveLength(1);
    expect([a?.kind, a?.next_stage, typeof a?.question_id]).toEqual([b?.kind, b?.next_stage, typeof b?.question_id]);
    expect((a?.change_notices ?? []).filter((line) => line !== NO_GIT)).toEqual(b?.change_notices ?? []);
    const a2 = (await next(noGit, [])).directive as Directive | null;
    const b2 = (await next(inGit, [])).directive as Directive | null;
    expect([a2?.kind, a2?.stage, a2?.gate_only]).toEqual([b2?.kind, b2?.stage, b2?.gate_only]);
  });

  test("the step after creation does not carry it: the gate is its one place", () => {
    const proj = project();
    const chat = { ...process.env, AIDLC_SESSION_OVERRIDE: SESSION, AIDLC_SESSION_OVERRIDE_SOURCE: "payload" };
    const creation = runOrchestrateNext(ORCHESTRATE, proj, ["--scope", "poc", "build a lunch poll"], { env: chat }).directive;
    expect(creation?.kind, JSON.stringify(creation)).toBe("print");
    const request = /--request ([0-9a-f]{8})/.exec(String(creation?.message))?.[1];
    expect(request, String(creation?.message)).toBeDefined();
    const made = spawnSync(BUN, [
      AIDLC, "engine", "intent", "create", "--scope", "poc", "--request", request ?? "", "--label", "lunch-poll",
      "--project-dir", proj,
    ], { cwd: proj, encoding: "utf-8", env: chat, timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
    expect(made.status, `${made.stdout}${made.stderr}`).toBe(0);
    const first = runOrchestrateNext(ORCHESTRATE, proj, [], { env: chat }).directive as Directive | null;
    expect(first?.kind, JSON.stringify(first)).toBe("run-stage");
    expect((first?.change_notices ?? []).join(" ")).toContain("Setting up the poc workflow for this");
    expect(heard(first)).not.toContain("no git");
    expect(existsSync(join(proj, SAID))).toBe(false);
  });
});
