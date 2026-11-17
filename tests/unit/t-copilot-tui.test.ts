// t-copilot-tui.test.ts - the Copilot CLI terminal the live Copilot journeys
// type into (tests/harness/copilot-tui.ts): Copilot's permission dialogs get
// one Enter each, also while the shell line's clock above them keeps the
// screen moving, and are counted from its session record by what drew them, a turn
// ends only when the screen is at the prompt and the record has closed the
// agent's last model call, any other dialog stops the turn unanswered, a
// dialog at startup stops the journey, a turn that outlives the work budget
// comes back with its last screen, AI-DLC's own commands are told from the
// agent's in each shell's form, an earlier terminal's session in the same home
// is never read as this one's, on Windows the terminal starts npm's .cmd
// launcher rather than its shell shim, and an agent that runs ahead fails
// the moved journeys: work started in the first turn fails the release
// journey's check, and a gate approved in the turn that opened it fails the
// golden journey's typed turn, both as person-turn failures. A scripted screen
// and a written session record stand in for Copilot, so each case is exact.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CopilotTerminal, ledgeredTurn, promptCounts, type TuiDrive, windowsLauncher } from "../harness/copilot-tui.ts";
import { cleanupTestProject, createTestProject, seededAuditShard } from "../harness/fixtures.ts";
import { sourceListing } from "../harness/golden-journey.ts";
import { PersonTurnError } from "../harness/person-turns.ts";
import { checkReleaseJourneyTurn, expectPersonFirstInJourney, type ReleaseJourneyReport } from "../harness/release-journey.ts";
import { TestBudgetExhaustedError } from "../harness/test-budget.ts";

const RULE = "\u2500".repeat(60);
const IDLE = [" \u25CF Done.", " /proj [\u2387 master]", RULE, "\u276F", RULE, " \u2190 open sidebar \u00B7 Interactive \u00B7 Manual Approval \u00B7 / commands \u00B7 ? help"].join("\n");
const dialog = (title: string, body: string, question: string) => [
  `\u256D${RULE}\u256E`, `\u2502 ${title} \u2502`, `\u2502 \u256D${RULE}\u256E \u2502`, `\u2502 \u2502 ${body} \u2502 \u2502`, `\u2502 \u2570${RULE}\u256F \u2502`, `\u2502 ${question} \u2502`,
  "\u2502 \u276F 1. Yes \u2502", "\u2502   2. No (Esc) \u2502", "\u2502 \u2191/\u2193 to navigate \u00B7 enter to select \u00B7 esc to cancel \u2502", `\u2570${RULE}\u256F`,
].join("\n");

const roots: string[] = [];
const projects: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const project of projects.splice(0)) cleanupTestProject(project);
});

let clock = 0;
function auditRow(project: string, event: string, fields: Record<string, string> = {}): void {
  const shard = seededAuditShard(project);
  mkdirSync(dirname(shard), { recursive: true });
  const at = new Date(Date.UTC(2026, 9, 30, 12, 0, clock++)).toISOString().replace(/\.\d{3}Z$/, "Z");
  const lines = Object.entries(fields).map(([name, value]) => `**${name}**: ${value}`);
  appendFileSync(shard, [`## ${event}`, `**Timestamp**: ${at}`, `**Event**: ${event}`, ...lines, "", "---", "", ""].join("\n"));
}

/**
 * A Copilot that shows `screen`; each Enter after the typed line runs the next
 * step. `ticking` keeps the screen from ever holding still, as the clock on a
 * shell line above a dialog does.
 */
class ScriptedCopilot {
  screen = IDLE;
  ticking = false;
  readonly sent: string[] = [];
  readonly steps: Array<() => void> = [];
  captures = 0;
  onCapture?: (n: number) => void;
  readonly drive: TuiDrive = (args) => {
    const flag = (name: string) => args[args.indexOf(name) + 1];
    switch (args[0]) {
      case "wait": {
        const still = !this.ticking || flag("--stable-ms") === "0";
        return { rc: still && new RegExp(flag("--pattern")).test(this.screen) ? 0 : 1, stdout: "", timedOut: false };
      }
      case "capture":
        this.onCapture?.(++this.captures);
        return { rc: 0, stdout: this.ticking ? ` $ Shell Confirm bugfix plan ${this.captures}s\n${this.screen}` : this.screen, timedOut: false };
      case "send":
        this.sent.push(flag("--keys"));
        if (flag("--keys") === "Enter") this.steps.shift()?.();
        return { rc: 0, stdout: "", timedOut: false };
      default:
        return { rc: 0, stdout: "", timedOut: false };
    }
  };
}

