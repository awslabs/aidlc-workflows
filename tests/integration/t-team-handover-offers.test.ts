// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report, subcommand:aidlc-unit:share, subcommand:aidlc-unit:publish, subcommand:aidlc-unit:land, subcommand:aidlc-unit:pin, function:planMadeElsewhere, function:codeGenerationStepOnRecord
//
// In team-owned Construction on the workspace's own repository, each hand-over
// between people is put to the person as one question at the moment it is due,
// and a yes runs it: share the plan with the teams, take a Unit in another
// clone, publish a finished Unit, review and merge a published one, push main
// after a land. Each question is put once in its state; the reply that does not
// take it runs `next`, which never puts it again (no self-loop), and typed
// commands work as before.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActiveDirectiveMarker, readUnitScopeStamp } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { codeGenerationStepOnRecord } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import { AIDLC_SRC, seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import { gitBashPath, gitBashSkipReason } from "../harness/git-bash.ts";
import {
  ORCH,
  STATE,
  UNIT,
  approveMerge,
  asLeadsOwnCheckout as ranTheWorkHere,
  cleanupTempDirs,
  clone,
  git,
  makeSeed,
  nextDirective,
  parallelDependencyBody,
  prepareCandidate,
  runMergeTool,
  tempDirs,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

afterEach(cleanupTempDirs);

type Choice = { label: string; detail?: string; command?: string };

function choicesOf(directive: Record<string, unknown>): Choice[] {
  return (directive.choices ?? []) as Choice[];
}

function labels(directive: Record<string, unknown>): string[] {
  return choicesOf(directive).map((choice) => choice.label);
}

function commandFor(directive: Record<string, unknown>, label: string): string {
  const command = choicesOf(directive).find((choice) => choice.label === label)?.command;
  expect(command, JSON.stringify(directive)).toBeTruthy();
  return command as string;
}

function detailFor(directive: Record<string, unknown>, label: string): string | undefined {
  return choicesOf(directive).find((choice) => choice.label === label)?.detail;
}

const PLAIN_PUSH = "main to origin as a plain push; it never overwrites what a team pushed.";

function isHandover(directive: Record<string, unknown>, kind?: string): boolean {
  if (directive.kind !== "ask" || directive.ask_type !== "team-handover") return false;
  return kind === undefined || ((directive.handovers ?? []) as string[]).includes(kind);
}

// The lead's own checkout (asLeadsOwnCheckout), with the walking skeleton's
// stance settled, as the first Construction step does before the walk starts
// a Unit.
function asLeadsOwnCheckout(dir: string): void {
  writeFileSync(
    seededStateFile(dir),
    readFileSync(seededStateFile(dir), "utf-8")
      .replace("- **Unit Gate Rhythm**: per-stage\n", "- **Unit Gate Rhythm**: per-stage\n- **Skeleton Stance**: on\n"),
  );
  ranTheWorkHere(dir);
}

function boardText(directive: Record<string, unknown>): string {
  expect(directive.kind, JSON.stringify(directive)).toBe("notice");
  return String(directive.message);
}

// A clone whose dependency folder nobody ignored: `count` files git does not
// track, all but three deep in node_modules, and one file each one, two and
// three levels down (z-deploy.env and src/x/y.ts sort after node_modules,
// config/app.json before it).
function addManyNewFiles(dir: string, count: number): void {
  writeFileSync(join(dir, "z-deploy.env"), "KEY=untracked\n");
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(join(dir, "config", "app.json"), "{}\n");
  mkdirSync(join(dir, "src", "x"), { recursive: true });
  writeFileSync(join(dir, "src", "x", "y.ts"), "export const y = 1;\n");
  for (let i = 3; i < count; i++) {
    const folder = join(dir, "node_modules", `pkg-${i % 100}`, "lib");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `file-${i}.js`), "module.exports = 1;\n");
  }
}

// The new files outside aidlc/ that a commit here takes, as git lists them.
function newFilesOutsideRecord(dir: string): number {
  return git(dir, ["ls-files", "--others", "--exclude-standard"]).split("\n")
    .filter((path) => path !== "" && !path.startsWith("aidlc/")).length;
}

// However many new files there are, the question names ten, the ones nearest
// the project's top first and git's order within a depth, in git's own
// spelling (`/` on Windows too), and says how many more, so the step stays a
// few KB, far under any harness's limit for one step.
function expectTenNamedAndTheCount(directive: Record<string, unknown>, dir: string): void {
  const question = String(directive.question);
  const words = question.match(/\(new: (.*), and (\d+) more; `git status` shows the rest\)/);
  expect(words, question).not.toBeNull();
  const deepest = git(dir, ["ls-files", "--others", "--exclude-standard", "--", "node_modules"]).split("\n").slice(0, 7);
  expect((words as RegExpMatchArray)[1].split(", ")).toEqual(["z-deploy.env", "config/app.json", "src/x/y.ts", ...deepest]);
  expect(Number((words as RegExpMatchArray)[2])).toBe(newFilesOutsideRecord(dir) - 10);
  expect(question.length).toBeLessThan(1_500);
  expect(Buffer.byteLength(JSON.stringify(directive), "utf-8")).toBeLessThan(4 * 1024);
}

// Files of the person's already on main: one they later delete here, one
// they later edit in two halves.
function withPersonsPushedFiles(dir: string): void {
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "old-notes.md"), "notes the person keeps on main\n");
  writeFileSync(join(dir, "src", "split.ts"), "export const split = \"base\";\n");
  git(dir, ["add", "docs/old-notes.md", "src/split.ts"]);
  git(dir, ["commit", "-m", "the person's earlier work"]);
  git(dir, ["push", "origin", "HEAD"]);
}

// The person's own uncommitted work: a tracked edit, a new file git does not
// track, a staged new file, a staged edit with a further unstaged edit, and a
// delete. A commit here takes every one of them, so each is named by what the
// commit does to it.
function personsOwnEdits(dir: string): void {
  writeFileSync(join(dir, "src", "shared.ts"), `${readFileSync(join(dir, "src", "shared.ts"), "utf-8")}// half-done local edit\n`);
  writeFileSync(join(dir, "z-deploy.env"), "API_KEY=not-for-the-team\n");
  writeFileSync(join(dir, "staged-only.txt"), "staged, not committed\n");
  writeFileSync(join(dir, "src", "split.ts"), "export const split = \"staged half\";\n");
  git(dir, ["add", "staged-only.txt", "src/split.ts"]);
  writeFileSync(join(dir, "src", "split.ts"), "export const split = \"staged half\";\n// unstaged half\n");
  unlinkSync(join(dir, "docs", "old-notes.md"));
}

