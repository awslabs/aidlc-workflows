// covers: subcommand:aidlc-unit:hand-off, subcommand:aidlc-unit:take-in, subcommand:aidlc-unit:progress, function:renderHandFile, function:parseHandFile, function:handFileStep
//
// Hand-off by file (#2410, item 6), for a team that cannot reach the home's
// repository. The lead holds the Unit for the team and writes one readable
// file; the team starts the Unit's build from it in its own workspace, however
// it points at the file; its progress and its result go back as files the lead
// takes in by pointing at them, and the home's board offers the hand-off. A
// repo the home cannot fetch keeps the team's own word on whether it merged.
// Files are LF when written and read with CRLF too; a changed file is taken in
// as it is, an older one with a line, one for other work changes nothing.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { createTestProject, fixtureIntentId8, seedAidlcMemory } from "../harness/fixtures.ts";
import {
  claimPayload,
  cleanupTeamBuild,
  cloneCode,
  codeHost,
  git,
  makeHome,
  next,
  run,
  STATE,
  tempDir,
  UNIT,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

const OPEN = "# Unit dependencies\n\n```yaml\nunits:\n  - name: refunds\n    depends_on: []\n" +
  "  - name: reporting\n    repos: [ledger]\n    depends_on: []\n```\n";
const FILE = "aidlc/handoff/fixture-reporting.md";

function handedOff() {
  const home = makeHome({ dependencies: OPEN });
  expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
  expect(run(UNIT, ["assign", "refunds=payments"], home.dir).status).toBe(0);
  const handed = run(UNIT, ["hand-off", "reporting", "--team", "data", "--person-words", "hand off reporting to the data team"], home.dir);
  expect(handed.status, handed.out).toBe(0);
  return { home, handed };
}

// The data team's own workspace, with its own copy of ledger; not a clone of
// the home's, and no way to reach it.
function partnerWorkspace(): { dir: string; ledgerHost: string } {
  const dir = createTestProject();
  seedAidlcMemory(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  const ledgerHost = codeHost("ledger");
  cloneCode(ledgerHost, dir, "ledger", "dana");
  return { dir, ledgerHost };
}

// The file as it reaches the partner: a mail attachment saved with CRLF, in a
// folder with a space in its name.
function deliver(homeDir: string, file: string, edit?: (text: string) => string): string {
  const inbox = join(tempDir("inbox"), "from the lead");
  mkdirSync(inbox, { recursive: true });
  const text = readFileSync(join(homeDir, ...file.split("/")), "utf-8");
  const path = join(inbox, file.split("/").at(-1)!);
  writeFileSync(path, (edit ? edit(text) : text).replace(/\n/g, "\r\n"));
  return path;
}

describe("the lead hands a Unit off by file", () => {
  test("the Unit is held for the team, one readable file is written, and the board says so", () => {
    const { home, handed } = handedOff();
    expect(handed.json?.notice).toBe(
      `The hand-off file for reporting is ${FILE}: send it to the data team. They take it in with ` +
        "/aidlc <the file> in their own workspace, and send its result back to you as a file.",
    );
    const text = readFileSync(join(home.dir, ...FILE.split("/")), "utf-8");
    expect(text).toStartWith("# Hand-off: reporting of fixture\n");
    expect(text).toContain("Take it in with `/aidlc <this file>` in your own ");
    expect(text).toContain("## File: inception/requirements-analysis/requirements.md");
    expect(text).not.toContain("\r");
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "reporting")).toMatchObject({ owner: "data", by_file: true });
    const row = readAuditShardEvents(home.dir).filter((entry) => entry.event === "UNITS_ASSIGNED").at(-1);
    expect(row?.block).toContain(`**By File**: ${FILE}`);
    expect(row?.block).toContain("**Person Words**: hand off reporting to the data team");
  });

  test("the board offers the hand-off once for a Unit held for a team and not taken, and gives the agent the commands", () => {
    const { home } = handedOff();
    const board = next(home.dir);
    expect(String(board.message)).toContain("- refunds, payments: held for payments, not taken yet");
    // reporting went by file already, so only refunds is offered.
    expect((board.change_notices ?? []) as string[]).toContain(
      'If payments cannot reach this workspace, say "hand off refunds by file" and send them the file it writes.',
    );
    expect(String(board.board_note)).toContain("aidlc-unit.ts hand-off <unit> --team <team> --person-words '<their words>'");
    expect(String(board.board_note)).toContain("aidlc-unit.ts take-in <file>");
  });
});

describe("the team takes the file in", () => {
  test("pointing at the file is the offer to start it; taking it starts the Unit's build, by file", () => {
    const { home } = handedOff();
    const partner = partnerWorkspace();
    const path = deliver(home.dir, FILE);
    const ask = next(partner.dir, undefined, [path]);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-handoff");
    expect(String(ask.question)).toMatch(/^Reporting is yours, handed off from fixture by its lead on \d{4}-\d\d-\d\d\. It likely changes ledger, already here\.$/);
    const took = run(UNIT, ["take", "--file", path], partner.dir);
    expect(took.status, took.out).toBe(0);
    expect(String(took.json?.notice)).toContain("its result goes back as a file when it is built.");
    expect(String(took.json?.notice)).not.toContain("changed after");
    const intents = join(partner.dir, "aidlc", "spaces", "data", "intents");
    const record = join(intents, readdirSync(intents).find((name) => name.endsWith("-reporting"))!);
    expect(readFileSync(join(record, "aidlc-state.md"), "utf-8")).toContain("- **Home Result**: by file");
    expect(readFileSync(join(record, "inception", "requirements-analysis", "requirements.md"), "utf-8"))
      .toBe("# Requirements\n\nFR1 refunds.\n");
    const step = next(partner.dir);
    expect(step.kind, JSON.stringify(step)).toBe("run-stage");
    expect(step.unit).toBe("reporting");
  });

  test("a file changed after the lead wrote it is taken in as it is, with one line", () => {
    const { home } = handedOff();
    const partner = partnerWorkspace();
    const path = deliver(home.dir, FILE, (text) => text.replace("FR1 refunds.", "FR1 refunds, edited."));
    const took = run(UNIT, ["take", "--file", path], partner.dir);
    expect(took.status, took.out).toBe(0);
    expect(String(took.json?.notice)).toContain("This file was changed after the lead wrote it: it is taken in as it is.");
  });
});