function home(): { proj: string; copilotHome: string; record: (session: string, events: object[]) => void } {
  const root = mkdtempSync(join(tmpdir(), "copilot-tui-"));
  roots.push(root);
  const proj = join(root, "proj");
  const copilotHome = join(root, "copilot-home");
  mkdirSync(proj, { recursive: true });
  return {
    proj, copilotHome,
    record: (session, events) => {
      const dir = join(copilotHome, "session-state", session);
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, "events.jsonl"), events.map((event) => `${JSON.stringify(event)}\n`).join(""));
    },
  };
}

function terminal(fake: ScriptedCopilot, proj: string, copilotHome: string): CopilotTerminal {
  return new CopilotTerminal({
    session: "t", proj, copilotHome, bin: "copilot", workMs: () => 60_000, cleanupMs: () => 60_000, drive: fake.drive,
  });
}

const user = (content: string) => ({ type: "user.message", data: { content } });
const turnStart = { type: "assistant.turn_start", data: {} };
const turnEnd = { type: "assistant.turn_end", data: {} };
const shell = (command: string) => ({ type: "permission.requested", data: { permissionRequest: { kind: "shell", fullCommandText: command } } });
const ran = (id: string, command: string, result: string) => [
  { type: "tool.execution_start", data: { toolCallId: id, toolName: "bash", arguments: { command } } },
  { type: "tool.execution_complete", data: { toolCallId: id, success: true, result: { content: result } } },
];