const OWN_EDITS_NAMED = "(changed: src/shared.ts, src/split.ts; new: staged-only.txt, z-deploy.env; deleted: docs/old-notes.md)";

// The files the last commit here took, a rename's two names apart.
function committedHere(dir: string): string[] {
  return git(dir, ["show", "--no-renames", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean);
}

// The step `next` gives in one chat (a line said once is said once a chat).
function nextInChat(dir: string, chat: string): Record<string, unknown> {
  const env = { AIDLC_SESSION_OVERRIDE: chat, AIDLC_SESSION_OVERRIDE_SOURCE: "payload" };
  let result = runMergeTool(ORCH, ["next"], dir, false, env);
  for (;;) {
    expect(result.status, result.out).toBe(0);
    const step = JSON.parse(result.stdout) as Record<string, unknown>;
    if (step.kind !== "load-steering" || typeof step.receipt !== "string") return step;
    result = runMergeTool(ORCH, ["continue", step.receipt], dir, false, env);
  }
}

// The share's result: it names what it committed in the words the question
// used, and counts what the commit took.
function expectResultNames(stdout: string, dir: string, words: string): void {
  const result = JSON.parse(stdout);
  expect(result, stdout).toMatchObject({ shared: true, committed_files: words });
  expect(words.startsWith(`the ${result.committed_paths} changed files here `), words).toBe(true);
  expect(committedHere(dir)).toHaveLength(result.committed_paths);
}

describe("step 1: the lead shares the plan with the teams", () => {
  test("Several teams, claims open, a remote: the first Unit step is the share offer, once", () => {
    const { seed: lead } = makeSeed();
    asLeadsOwnCheckout(lead);
    const offer = nextDirective(lead);
    expect(isHandover(offer, "share"), JSON.stringify(offer)).toBe(true);
    expect(String(offer.question)).toContain("Share them now?");
    expect(String(offer.question)).toContain("push main to origin");
    expect(labels(offer)).toEqual(["Share them with the teams", "Build them here for now"]);
    expect(commandFor(offer, "Share them with the teams")).toMatch(/ unit share$/);
    expect(commandFor(offer, "Build them here for now")).toMatch(/ next$/);
    expect(detailFor(offer, "Share them with the teams")).toBe(`Pushes ${PLAIN_PUSH}`);
    expect(JSON.stringify(offer)).not.toContain("Team work needs this project at the top");
    // No self-loop: the reply that does not take it runs next, and the walk goes on.
    const walk = nextDirective(lead);
    expect(isHandover(walk), JSON.stringify(walk)).toBe(false);
    expect(walk).toMatchObject({ kind: "run-stage", unit: "alpha" });
  });

  test("share commits, pushes main, and this checkout shows the board", () => {
    const { seed: lead, remote } = makeSeed();
    asLeadsOwnCheckout(lead);
    writeFileSync(join(lead, "notes.txt"), "an untracked note\n");
    expect(String(nextDirective(lead).question)).toContain("notes.txt");
    const shared = runMergeTool(UNIT, ["share"], lead);
    expect(shared.status, shared.out).toBe(0);
    expect(JSON.parse(shared.stdout)).toMatchObject({ shared: true, branch: "main", remote: "origin" });
    expect(git(remote, ["rev-parse", "main"])).toBe(git(lead, ["rev-parse", "HEAD"]));
    expect(git(lead, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
    const board = boardText(nextDirective(lead));
    expect(board).toContain("# Team Construction Board");
  });

  // Once shared, the teams build the Units: the lead's "redo" with no Unit
  // named is never sent to a Unit step this checkout does not build.
  test("after the share, a redo that names no Unit names no Unit step here", () => {
    const { seed: lead } = makeSeed();
    asLeadsOwnCheckout(lead);
    expect(isHandover(nextDirective(lead), "share")).toBe(true);
    const shared = runMergeTool(UNIT, ["share"], lead);
    expect(shared.status, shared.out).toBe(0);
    const redo = runMergeTool(ORCH, ["report", "--result", "resumed", "--choice", "redo"], lead);
    expect(redo.status, redo.out).toBe(0);
    const message = String((JSON.parse(redo.stdout) as { message?: string }).message);
    expect(message).not.toContain('for unit "alpha"');
    expect(boardText(nextDirective(lead))).toContain("# Team Construction Board");
  });

  // Share commits every path git shows: with a handful of new files the
  // question names every one, so a key in the sixth file is seen before it is
  // pushed.
  test("a handful of new files: the share question names every one outside aidlc/", () => {
    const { seed: lead } = makeSeed();
    asLeadsOwnCheckout(lead);
    for (const name of ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt", "z-deploy.env"]) {
      writeFileSync(join(lead, name), "untracked\n");
    }
    const question = String(nextDirective(lead).question);
    expect(question).toContain("(new: a.txt, b.txt, c.txt, d.txt, e.txt, z-deploy.env)");
    expect(question).not.toContain(" more; ");
  });

  test("hundreds of new files: the share question is put, says how many and names ten", () => {
    const { seed: lead } = makeSeed();
    asLeadsOwnCheckout(lead);
    addManyNewFiles(lead, 400);
    const offer = nextDirective(lead);
    expect(isHandover(offer, "share"), JSON.stringify(offer).slice(0, 2000)).toBe(true);
    expectTenNamedAndTheCount(offer, lead);
  });

  // The share commits the person's tracked edits, staged files and deletes
  // as well as new files, so the question names each by what the commit does
  // to it, and the result after the push names what it took in the same words.
  test("the person's own edits, staged files and a delete: the share question names each, and so does its result", () => {
    const { seed: lead, remote } = makeSeed();
    asLeadsOwnCheckout(lead);
    withPersonsPushedFiles(lead);
    personsOwnEdits(lead);
    const base = git(remote, ["rev-parse", "main"]);
    const offer = nextDirective(lead);
    expect(isHandover(offer, "share"), JSON.stringify(offer)).toBe(true);
    const question = String(offer.question);
    const words = question.match(/I'd commit (the \d+ changed files here \(.*\)) and push main to origin, /)?.[1];
    expect(words, question).toEndWith(` here ${OWN_EDITS_NAMED}`);
    const shared = runMergeTool(UNIT, ["share"], lead);
    expect(shared.status, shared.out).toBe(0);
    expectResultNames(shared.stdout, lead, words as string);
    // What the share takes is as before: every one of them reaches the remote.
    const onRemote = git(remote, ["diff", "--name-status", base, "main"]).split("\n");
    for (const line of ["M\tsrc/shared.ts", "M\tsrc/split.ts", "A\tstaged-only.txt", "A\tz-deploy.env", "D\tdocs/old-notes.md"]) {
      expect(onRemote).toContain(line);
    }
    expect(git(remote, ["show", "main:src/split.ts"])).toContain("unstaged half");
  });

  test("a typed share puts no question, and its result names what it committed", () => {
    const { seed: lead } = makeSeed();
    asLeadsOwnCheckout(lead);
    withPersonsPushedFiles(lead);
    personsOwnEdits(lead);
    const shared = runMergeTool(UNIT, ["share"], lead);
    expect(shared.status, shared.out).toBe(0);
    const words = String(JSON.parse(shared.stdout).committed_files);
    expect(words).toEndWith(` here ${OWN_EDITS_NAMED}`);
    expectResultNames(shared.stdout, lead, words);
  });

  test("the share run again after its own reading step names what it committed", () => {
    const { seed: lead } = makeSeed();
    asLeadsOwnCheckout(lead);
    const teamMd = join(lead, "aidlc", "spaces", "default", "memory", "team.md");
    writeFileSync(teamMd, readFileSync(teamMd, "utf-8").replace("## Way of Working\n", "## Way of Working\n\nWork merges into `main`.\n"));
    withPersonsPushedFiles(lead);
    personsOwnEdits(lead);
    const first = runMergeTool(UNIT, ["share"], lead);
    expect(first.status, first.out).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ shared: false });
    const recorded = runMergeTool(STATE, ["practices-branch", "--file", "team.md", "--branch", "main"], lead);
    expect(recorded.status, recorded.out).toBe(0);
    const again = runMergeTool(UNIT, ["share"], lead);
    expect(again.status, again.out).toBe(0);
    const words = String(JSON.parse(again.stdout).committed_files);
    expect(words).toEndWith(` here ${OWN_EDITS_NAMED}`);
    expectResultNames(again.stdout, lead, words);
  });

  // A rename and a removal the person staged with git (git mv, git rm) are in
  // neither the index nor the disk under the old names, which git add refuses
  // to be given, so the share stopped on "git add failed" on every try.
  test("a rename and a removal the person staged with git: the share commits and names them", () => {
    const { seed: lead, remote } = makeSeed();
    asLeadsOwnCheckout(lead);
    mkdirSync(join(lead, "docs"), { recursive: true });
    writeFileSync(join(lead, "docs", "old-name.md"), "renamed later\n");
    writeFileSync(join(lead, "docs", "gone.md"), "removed later\n");
    git(lead, ["add", "docs"]);
    git(lead, ["commit", "-m", "the person's docs"]);
    git(lead, ["push", "origin", "HEAD"]);
    const base = git(remote, ["rev-parse", "main"]);
    git(lead, ["mv", "docs/old-name.md", "docs/new-name.md"]);
    git(lead, ["rm", "-q", "docs/gone.md"]);
    const offer = nextDirective(lead);
    expect(isHandover(offer, "share"), JSON.stringify(offer)).toBe(true);
    const question = String(offer.question);
    const words = question.match(/I'd commit (the \d+ changed files here \(.*\)) and push main to origin, /)?.[1];
    expect(words, question).toEndWith(" here (new: docs/new-name.md; deleted: docs/gone.md, docs/old-name.md)");
    const shared = runMergeTool(UNIT, ["share"], lead);
    expect(shared.status, shared.out).toBe(0);
    expectResultNames(shared.stdout, lead, words as string);
    const onRemote = git(remote, ["diff", "--no-renames", "--name-status", base, "main"]).split("\n");
    for (const line of ["A\tdocs/new-name.md", "D\tdocs/gone.md", "D\tdocs/old-name.md"]) expect(onRemote).toContain(line);
  });

  // git's own words for a file it cannot add end without a full stop; the
  // refusal still reads as two sentences.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a file git cannot read: the share's refusal ends git's words with a full stop", () => {
    const { seed: lead } = makeSeed();
    asLeadsOwnCheckout(lead);
    writeFileSync(join(lead, "unreadable.txt"), "the person's\n");
    chmodSync(join(lead, "unreadable.txt"), 0o000);
    try {
      const shared = runMergeTool(UNIT, ["share"], lead);
      expect(shared.status, shared.out).not.toBe(0);
      expect(shared.out).toContain("fatal: adding files failed. Then share again.");
    } finally {
      chmodSync(join(lead, "unreadable.txt"), 0o644);
    }
  });

  // Taking, publishing and landing Units read and write the repository's trees
  // at its top, so a project in a folder below it cannot hand Units to teams
  // yet: no share is offered that would then fail, the walk says why once, and
  // a typed share says it before it stages, commits or pushes anything.
  test("a project in a folder of a bigger repository: no share is offered, and a typed share says why first", () => {
    const { seed: lead } = makeSeed();
    asLeadsOwnCheckout(lead);
    const outer = mkdtempSync(join(tmpdir(), "aidlc-inc3-outer-"));
    tempDirs.push(outer);
    git(outer, ["init", "-b", "main"]);
    git(outer, ["config", "user.name", "outer"]);
    git(outer, ["config", "user.email", "outer@example.test"]);
    cpSync(lead, join(outer, "app"), { recursive: true, filter: (path) => !path.split(/[\\/]/).includes(".git") });
    mkdirSync(join(outer, "other"), { recursive: true });
    writeFileSync(join(outer, "other", "notes.md"), "the person's other package\n");
    git(outer, ["add", "-A"]);
    git(outer, ["commit", "-m", "monorepo"]);
    const bare = mkdtempSync(join(tmpdir(), "aidlc-inc3-outer-remote-"));
    tempDirs.push(bare);
    git(bare, ["init", "--bare", "-b", "main"]);
    git(outer, ["remote", "add", "origin", bare]);
    git(outer, ["push", "-u", "origin", "main"]);
    const app = join(outer, "app");
    writeFileSync(join(outer, "other", "staged.md"), "staged outside the project\n");
    git(outer, ["add", "other/staged.md"]);
    writeFileSync(join(app, "z-deploy.env"), "API_KEY=not-for-the-team\n");
    const line = "Team work needs this project at the top of its git repository; it sits in app of " +
      `${git(outer, ["rev-parse", "--show-toplevel"])}.`;
    const chat = "01995000-7a11-7000-8000-000000003822";
    const step = nextInChat(app, chat);
    expect(isHandover(step), JSON.stringify(step)).toBe(false);
    expect(JSON.stringify(step)).toContain(line);
    // Said once, beside the step that starts the build, not at every step.
    const after = nextInChat(app, chat);
    expect(isHandover(after), JSON.stringify(after)).toBe(false);
    expect(JSON.stringify(after)).not.toContain(line);
    const before = [git(outer, ["rev-parse", "HEAD"]), git(bare, ["rev-parse", "main"]), git(outer, ["status", "--porcelain"])];
    const shared = runMergeTool(UNIT, ["share"], app);
    expect(shared.status, shared.out).not.toBe(0);
    expect(shared.out).toContain(JSON.stringify({ error: line }));
    expect([git(outer, ["rev-parse", "HEAD"]), git(bare, ["rev-parse", "main"]), git(outer, ["status", "--porcelain"])]).toEqual(before);
  });

  // Ten names in all, whatever their kind: the ten nearest the project's top,
  // each under what the commit does to it, then how many more.
  test("hundreds of files of every kind: the share question names ten in all, nearest the top, and its result the same ten", () => {
    const { seed: lead, remote } = makeSeed();
    asLeadsOwnCheckout(lead);
    const deep = ["four", "one", "three", "two"].map((name) => `lib/a/${name}.ts`);
    mkdirSync(join(lead, "lib", "a"), { recursive: true });
    for (const path of deep) writeFileSync(join(lead, ...path.split("/")), "export {};\n");
    writeFileSync(join(lead, "old.md"), "the person's old notes\n");
    git(lead, ["add", "lib", "old.md"]);
    git(lead, ["commit", "-m", "the person's earlier work"]);
    git(lead, ["push", "origin", "HEAD"]);
    for (const path of deep) writeFileSync(join(lead, ...path.split("/")), "export const edited = 1;\n");
    unlinkSync(join(lead, "old.md"));
    addManyNewFiles(lead, 400);
    const modules = git(lead, ["ls-files", "--others", "--exclude-standard", "--", "node_modules"]).split("\n").slice(0, 2);
    const ten = `(changed: ${deep.join(", ")}; new: z-deploy.env, config/app.json, src/x/y.ts, ${modules.join(", ")}; ` +
      "deleted: old.md; and 395 more";
    const offer = nextDirective(lead);
    expect(isHandover(offer, "share"), JSON.stringify(offer).slice(0, 2000)).toBe(true);
    const question = String(offer.question);
    const words = question.match(/I'd commit (the \d+ changed files here \(.*\)) and push main to origin, /)?.[1];
    expect(words, question).toEndWith(` here ${ten}; \`git status\` shows the rest)`);
    expect(question.length).toBeLessThan(1_500);
    expect(git(remote, ["rev-parse", "main"])).toBe(git(lead, ["rev-parse", "HEAD"]));
    const shared = runMergeTool(UNIT, ["share"], lead);
    expect(shared.status, shared.out).toBe(0);
    // After the commit `git status` shows nothing more, so the result does not send the person there.
    expectResultNames(shared.stdout, lead, (words as string).replace(/; `git status` shows the rest\)$/, ")"));
  });

  test("share refused: the commit is kept, next offers share again and starts no Unit here", () => {
    const { seed: lead, remote } = makeSeed();
    const other = clone(remote, "other");
    writeFileSync(join(other, "README.md"), "someone else pushed first\n");
    git(other, ["add", "-A"]);
    git(other, ["commit", "-m", "a colleague's commit"]);
    git(other, ["push", "origin", "main"]);
    asLeadsOwnCheckout(lead);
    expect(isHandover(nextDirective(lead), "share")).toBe(true);
    const before = git(lead, ["rev-parse", "HEAD"]);
    const shared = runMergeTool(UNIT, ["share"], lead);
    expect(shared.status, shared.out).not.toBe(0);
    expect(shared.out).toContain("pull main, then share again");
    expect(git(lead, ["rev-parse", "HEAD"])).not.toBe(before);
    expect(git(lead, ["status", "--porcelain"])).toBe("");
    const again = nextDirective(lead);
    expect(isHandover(again, "share"), JSON.stringify(again)).toBe(true);
  });

  test("share whose commit git refuses (the team's own pre-commit hook): next offers share again and starts no Unit here", () => {
    const { seed: lead, remote } = makeSeed();
    const hooks = join(lead, "..", `${lead.split(/[\\/]/).pop()}-hooks`);
    mkdirSync(hooks, { recursive: true });
    tempDirs.push(hooks);
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\necho \"the team's pre-commit check said no\" >&2\nexit 1\n");
    chmodSync(join(hooks, "pre-commit"), 0o755);
    git(lead, ["config", "core.hooksPath", hooks]);
    asLeadsOwnCheckout(lead);
    expect(isHandover(nextDirective(lead), "share")).toBe(true);
    const before = git(lead, ["rev-parse", "HEAD"]);
    const shared = runMergeTool(UNIT, ["share"], lead);
    expect(shared.status, shared.out).not.toBe(0);
    expect(shared.out).toContain("the team's pre-commit check said no");
    expect(shared.out).toContain("Then share again.");
    expect(git(lead, ["rev-parse", "HEAD"])).toBe(before);
    expect(git(remote, ["rev-parse", "main"])).toBe(before);
    const again = nextDirective(lead);
    expect(isHandover(again, "share"), JSON.stringify(again)).toBe(true);
  });

  test("the lead's own checkout building a Unit here pushes main for backup: the walk goes on, no board", () => {
    const { seed: lead } = makeSeed();
    asLeadsOwnCheckout(lead);
    expect(isHandover(nextDirective(lead), "share")).toBe(true);
    expect(nextDirective(lead)).toMatchObject({ kind: "run-stage", unit: "alpha" });
    git(lead, ["add", "-A"]);
    git(lead, ["commit", "-m", "backup"]);
    git(lead, ["push", "origin", "main"]);
    expect(nextDirective(lead)).toMatchObject({ kind: "run-stage", unit: "alpha" });
  });
});

