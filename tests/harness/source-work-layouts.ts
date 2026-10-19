// Code Generation fixtures for the source-work check: a real git workspace
// with AI-DLC set up, the code written only in one layout's folder, and the
// engine driven the way the conductor drives it. Shared by
// tests/unit/t-source-work-layouts.test.ts (the layouts matrix) and
// tests/unit/t331-guard-deadlock-liveness.test.ts (the ways on).

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse as parsePath } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  auditBlockField,
  discoverSiblingRepos,
  readAuditShardEvents,
  sourceBaselineAuditFields,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  seedAidlcMemory,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
  seedWorkspaceShell,
  toPortablePath,
} from "./fixtures.ts";

const BUN = process.execPath;
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
export const UNIT = "user-auth";

// Every folder a case made, removed after it.
const made: string[] = [];
export function cleanupLayouts(): void {
  while (made.length > 0) cleanupTestProject(made.pop());
}

export function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  return r.stdout;
}

function identity(cwd: string): void {
  git(cwd, ["config", "user.email", "t-source-work@example.com"]);
  git(cwd, ["config", "user.name", "t-source-work"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
}

function initRepo(cwd: string): void {
  mkdirSync(cwd, { recursive: true });
  git(cwd, ["init", "-q"]);
  identity(cwd);
}

function tempDir(prefix: string, base = process.env.TMPDIR || tmpdir()): string {
  const dir = toPortablePath(realpathSync(mkdtempSync(join(base, prefix))));
  made.push(dir);
  return dir;
}

// A repo kept outside the project, with code committed before the work began.
export function outsideRepo(base?: string): string {
  const repo = join(tempDir("t-source-work-outside-", base), "app");
  initRepo(repo);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# app\n");
  writeFileSync(join(repo, "src", "legacy.ts"), "export const legacy = 1;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "outside baseline"]);
  return repo;
}

// The AI-DLC workspace at Code Generation's start: a git repo with the record
// shell and a first commit carrying `ignore` as its .gitignore.
export function workspace(ignore: string, proj = createTestProject()): string {
  resetAidlcEnv();
  if (!made.includes(proj)) made.push(proj);
  seedAidlcMemory(proj);
  seedStateFile(proj, "state-mid-ideation.md");
  const sp = seededStateFile(proj);
  writeFileSync(sp, `${readFileSync(sp, "utf-8")}- **Collaborators**: on (set by you)\n`);
  initRepo(proj);
  writeFileSync(join(proj, ".gitignore"), ignore);
  writeFileSync(join(proj, "README.md"), "# workspace\n");
  git(proj, ["add", "-A"]);
  git(proj, ["commit", "-q", "-m", "workspace shell"]);
  return proj;
}

// A project that is a folder of a larger repo (a monorepo package).
export function monorepoWorkspace(): string {
  const mono = tempDir("t-source-work-mono-");
  initRepo(mono);
  const proj = join(mono, "packages", "app");
  mkdirSync(proj, { recursive: true });
  seedWorkspaceShell(proj);
  seedAidlcMemory(proj);
  seedStateFile(proj, "state-mid-ideation.md");
  const sp = seededStateFile(proj);
  writeFileSync(sp, `${readFileSync(sp, "utf-8")}- **Collaborators**: on (set by you)\n`);
  writeFileSync(join(mono, "README.md"), "# mono\n");
  git(mono, ["add", "-A"]);
  git(mono, ["commit", "-q", "-m", "monorepo shell"]);
  return proj;
}

// The intent's repos as intent creation records them: the child repos found
// then.
export function recordReposAsCreation(proj: string): string[] {
  const repos = discoverSiblingRepos(proj);
  if (repos.length === 0) return repos;
  const registry = join(dirname(seededRecordDir(proj)), "intents.json");
  const rows = JSON.parse(readFileSync(registry, "utf-8")) as Array<Record<string, unknown>>;
  writeFileSync(registry, `${JSON.stringify(rows.map((row) => ({ ...row, repos })), null, 2)}\n`);
  return repos;
}

// The piece of work's Guard Policy line, in place of the one it carries (the
// fixture's retired Change Control line included).
export function setGuardPolicy(proj: string, value: string, label: string): void {
  const sp = seededStateFile(proj);
  const line = `- **Guard Policy**: ${value} (${label})`;
  const content = readFileSync(sp, "utf-8");
  const replaced = content.replace(/^- \*\*(?:Guard Policy|Change Control)\*\*: .*$/m, line);
  writeFileSync(sp, replaced === content ? `${content.trimEnd()}\n${line}\n` : replaced);
}

// A memory layer's Guard Policy section (`Mode: <value>`).
export function memoryGuardPolicy(proj: string, mode: string): void {
  const file = join(proj, "aidlc", "spaces", "default", "memory", "project.md");
  mkdirSync(dirname(file), { recursive: true });
  const before = existsSync(file) ? readFileSync(file, "utf-8") : "# Project\n";
  writeFileSync(
    file,
    before.includes("## Guard Policy\n")
      ? before.replace("## Guard Policy\n", `## Guard Policy\n\nMode: ${mode}\n`)
      : `${before.trimEnd()}\n\n## Guard Policy\n\nMode: ${mode}\n`,
  );
}

export function engineEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.AIDLC_SKIP_ARTIFACT_GUARD;
  delete env.AIDLC_SKIP_SOURCE_FRESHNESS;
  delete env.AIDLC_DISABLE_ENSEMBLE_EVIDENCE;
  env.AIDLC_DISABLE_PLAN_APPROVAL_GUARD = "1";
  env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD = "1";
  for (const [key, value] of Object.entries(extra)) env[key] = value;
  return env;
}

// The human-presence check on, as in a person's own run.
export const PERSON = { AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0" };

export function state(proj: string, args: string[], extra: Record<string, string> = {}): { rc: number; out: string } {
  const env = engineEnv(extra);
  env.AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS = "1";
  const r = spawnSync(BUN, [STATE, ...args, "--project-dir", proj], { encoding: "utf-8", env });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

export interface EngineStep {
  rc: number;
  out: string;
  directive: Record<string, unknown> | null;
}

export function orchestrate(proj: string, args: string[], extra: Record<string, string> = {}): EngineStep {
  const r = spawnSync(BUN, [ORCHESTRATE, ...args, "--project-dir", proj], { encoding: "utf-8", env: engineEnv(extra) });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const last = (r.stdout ?? "").trim().split("\n").reverse().find((line) => line.trim().startsWith("{"));
  let directive: Record<string, unknown> | null = null;
  try {
    directive = last === undefined ? null : JSON.parse(last) as Record<string, unknown>;
  } catch {
    directive = null;
  }
  return { rc: r.status ?? -1, out, directive };
}

export function report(proj: string, result: string, extra: Record<string, string> = {}, more: string[] = []): EngineStep {
  return orchestrate(proj, ["report", "--stage", "code-generation", "--result", result, ...more], extra);
}

// The person's own reply, as the prompt-submit hook records it.
export function personSays(proj: string): void {
  appendAuditEntry("HUMAN_TURN", { Origin: "person", Source: "typed" }, proj);
}

export function stageBox(proj: string): string {
  const line = readFileSync(seededStateFile(proj), "utf-8").split("\n")
    .find((entry) => /^- \[.\] code-generation\b/.test(entry));
  return line?.slice(3, 4) ?? "";
}

export function sourceWorkRows(proj: string): Array<Record<string, string | null>> {
  return readAuditShardEvents(proj)
    .filter((row) => row.event === "SOURCE_WORK_NOT_FOUND")
    .map((row) => ({
      outcome: auditBlockField(row.block, "Outcome"),
      lookedIn: auditBlockField(row.block, "Looked In"),
      details: auditBlockField(row.block, "Details"),
    }));
}

export function approvalNote(proj: string): string | null {
  const rows = readAuditShardEvents(proj).filter((row) => row.event === "GATE_APPROVED");
  const last = rows.at(-1);
  return last === undefined ? null : auditBlockField(last.block, "Source Work");
}

function writeRecordDoc(proj: string, rel: string): void {
  const full = join(seededRecordDir(proj), rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, "# stub\n\n## A\n\n## B\n");
}

// Code Generation in progress with its records written: per Unit, or for the
// whole stage when the plan skips Units Generation.
export function startCodeGeneration(proj: string, perUnit: boolean): void {
  state(proj, ["set", "Current Stage=code-generation"]);
  state(proj, ["checkbox", "code-generation=in-progress"]);
  if (!perUnit) {
    const sp = seededStateFile(proj);
    writeFileSync(
      sp,
      readFileSync(sp, "utf-8").replace(/^(- \[[ xSR?-]\] units-generation\s+\u2014\s+)EXECUTE$/m, "$1SKIP"),
    );
  }
  appendAuditEntry(
    "STAGE_STARTED",
    { Stage: "code-generation", Agent: "aidlc-developer-agent", ...sourceBaselineAuditFields(proj, "code-generation") },
    proj,
  );
  const boundarySecond = Math.floor(Date.now() / 1000);
  while (Math.floor(Date.now() / 1000) === boundarySecond) {
    // Records written after the stage start's second.
  }
  const base = perUnit ? `construction/${UNIT}/code-generation` : "construction/code-generation";
  writeRecordDoc(proj, `${base}/code-generation-plan.md`);
  writeRecordDoc(proj, `${base}/unit-test-instructions.md`);
  writeRecordDoc(proj, `${base}/code-summary.md`);
  if (perUnit) writeRecordDoc(proj, `${base}/traceability.json`);
}

// The records committed in the workspace, so its last commit is records only.
export function commitRecords(proj: string, repoRoot = proj): void {
  git(repoRoot, ["add", "-A", "--", "."]);
  const staged = git(repoRoot, ["diff", "--cached", "--name-only"]).trim();
  if (staged.length > 0) git(repoRoot, ["commit", "-q", "-m", "code-generation records"]);
}

export function writeCode(dir: string, text = "export const login = 1;\n"): void {
  mkdirSync(join(dir, "src", "auth"), { recursive: true });
  writeFileSync(join(dir, "src", "auth", "login.ts"), text);
}

// The reviewer's pass over the stage (or the Unit, with its source manifest
// naming the code where it is), recorded with source freshness on.
export function review(
  proj: string,
  perUnit: boolean,
  writes: Array<Record<string, string>>,
  iteration = 1,
): { rc: number; out: string } {
  const reviewer = "aidlc-architecture-reviewer-agent";
  const artifact = join(
    seededRecordDir(proj),
    "construction",
    ...(perUnit ? [UNIT] : []),
    "code-generation",
    "code-generation-plan.md",
  );
  const current = existsSync(artifact) ? readFileSync(artifact, "utf-8") : "# plan\n\n## A\n\n## B\n";
  writeFileSync(artifact, `${current.replace(/(?:^|\r?\n)## Review[ \t]*(?:\r?\n|$)[\s\S]*$/, "").trimEnd()}\n`);
  if (perUnit) {
    seedBoltDag(proj, [UNIT]);
    writeFileSync(
      join(dirname(artifact), "source-manifest.json"),
      `${JSON.stringify({ stage: "code-generation", unit: UNIT, version: 1, writes }, null, 2)}\n`,
    );
  }
  const args = [LOG, "review", "--stage", "code-generation", "--reviewer", reviewer, "--iteration", String(iteration), "--project-dir", proj];
  if (perUnit) args.splice(4, 0, "--unit", UNIT);
  const env = engineEnv();
  const requested = spawnSync(BUN, args, { encoding: "utf-8", env });
  if ((requested.status ?? -1) !== 0) return { rc: requested.status ?? -1, out: `${requested.stdout}${requested.stderr}` };
  appendFileSync(
    artifact,
    ["", "## Review", "", "**Verdict:** READY", `**Reviewer:** ${reviewer}`, "**Date:** 2026-08-26T00:00:00Z", `**Iteration:** ${iteration}`, ""].join("\n"),
  );
  const verdict = spawnSync(BUN, [...args, "--verdict", "READY"], { encoding: "utf-8", env });
  return { rc: verdict.status ?? -1, out: `${verdict.stdout}${verdict.stderr}` };
}

// One place the code may be kept. `make` builds the folder (before the work
// starts or after, as `made` says) and returns where the code goes; `claim` is
// the Unit manifest's write for it.
export interface Layout {
  name: string;
  ignore: string;
  made: "before" | "after";
  make: (proj: string) => string;
  claim: (proj: string, recorded: string[]) => Record<string, string>;
  // The code is committed, then the records: the last commit is records only.
  commitsCode?: boolean;
  // The source walk (what the review binds) does not reach the code here, so
  // the check does not count it: the person decides with the note.
  outOfReview?: boolean;
  project?: () => string;
  skip?: string | false;
}

function worktreeOf(repo: string, path: string): string {
  git(repo, ["worktree", "add", "-q", path, "-b", `feature-${Math.random().toString(36).slice(2, 8)}`]);
  return path;
}

const inPlace = (place: string) => (_proj: string, recorded: string[]): Record<string, string> =>
  recorded.includes(place) ? { repo: place, path: "src/" } : { path: `${place}/src/` };

// A second fixed drive on Windows (a worktree of the project on another drive).
function otherDrive(): string | null {
  if (process.platform !== "win32") return null;
  const here = parsePath(process.env.TMPDIR || tmpdir()).root.toUpperCase();
  for (const candidate of [process.env.RUNNER_TEMP, "D:\\", "C:\\Windows\\Temp"]) {
    if (!candidate || !existsSync(candidate)) continue;
    if (parsePath(candidate).root.toUpperCase() !== here) return candidate;
  }
  return null;
}

export const LAYOUTS: Layout[] = [
  { name: "the project root", ignore: "", made: "after", make: (proj) => proj, claim: () => ({ path: "src/" }) },
  {
    name: "a worktree in a child folder, made before the work",
    ignore: "wt-feature/\n",
    made: "before",
    make: (proj) => worktreeOf(proj, join(proj, "wt-feature")),
    claim: inPlace("wt-feature"),
  },
  {
    name: "a worktree in a child folder, made after the work started",
    ignore: "wt-feature/\n",
    made: "after",
    make: (proj) => worktreeOf(proj, join(proj, "wt-feature")),
    claim: inPlace("wt-feature"),
  },
  {
    name: "a nested worktree",
    ignore: ".worktrees/\n",
    made: "after",
    make: (proj) => worktreeOf(proj, join(proj, ".worktrees", "feature")),
    claim: inPlace(".worktrees/feature"),
  },
  {
    name: "a worktree in the harness folder",
    outOfReview: true,
    ignore: ".claude/worktrees/\n",
    made: "after",
    make: (proj) => worktreeOf(proj, join(proj, ".claude", "worktrees", "feature")),
    claim: inPlace(".claude/worktrees/feature"),
  },
  {
    name: "an outside repo's worktree in a child folder, made after the work started",
    ignore: "wt-app/\n",
    made: "after",
    make: (proj) => worktreeOf(outsideRepo(), join(proj, "wt-app")),
    claim: inPlace("wt-app"),
  },
  {
    name: "an outside repo's worktree, nested",
    ignore: ".worktrees/\n",
    made: "before",
    make: (proj) => worktreeOf(outsideRepo(), join(proj, ".worktrees", "app")),
    claim: inPlace(".worktrees/app"),
  },
  {
    name: "an outside repo's worktree in the harness folder",
    outOfReview: true,
    ignore: ".claude/worktrees/\n",
    made: "after",
    make: (proj) => worktreeOf(outsideRepo(), join(proj, ".claude", "worktrees", "app")),
    claim: inPlace(".claude/worktrees/app"),
  },
  {
    name: "a separate clone, made after the work started",
    ignore: "app-clone/\n",
    made: "after",
    make: (proj) => {
      const clone = join(proj, "app-clone");
      git(proj, ["clone", "-q", outsideRepo(), clone]);
      identity(clone);
      return clone;
    },
    claim: inPlace("app-clone"),
  },
  {
    name: "a submodule",
    ignore: "",
    made: "before",
    make: (proj) => {
      git(proj, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", outsideRepo(), "libs/app"]);
      git(proj, ["commit", "-q", "-m", "the app as a submodule"]);
      identity(join(proj, "libs", "app"));
      return join(proj, "libs", "app");
    },
    claim: () => ({ path: "libs/app/src/" }),
  },
  {
    name: "a monorepo package",
    ignore: "",
    made: "after",
    project: monorepoWorkspace,
    make: (proj) => proj,
    claim: () => ({ path: "src/" }),
  },
  {
    name: "the root, the code committed and then the records",
    ignore: "",
    made: "after",
    commitsCode: true,
    make: (proj) => proj,
    claim: () => ({ path: "src/" }),
  },
  {
    name: "a worktree on another drive",
    outOfReview: true,
    ignore: "",
    made: "after",
    skip: process.platform !== "win32" ? "Windows only" : otherDrive() === null ? "one drive on this machine" : false,
    make: (proj) => worktreeOf(proj, join(tempDir("t-source-work-drive-", otherDrive() ?? undefined), "feature")),
    claim: () => ({ path: "src/" }),
  },
  {
    name: "a junction to a checkout elsewhere",
    ignore: "wt-link\n",
    made: "after",
    skip: process.platform !== "win32" ? "Windows only" : false,
    make: (proj) => linkedCheckout(proj, "junction"),
    claim: () => ({ path: "wt-link/" }),
  },
  // The same shape as the junction where links need no admin rights.
  {
    name: "a symlink to a checkout elsewhere",
    ignore: "wt-link\n",
    made: "after",
    skip: process.platform === "win32" ? "a junction on Windows" : false,
    make: (proj) => linkedCheckout(proj, "dir"),
    claim: () => ({ path: "wt-link/" }),
  },
];

// A clone kept outside the project, linked into it at `wt-link`. Made after
// the work started, every file in it is new to the stage, so the Unit claims
// the whole link.
function linkedCheckout(proj: string, type: "junction" | "dir"): string {
  const elsewhere = join(tempDir("t-source-work-link-"), "app");
  git(dirname(elsewhere), ["clone", "-q", outsideRepo(), elsewhere]);
  identity(elsewhere);
  symlinkSync(elsewhere, join(proj, "wt-link"), type);
  return elsewhere;
}

// The layout built around Code Generation, the code written where it keeps
// it (and committed with the records after it when the layout says so), and
// the review recorded. Returns the project.
export function buildLayout(layout: Layout, perUnit: boolean): { proj: string; codeDir: string } {
  const proj = layout.project ? layout.project() : workspace(layout.ignore);
  const repoRoot = git(proj, ["rev-parse", "--show-toplevel"]).trim();
  let codeDir = layout.made === "before" ? layout.make(proj) : "";
  const recorded = layout.made === "before" ? recordReposAsCreation(proj) : [];
  startCodeGeneration(proj, perUnit);
  commitRecords(proj, repoRoot);
  if (layout.made === "after") codeDir = layout.make(proj);
  writeCode(codeDir);
  if (layout.commitsCode) {
    git(codeDir, ["add", "src"]);
    git(codeDir, ["commit", "-q", "-m", "the code"]);
  }
  const reviewed = review(proj, perUnit, [layout.claim(proj, recorded)]);
  if (reviewed.rc !== 0) throw new Error(`review of ${layout.name} failed: ${reviewed.out}`);
  if (layout.commitsCode) commitRecords(proj, repoRoot);
  return { proj, codeDir };
}

// Code Generation with no code anywhere AI-DLC looks: the code went to a repo
// outside the project that is not a worktree of anything in it.
export function codeOutOfSight(perUnit = false): { proj: string; elsewhere: string } {
  const proj = workspace("");
  startCodeGeneration(proj, perUnit);
  commitRecords(proj);
  const elsewhere = outsideRepo();
  writeCode(elsewhere);
  const reviewed = review(proj, perUnit, []);
  if (reviewed.rc !== 0) throw new Error(`review failed: ${reviewed.out}`);
  return { proj, elsewhere };
}

export function isGuardAsk(step: EngineStep): boolean {
  return step.directive?.ask_type === "guard-recovery";
}

export function reasonCodes(step: EngineStep): string[] {
  const codes = step.directive?.reason_codes;
  return Array.isArray(codes) ? codes.map(String) : [];
}

export function notices(step: EngineStep): string[] {
  const list = step.directive?.change_notices;
  return Array.isArray(list) ? list.map(String) : [];
}