describe("t-copilot-tui: the person's turn in Copilot CLI's own terminal", () => {
  test("Enter on each permission dialog, counted by what drew it, and the turn ends when the record closes it", () => {
    const { proj, copilotHome, record } = home();
    const fake = new ScriptedCopilot();
    const next = "bun .aidlc/tools/aidlc-orchestrate.ts next --scope bugfix --request r1";
    fake.steps.push(
      () => {
        record("s1", [user("1"), turnStart, shell(next)]);
        fake.screen = dialog("Confirm bugfix plan", next, "Do you want to run this command?");
      },
      () => {
        record("s1", [...ran("t1", next, '{"kind":"print"}'),
          { type: "permission.requested", data: { permissionRequest: { kind: "write", fileName: join(proj, "aidlc", "a.md") } } }]);
        fake.screen = dialog("Create file", "a.md", `Do you want to create ${join(proj, "aidlc", "a.md")}?`);
      },
      () => {
        record("s1", [shell("mkdir -p src"), ...ran("t2", "mkdir -p src", ""),
          { type: "assistant.message", data: { content: "Reverse Engineering is ready for your review." } },
          { type: "assistant.message", data: { content: "a helper's words", parentToolCallId: "t9" } },
          { type: "session.usage_record", data: { usage: { inputTokens: 100, outputTokens: 7 } } }]);
        fake.screen = IDLE;
        const at = fake.captures;
        // The screen is back at the prompt a while before the record closes the agent's last call.
        fake.onCapture = (n) => {
          if (n === at + 4) {
            record("s1", [turnEnd]);
            closed = n;
          }
        };
      },
    );
    let closed: number | undefined;
    const copilot = terminal(fake, proj, copilotHome);
    copilot.start();
    const turn = copilot.turn("1");
    expect(turn.ended).toBe(true);
    expect(fake.sent).toEqual(["1", "Enter", "Enter", "Enter"]);
    expect(closed).toBeDefined();
    expect(fake.captures).toBeGreaterThanOrEqual(closed!);
    expect(turn.prompts.map((p) => p.kind)).toEqual(["aidlc", "write", "command"]);
    expect(promptCounts(turn.prompts)).toEqual({
      "permission prompts": 3, "for AI-DLC commands": 1, "for file writes": 1, "for other commands": 1,
    });
    expect(turn.results.map((r) => [r.input.command, r.resultText])).toEqual([[next, '{"kind":"print"}'], ["mkdir -p src", ""]]);
    expect(turn.words.map((w) => w.text)).toEqual(["Reverse Engineering is ready for your review."]);
    expect(turn.tokens).toEqual({ input: 100, output: 7 });
  });

  test("a permission dialog under a ticking clock gets one Enter, and the turn goes on", () => {
    const { proj, copilotHome, record } = home();
    const fake = new ScriptedCopilot();
    const next = "bun .aidlc/tools/aidlc-orchestrate.ts next --scope bugfix --request r1";
    fake.steps.push(
      () => {
        record("s1", [user("1"), turnStart, shell(next)]);
        fake.ticking = true;
        fake.screen = dialog("Confirm bugfix plan", next, "Do you want to run this command?");
      },
      () => {
        record("s1", [...ran("t1", next, "ok"), turnEnd]);
        fake.ticking = false;
        fake.screen = IDLE;
      },
    );
    const copilot = new CopilotTerminal({
      session: "t", proj, copilotHome, bin: "copilot", cleanupMs: () => 60_000, drive: fake.drive,
      workMs: ((end) => () => Math.max(0, end - Date.now()))(Date.now() + 5000),
    });
    copilot.start();
    const turn = copilot.turn("1");
    expect(turn.ended).toBe(true);
    expect(fake.sent).toEqual(["1", "Enter", "Enter"]);
    expect(turn.prompts.map((p) => p.kind)).toEqual(["aidlc"]);
  });

  test("a turn that outlives the work budget comes back with its last screen, read on the cleanup's time", () => {
    const { proj, copilotHome, record } = home();
    const fake = new ScriptedCopilot();
    const working = [" \u25D0 Thinking (Esc to cancel)", RULE, "\u276F", RULE, " Esc to cancel"].join("\n");
    fake.steps.push(() => {
      record("s1", [user("1"), turnStart]);
      fake.screen = working;
    });
    const end = Date.now() + 1500;
    const copilot = new CopilotTerminal({
      session: "t", proj, copilotHome, bin: "copilot", cleanupMs: () => 60_000, drive: fake.drive,
      workMs: () => {
        const left = end - Date.now();
        if (left < 1) throw new TestBudgetExhaustedError("E2E live work", "case", left, 0);
        return left;
      },
    });
    copilot.start();
    const seen: boolean[] = [];
    const turn = ledgeredTurn(copilot, proj, "1", (t) => seen.push(t.ended));
    expect(turn.ended).toBe(false);
    expect(turn.stopped).toStartWith("the time ran out:");
    expect(turn.stopped).toContain("Thinking");
    expect(seen).toEqual([false]);
  });

  test("AI-DLC's own commands are told from the agent's, in each shell's form", () => {
    const { proj, copilotHome, record } = home();
    const fake = new ScriptedCopilot();
    const commands = [
      "bun .aidlc/tools/aidlc.ts engine orchestrate next",
      "& bun .aidlc/tools/aidlc-orchestrate.ts next --scope bugfix --request r1",
      "bun .aidlc\\tools\\aidlc-log.ts review --stage requirements-analysis",
      "& 'C:\\tools\\bun.exe' .aidlc\\tools\\aidlc.ts engine intent create",
      "mkdir -p src",
      "bun test/app.test.js",
    ];
    fake.steps.push(() => record("s1", [user("1"), turnStart, ...commands.map(shell), turnEnd]));
    const copilot = terminal(fake, proj, copilotHome);
    copilot.start();
    expect(copilot.turn("1").prompts.map((p) => p.kind)).toEqual(["aidlc", "aidlc", "aidlc", "aidlc", "command", "command"]);
  });

  test("a dialog that is not a permission one stops the turn, unanswered", () => {
    const { proj, copilotHome, record } = home();
    const fake = new ScriptedCopilot();
    fake.steps.push(() => {
      record("s1", [user("Approve"), turnStart]);
      fake.screen = dialog("Select model", "openai.gpt-5.5", "Which model should Copilot use?");
    });
    const copilot = terminal(fake, proj, copilotHome);
    copilot.start();
    const turn = copilot.turn("Approve");
    expect(turn.ended).toBe(false);
    expect(turn.stopped).toStartWith("a dialog the driver does not answer:");
    expect(fake.sent).toEqual(["Approve", "Enter"]);
  });

  test("a dialog at startup (folder trust) stops the journey with the screen", () => {
    const { proj, copilotHome } = home();
    const fake = new ScriptedCopilot();
    fake.screen = dialog("Confirm folder trust", proj, "Do you trust the files in this folder?");
    expect(() => terminal(fake, proj, copilotHome).start()).toThrow(/did not reach its prompt[\s\S]*Do you trust the files/);
  });

  test("an earlier terminal's session in the same home is not read as this turn's", () => {
    const { proj, copilotHome, record } = home();
    record("s0", [user("1"), turnStart, shell("bun .aidlc/tools/aidlc.ts engine orchestrate next"), turnEnd]);
    const fake = new ScriptedCopilot();
    fake.steps.push(() => {
      record("s0", [user("late line of the old session")]);
      record("s1", [user("1"), turnStart, { type: "assistant.message", data: { content: "Picking up where we left off." } }, turnEnd]);
    });
    const copilot = terminal(fake, proj, copilotHome);
    copilot.start();
    const turn = copilot.turn("1");
    expect(turn.ended).toBe(true);
    expect(turn.prompts).toEqual([]);
    expect(turn.words.map((w) => w.text)).toEqual(["Picking up where we left off."]);
  });

  test("work the agent started before the person picked a plan fails the release journey's first turn as a person-turn failure", () => {
    const { proj, copilotHome, record } = home();
    const files = sourceListing(proj);
    const fake = new ScriptedCopilot();
    const create = "bun .aidlc/tools/aidlc.ts engine intent create --scope bugfix --request r1 --label greeter";
    fake.steps.push(() => {
      // What a run-ahead leaves: the plan's work created in the first turn, with the plan question still open.
      record("s1", [user("/aidlc fix the greeter"), turnStart, shell(create), ...ran("t1", create, "created"), turnEnd]);
      mkdirSync(join(proj, "aidlc", "spaces", "default", "intents"), { recursive: true });
      writeFileSync(join(proj, "aidlc", "spaces", "default", "intents", "intents.json"), JSON.stringify([{ scope: "bugfix" }]));
    });
    const copilot = terminal(fake, proj, copilotHome);
    copilot.start();
    const turn = copilot.turn("/aidlc fix the greeter");
    expect(turn.ended).toBe(true);
    const report: ReleaseJourneyReport = { harness: "copilot", toolVersion: "1.0.105", turns: [], extra: {}, problems: [] };
    checkReleaseJourneyTurn(report, { proj, files, start: 0 }, 1, "/aidlc fix the greeter");
    expect(report.problems).toContain('after "/aidlc fix the greeter": work was started before the person answered the plan question');
    expect(() => expectPersonFirstInJourney(report)).toThrow(PersonTurnError);
  });

  test("a gate the agent approved in the turn that opened it fails the golden journey's typed turn as a person-turn failure", () => {
    const proj = createTestProject();
    projects.push(proj);
    auditRow(proj, "WORKFLOW_STARTED");
    const { copilotHome, record } = home();
    const fake = new ScriptedCopilot();
    const approve = "bun .aidlc/tools/aidlc.ts engine orchestrate report --stage reverse-engineering --result approved --user-input Approve";
    fake.steps.push(() => {
      // What a run-ahead leaves: Reverse Engineering's gate opened and approved in one turn, with no line of the person's after it opened.
      record("s1", [user("1"), turnStart, shell(approve), ...ran("t1", approve, "approved"), turnEnd]);
      auditRow(proj, "STAGE_AWAITING_APPROVAL", { Stage: "reverse-engineering" });
      auditRow(proj, "GATE_APPROVED", { Stage: "reverse-engineering", "User Input": "Approve" });
    });
    const copilot = terminal(fake, proj, copilotHome);
    copilot.start();
    const seen: string[] = [];
    let thrown: unknown;
    try {
      ledgeredTurn(copilot, proj, "1", (turn) => seen.push(...turn.prompts.map((p) => p.kind)));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PersonTurnError);
    expect((thrown as Error).message).toContain('The Copilot turn "1" recorded 1 decision(s) as the person\'s that no turn from them backs');
    expect((thrown as Error).message).toContain("GATE_APPROVED reverse-engineering");
    // The report still gets the turn that failed.
    expect(seen).toEqual(["aidlc"]);
  });

  test("on Windows the terminal starts the first launcher Windows can run, never npm's shell shim", () => {
    const npm = ["C:\\Users\\a\\AppData\\Roaming\\npm\\copilot", "C:\\Users\\a\\AppData\\Roaming\\npm\\copilot.cmd"];
    expect(windowsLauncher("copilot", () => npm)).toBe(npm[1]);
    expect(windowsLauncher("copilot", () => ["C:\\wf\\copilot.exe", ...npm])).toBe("C:\\wf\\copilot.exe");
    expect(windowsLauncher("C:\\tools\\copilot.cmd", () => npm)).toBe("C:\\tools\\copilot.cmd");
    expect(windowsLauncher("copilot", () => [])).toBe("copilot");
  });
});