describe("step 2: another clone takes a Unit", () => {
  test("a teammate's fresh clone is offered the Units it can take; Not now shows the board, never the walk, never again", () => {
    const { remote } = makeSeed(parallelDependencyBody());
    const mate = clone(remote, "mate");
    const offer = nextDirective(mate);
    expect(isHandover(offer, "join"), JSON.stringify(offer)).toBe(true);
    expect(String(offer.question)).toContain("Take one for your team?");
    expect(labels(offer)).toEqual(["Take alpha", "Take beta", "Not now"]);
    expect(commandFor(offer, "Take alpha")).toMatch(/ next --claim alpha$/);
    expect(commandFor(offer, "Not now")).toMatch(/ next$/);
    const board = nextDirective(mate);
    expect(isHandover(board)).toBe(false);
    expect(boardText(board)).toContain("# Team Construction Board");
    expect(boardText(nextDirective(mate))).toContain("# Team Construction Board");
  });

  // The live run: a team built its first Unit in its own clone (that Unit's
  // rows are in the clone's own shard), the lead merged and pushed it, and the
  // team pulled main: its next Unit is offered, never a typed claim.
  test("each Take choice says what waits on it, and the question names the team's label once", () => {
    const { remote } = makeSeed();
    const mate = clone(remote, "mate");
    const offer = nextDirective(mate);
    expect(isHandover(offer, "join"), JSON.stringify(offer)).toBe(true);
    expect(labels(offer)).toEqual(["Take alpha", "Not now"]);
    expect(detailFor(offer, "Take alpha")).toBe("beta waits on it.");
    const label = "I'd label your team \"mate\"; say another name to use it instead.";
    expect(String(offer.question).split(label).length - 1, String(offer.question)).toBe(1);
    expect(String(offer.question_note)).toContain("--team '");
    // The label the question names is the one a claim with no name of theirs writes.
    const claimed = runMergeTool(UNIT, ["claim", "alpha"], mate);
    expect(claimed.status, claimed.out).toBe(0);
    expect(JSON.parse(claimed.stdout)).toMatchObject({ unit: "alpha", owner: "mate" });
  });

  test("the question says once which Units other teams hold", () => {
    const { remote } = makeSeed(parallelDependencyBody());
    const held = runMergeTool(UNIT, ["claim", "beta", "--team", "team-b"], clone(remote, "other"));
    expect(held.status, held.out).toBe(0);
    const offer = nextDirective(clone(remote, "mate"));
    expect(labels(offer), JSON.stringify(offer)).toEqual(["Take alpha", "Not now"]);
    expect(detailFor(offer, "Take alpha")).toBe("No other Unit waits on it.");
    expect(String(offer.question).split("beta is with team-b").length - 1, String(offer.question)).toBe(1);
  });

  test("a team name the person gives goes through --team onto the claim, and the other clones see it", () => {
    const { remote } = makeSeed(parallelDependencyBody());
    const mate = clone(remote, "mate");
    expect(commandFor(nextDirective(mate), "Take alpha")).toMatch(/ next --claim alpha$/);
    const take = runMergeTool(ORCH, ["next", "--claim", "alpha", "--team", "Payments team"], mate);
    expect(take.status, take.out).toBe(0);
    // The name goes in a file the claim reads, which the claim spends.
    const file = String(JSON.parse(take.stdout).message).match(/--claim alpha --request-file (\S+)`/)?.[1];
    expect(file, take.stdout).toBeDefined();
    expect(readFileSync(join(mate, file as string), "utf-8")).toBe("Payments team");
    const claimed = runMergeTool(UNIT, ["claim", "alpha", "--request-file", file as string], mate);
    expect(claimed.status, claimed.out).toBe(0);
    expect(JSON.parse(claimed.stdout)).toMatchObject({ owner: "Payments team" });
    expect(existsSync(join(mate, file as string))).toBe(false);
    const offer = nextDirective(clone(remote, "late"));
    expect(labels(offer), JSON.stringify(offer)).toEqual(["Take beta", "Not now"]);
    expect(String(offer.question)).toContain("alpha is with Payments team");
  });

  // The claim command next prints, run through the shell the agent runs it in:
  // bash (Git Bash on Windows, Claude Code's), PowerShell (Kiro's and Codex's on
  // Windows), cmd.exe (Copilot's and opencode's). No one quoting reads an
  // apostrophe beside & the same in PowerShell and Git Bash. The board is every
  // other clone's: the Take question's holders.
  const NAMES = ["O'Brien", "Ops & QA", "QA\\", "O'Brien & QA"];
  const SHELLS = [
    { shell: "bash", skip: gitBashSkipReason() },
    { shell: "PowerShell", skip: process.platform === "win32" ? null : "Windows only" },
    { shell: "cmd.exe", skip: process.platform === "win32" ? null : "Windows only" },
  ] as const;
  for (const { shell, skip } of SHELLS) {
    test.skipIf(skip !== null)(`a team name as given reaches the board, through ${shell}: ${NAMES.join(", ")}`, () => {
      const units = ["alpha", "beta", "gamma", "delta", "epsilon"];
      const { remote } = makeSeed(
        "# Unit dependencies\n\n```yaml\nunits:\n  - name: skeleton\n    depends_on: []\n" +
          units.map((unit) => `  - name: ${unit}\n    depends_on: [skeleton]\n`).join("") + "```\n",
      );
      NAMES.forEach((name, i) => {
        const mate = clone(remote, `mate${i}`);
        const take = runMergeTool(ORCH, ["next", "--claim", units[i], "--team", name], mate);
        expect(take.status, take.out).toBe(0);
        const printed = String(JSON.parse(take.stdout).message).match(/`[^`]*? (--claim [^`]*)`/)?.[1];
        expect(printed, take.stdout).toBeDefined();
        const dir = mkdtempSync(join(tmpdir(), "aidlc-claim-shell-"));
        tempDirs.push(dir);
        const words = [process.execPath, join(AIDLC_SRC, "tools", "aidlc.ts")];
        const [file, argv]: [string, string[]] = shell === "bash"
          ? [join(dir, "claim.sh"), [process.platform === "win32" ? gitBashPath() : "bash"]]
          : shell === "PowerShell"
          ? [join(dir, "claim.ps1"), ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]]
          : [join(dir, "claim.cmd"), ["cmd.exe", "/d", "/c"]];
        const q = (word: string) => (shell === "cmd.exe" ? `"${word}"` : `'${word}'`);
        writeFileSync(
          file,
          shell === "bash"
            ? `${words.map(q).join(" ")} ${printed} --project-dir ${q(mate)}\n`
            : shell === "PowerShell"
            ? `& ${words.map(q).join(" ")} ${printed} --project-dir ${q(mate)}\r\nexit $LASTEXITCODE\r\n`
            : `@${words.map(q).join(" ")} ${printed} --project-dir ${q(mate)}\r\n`,
        );
        const claimed = spawnSync(argv[0], [...argv.slice(1), file], {
          cwd: mate,
          encoding: "utf-8",
          env: {
            ...process.env,
            AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
            AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
            AIDLC_SKIP_ARTIFACT_GUARD: "1",
          },
        });
        expect(claimed.status, `${printed}\n${claimed.stdout}${claimed.stderr}`).toBe(0);
        expect(JSON.parse(claimed.stdout).owner, printed).toBe(name);
      });
      const offer = nextDirective(clone(remote, "late"));
      for (const [i, name] of NAMES.entries()) expect(String(offer.question)).toContain(`${units[i]} is with ${name}`);
    });
  }

  test("a team's clone after its Unit lands and it pulls is offered the next Unit", () => {
    const { seed: lead, remote } = makeSeed(parallelDependencyBody());
    const { checkout } = prepareCandidate(remote, "alpha", "team-a");
    approveMerge(lead, "alpha");
    expect(runMergeTool(UNIT, ["land", "alpha"], lead).status).toBe(0);
    git(lead, ["push", "origin", "main"]);
    git(checkout, ["pull", "-q", "--ff-only", "origin", "main"]);
    const offer = nextDirective(checkout);
    expect(isHandover(offer, "join"), JSON.stringify(offer)).toBe(true);
    expect(labels(offer)).toEqual(["Take beta", "Not now"]);
  });

  test("the participant marker keeps today's picker", () => {
    const { remote } = makeSeed(parallelDependencyBody());
    const mate = clone(remote, "mate");
    expect(runMergeTool(UNIT, ["participate"], mate).status).toBe(0);
    expect(nextDirective(mate)).toMatchObject({ kind: "ask", ask_type: "unit-claim" });
  });
});

