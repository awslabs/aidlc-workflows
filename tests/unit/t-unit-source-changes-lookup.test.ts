// covers: subcommand:aidlc-state:lookup, function:buildStartListing
//
// A Unit's `source-manifest.json` lists every source path its build created,
// modified or deleted. `lookup source-changes <unit>` gives the agent a list to
// check its account of the build against without git, which Kiro asks the
// person about: what changed since that Unit's Code Generation began, AI-DLC's
// own files left out, with the other Units' manifests that list a path named
// beside it. It only reads.
// Places it cannot list as a manifest claims them (a recorded checkout, a folder
// a link leads to outside the project, a checkout the project's git ignores)
// are named apart, a name that is no Unit is refused, and an unreadable
// listing says so.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, runOrchestrateNext, seedAidlcMemory, seedBoltDag, seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import { runNamed } from "../harness/code-generation-states.ts";
import {
  checkoutCommand, cleanupLayouts, commitRecords, outsideRepo, shellWorkspace, startCodeGeneration, worktreeOf, writeCode,
} from "../harness/source-work-layouts.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { broughtFileNames } from "../../dist/claude/.claude/tools/aidlc-brought-files.ts";
import { sourceBaselineAuditFields, workspaceBaselineStageSlugs } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

// The stage's checks are not this file's subject.
process.env.AIDLC_DISABLE_SENSORS = "1";

setDefaultTimeout(600_000);
const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
  cleanupLayouts();
});

const CHAT = "01995000-7a11-7000-8000-0000000c0002";

function write(proj: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(proj, path)), { recursive: true });
    writeFileSync(join(proj, path), text, "utf-8");
  }
}

// `next`, with the setup questions Code Generation asks first answered: the
// folder stays existing code, and one session builds the Units.
function step(proj: string): Record<string, unknown> {
  for (let hop = 0; hop < 5; hop++) {
    const result = runOrchestrateNext(join(AIDLC_SRC, "tools/aidlc-orchestrate.ts"), proj, [], {
      env: {
        ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0",
        AIDLC_SESSION_OVERRIDE: CHAT, AIDLC_SESSION_OVERRIDE_SOURCE: "payload",
      },
    });
    const directive = result.directive as Record<string, unknown> | null;
    expect(directive, result.out).not.toBeNull();
    const command = directive!.kind !== "ask" ? undefined
      : directive!.ask_type === "project-type"
      ? directive!.existing_code_command
      : directive!.ask_type === "construction-staffing"
      ? (directive!.choices as Array<{ label: string; command?: string }>).find((choice) => choice.label === "Just me")?.command
      : undefined;
    if (typeof command !== "string") return directive!;
    const ran = runNamed(proj, command, { ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" });
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
  }
  throw new Error("the setup questions did not end in 5 answers");
}

function lookup(proj: string, unit: string): Record<string, unknown> {
  const ran = runNamed(proj, `bun .claude/tools/aidlc.ts engine state lookup source-changes ${unit}`);
  expect(ran.status, ran.stdout + ran.stderr).toBe(0);
  return JSON.parse(ran.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
}

// The packaged state tool, for a project with no AI-DLC install of its own.
function lookupWithTool(proj: string, args: string[]): { status: number; out: string; json: Record<string, unknown> | null } {
  const ran = spawnSync(process.execPath, [join(AIDLC_SRC, "tools", "aidlc-state.ts"), "lookup", "source-changes", ...args, "--project-dir", proj], {
    encoding: "utf-8",
  });
  const out = `${ran.stdout ?? ""}${ran.stderr ?? ""}`;
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse((ran.stdout ?? "").trim().split("\n").at(-1) ?? "") as Record<string, unknown>;
  } catch {
    // Not JSON: a refusal.
  }
  return { status: ran.status ?? -1, out, json };
}

function writeManifest(proj: string, unit: string, paths: string[]): void {
  const dir = join(seededRecordDir(proj), "construction", unit, "code-generation");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "source-manifest.json"), `${JSON.stringify({
    stage: "code-generation", unit, version: 1, writes: paths.map((path) => ({ path })),
  }, null, 2)}\n`);
}

// What the record holds and the files around it, to show the lookup wrote nothing.
function snapshot(proj: string): string {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [`${join(dir, entry.name)}\n${readFileSync(join(dir, entry.name), "utf-8")}`]);
  return walk(join(proj, "aidlc")).sort().join("\n");
}