describe("progress and the result come back as files", () => {
  test("the board shows the team's progress; its result, with its own word on a repo the home cannot fetch, makes the Unit done", () => {
    const { home } = handedOff();
    const partner = partnerWorkspace();
    expect(run(UNIT, ["take", "--file", deliver(home.dir, FILE)], partner.dir).status).toBe(0);
    const progress = run(UNIT, ["progress"], partner.dir);
    expect(progress.status, progress.out).toBe(0);
    expect(progress.json?.notice).toBe("The progress file is aidlc/handoff/fixture-reporting-progress.md; send it to the lead if you like.");
    const progressFile = deliver(partner.dir, "aidlc/handoff/fixture-reporting-progress.md");
    expect(readFileSync(progressFile, "utf-8")).toContain("Take it in at the home with `/aidlc <this file>`.");
    // Its path given to the home's /aidlc is the step that takes it in.
    const step = next(home.dir, undefined, [progressFile]);
    expect(step.kind, JSON.stringify(step)).toBe("print");
    expect(String(step.message)).toBe(
      `Run \`bun .claude/tools/aidlc-unit.ts take-in '${progressFile}'\`, then tell the person its notice line in one line ` +
        "and re-run `next` to continue.",
    );
    const progressIn = run(UNIT, ["take-in", progressFile], home.dir);
    expect(progressIn.status, progressIn.out).toBe(0);
    expect(progressIn.json?.notice).toBe("Took in reporting's progress from data: Functional Design.");
    expect(String(next(home.dir).message)).toContain("- reporting, data: handed off by file, at Functional Design");
    // Code Generation wrote one file in ledger; the team pushes, then merges.
    const intents = join(partner.dir, "aidlc", "spaces", "data", "intents");
    const record = join(intents, readdirSync(intents).find((name) => name.endsWith("-reporting"))!);
    mkdirSync(join(partner.dir, "ledger", "src"), { recursive: true });
    writeFileSync(join(partner.dir, "ledger", "src", "report.ts"), "export const report = 1;\n");
    const stage = join(record, "construction", "reporting", "code-generation");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "source-manifest.json"), `${JSON.stringify({
      stage: "code-generation", unit: "reporting", version: 1, writes: [{ path: "src/report.ts" }],
    })}\n`);
    expect(run(UNIT, ["push"], partner.dir).status).toBe(0);
    git(join(partner.dir, "ledger"), ["switch", "-q", "main"]);
    git(join(partner.dir, "ledger"), ["merge", "-q", "--ff-only", "reporting"]);
    git(join(partner.dir, "ledger"), ["push", "-q", "origin", "main"]);
    const again = run(UNIT, ["push"], partner.dir);
    expect(again.status, again.out).toBe(0);
    expect(String(again.json?.notice)).toContain("The result file is aidlc/handoff/fixture-reporting-result.md; send it to the lead.");
    const resultFile = deliver(partner.dir, "aidlc/handoff/fixture-reporting-result.md");
    expect(String(next(home.dir, undefined, [resultFile]).message)).toContain(`take-in '${resultFile}'`);
    const resultIn = run(UNIT, ["take-in", resultFile], home.dir);
    expect(resultIn.status, resultIn.out).toBe(0);
    expect(resultIn.json?.notice).toBe("Took in reporting's result from data.");
    next(home.dir);
    const merged = readAuditShardEvents(home.dir).filter((row) => row.event === "UNIT_MERGED");
    expect(merged.map((row) => row.block).join("\n")).toContain("reported by data");
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "reporting")).toMatchObject({ done: true });
  });

  test("a file for other work changes nothing; an older one is taken in with a line", () => {
    const { home } = handedOff();
    const partner = partnerWorkspace();
    expect(run(UNIT, ["take", "--file", deliver(home.dir, FILE)], partner.dir).status).toBe(0);
    expect(run(UNIT, ["progress"], partner.dir).status).toBe(0);
    const foreign = deliver(partner.dir, "aidlc/handoff/fixture-reporting-progress.md", (text) =>
      text.replace(/^- \*\*Home Work\*\*: .*$/m, "- **Home Work**: 00000000-0000-7000-8000-00000000beef")
        .replace(/^- \*\*Home Label\*\*: .*$/m, "- **Home Label**: payroll"));
    const ignored = run(UNIT, ["take-in", foreign], home.dir);
    expect(ignored.status, ignored.out).toBe(0);
    expect(String(ignored.json?.notice)).toEndWith("is for other work (payroll), not this one, so nothing changed.");
    const older = deliver(partner.dir, "aidlc/handoff/fixture-reporting-progress.md", (text) =>
      text.replace(/^- \*\*Attempt\*\*: .*$/m, "- **Attempt**: 0"));
    const late = run(UNIT, ["take-in", older], home.dir);
    expect(late.status, late.out).toBe(0);
    expect(String(late.json?.notice)).toContain("This file is from an earlier attempt of reporting; it is taken in as the team's latest word.");
  });
});