// The claimed checkout with its Unit worked through every stage, Current Stage
// where the walk leaves it (the Unit's last stage).
function doneIn(checkout: string): Record<string, unknown> {
  writeFileSync(
    seededStateFile(checkout),
    readFileSync(seededStateFile(checkout), "utf-8")
      .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: code-generation"),
  );
  return nextDirective(checkout);
}

// What the Unit's Code Generation says it wrote (its source manifest): the
// new files a publish commits as the Unit's own work.
function claimAsUnitWork(checkout: string, paths: string[]): void {
  writeFileSync(
    join(seededRecordDir(checkout), "construction", "alpha", "code-generation", "source-manifest.json"),
    `${JSON.stringify({ stage: "code-generation", unit: "alpha", version: 1, writes: paths.map((path) => ({ path })) })}\n`,
  );
}

describe("step 3: a team publishes its finished Unit", () => {
  test("a claimed Unit done: the publish offer, once; Not now gives the done notice; publish --commit publishes", () => {
    const { remote } = makeSeed();
    const { checkout } = prepareCandidate(remote, "alpha", "team-a", { publish: false });
    const offer = doneIn(checkout);
    expect(isHandover(offer, "publish"), JSON.stringify(offer)).toBe(true);
    expect(offer.unit).toBe("alpha");
    expect(String(offer.question)).toContain("for review on main?");
    expect(labels(offer)).toEqual(["Commit and publish", "Not now"]);
    expect(commandFor(offer, "Commit and publish")).toMatch(/ unit publish alpha --commit$/);
    // The offer is the step after Code Generation, as the done notice is: the
    // Unit's own commit is not held to its plan.
    const state = readFileSync(seededStateFile(checkout), "utf-8");
    expect(codeGenerationStepOnRecord(checkout, state, readActiveDirectiveMarker(checkout, state))).toBe(false);
    const notice = nextDirective(checkout);
    expect(notice).toMatchObject({ kind: "notice", unit: "alpha" });
    expect(String(notice.message)).toContain('Unit "alpha" is complete and approved in this checkout');
    expect(String(notice.message)).not.toContain("aidlc unit publish");
    expect(isHandover(nextDirective(checkout))).toBe(false);
    writeFileSync(join(checkout, "src", "alpha-extra.ts"), "export const extra = 1;\n");
    claimAsUnitWork(checkout, ["src/alpha.ts", "src/alpha-extra.ts"]);
    const claimRef = readUnitScopeStamp(checkout)?.claim_ref as string;
    const claimBefore = git(remote, ["rev-parse", claimRef]);
    const published = runMergeTool(UNIT, ["publish", "alpha", "--commit"], checkout);
    expect(published.status, published.out).toBe(0);
    expect(JSON.parse(published.stdout)).toMatchObject({ published: true, unit: "alpha" });
    expect(git(checkout, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
    expect(git(remote, ["rev-parse", claimRef])).not.toBe(claimBefore);
  });

  test("a handful of the Unit's new files: the publish question names every one", () => {
    const { remote } = makeSeed();
    const { checkout } = prepareCandidate(remote, "alpha", "team-a", { publish: false });
    for (const name of ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt", "z-deploy.env"]) {
      writeFileSync(join(checkout, name), "untracked\n");
    }
    claimAsUnitWork(checkout, ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt", "z-deploy.env"]);
    const offer = doneIn(checkout);
    expect(isHandover(offer, "publish"), JSON.stringify(offer)).toBe(true);
    expect(String(offer.question)).toContain("(new: a.txt, b.txt, c.txt, d.txt, e.txt, z-deploy.env).");
    expect(String(offer.question)).not.toContain(" more; ");
  });

  // Publish commits every tracked change here, whatever the Unit's manifest
  // lists, so its question names those too and counts what its commit takes.
  test("the person's own edits, staged file and delete in a team's clone: the publish question names each", () => {
    const { seed: lead, remote } = makeSeed();
    withPersonsPushedFiles(lead);
    const { checkout } = prepareCandidate(remote, "alpha", "team-a", { publish: false });
    personsOwnEdits(checkout);
    claimAsUnitWork(checkout, ["src/alpha.ts"]);
    const offer = doneIn(checkout);
    expect(isHandover(offer, "publish"), JSON.stringify(offer)).toBe(true);
    const question = String(offer.question);
    const words = question.match(/I'd commit (the (\d+) changed files of its work here \((.*)\))\.$/);
    expect(words?.[3], question).toBe("changed: src/shared.ts, src/split.ts; new: staged-only.txt; deleted: docs/old-notes.md");
    const published = runMergeTool(UNIT, ["publish", "alpha", "--commit"], checkout);
    expect(published.status, published.out).toBe(0);
    expect(committedHere(checkout)).toHaveLength(Number(words?.[2]));
    // A typed publish names what it put on the claim ref the same way, beside what it left out.
    expect(JSON.parse(published.stdout)).toMatchObject({ published: true, committed_files: words?.[1], left_out: 1 });
  });

  test("a removal the person staged with git in a team's clone: Commit and publish commits it", () => {
    const { seed: lead, remote } = makeSeed();
    withPersonsPushedFiles(lead);
    const { checkout } = prepareCandidate(remote, "alpha", "team-a", { publish: false });
    git(checkout, ["rm", "-q", "docs/old-notes.md"]);
    claimAsUnitWork(checkout, ["src/alpha.ts"]);
    expect(isHandover(doneIn(checkout), "publish")).toBe(true);
    const published = runMergeTool(UNIT, ["publish", "alpha", "--commit"], checkout);
    expect(published.status, published.out).toBe(0);
    expect(committedHere(checkout)).toContain("docs/old-notes.md");
    expect(JSON.parse(published.stdout).committed_files).toEndWith(" here (deleted: docs/old-notes.md)");
  });

  // A Unit whose own work (its manifest claims it) is thousands of new files:
  // the question is put, not a step too long to send, and its choices walk on
  // as with a handful. The commit takes every one of them.
  for (const count of [400, 10_000]) {
    test(`${count} new files: the publish question is put, says how many and names ten; Not now walks on, never back`, () => {
      const { remote } = makeSeed();
      const { checkout } = prepareCandidate(remote, "alpha", "team-a", { publish: false });
      addManyNewFiles(checkout, count);
      claimAsUnitWork(checkout, ["z-deploy.env", "config/", "src/x/", "node_modules/"]);
      const offer = doneIn(checkout);
      expect(isHandover(offer, "publish"), JSON.stringify(offer).slice(0, 2000)).toBe(true);
      expect(String(offer.question)).toContain(`changed files of its work here (new: z-deploy.env, config/app.json, src/x/y.ts, `);
      expectTenNamedAndTheCount(offer, checkout);
      expect(labels(offer)).toEqual(["Commit and publish", "Not now"]);
      expect(commandFor(offer, "Not now")).toMatch(/ next$/);
      const notice = nextDirective(checkout);
      expect(notice).toMatchObject({ kind: "notice", unit: "alpha" });
      expect(isHandover(nextDirective(checkout))).toBe(false);
      if (count > 1_000) return;
      const published = runMergeTool(UNIT, ["publish", "alpha", "--commit"], checkout);
      expect(published.status, published.out).toBe(0);
      expect(git(checkout, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
      expect(git(checkout, ["ls-files", "node_modules"]).split("\n")).toHaveLength(count - 3);
    });
  }

  test("publish without --commit still refuses a dirty tree, as today", () => {
    const { remote } = makeSeed();
    const { checkout } = prepareCandidate(remote, "alpha", "team-a", { publish: false });
    writeFileSync(join(checkout, "src", "alpha.ts"), "export const alpha = \"edited\";\n");
    const published = runMergeTool(UNIT, ["publish", "alpha"], checkout);
    expect(published.status).not.toBe(0);
    expect(published.out).toContain("commit the candidate first");
  });
});

describe("step 4: a published Unit is reviewed and merged", () => {
  test("the lead's board sees a team's publish without a typed fetch and offers review; Not now leaves a board line", () => {
    const { seed: lead, remote } = makeSeed();
    asLeadsOwnCheckout(lead);
    git(lead, ["add", "-A"]);
    git(lead, ["commit", "-m", "lead's record"]);
    git(lead, ["push", "origin", "main"]);
    prepareCandidate(remote, "alpha", "team-a");
    const offer = nextDirective(lead);
    expect(isHandover(offer, "review"), JSON.stringify(offer)).toBe(true);
    expect(String(offer.question)).toContain("alpha is ready from team-a");
    expect(labels(offer)).toEqual(["Review and merge alpha", "Not now"]);
    expect(commandFor(offer, "Review and merge alpha")).toMatch(/ unit pin alpha$/);
    const board = nextDirective(lead);
    expect(isHandover(board)).toBe(false);
    expect(boardText(board)).toContain("`alpha` is ready from team-a to review and merge");
    const pin = runMergeTool(UNIT, ["pin", "alpha"], lead);
    expect(pin.status, pin.out).toBe(0);
    expect(JSON.parse(pin.stdout).merge_gate).toMatchObject({ strategy: "merge", target_branch: "main" });
  });

  // The live sighting: both teams claimed, built and published from their
  // clones; the lead's own checkout had fetched nothing since, so it held no
  // claim ref of its own, and its /aidlc walked the Units itself.
  test("teams' claims and publishes only on the remote: the lead's /aidlc gives the review, never the walk", () => {
    const { seed: lead, remote } = makeSeed(parallelDependencyBody());
    asLeadsOwnCheckout(lead);
    git(lead, ["add", "-A"]);
    git(lead, ["commit", "-m", "lead's record"]);
    git(lead, ["push", "origin", "main"]);
    prepareCandidate(remote, "alpha", "team-a");
    prepareCandidate(remote, "beta", "team-b");
    expect(git(lead, ["for-each-ref", "refs/remotes/origin/claim", "refs/heads/claim"])).toBe("");
    const offer = nextDirective(lead);
    expect(offer.kind, JSON.stringify(offer)).not.toBe("run-stage");
    expect(isHandover(offer, "review"), JSON.stringify(offer)).toBe(true);
    expect(labels(offer)).toEqual(["Review and merge alpha", "Review and merge beta", "Not now"]);
    const board = nextDirective(lead);
    expect(board.kind, JSON.stringify(board)).not.toBe("run-stage");
    expect(boardText(board)).toContain("`beta` is ready from team-b to review and merge");
  });

  test("the lead's own fresh clone: review and take in one question", () => {
    const { remote } = makeSeed(parallelDependencyBody());
    prepareCandidate(remote, "alpha", "team-a");
    const fresh = clone(remote, "fresh");
    const offer = nextDirective(fresh);
    expect(isHandover(offer, "review"), JSON.stringify(offer)).toBe(true);
    expect(isHandover(offer, "join")).toBe(true);
    expect(labels(offer)).toEqual(["Take beta", "Review and merge alpha", "Not now"]);
    expect(String(offer.question)).toContain("Take one for your team, or review and merge?");
    expect(String(offer.numbered_prose_question)).toContain("1. **Take beta**");
    expect(detailFor(offer, "Review and merge alpha"))
      .toBe("Shows what the team built and its checks, then asks whether to merge it.");
    // No self-loop: Not now runs next, which never puts the same question again.
    expect(commandFor(offer, "Not now")).toMatch(/ next$/);
    expect(isHandover(nextDirective(fresh))).toBe(false);
  });
});

describe("step 5: main is pushed after a land", () => {
  test("land says run next only when the push is due; next offers it once; share pushes it", () => {
    const { seed: lead, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "team-a");
    approveMerge(lead, "alpha");
    const landed = runMergeTool(UNIT, ["land", "alpha"], lead);
    expect(landed.status, landed.out).toBe(0);
    const land = JSON.parse(landed.stdout);
    expect(land).toMatchObject({ landed: true, status: "complete" });
    expect(String(land.next_step)).toMatch(/ next`/);
    const offer = nextDirective(lead);
    expect(isHandover(offer, "push"), JSON.stringify(offer)).toBe(true);
    expect(String(offer.question)).toBe("Push main to origin now so the other teams see alpha landed?");
    expect(labels(offer)).toEqual(["Push main", "Not now"]);
    expect(commandFor(offer, "Push main")).toMatch(/ unit share$/);
    expect(detailFor(offer, "Push main")).toBe(`Pushes ${PLAIN_PUSH}`);
    expect(isHandover(nextDirective(lead), "push")).toBe(false);
    const shared = runMergeTool(UNIT, ["share"], lead);
    expect(shared.status, shared.out).toBe(0);
    // Only AI-DLC's own record went in with the push, so no file is named.
    expect(JSON.parse(shared.stdout).committed_files).toBeUndefined();
    expect(git(remote, ["merge-base", "--is-ancestor", land.git_commit_oid, "main"])).toBe("");
    // What the push committed first, if anything, is named for the landing, never as the plan.
    expect(git(lead, ["log", "-1", "--format=%s"])).not.toBe("Share the plan with the teams");
    expect(git(lead, ["status", "--porcelain"])).toBe("");
  });

  // The push commits what is left here first; its count takes in the row the
  // question itself writes to this checkout's record, so it is the number the
  // push then commits.
  test("the person's own edit and new file after a land: the push question names them and counts what the push commits", () => {
    const { seed: lead, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "team-a");
    approveMerge(lead, "alpha");
    expect(runMergeTool(UNIT, ["land", "alpha"], lead).status).toBe(0);
    writeFileSync(join(lead, "src", "shared.ts"), `${readFileSync(join(lead, "src", "shared.ts"), "utf-8")}// half-done local edit\n`);
    writeFileSync(join(lead, "z-deploy.env"), "API_KEY=not-for-the-team\n");
    const offer = nextDirective(lead);
    expect(isHandover(offer, "push"), JSON.stringify(offer)).toBe(true);
    expect(String(offer.question)).toBe(
      "Push main to origin now so the other teams see alpha landed? I'd commit the 3 changed files here " +
        "(changed: src/shared.ts; new: z-deploy.env) first.",
    );
    const shared = runMergeTool(UNIT, ["share"], lead);
    expect(shared.status, shared.out).toBe(0);
    expectResultNames(shared.stdout, lead, "the 3 changed files here (changed: src/shared.ts; new: z-deploy.env)");
  });

  test("hundreds of new files: the push question is put, says how many and names ten", () => {
    const { seed: lead, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "team-a");
    approveMerge(lead, "alpha");
    expect(runMergeTool(UNIT, ["land", "alpha"], lead).status).toBe(0);
    addManyNewFiles(lead, 400);
    const offer = nextDirective(lead);
    expect(isHandover(offer, "push"), JSON.stringify(offer).slice(0, 2000)).toBe(true);
    expect(String(offer.question)).toMatch(/shows the rest\) first\.$/);
    expectTenNamedAndTheCount(offer, lead);
  });

  // Team work begun before the Integration branch line existed: team.md says
  // the branch only in words, which the share's own step reads first. The push
  // question and the board both stay, naming the team's branch until then.
  test("while team.md's words are still to be read, the push offer and the board name the team's branch", () => {
    const { seed: lead, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "team-a");
    approveMerge(lead, "alpha");
    expect(runMergeTool(UNIT, ["land", "alpha"], lead).status).toBe(0);
    const teamMd = join(lead, "aidlc", "spaces", "default", "memory", "team.md");
    writeFileSync(teamMd, readFileSync(teamMd, "utf-8").replace("## Way of Working\n", "## Way of Working\n\nWork merges into `main`.\n"));
    const offer = nextDirective(lead);
    expect(isHandover(offer, "push"), JSON.stringify(offer)).toBe(true);
    expect(labels(offer)).toEqual(["Push the team's branch", "Not now"]);
    const board = runMergeTool(ORCH, ["team-board", "--snapshot"], lead);
    expect(board.status, board.out).toBe(0);
    expect(board.stdout).toContain("the team's branch has alpha landed here and not on origin yet");
  });

  test("a land already on origin is not offered", () => {
    const { seed: lead, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "team-a");
    approveMerge(lead, "alpha");
    expect(runMergeTool(UNIT, ["land", "alpha"], lead).status).toBe(0);
    git(lead, ["push", "origin", "main"]);
    expect(isHandover(nextDirective(lead), "push")).toBe(false);
  });
});
