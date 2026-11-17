// covers: a Unit pushed from where the person was while main changed one of its
// own files on the remote. The fact is read once, at the push that made the
// branch (mainChangedUnder over the Unit's own paths), and kept as an engine
// mark for that pushed head; every other push, and every other file, leaves no
// mark. Real clones of bare remotes, through the shipped tools.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { engineAskMark, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
// Read by name at each call, so a case red before these exist fails on its own.
import * as unitTool from "../../dist/claude/.claude/tools/aidlc-unit.ts";
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import {
  cleanupTeamBuild,
  cloneOf,
  commitMessage,
  git,
  next,
  refundsTakenInClone,
  run,
  TICKET_HOOK_WORDS,
  TICKET_RULE_WORDS,
  tempDir,
  ticketKeyHook,
  ticketKeyRule,
  UNIT,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

const README = ["# billing", "", "Pays out.", "", "Keeps a ledger.", ""].join("\n");

// Someone else's commit on the host's main.
function onHostMain(host: string, path: string, text: string, label: string): void {
  const other = cloneOf(host, label);
  mkdirSync(join(other, ...path.split("/").slice(0, -1)), { recursive: true });
  writeFileSync(join(other, path), text);
  git(other, ["add", "-A"]);
  git(other, ["commit", "-q", "-m", `${label}: ${path}`]);
  git(other, ["push", "-q", "origin", "HEAD:main"]);
}

// Code Generation of refunds writing `writes` in billing, with its manifest.
function codeWrote(alice: string, record: string, writes: Record<string, string>): void {
  for (const [path, text] of Object.entries(writes)) {
    mkdirSync(join(alice, "billing", ...path.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(alice, "billing", path), text);
  }
  const stage = join(record, "construction", "refunds", "code-generation");
  mkdirSync(stage, { recursive: true });
  writeFileSync(join(stage, "source-manifest.json"), `${JSON.stringify({
    stage: "code-generation",
    unit: "refunds",
    version: 1,
    writes: Object.keys(writes).map((path) => ({ repo: "billing", path })),
  }, null, 2)}\n`);
  writeFileSync(join(stage, "code-summary.md"), "# Code summary\n\nRefunds.\n");
}

// A teammate whose billing main has the longer README, then main moves on the
// host after it: their main is older than the remote's from here on.
function takenThenMainMoves(mainChange: Record<string, string>) {
  const taken = refundsTakenInClone();
  onHostMain(taken.hosts.billing, "README.md", README, "bob");
  onHostMain(taken.hosts.billing, "LICENSE", "v1\n", "bob");
  git(join(taken.alice, "billing"), ["pull", "-q", "--ff-only"]);
  for (const [path, text] of Object.entries(mainChange)) onHostMain(taken.hosts.billing, path, text, "carol");
  return taken;
}

const pushedHead = (alice: string): string => git(join(alice, "billing"), ["rev-parse", "refs/heads/refunds"]);
const markAt = (alice: string): unknown => engineAskMark(alice, unitTool.mainMovedMark("refunds", pushedHead(alice)));

describe("main moved under a Unit, read at its push", () => {
  test("main changed a file the Unit changes and the branch starts where they are: the push keeps the mark for its head", () => {
    const { alice, record } = takenThenMainMoves({ "README.md": README.replace("# billing", "# Billing service") });
    codeWrote(alice, record, { "README.md": README.replace("Keeps a ledger.", "Keeps a ledger and refunds.") });
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    // The branch started where she was: origin/main is not in it.
    expect(spawnSync("git", ["merge-base", "--is-ancestor", "origin/main", "refunds"], { cwd: join(alice, "billing") }).status).toBe(1);
    expect(markAt(alice)).not.toBeNull();
    // The push itself says nothing new.
    expect(String(pushed.json?.notice ?? "")).not.toContain("origin/main in billing has a change");
  });

  test("main moved but changed only other files: the branch starts from it, and no mark", () => {
    const { alice, record } = takenThenMainMoves({ "docs/ops.md": "On call.\n" });
    codeWrote(alice, record, { "README.md": README.replace("Keeps a ledger.", "Keeps a ledger and refunds.") });
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    expect(markAt(alice)).toBeNull();
  });

  test("main did not move: no mark", () => {
    const { alice, record } = takenThenMainMoves({});
    codeWrote(alice, record, { "lib/refund.ts": "export const refund = 1;\n" });
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    expect(markAt(alice)).toBeNull();
  });

  test("a commit of theirs that comes along changes a file main changed, and the Unit's own files do not: no mark", () => {
    const { alice, record } = takenThenMainMoves({ "docs/ops.md": "On call.\n" });
    const billing = join(alice, "billing");
    mkdirSync(join(billing, "docs"), { recursive: true });
    writeFileSync(join(billing, "docs", "ops.md"), "Mine.\n");
    git(billing, ["add", "-A"]);
    git(billing, ["commit", "-q", "-m", "my ops notes"]);
    // Their uncommitted edit keeps git from moving them to origin/main.
    writeFileSync(join(billing, "docs", "ops.md"), "Mine, still editing.\n");
    codeWrote(alice, record, { "lib/refund.ts": "export const refund = 1;\n" });
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toContain('your commit not yet on origin/main comes along: "my ops notes"');
    expect(markAt(alice)).toBeNull();
  });

  test("a later push on the branch it made reads nothing again: no mark for its head", () => {
    const { alice, hosts, record } = takenThenMainMoves({ "docs/ops.md": "On call.\n" });
    codeWrote(alice, record, { "README.md": README.replace("Keeps a ledger.", "Keeps a ledger and refunds.") });
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    expect(markAt(alice)).toBeNull();
    // Main then changes the Unit's own file, and the Unit is pushed again on its branch.
    onHostMain(hosts.billing, "README.md", README.replace("Pays out.", "Pays out daily."), "dave");
    git(join(alice, "billing"), ["fetch", "-q", "origin"]);
    writeFileSync(join(alice, "billing", "README.md"), README.replace("Keeps a ledger.", "Keeps a ledger, refunds too."));
    const again = run(UNIT, ["push"], alice);
    expect(again.status, again.out).toBe(0);
    expect(markAt(alice)).toBeNull();
  });
});

describe("mainChangedUnder", () => {
  // A repository with main and a branch off its first commit, each changing what `changes` says.
  function forked(main: Record<string, string>, branch: Record<string, string>): { dir: string; head: string; into: string } {
    const dir = join(tempDir("main-changed"), "repo");
    git(join(dir, ".."), ["init", "-q", "-b", "main", dir]);
    git(dir, ["config", "user.name", "t"]);
    git(dir, ["config", "user.email", "t@example.test"]);
    writeFileSync(join(dir, "a.md"), "a\n");
    writeFileSync(join(dir, "b.md"), "b\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "start"]);
    git(dir, ["branch", "unit"]);
    const commit = (changes: Record<string, string>, message: string): void => {
      for (const [path, text] of Object.entries(changes)) writeFileSync(join(dir, path), text);
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-q", "--allow-empty", "-m", message]);
    };
    commit(main, "main moves");
    git(dir, ["switch", "-q", "unit"]);
    commit(branch, "the unit");
    return { dir, head: git(dir, ["rev-parse", "HEAD"]), into: "main" };
  }

  test("names the Unit's files main changed since the branch left it", () => {
    const { dir, head, into } = forked({ "a.md": "a from main\n" }, { "a.md": "a from the unit\n" });
    expect(unitTool.mainChangedUnder(dir, head, into, ["a.md", "b.md"])).toEqual(["a.md"]);
  });

  test("leaves out a file the Unit does not write, and one main and the Unit hold the same", () => {
    const { dir, head, into } = forked({ "a.md": "same\n", "b.md": "b from main\n" }, { "a.md": "same\n" });
    expect(unitTool.mainChangedUnder(dir, head, into, ["a.md"])).toEqual([]);
  });

  test("nothing when the branch already has main", () => {
    const { dir } = forked({ "a.md": "a from main\n" }, { "b.md": "b from the unit\n" });
    git(dir, ["merge", "-q", "--no-edit", "main"]);
    expect(unitTool.mainChangedUnder(dir, git(dir, ["rev-parse", "HEAD"]), "main", ["a.md", "b.md"])).toEqual([]);
  });
});

// Main moved on the host and changed README.md, which the Unit changes too: the
// push makes the branch from where she was. `clash` puts both on one line.
function movedAndPushed(clash = false) {
  const taken = takenThenMainMoves({ "README.md": clash ? README.replace("Keeps a ledger.", "Keeps two ledgers.") : README.replace("# billing", "# Billing service") });
  codeWrote(taken.alice, taken.record, { "README.md": README.replace("Keeps a ledger.", "Keeps a ledger and refunds.") });
  const pushed = run(UNIT, ["push"], taken.alice);
  expect(pushed.status, pushed.out).toBe(0);
  return { ...taken, billing: join(taken.alice, "billing") };
}

const OFFER = "origin/main in billing has a change to README.md that refunds's branch does not have, and refunds changes that " +
  "file too, so its pull request may show a clash. Do you want me to bring origin/main into refunds now? I'd merge it with " +
  "your own git and push refunds again.";
const CLASH = "origin/main and refunds both change README.md in billing in ways git cannot put together, so the merge is waiting " +
  "for you there: resolve README.md, and I can finish it and push refunds; or say if you want me to undo it. Nothing was pushed.";
const pushedRows = (alice: string): number => readAuditShardEvents(alice).filter((row) => row.event === "UNIT_PUSHED").length;
const onHost = (host: string, ref: string): string => git(host, ["rev-parse", ref]);
const mergeWaits = (dir: string): boolean => spawnSync("git", ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], { cwd: dir }).status === 0;

describe("the offer after the push, and its yes", () => {
  test("the step after that push offers to bring main in, once", () => {
    const { alice } = movedAndPushed();
    const ask = next(alice);
    expect(ask.ask_type, JSON.stringify(ask).slice(0, 600)).toBe("unit-main-moved");
    expect(ask.question).toBe(OFFER);
    const choices = ask.choices as Array<{ label: string; detail: string; command?: string }>;
    expect(choices.map((choice) => choice.label)).toEqual(["Bring origin/main in", "Not now"]);
    expect(choices[0].detail).toBe("Merges origin/main into refunds with your git and pushes it; nothing is rewritten or forced.");
    expect(choices[0].command).toEndWith("unit push --merge-main");
    expect(choices[1].detail).toBe("refunds stays as it was pushed; say when you want origin/main brought in.");
    const after = next(alice);
    expect(after.ask_type ?? null).not.toBe("unit-main-moved");
    expect(String(after.board_note ?? "")).toContain("unit push --merge-main");
  });

  test("the yes merges main with her git and pushes refunds; nothing else is recorded, and the offer is not put again", () => {
    const { alice, hosts, billing } = movedAndPushed();
    next(alice);
    const rows = pushedRows(alice);
    const yes = run(UNIT, ["push", "--merge-main"], alice);
    expect(yes.status, yes.out).toBe(0);
    expect(String(yes.json?.notice)).toBe("Merged origin/main into refunds in billing and pushed refunds.");
    expect(git(billing, ["log", "-1", "--format=%s", "refunds"])).toBe("Merge remote-tracking branch 'origin/main' into refunds");
    expect(onHost(hosts.billing, "refunds")).toBe(git(billing, ["rev-parse", "refunds"]));
    expect(spawnSync("git", ["merge-base", "--is-ancestor", "main", "refunds"], { cwd: hosts.billing }).status).toBe(0);
    expect(git(hosts.billing, ["show", "refunds:README.md"])).toContain("# Billing service");
    expect(pushedRows(alice)).toBe(rows);
    expect(next(alice).ask_type ?? null).not.toBe("unit-main-moved");
    expect(String(next(alice).board_note ?? "")).not.toContain("--merge-main");
    const again = run(UNIT, ["push", "--merge-main"], alice);
    expect(String(again.json?.notice)).toBe("refunds already has origin/main's changes to its files in billing; nothing was merged or pushed.");
  });

  test("a clash is left for her; a plain push and a bare next commit nothing over it; once resolved the same command finishes and pushes", () => {
    const { alice, hosts, billing } = movedAndPushed(true);
    next(alice);
    const before = onHost(hosts.billing, "refunds");
    const yes = run(UNIT, ["push", "--merge-main"], alice);
    expect(yes.status).not.toBe(0);
    expect(String(yes.json?.error)).toBe(CLASH);
    expect(mergeWaits(billing)).toBe(true);
    expect(onHost(hosts.billing, "refunds")).toBe(before);
    const head = git(billing, ["rev-parse", "HEAD"]);
    const plain = run(UNIT, ["push"], alice);
    expect(plain.status).not.toBe(0);
    expect(String(plain.json?.error)).toContain("billing is in the middle of a merge, so nothing was committed or pushed.");
    next(alice);
    expect(git(billing, ["rev-parse", "HEAD"])).toBe(head);
    expect(mergeWaits(billing)).toBe(true);
    expect(readFileSync(join(billing, "README.md"), "utf-8")).toContain("<<<<<<<");
    // Still unresolved: the same line again, nothing committed.
    expect(String(run(UNIT, ["push", "--merge-main"], alice).json?.error)).toBe(CLASH);
    writeFileSync(join(billing, "README.md"), README.replace("Keeps a ledger.", "Keeps two ledgers and refunds."));
    git(billing, ["add", "README.md"]);
    const done = run(UNIT, ["push", "--merge-main"], alice);
    expect(done.status, done.out).toBe(0);
    expect(String(done.json?.notice)).toBe("Merged origin/main into refunds in billing and pushed refunds.");
    expect(mergeWaits(billing)).toBe(false);
    expect(git(hosts.billing, ["show", "refunds:README.md"])).toContain("Keeps two ledgers and refunds.");
  });

  test("a clash she resolves and commits herself: the same command pushes it", () => {
    const { alice, hosts, billing } = movedAndPushed(true);
    next(alice);
    run(UNIT, ["push", "--merge-main"], alice);
    writeFileSync(join(billing, "README.md"), README.replace("Keeps a ledger.", "Keeps two ledgers and refunds."));
    git(billing, ["commit", "-q", "-am", "merge main"]);
    const pushed = run(UNIT, ["push", "--merge-main"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toBe("Pushed refunds in billing, with origin/main merged into it.");
    expect(onHost(hosts.billing, "refunds")).toBe(git(billing, ["rev-parse", "HEAD"]));
  });

  test("the undo on her word takes the waiting merge back out; with none waiting, or one she committed, it says so", () => {
    const { alice, billing } = movedAndPushed(true);
    next(alice);
    const head = git(billing, ["rev-parse", "HEAD"]);
    run(UNIT, ["push", "--merge-main"], alice);
    const undone = run(UNIT, ["push", "--undo-merge"], alice);
    expect(undone.status, undone.out).toBe(0);
    expect(String(undone.json?.notice)).toBe("I undid the merge of origin/main into refunds in billing; refunds is as it was there, and nothing was pushed.");
    expect(mergeWaits(billing)).toBe(false);
    expect(git(billing, ["rev-parse", "HEAD"])).toBe(head);
    expect(String(run(UNIT, ["push", "--undo-merge"], alice).json?.notice)).toBe("No merge of origin/main is waiting in billing, so nothing was undone.");
    run(UNIT, ["push", "--merge-main"], alice);
    writeFileSync(join(billing, "README.md"), README.replace("Keeps a ledger.", "Keeps two ledgers and refunds."));
    git(billing, ["commit", "-q", "-am", "merge main"]);
    expect(String(run(UNIT, ["push", "--undo-merge"], alice).json?.notice)).toBe("The merge of origin/main is already committed on refunds in billing, so I left it.");
  });

  test("a clash she resolved, then her hook refuses git's merge message at the finish: the merge waits as she resolved it, and her message finishes it", () => {
    const { alice, hosts, billing, record } = movedAndPushed(true);
    next(alice);
    run(UNIT, ["push", "--merge-main"], alice);
    const resolved = README.replace("Keeps a ledger.", "Keeps two ledgers and refunds.");
    writeFileSync(join(billing, "README.md"), resolved);
    git(billing, ["add", "README.md"]);
    ticketKeyHook(billing);
    const refused = run(UNIT, ["push", "--merge-main"], alice);
    expect(refused.status).not.toBe(0);
    expect(String(refused.json?.error)).toBe(`Your hook in billing did not take the merge of origin/main into refunds (${TICKET_HOOK_WORDS}), so ` +
      "the merge is still waiting there as you resolved it, and nothing was pushed. If it is the merge's message, tell me the one " +
      "to use, and I will finish it with that.");
    expect(mergeWaits(billing)).toBe(true);
    expect(readFileSync(join(billing, "README.md"), "utf-8")).toBe(resolved);
    const done = run(UNIT, ["push", "--merge-main", "--commit-message-file", commitMessage(alice, record, "PAY-12 bring main in\n")], alice);
    expect(done.status, done.out).toBe(0);
    expect(git(hosts.billing, ["log", "-1", "--format=%s", "refunds"])).toBe("PAY-12 bring main in");
    expect(git(hosts.billing, ["show", "refunds:README.md"])).toContain("Keeps two ledgers and refunds.");
  });

  test("the undo where git cannot take the waiting merge back out says git's words, and the merge still waits", () => {
    const { alice, billing } = movedAndPushed(true);
    next(alice);
    run(UNIT, ["push", "--merge-main"], alice);
    // Another git of hers holds the index.
    const lock = join(billing, ".git", "index.lock");
    writeFileSync(lock, "");
    const said = String(run(UNIT, ["push", "--undo-merge"], alice).json?.notice);
    rmSync(lock);
    expect(said).toStartWith('The merge of origin/main into refunds in billing could not be undone: git says "');
    expect(said).toEndWith("It is still waiting there.");
    expect(mergeWaits(billing)).toBe(true);
  });

  test("her change in a file main changes stops it before anything merges; a change in another file rides along", () => {
    const { alice, billing } = movedAndPushed();
    next(alice);
    writeFileSync(join(billing, "README.md"), `${README.replace("Keeps a ledger.", "Keeps a ledger and refunds.")}mine\n`);
    // Her README edit is also a Unit file: the Unit's own line says so first.
    expect(String(run(UNIT, ["push", "--merge-main"], alice).json?.error)).toBe(
      "refunds's README.md in billing has a change that is not committed, so nothing was merged or pushed. Once it is pushed with " +
        "refunds, or put aside, I can bring origin/main in.");
    git(billing, ["checkout", "--", "README.md"]);
    writeFileSync(join(billing, "LICENSE"), "v1, mine\n");
    const yes = run(UNIT, ["push", "--merge-main"], alice);
    expect(yes.status, yes.out).toBe(0);
    expect(readFileSync(join(billing, "LICENSE"), "utf-8")).toBe("v1, mine\n");
  });

  test("a file of hers where main adds one, and a tracked change in a file main changes: nothing merged", () => {
    const { alice, hosts, billing } = movedAndPushed();
    next(alice);
    onHostMain(hosts.billing, "docs/notes.md", "from main\n", "erin");
    mkdirSync(join(billing, "docs"), { recursive: true });
    writeFileSync(join(billing, "docs", "notes.md"), "mine\n");
    expect(String(run(UNIT, ["push", "--merge-main"], alice).json?.error)).toBe(
      "origin/main adds docs/notes.md in billing, where you have a file of your own, so nothing was merged or pushed. Once it is " +
        "moved or put aside, I can bring origin/main in.");
    expect(readFileSync(join(billing, "docs", "notes.md"), "utf-8")).toBe("mine\n");
    renameSync(join(billing, "docs", "notes.md"), join(billing, "docs", "notes-mine.md"));
    onHostMain(hosts.billing, "LICENSE", "v2\n", "frank");
    writeFileSync(join(billing, "LICENSE"), "v1, mine\n");
    expect(String(run(UNIT, ["push", "--merge-main"], alice).json?.error)).toBe(
      "Your change to LICENSE in billing is in a file origin/main changes, so nothing was merged or pushed. Once it is committed or " +
        "put aside, I can bring origin/main in.");
    expect(mergeWaits(billing)).toBe(false);
  });

  test("her hook refuses git's merge message: undone, with the offer; her message then makes the merge", () => {
    const { alice, hosts, billing, record } = movedAndPushed();
    next(alice);
    ticketKeyHook(billing);
    const refused = run(UNIT, ["push", "--merge-main"], alice);
    expect(String(refused.json?.error)).toBe(`Your hook in billing did not take the merge of origin/main into refunds (${TICKET_HOOK_WORDS}), so I ` +
      "undid it, and nothing was pushed. If it is the merge's message, tell me the one to use, and I will merge with that.");
    expect(mergeWaits(billing)).toBe(false);
    const yes = run(UNIT, ["push", "--merge-main", "--commit-message-file", commitMessage(alice, record, "PAY-12 bring main in\n")], alice);
    expect(yes.status, yes.out).toBe(0);
    expect(git(hosts.billing, ["log", "-1", "--format=%s", "refunds"])).toBe("PAY-12 bring main in");
  });

  test("the host refuses the merge's push for its message: the merge stays here, and her message goes on it", () => {
    const { alice, hosts, billing, record } = movedAndPushed();
    next(alice);
    ticketKeyRule(hosts.billing);
    const was = git(billing, ["rev-parse", "--short", "refunds"]);
    const refused = run(UNIT, ["push", "--merge-main"], alice);
    expect(refused.status).not.toBe(0);
    expect(String(refused.json?.error)).toBe(`Merged origin/main into refunds in billing, and the push was refused: ${TICKET_RULE_WORDS} ` +
      `(pre-receive hook declined). The merge stays here; refunds was at ${was} before it. If it is the merge's message, tell me the ` +
      "one to use, and I will merge with that and push again.");
    const yes = run(UNIT, ["push", "--merge-main", "--commit-message-file", commitMessage(alice, record, "PAY-12 bring main in\n")], alice);
    expect(yes.status, yes.out).toBe(0);
    expect(git(hosts.billing, ["log", "-1", "--format=%s", "refunds"])).toBe("PAY-12 bring main in");
    expect(git(billing, ["rev-parse", "refunds^2"]).length).toBeGreaterThan(0);
  });

  // The Unit redone from the newer main after its merge of main went: its next push asks for the replace.
  function redoneOnMain(alice: string, billing: string): void {
    git(billing, ["fetch", "-q", "origin"]);
    git(billing, ["switch", "-q", "main"]);
    git(billing, ["branch", "-q", "-D", "refunds"]);
    git(billing, ["switch", "-q", "-c", "refunds", "origin/main"]);
    writeFileSync(join(billing, "README.md"), `${readFileSync(join(billing, "README.md"), "utf-8")}Refunds, again.\n`);
    const refused = run(UNIT, ["push"], alice);
    expect(String(refused.json?.error)).toContain("Ask the person whether to replace refunds there with this build");
  }

  test("a clean merge of main the yes pushed: a later replace leases on it as on its own push", () => {
    const { alice, hosts, billing } = movedAndPushed();
    next(alice);
    expect(run(UNIT, ["push", "--merge-main"], alice).status).toBe(0);
    redoneOnMain(alice, billing);
    const replaced = run(UNIT, ["push", "--replace"], alice);
    expect(replaced.status, replaced.out).toBe(0);
    expect(git(hosts.billing, ["show", "refunds:README.md"])).toContain("Refunds, again.");
  });

  test("a merge whose clash was resolved: a later replace is refused, so the resolution is never dropped", () => {
    const { alice, hosts, billing } = movedAndPushed(true);
    next(alice);
    run(UNIT, ["push", "--merge-main"], alice);
    writeFileSync(join(billing, "README.md"), README.replace("Keeps a ledger.", "Keeps two ledgers and refunds."));
    git(billing, ["add", "README.md"]);
    expect(run(UNIT, ["push", "--merge-main"], alice).status).toBe(0);
    const resolved = git(hosts.billing, ["rev-parse", "refunds"]);
    redoneOnMain(alice, billing);
    const refused = run(UNIT, ["push", "--replace"], alice);
    expect(refused.status).not.toBe(0);
    expect(String(refused.json?.error)).toContain("is not where this build's last push left it, so it was not replaced, and nothing was pushed.");
    expect(git(hosts.billing, ["rev-parse", "refunds"])).toBe(resolved);
  });

  test("the fetch refused: nothing merged, and the way on", () => {
    const { alice, billing } = movedAndPushed();
    next(alice);
    git(billing, ["remote", "set-url", "origin", join(tempDir("gone"), "nowhere.git")]);
    const said = String(run(UNIT, ["push", "--merge-main"], alice).json?.error);
    expect(said).toStartWith('origin/main could not be fetched in billing: git says "');
    expect(said).toEndWith("Nothing was merged or pushed. Say when to try again.");
    expect(mergeWaits(billing)).toBe(false);
  });

  test("not offered while a push is due, at an unsent result, or for a build whose branch started from main", () => {
    const { alice, record } = takenThenMainMoves({ "docs/ops.md": "On call.\n" });
    codeWrote(alice, record, { "README.md": README.replace("Keeps a ledger.", "Keeps a ledger and refunds.") });
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    expect(next(alice).ask_type ?? null).not.toBe("unit-main-moved");
    expect(String(run(UNIT, ["push", "--merge-main"], alice).json?.notice)).toBe(
      "refunds has nothing to bring in from the branch it merges into; nothing was merged or pushed.");
  });
});
