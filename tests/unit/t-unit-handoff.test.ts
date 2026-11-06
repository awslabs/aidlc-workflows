// covers: subcommand:aidlc-unit:hand-off, subcommand:aidlc-unit:take-in, subcommand:aidlc-unit:progress, function:renderHandFile, function:parseHandFile, function:handFileStep, function:pastUnitStages
//
// Hand-off by file (#2410, item 6), for a team that cannot reach the home's
// repository. The lead holds the Unit for the team and writes one readable
// file; the team starts the Unit's build from it in its own workspace, however
// it points at the file; its progress and its result go back as files the lead
// takes in by pointing at them, and the home's board offers the hand-off. A
// repo the home cannot fetch keeps the team's own word on whether it merged.
// Files are LF when written and read with CRLF too; a changed file is taken in
// as it is, an older one with a line, one for other work changes nothing. A
// result taken in once the work moved on past the Unit stages says it is not
// recorded yet and where it is, and back on them it is recorded.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { pastUnitStages } from "../../dist/claude/.claude/tools/aidlc-unit.ts";
import { AIDLC_SRC, createTestProject, fixtureIntentId8, seedAidlcMemory } from "../harness/fixtures.ts";
import {
  claimPayload,
  cleanupTeamBuild,
  cloneCode,
  cloneOf,
  codeHost,
  ENV,
  git,
  HOME_RECORD,
  homeState,
  makeHome,
  next,
  ORCH,
  run,
  STATE,
  tellsWhatToType,
  tempDir,
  UNIT,
  UTILITY,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

const JUMP = join(AIDLC_SRC, "tools", "aidlc-jump.ts");

const OPEN = "# Unit dependencies\n\n```yaml\nunits:\n  - name: refunds\n    depends_on: []\n" +
  "  - name: reporting\n    repos: [ledger]\n    depends_on: []\n```\n";
const FILE = "aidlc/handoff/fixture-reporting.md";

function handedOff() {
  const home = makeHome({ dependencies: OPEN, repos: { ledger: "" } });
  expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
  expect(run(UNIT, ["assign", "refunds=payments"], home.dir).status).toBe(0);
  const handed = run(UNIT, ["hand-off", "reporting", "--team", "data", "--person-words", "hand off reporting to the data team"], home.dir);
  expect(handed.status, handed.out).toBe(0);
  // The lead's yes to sharing the plan with the teams.
  expect(run(UNIT, ["share", "--plan"], home.dir).status).toBe(0);
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
      `The hand-off file for reporting is ${FILE}: send it to the data team. They take it in by ` +
        "pointing AI-DLC at it in their own workspace, and send its result back to you as a file.",
    );
    const text = readFileSync(join(home.dir, ...FILE.split("/")), "utf-8");
    expect(text).toStartWith("# Hand-off: reporting of fixture\n");
    expect(text).toContain("Point AI-DLC at this file in your own workspace");
    expect(text).toContain("## File: inception/requirements-analysis/requirements.md");
    expect(text).not.toContain("\r");
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "reporting")).toMatchObject({ owner: "data", by_file: true });
    const row = readAuditShardEvents(home.dir).filter((entry) => entry.event === "UNITS_ASSIGNED").at(-1);
    expect(row?.block).toContain(`**By File**: ${FILE}`);
    expect(row?.block).toContain("**Person Words**: hand off reporting to the data team");
  });

  test("a team the lead calls the data team is named once: no line says team twice", () => {
    const home = makeHome({ dependencies: OPEN, repos: { ledger: "" } });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    const handed = run(UNIT, ["hand-off", "reporting", "--team", "data team"], home.dir);
    expect(handed.status, handed.out).toBe(0);
    expect(String(handed.json?.notice)).toContain(": send it to the data team. They take it in by ");
    const file = readFileSync(join(home.dir, "aidlc", "handoff", "fixture-reporting.md"), "utf-8");
    expect(file).toContain("This file hands reporting to the data team. Point AI-DLC");
    expect(`${handed.out}${file}`).not.toContain("team team");
  });

  test("with the Unit plan open again at the home, the hand-off says once that the Unit goes on the plan as it stands", () => {
    const home = makeHome({
      dependencies: OPEN,
      repos: { ledger: "" },
      state: homeState().replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: units-generation"),
    });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    const handed = run(UNIT, ["hand-off", "reporting", "--team", "data"], home.dir);
    expect(handed.status, handed.out).toBe(0);
    expect(String(handed.json?.notice)).toEndWith("), so reporting goes to its team on the plan as it stands, which may still change.");
  });

  test("the board offers the hand-off once for a Unit held for a team and not taken, and gives the agent the commands", () => {
    const { home } = handedOff();
    const chat = { ...ENV, AIDLC_SESSION_OVERRIDE: "t-unit-handoff-board" };
    const board = next(home.dir, chat);
    expect(board.kind, JSON.stringify(board)).toBe("print");
    expect(String(board.narration)).toContain("- refunds, payments: held for payments, not taken yet");
    // reporting went by file already, so only refunds is offered.
    const offers = board.offers as Array<{ question: string; choices: Array<{ label: string; command?: string }> }>;
    expect(offers.map((offer) => offer.question)).toEqual([
      "If payments cannot reach this workspace, I can hand refunds to them as a file they build it from. Do you want me to?",
    ]);
    expect(tellsWhatToType(board.narration, board.offers, board.change_notices)).toBe(false);
    expect(offers[0].choices.map((choice) => choice.label)).toEqual(["Hand refunds to payments as a file", "Keep refunds for payments here"]);
    expect(offers[0].choices[0].command).toEndWith("aidlc-unit.ts hand-off refunds --team payments --request-file aidlc/.aidlc-request-text/unit-hand-off-refunds.txt");
    expect(String(board.board_note)).toContain("aidlc-unit.ts hand-off <unit> --team <team> --request-file aidlc/.aidlc-request-text/unit-hand-off.txt");
    expect(String(board.board_note)).toContain("aidlc-unit.ts take-in <file>");
    // Put once in a chat: the next look keeps only the board's note of the command.
    const again = next(home.dir, chat);
    expect(again.offers, JSON.stringify(again)).toBeUndefined();
    expect(String(again.board_note)).toContain("aidlc-unit.ts hand-off <unit>");
  });
});