// Existing code, Units alpha then beta, Code Generation the one Construction
// stage each Unit runs: alpha's Code Generation has begun.
function atAlphasBuild(): string {
  const p = createTestProject();
  created.push(p);
  seedAidlcMemory(p);
  writeFileSync(seededStateFile(p), `# AI-DLC State Tracking
## Project Information
- **Project**: Changed files
- **Project Type**: Brownfield
- **Project Type Source**: you
- **Scope**: feature
- **State Version**: 8
## Runtime State
- **Revision Count**: 0
- **Skeleton Stance**: off
- **Construction Iteration**: unit-major
- **Construction Checkpoints**: enabled
- **Construction Execution**: serial
- **Construction Autonomy Mode**: gated
- **Review Override**: advisory
- **Change Control**: strict
## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard
## Stage Progress
### CONSTRUCTION PHASE
- [S] functional-design — SKIP
- [S] nfr-requirements — SKIP
- [S] nfr-design — SKIP
- [S] infrastructure-design — SKIP
- [-] code-generation — EXECUTE
- [ ] build-and-test — EXECUTE
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: code-generation
- **Status**: Running
`);
  seedBoltDag(p, ["alpha", "beta"]);
  cpSync(AIDLC_SRC, join(p, ".claude"), { recursive: true });
  write(p, { "README.md": "# Notes\n", "src/notes.ts": "export const notes = 1;\n", "src/old.ts": "export const old = 1;\n" });
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature", ...sourceBaselineAuditFields(p, workspaceBaselineStageSlugs()) }, p);
  const plan = step(p);
  expect(plan.kind, JSON.stringify(plan).slice(0, 600)).toBe("run-stage");
  expect(plan.unit).toBe("alpha");
  return p;
}

describe("the files a Unit's build changed, for its source-manifest.json", () => {
  test("lists what the Unit's build created, modified and deleted, and writes nothing", () => {
    const p = atAlphasBuild();
    write(p, { "src/tag.ts": "export const tag = 1;\n", "src/notes.ts": "export const notes = 2;\n" });
    unlinkSync(join(p, "src/old.ts"));
    // AI-DLC's own record of the build is no Unit's source.
    write(p, { [join("aidlc", "spaces", "default", "intents", "notes-x", "scratch.md")]: "x\n" });
    const before = snapshot(p);
    expect(lookup(p, "alpha")).toEqual({
      unit: "alpha",
      since: "unit",
      changed: [
        { path: "src/notes.ts", change: "modified" },
        { path: "src/old.ts", change: "deleted" },
        { path: "src/tag.ts", change: "created" },
      ],
    });
    expect(snapshot(p)).toBe(before);
  });

  test("the next Unit's list leaves out what an earlier Unit's build changed", () => {
    const p = atAlphasBuild();
    write(p, { "src/tag.ts": "export const tag = 1;\n", "src/labels.ts": "export const labels = 1;\n" });
    writeManifest(p, "alpha", ["src/tag.ts", "src/labels.ts"]);
    // beta's Code Generation begins: the step that hands it out takes the files as beta finds them.
    broughtFileNames(p, readFileSync(seededStateFile(p), "utf-8"), false, "beta");
    write(p, { "src/export.ts": "export const exported = 1;\n", "src/tag.ts": "export const tag = 2;\n" });
    expect(lookup(p, "beta")).toEqual({
      unit: "beta",
      since: "unit",
      changed: [
        { path: "src/export.ts", change: "created" },
        { path: "src/tag.ts", change: "modified", listed_by: ["alpha"] },
      ],
    });
  });

  test("with no listing of the Unit's own start, the stage's start: another Unit's path says which Unit lists it", () => {
    const p = atAlphasBuild();
    write(p, { "src/tag.ts": "export const tag = 1;\n", "src/export.ts": "export const exported = 1;\n" });
    writeManifest(p, "alpha", ["src/tag.ts"]);
    expect(lookup(p, "beta")).toEqual({
      unit: "beta",
      since: "stage",
      changed: [
        { path: "src/export.ts", change: "created" },
        { path: "src/tag.ts", change: "created", listed_by: ["alpha"] },
      ],
    });
  });

  test("a name that is no Unit of this work is refused with the work's Units", () => {
    const p = atAlphasBuild();
    const ran = lookupWithTool(p, ["u1-tag"]);
    expect(ran.status, ran.out).not.toBe(0);
    expect(ran.out).toContain("No Unit named u1-tag in this work. Its Units: alpha, beta.");
  });

  // The Unit's own listing in brought-files, read before it is replaced: the
  // lookup answers from it (`since: "unit"`), so the replacement is what fails.
  function ownListing(p: string): string {
    const dir = join(seededRecordDir(p), ".aidlc-engine", "brought-files");
    const own = readdirSync(dir).find((name) => name.startsWith("unit-"));
    expect(own, readdirSync(dir).join(", ")).toBeDefined();
    expect(lookupWithTool(p, ["alpha"]).json).toMatchObject({ unit: "alpha", since: "unit" });
    return join(dir, own!);
  }

  test("a start listing that cannot be read answers available: false, not an error", () => {
    const p = atAlphasBuild();
    const listing = ownListing(p);
    // A folder where the file was: no regular file to read, on every OS.
    unlinkSync(listing);
    mkdirSync(listing);
    const ran = lookupWithTool(p, ["alpha"]);
    expect(ran.status, ran.out).toBe(0);
    expect(ran.json).toMatchObject({ unit: "alpha", available: false });
  });

  // A file link needs rights Windows does not give by default.
  test.skipIf(process.platform === "win32")("a start listing that is a link is not followed", () => {
    const p = atAlphasBuild();
    const listing = ownListing(p);
    const kept = readFileSync(listing, "utf-8");
    unlinkSync(listing);
    writeFileSync(join(p, "elsewhere.tsv"), kept);
    symlinkSync(join(p, "elsewhere.tsv"), listing);
    const ran = lookupWithTool(p, ["alpha"]);
    expect(ran.status, ran.out).toBe(0);
    expect(ran.json).toMatchObject({ unit: "alpha", available: false });
  });
});

