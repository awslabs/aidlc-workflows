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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActiveDirectiveMarker, readUnitScopeStamp } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { codeGenerationStepOnRecord } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import { AIDLC_SRC, seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import { gitBashPath, gitBashSkipReason } from "../harness/git-bash.ts";
import {
  ORCH,
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
    expect(board).toContain("# Team Construction Dispatcher");
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
    expect(boardText(nextDirective(lead))).toContain("# Team Construction Dispatcher");
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
    expect(boardText(board)).toContain("# Team Construction Dispatcher");
    expect(boardText(nextDirective(mate))).toContain("# Team Construction Dispatcher");
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
    expect(String(offer.question)).toContain("so the other teams see alpha");
    expect(labels(offer)).toEqual(["Push main", "Not now"]);
    expect(commandFor(offer, "Push main")).toMatch(/ unit share$/);
    expect(["Pushes", "Commits, then pushes"].map((lead) => `${lead} ${PLAIN_PUSH}`)).toContain(String(detailFor(offer, "Push main")));
    expect(isHandover(nextDirective(lead), "push")).toBe(false);
    const shared = runMergeTool(UNIT, ["share"], lead);
    expect(shared.status, shared.out).toBe(0);
    expect(git(remote, ["merge-base", "--is-ancestor", land.git_commit_oid, "main"])).toBe("");
    // What the push committed first, if anything, is named for the landing, never as the plan.
    expect(git(lead, ["log", "-1", "--format=%s"])).not.toBe("Share the plan with the teams");
    expect(git(lead, ["status", "--porcelain"])).toBe("");
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