describe("the team takes the file in", () => {
  // A live run (Copilot CLI on Windows): the member typed the documented
  // "/aidlc <hand-off file path>", the agent ran next with that path as the
  // request, and the engine offered to run a new feature plan for the path.
  test("a request that is only the hand-off file's path is that hand-off, never new work", () => {
    const { home } = handedOff();
    const partner = partnerWorkspace();
    const path = deliver(home.dir, FILE);
    for (const said of [path, `"${path}"`, `'${path}' `]) {
      const ask = next(partner.dir, undefined, [said]);
      expect(ask.ask_type, JSON.stringify(ask).slice(0, 600)).toBe("unit-handoff");
      expect(JSON.stringify(ask)).not.toContain("feature plan");
    }
    // Words that only mention the file are the person's request, as before.
    const words = next(partner.dir, undefined, [`please read ${path} later`]);
    expect(words.ask_type).not.toBe("unit-handoff");
  });

  test("pointing at the file is the offer to start it; taking it starts the Unit's build, by file", () => {
    const { home } = handedOff();
    const partner = partnerWorkspace();
    const path = deliver(home.dir, FILE);
    const ask = next(partner.dir, undefined, ["--hand-file", path]);
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
    // The build records ledger in a workspace with no repos.json: its first
    // step offers once to write it (t-repos-anywhere's), then the build runs.
    expect(next(partner.dir).ask_type).toBe("repos-manifest");
    const step = next(partner.dir);
    expect(step.kind, JSON.stringify(step)).toBe("run-stage");
    expect(step.unit).toBe("reporting");
    // Pointed at again, the file whose Unit is already being built here starts nothing new.
    const again = next(partner.dir, undefined, ["--hand-file", path]);
    expect(again.kind, JSON.stringify(again)).toBe("run-stage");
    expect(again.unit).toBe("reporting");
  });

  test("the agent hands the file's exact path: the offer to start it; a path that is no such file is said", () => {
    const { home } = handedOff();
    const partner = partnerWorkspace();
    const path = deliver(home.dir, FILE);
    const ask = next(partner.dir, undefined, ["--hand-file", path]);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-handoff");
    const notes = join(tempDir("notes"), "notes.md");
    writeFileSync(notes, "# my notes\n");
    const wrong = next(partner.dir, undefined, ["--hand-file", notes]);
    expect(wrong.kind, JSON.stringify(wrong)).toBe("error");
    expect(String(wrong.message)).toBe(`${notes} is not a file AI-DLC wrote for a hand-off, its progress or its result.`);
  });

  test("a file an editor reformatted (a padded table, fences in backticks) reads the same and is not taken as changed", () => {
    const { home } = handedOff();
    const partner = partnerWorkspace();
    const path = deliver(home.dir, FILE, (text) => text
      .replace(/^~{4,}( noeol)?$/gm, (_fence, noeol: string | undefined) => `\`\`\`\`${noeol ? " noeol" : ""}`)
      .replace(/^\| (.+?) \| (sha256:[0-9a-f]+) \|$/gm, "|   $1   |   $2   |"));
    const took = run(UNIT, ["take", "--file", path], partner.dir);
    expect(took.status, took.out).toBe(0);
    expect(String(took.json?.notice)).not.toContain("changed after");
    const intents = join(partner.dir, "aidlc", "spaces", "data", "intents");
    const record = join(intents, readdirSync(intents).find((name) => name.endsWith("-reporting"))!);
    expect(readFileSync(join(record, "inception", "requirements-analysis", "requirements.md"), "utf-8")).toBe("# Requirements\n\nFR1 refunds.\n");
    // The build's own list of what it was approved with, padded the same way, still lists them.
    const inputs = join(record, "approved-inputs.md");
    writeFileSync(inputs, readFileSync(inputs, "utf-8").replace(/^\| (\S+) \| (sha256:[0-9a-f]+) \|$/gm, "| $1   |   $2 |"));
    writeFileSync(join(record, "inception", "requirements-analysis", "requirements.md"), "# Requirements\n\nFR1 refunds, faster.\n");
    const proposed = run(UNIT, ["propose", "--input", "requirements.md"], partner.dir);
    expect(String(proposed.out)).not.toContain("is not one of the files");
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
    expect(readFileSync(progressFile, "utf-8")).toContain("Point AI-DLC at this file at the lead's project and it takes it in.");
    // Its path given to the home's /aidlc is the step that takes it in.
    const step = next(home.dir, undefined, ["--hand-file", progressFile]);
    expect(step.kind, JSON.stringify(step)).toBe("print");
    expect(String(step.message)).toBe(
      `Run \`bun .claude/tools/aidlc-unit.ts take-in '${progressFile}'\`, then tell the person its notice line in one line ` +
        "and re-run `next` to continue.",
    );
    const progressIn = run(UNIT, ["take-in", progressFile], home.dir);
    expect(progressIn.status, progressIn.out).toBe(0);
    expect(progressIn.json?.notice).toBe("Took in reporting's progress from data: Functional Design.");
    // The turn's words still name the file: taken in, it is not offered again; the step is the work's own.
    const pointedAgain = next(home.dir, undefined, ["--hand-file", progressFile]);
    expect(pointedAgain.kind, JSON.stringify(pointedAgain)).toBe("print");
    expect(String(pointedAgain.narration)).toContain("- reporting, data: handed off by file, at Functional Design");
    expect(String(next(home.dir).narration)).toContain("- reporting, data: handed off by file, at Functional Design");
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
    expect(String(next(home.dir, undefined, ["--hand-file", resultFile]).message)).toContain(`take-in '${resultFile}'`);
    const resultIn = run(UNIT, ["take-in", resultFile], home.dir);
    expect(resultIn.status, resultIn.out).toBe(0);
    expect(resultIn.json?.notice).toBe("Took in reporting's result from data.");
    // A team by file reads nothing from here, so the step never says it was told.
    const recorded = next(home.dir);
    expect(JSON.stringify(recorded.change_notices ?? [])).not.toContain("I've told the teams");
    const merged = readAuditShardEvents(home.dir).filter((row) => row.event === "UNIT_MERGED");
    expect(merged.map((row) => row.block).join("\n")).toContain("reported by data");
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "reporting")).toMatchObject({ done: true });
  });

  // A live run: a team building by file was told to send its change "with your
  // result file", which carries none, so its change had no way home. Its
  // proposal goes in a progress file, and the lead is asked when they take it in.
  test("a team by file proposes a change in a progress file, and the lead is asked about it once it is taken in", () => {
    const { home } = handedOff();
    const partner = partnerWorkspace();
    expect(run(UNIT, ["take", "--file", deliver(home.dir, FILE)], partner.dir).status).toBe(0);
    const intents = join(partner.dir, "aidlc", "spaces", "data", "intents");
    const record = join(intents, readdirSync(intents).find((name) => name.endsWith("-reporting"))!);
    writeFileSync(join(record, "inception", "requirements-analysis", "requirements.md"), "# Requirements\n\nFR1 refunds, by month.\n");
    // Its step puts the change to them as any team's is put; its command writes the progress file.
    const steps = [next(partner.dir), next(partner.dir)];
    expect(JSON.stringify(steps)).not.toContain("with your result file");
    expect(steps.map((step) => step.ask_type), JSON.stringify(steps).slice(0, 500)).toContain("unit-propose");
    const sent = run(UNIT, ["propose", "--input", "requirements.md", "--person-words", "report refunds by month"], partner.dir);
    expect(sent.status, sent.out).toBe(0);
    expect(sent.json?.notice).toBe(
      "Your change to the requirements is in aidlc/handoff/fixture-reporting-progress.md: send it to the lead, who is asked " +
        "about it when they take it in. I'm carrying on with your version here until the lead decides.",
    );
    const progressFile = deliver(partner.dir, "aidlc/handoff/fixture-reporting-progress.md");
    const progressIn = run(UNIT, ["take-in", progressFile], home.dir);
    expect(progressIn.status, progressIn.out).toBe(0);
    expect(String(progressIn.json?.notice)).toContain("It brings a change data proposes to the requirements.");
    const ask = next(home.dir);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-amend");
    expect(String(ask.question)).toStartWith('data proposes a change to the requirements for reporting ("report refunds by month").');
    expect(ask.ask_type).toBe("unit-amend");
  });

  // A live run: after the lead approved a by-file team's change, the newer
  // hand-off file was taken with "Carrying on" and nothing else: the build's
  // copy stayed the old one and nothing said the change was approved.
  test("approved, the newer hand-off file brings the approved text into the team's build, and says it was approved", () => {
    const { home } = handedOff();
    const partner = partnerWorkspace();
    expect(run(UNIT, ["take", "--file", deliver(home.dir, FILE)], partner.dir).status).toBe(0);
    const intents = join(partner.dir, "aidlc", "spaces", "data", "intents");
    const record = join(intents, readdirSync(intents).find((name) => name.endsWith("-reporting"))!);
    const copy = join(record, "inception", "requirements-analysis", "requirements.md");
    writeFileSync(copy, "# Requirements\n\nFR1 refunds, by month.\n");
    expect(run(UNIT, ["propose", "--input", "requirements.md", "--person-words", "report refunds by month"], partner.dir).status).toBe(0);
    expect(run(UNIT, ["take-in", deliver(partner.dir, "aidlc/handoff/fixture-reporting-progress.md")], home.dir).status).toBe(0);
    next(home.dir);
    const approved = run(UNIT, ["amend", "reporting", "--input", "inception/requirements-analysis/requirements.md", "--answer", "approve",
      "--person-words", "yes, by month"], home.dir);
    expect(approved.status, approved.out).toBe(0);
    const newer = /A newer hand-off file for reporting is at (\S+): send it/.exec(String(approved.json?.notice))?.[1];
    expect(newer, String(approved.json?.notice)).toBeString();
    const delivered = deliver(home.dir, newer!);
    // The person's own path: pointing AI-DLC at the newer file is the step that brings it in.
    const pointed = next(partner.dir, undefined, ["--hand-file", delivered]);
    expect(pointed.kind, JSON.stringify(pointed).slice(0, 600)).toBe("print");
    expect(String(pointed.message)).toContain(`take --file '${delivered}'`);
    expect(JSON.stringify(pointed)).not.toContain("is yours, handed off");
    const taken = run(UNIT, ["take", "--file", delivered], partner.dir);
    expect(taken.status, taken.out).toBe(0);
    expect(String(taken.json?.notice)).toContain("The lead approved your change to the requirements.");
    const homeCopy = join(home.dir, "aidlc", "spaces", "default", "intents", "fixture-8000000000000001", "inception", "requirements-analysis", "requirements.md");
    expect(readFileSync(copy, "utf-8").replace(/\r\n/g, "\n")).toBe(readFileSync(homeCopy, "utf-8").replace(/\r\n/g, "\n"));
    // A live run: payments' change to the same requirements, approved after, came in the next
    // newer file and was put beside the copy as if the copy were data's own edit, though it was
    // the version the lead approved; the approved change never reached the build.
    const pat = cloneOf(home.remote, "pat");
    expect(run(UNIT, ["take", "refunds", "--home", HOME_RECORD, "--team", "payments"], pat).status).toBe(0);
    const patIntents = join(pat, "aidlc", "spaces", "payments", "intents");
    const patRecord = join(patIntents, readdirSync(patIntents).find((name) => name.endsWith("-refunds"))!);
    writeFileSync(join(patRecord, "inception", "requirements-analysis", "requirements.md"),
      `${readFileSync(homeCopy, "utf-8").replace(/\r\n/g, "\n").trimEnd()}\nFR2 refunds in the shop's currency.\n`);
    expect(run(UNIT, ["propose", "--input", "requirements.md", "--person-words", "refunds in the shop's currency"], pat).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    const second = run(UNIT, ["amend", "refunds", "--input", "inception/requirements-analysis/requirements.md", "--answer", "approve",
      "--person-words", "yes, in the shop's currency"], home.dir);
    expect(second.status, second.out).toBe(0);
    const newest = /A newer hand-off file for reporting is at (\S+): send it/.exec(String(second.json?.notice))?.[1];
    expect(newest, String(second.json?.notice)).toBeString();
    const again = run(UNIT, ["take", "--file", deliver(home.dir, newest!)], partner.dir);
    expect(again.status, again.out).toBe(0);
    expect(String(again.json?.notice)).not.toContain("your own edits");
    expect(readFileSync(copy, "utf-8").replace(/\r\n/g, "\n")).toContain("FR2 refunds in the shop's currency.");
  });

  // A live run: the partner had proposed its own change, still in its
  // progress file; the lead approved another team's change and the newer file
  // was read as the answer to the partner's: "the lead approved your change",
  // and the partner's own edit was written over.
  test("a newer file that brings another team's approved change never answers the team's own proposal, nor writes over its edit", () => {
    const { home } = handedOff();
    const partner = partnerWorkspace();
    expect(run(UNIT, ["take", "--file", deliver(home.dir, FILE)], partner.dir).status).toBe(0);
    const intents = join(partner.dir, "aidlc", "spaces", "data", "intents");
    const record = join(intents, readdirSync(intents).find((name) => name.endsWith("-reporting"))!);
    const copy = join(record, "inception", "requirements-analysis", "requirements.md");
    const own = "# Requirements\n\nFR1 refunds, by month.\n";
    writeFileSync(copy, own);
    expect(run(UNIT, ["propose", "--input", "requirements.md", "--person-words", "report refunds by month"], partner.dir).status).toBe(0);
    // payments proposes its own change, and the lead approves that one.
    const homeCopy = join(home.dir, "aidlc", "spaces", "default", "intents", "fixture-8000000000000001", "inception", "requirements-analysis", "requirements.md");
    const pat = cloneOf(home.remote, "pat");
    expect(run(UNIT, ["take", "refunds", "--home", HOME_RECORD, "--team", "payments"], pat).status).toBe(0);
    const patIntents = join(pat, "aidlc", "spaces", "payments", "intents");
    const patRecord = join(patIntents, readdirSync(patIntents).find((name) => name.endsWith("-refunds"))!);
    writeFileSync(join(patRecord, "inception", "requirements-analysis", "requirements.md"),
      `${readFileSync(homeCopy, "utf-8").replace(/\r\n/g, "\n").trimEnd()}\nFR2 refunds in the shop's currency.\n`);
    expect(run(UNIT, ["propose", "--input", "requirements.md", "--person-words", "refunds in the shop's currency"], pat).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    const approved = run(UNIT, ["amend", "refunds", "--input", "inception/requirements-analysis/requirements.md", "--answer", "approve",
      "--person-words", "yes, in the shop's currency"], home.dir);
    expect(approved.status, approved.out).toBe(0);
    const newer = /A newer hand-off file for reporting is at (\S+): send it/.exec(String(approved.json?.notice))?.[1];
    expect(newer, String(approved.json?.notice)).toBeString();
    const taken = run(UNIT, ["take", "--file", deliver(home.dir, newer!)], partner.dir);
    expect(taken.status, taken.out).toBe(0);
    expect(String(taken.json?.notice)).not.toContain("The lead approved your change");
    expect(readFileSync(copy, "utf-8").replace(/\r\n/g, "\n")).toBe(own);
    expect(readFileSync(copy.replace(/\.md$/, ".from-lead.md"), "utf-8")).toContain("FR2 refunds in the shop's currency.");
  });

  test("a turned-down by-file change says nothing reaches the team from here", () => {
    const { home } = handedOff();
    const partner = partnerWorkspace();
    expect(run(UNIT, ["take", "--file", deliver(home.dir, FILE)], partner.dir).status).toBe(0);
    const intents = join(partner.dir, "aidlc", "spaces", "data", "intents");
    const record = join(intents, readdirSync(intents).find((name) => name.endsWith("-reporting"))!);
    writeFileSync(join(record, "inception", "requirements-analysis", "requirements.md"), "# Requirements\n\nFR1 refunds, by month.\n");
    expect(run(UNIT, ["propose", "--input", "requirements.md", "--person-words", "report refunds by month"], partner.dir).status).toBe(0);
    expect(run(UNIT, ["take-in", deliver(partner.dir, "aidlc/handoff/fixture-reporting-progress.md")], home.dir).status).toBe(0);
    next(home.dir);
    // Turned down, nothing reaches a team that builds from a file: the line says to tell them.
    const down = run(UNIT, ["amend", "reporting", "--input", "inception/requirements-analysis/requirements.md", "--answer", "reject",
      "--person-words", "not this month"], home.dir);
    expect(down.status, down.out).toBe(0);
    expect(down.json?.notice).toBe("Turned down data's change to the requirements. They build from a file, so nothing reaches them " +
      "from here: tell them, and they carry on with the approved requirements.");
  });

  test("a result brings home only the Unit outputs the home reads: a file naming the home's state is left out, with a line", () => {
    const { home } = handedOff();
    const partner = partnerWorkspace();
    expect(run(UNIT, ["take", "--file", deliver(home.dir, FILE)], partner.dir).status).toBe(0);
    const intents = join(partner.dir, "aidlc", "spaces", "data", "intents");
    const record = join(intents, readdirSync(intents).find((name) => name.endsWith("-reporting"))!);
    mkdirSync(join(partner.dir, "ledger", "src"), { recursive: true });
    writeFileSync(join(partner.dir, "ledger", "src", "report.ts"), "export const report = 1;\n");
    const stage = join(record, "construction", "reporting", "code-generation");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "source-manifest.json"), `${JSON.stringify({ stage: "code-generation", unit: "reporting", version: 1, writes: [{ path: "src/report.ts" }] })}\n`);
    expect(run(UNIT, ["push"], partner.dir).status).toBe(0);
    const homeState = readFileSync(join(home.dir, "aidlc", "spaces", "default", "intents", "fixture-8000000000000001", "aidlc-state.md"), "utf-8");
    const result = deliver(partner.dir, "aidlc/handoff/fixture-reporting-result.md", (text) =>
      `${text}\n## File: aidlc-state.md\n\n~~~~\n# not the home's state\n~~~~\n`);
    const taken = run(UNIT, ["take-in", result], home.dir);
    expect(taken.status, taken.out).toBe(0);
    expect(String(taken.json?.notice)).toContain("aidlc-state.md is not an output the lead's project reads of reporting, so it was left out.");
    const tip = git(home.remote, ["rev-parse", `refs/heads/claim/${fixtureIntentId8(home.dir)}/reporting`]);
    expect(git(home.remote, ["ls-tree", "-r", "--name-only", tip]).split("\n")).not.toContain(".aidlc-unit-result/aidlc-state.md");
    expect(readFileSync(join(home.dir, "aidlc", "spaces", "default", "intents", "fixture-8000000000000001", "aidlc-state.md"), "utf-8")).toBe(homeState);
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

// The team builds reporting from the file, pushes and merges in ledger, and
// sends its result file back to the lead.
function resultSent(home: { dir: string }): string {
  const partner = partnerWorkspace();
  expect(run(UNIT, ["take", "--file", deliver(home.dir, FILE)], partner.dir).status).toBe(0);
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
  expect(run(UNIT, ["push"], partner.dir).status).toBe(0);
  return deliver(partner.dir, "aidlc/handoff/fixture-reporting-result.md");
}

// A live run: the lead skipped ahead from Functional Design to Build and Test,
// then took in a team's result file. Take-in said "Took in", the board read
// merged, nothing recorded it, and Build and Test ran without its outputs.
describe("a result taken in after the lead's project moved on past the Unit stages", () => {
  test("take-in, the board and the step say it is not recorded yet and where it is, and back on Functional Design it is", () => {
    const { home } = handedOff();
    const resultFile = resultSent(home);
    const lead = { ...ENV, AIDLC_SESSION_OVERRIDE: "t-unit-handoff-lead" };
    next(home.dir, lead);
    const jumped = run(JUMP, ["execute", "--target", "build-and-test", "--direction", "forward"], home.dir);
    expect(jumped.status, jumped.out).toBe(0);
    expect(next(home.dir, lead).stage).toBe("build-and-test");
    const why = "this work moved on to Build and Test past the Unit stages, so it is recorded once the work is back on " +
      "Functional Design, and Build and Test does not have its outputs until then.";
    const taken = run(UNIT, ["take-in", resultFile], home.dir, lead);
    expect(taken.status, taken.out).toBe(0);
    expect(taken.json?.notice).toBe(`Took in reporting's result from data, but it is not recorded yet: ${why}`);
    const row = "- reporting, data: ledger merged, not recorded yet: it is recorded once the work is back on Functional Design";
    expect(run(ORCH, ["team-board"], home.dir).out).toContain(row);
    expect(run(UTILITY, ["status"], home.dir).out).toContain(row);
    // Said at take-in in the lead's chat, so its next step does not say it again; another chat hears it once.
    const step = next(home.dir, lead);
    expect(step.stage, JSON.stringify(step)).toBe("build-and-test");
    expect(JSON.stringify(step)).not.toContain("not recorded yet");
    const other = next(home.dir, { ...ENV, AIDLC_SESSION_OVERRIDE: "t-unit-handoff-second-chat" });
    expect(other.change_notices, JSON.stringify(other)).toContain(`reporting (from data) is back but not recorded yet: ${why}`);
    expect(readAuditShardEvents(home.dir).filter((entry) => entry.event === "UNIT_MERGED")).toEqual([]);
    // Back on Functional Design, the walk records it.
    const back = run(JUMP, ["execute", "--target", "functional-design", "--direction", "backward"], home.dir);
    expect(back.status, back.out).toBe(0);
    next(home.dir, lead);
    const merged = readAuditShardEvents(home.dir).filter((entry) => entry.event === "UNIT_MERGED");
    expect(merged.map((entry) => entry.block).join("\n")).toContain("reported by data");
  });

  test("the way back named is the Unit stage the work left from, and a home still on the Unit stages is not past them", () => {
    const fromCodeGeneration = homeState()
      .replace(/^- \[-\] functional-design/m, "- [x] functional-design")
      .replace(/^- \[ \] (nfr-requirements|nfr-design|infrastructure-design) /gm, "- [x] $1 ")
      .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: build-and-test");
    expect(pastUnitStages(fromCodeGeneration)).toEqual({ at: "Build and Test", back: "Code Generation" });
    expect(pastUnitStages(homeState())).toBeNull();
  });
});

describe("a hand-off of a Unit that waits on one the lead's project builds", () => {
  const WAITS = "# Unit dependencies\n\n```yaml\nunits:\n" +
    "  - name: refunds\n    repos: [checkout-api]\n    depends_on: []\n" +
    "  - name: checkout-ui\n    repos: [checkout-api]\n    depends_on: []\n" +
    "  - name: reporting\n    repos: [checkout-api]\n    depends_on: [refunds]\n```\n";
  const REPORTING = "aidlc/handoff/fixture-reporting.md";

  test("says once which Unit it waits on while that code is not on the repo's remote, to the lead and in the file, and nothing once it is", () => {
    const home = makeHome({ dependencies: WAITS, repos: { "checkout-api": codeHost("checkout-api") } });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    expect(run(UNIT, ["assign", "checkout-ui=web"], home.dir).status).toBe(0);
    // refunds, built at the lead's project: committed in the lead's clone of checkout-api, not pushed.
    const repo = join(home.dir, "checkout-api");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "refunds.ts"), "export const refunds = 1;\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "refunds"]);
    const stage = join(home.dir, "aidlc", "spaces", "default", "intents", HOME_RECORD, "construction", "refunds", "code-generation");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "source-manifest.json"), `${JSON.stringify({
      stage: "code-generation", unit: "refunds", version: 1, writes: [{ repo: "checkout-api", path: "src/refunds.ts" }],
    }, null, 2)}\n`);
    const handed = run(UNIT, ["hand-off", "reporting", "--team", "data"], home.dir);
    expect(handed.status, handed.out).toBe(0);
    expect(String(handed.json?.notice)).toContain(
      "reporting waits on refunds, which this project builds: its code is not on origin/main in checkout-api yet.",
    );
    const line = "reporting waits on refunds, which the lead's project builds: when this file was written its code was not on " +
      "origin/main in checkout-api yet.";
    const partner = partnerWorkspace();
    const took = run(UNIT, ["take", "--file", deliver(home.dir, REPORTING)], partner.dir);
    expect(took.status, took.out).toBe(0);
    expect(String(took.json?.notice)).toContain(line);
    // Pushed: the next hand-off file for it says nothing of refunds.
    git(repo, ["push", "-q", "origin", "HEAD:main"]);
    const again = run(UNIT, ["hand-off", "reporting", "--team", "data"], home.dir);
    expect(again.status, again.out).toBe(0);
    expect(String(again.json?.notice)).not.toContain("waits on refunds");
    expect(readFileSync(join(home.dir, ...REPORTING.split("/")), "utf-8")).not.toContain("Waits On");
  });

  // A live run, on work begun before a project's own submodule stopped being
  // recorded: the work records the submodule as its only repo, the lead's
  // project built refunds in the project itself and has not pushed it, and the
  // hand-off said nothing of it, so the team met a Code Generation stop.
  test("under work that records only the project's submodule, it says the code it waits on is not on the project's remote yet", () => {
    const vendorHost = codeHost("vendor");
    const deps = "# Unit dependencies\n\n```yaml\nunits:\n  - name: refunds\n    depends_on: []\n" +
      "  - name: checkout-ui\n    depends_on: []\n  - name: reporting\n    depends_on: [refunds]\n```\n";
    const home = makeHome({ dependencies: deps, repos: { vendor: vendorHost } });
    writeFileSync(join(home.dir, ".gitignore"), readFileSync(join(home.dir, ".gitignore"), "utf-8").replace("/vendor/\n", ""));
    git(home.dir, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", vendorHost, "vendor"]);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "vendor"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    expect(run(UNIT, ["assign", "checkout-ui=web"], home.dir).status).toBe(0);
    mkdirSync(join(home.dir, "src"), { recursive: true });
    writeFileSync(join(home.dir, "src", "refunds.ts"), "export const refunds = 1;\n");
    const stage = join(home.dir, "aidlc", "spaces", "default", "intents", HOME_RECORD, "construction", "refunds", "code-generation");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "source-manifest.json"), `${JSON.stringify({
      stage: "code-generation", unit: "refunds", version: 1, writes: [{ path: "src/refunds.ts" }],
    }, null, 2)}\n`);
    const handed = run(UNIT, ["hand-off", "reporting", "--team", "data"], home.dir);
    expect(handed.status, handed.out).toBe(0);
    expect(String(handed.json?.notice)).toContain(
      "reporting waits on refunds, which this project builds: its code is not on origin/main in the repo yet.",
    );
  });
});

// The lead's assign over a Unit handed off by file (x2783-s9): with nothing
// back from the file yet it is a hold here again (t-unit-assignment); once the
// team builds from it, it stays by file, said.
describe("the lead's assign over a Unit its team builds from the hand-off file", () => {
  test("it stays by file, said in one line", () => {
    const { home } = handedOff();
    const partner = partnerWorkspace();
    expect(run(UNIT, ["take", "--file", deliver(home.dir, FILE)], partner.dir).status).toBe(0);
    expect(run(UNIT, ["progress"], partner.dir).status).toBe(0);
    const progressFile = deliver(partner.dir, "aidlc/handoff/fixture-reporting-progress.md");
    expect(run(UNIT, ["take-in", progressFile], home.dir).status).toBe(0);
    const again = run(UNIT, ["assign", "reporting=data"], home.dir);
    expect(again.status, again.out).toBe(0);
    expect(String(again.json?.notice)).toContain("reporting is being built by data from its hand-off file, so it stays by file.");
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "reporting")?.by_file).toBe(true);
  });
});