// Code Generation under way with no Units and no listing of the work's start
// (only the stage's), its code partly in a worktree in the harness folder.
describe("the stage's start, and code kept in a recorded checkout", () => {
  test("with only the stage's start listing, the list starts there; a recorded checkout is named apart, not listed", () => {
    const proj = shellWorkspace(".claude/worktrees/\n");
    startCodeGeneration(proj, false);
    commitRecords(proj);
    const worktree = worktreeOf(proj, join(proj, ".claude", "worktrees", "feature"));
    writeCode(worktree);
    writeCode(proj);
    expect(checkoutCommand(proj, "add-checkout", ".claude/worktrees/feature").rc).toBe(0);
    const ran = lookupWithTool(proj, []);
    expect(ran.status, ran.out).toBe(0);
    // The checkout's own README and .gitignore were never this build's: it is named, for the build's account.
    expect(ran.json).toEqual({
      since: "stage",
      changed: [{ path: "src/auth/login.ts", change: "created" }],
      not_listed: [".claude/worktrees/feature"],
    });
  });
});

describe("places the lookup cannot list as a manifest claims them", () => {
  test("a folder a link leads to outside the project is named, not listed as its walk names it; a file named with @target is listed", () => {
    const proj = shellWorkspace("");
    const outside = outsideRepo();
    symlinkSync(outside, join(proj, "wt-link"), "junction");
    startCodeGeneration(proj, false);
    writeFileSync(join(outside, "src", "legacy.ts"), "export const legacy = 2;\n");
    // Beside the link, a file whose name starts with the link's and `@target`.
    write(proj, { "src/a@target.ts": "export const a = 1;\n", "wt-link@target.ts": "export const b = 1;\n" });
    const ran = lookupWithTool(proj, []);
    expect(ran.status, ran.out).toBe(0);
    expect(ran.json).toEqual({
      since: "stage",
      changed: [{ path: "src/a@target.ts", change: "created" }, { path: "wt-link@target.ts", change: "created" }],
      not_listed: ["wt-link"],
    });
  });

  test("a link in a folder the project's git ignores, to a folder outside, is named too", () => {
    const proj = shellWorkspace("links/\n");
    const outside = outsideRepo();
    mkdirSync(join(proj, "links"), { recursive: true });
    symlinkSync(outside, join(proj, "links", "app"), "junction");
    startCodeGeneration(proj, false);
    writeFileSync(join(outside, "src", "legacy.ts"), "export const legacy = 2;\n");
    const ran = lookupWithTool(proj, []);
    expect(ran.status, ran.out).toBe(0);
    expect(ran.json).toEqual({ since: "stage", changed: [], not_listed: ["links/app"] });
  });

  test("a checkout of its own that the project's git ignores is named, not dropped without a word", () => {
    const proj = shellWorkspace(".worktrees/\n");
    const worktree = worktreeOf(proj, join(proj, ".worktrees", "feature"));
    startCodeGeneration(proj, false);
    writeCode(worktree);
    const ran = lookupWithTool(proj, []);
    expect(ran.status, ran.out).toBe(0);
    expect(ran.json).toEqual({ since: "stage", changed: [], not_listed: [".worktrees/feature"] });
  });
});
