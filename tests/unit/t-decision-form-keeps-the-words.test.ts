// The decision command the engine prints, and the answer form log answer's
// usage prints, filled in the way the agent fills them, keep a choice's words
// through the shell that runs them. On a Windows golden
// journey the double-quoted form carried the choice "$0.00": bash read $0 as
// its own name, Claude Code asked to allow AI-DLC's own command, and the record
// said "/usr/bin/bash.00". The forms are read from the shipped protocol and
// Claude Code skill, so this follows the printed text. Mechanism: bash (Git Bash
// on Windows, the shell Claude Code runs there) runs the shipped aidlc-log.ts.
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { optionsList, readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { cleanupTestProject, createTestProject, seedStateFile } from "../harness/fixtures.ts";
import { gitBashPath, gitBashSkipReason } from "../harness/git-bash.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const SHIPPED = join(import.meta.dir, "..", "..", "dist", "claude", ".claude");
const LOG = join(SHIPPED, "tools", "aidlc-log.ts");
const QUESTION = "Q1: What should formatPrice(0) show?";
const CHOICES = "Show $0.00,Keep it empty";

const FORMS = [
  {
    where: "the protocol's non-gate question",
    file: "aidlc-common/protocols/stage-protocol.md",
    form: /engine log decision --stage <slug> (--decision \S*<summary>\S* --options \S*<A,B,C>\S*)`/,
    fill: (flags: string) => flags.replace("<summary>", QUESTION).replace("<A,B,C>", CHOICES),
  },
  {
    where: "the skill's question shown before it was recorded",
    file: "skills/aidlc/SKILL.md",
    form: /engine log decision --stage <stage> (--decision \S*<the question>\S* --options \S*<the choices>\S*)`/,
    fill: (flags: string) => flags.replace("<the question>", QUESTION).replace("<the choices>", CHOICES),
  },
];

const projects: string[] = [];
afterAll(() => {
  for (const p of projects) cleanupTestProject(p);
});

function recorded(p: string, name: string): string | undefined {
  const row = readAllAuditShards(p).split(/\n---\n/).filter((block) => block.includes("**Event**: DECISION_RECORDED")).at(-1);
  return row?.split("\n").find((line) => line.startsWith(`**${name}**: `))?.slice(`**${name}**: `.length);
}

const skip = gitBashSkipReason();
describe("t-decision-form-keeps-the-words: a choice that names a price is recorded as written", () => {
  for (const { where, file, form, fill } of FORMS) {
    test.skipIf(skip !== null)(`${where}, run through bash`, () => {
      const printed = readFileSync(join(SHIPPED, file), "utf-8").match(form);
      expect(printed, `${file} prints the decision form`).not.toBeNull();
      const p = createTestProject();
      projects.push(p);
      seedStateFile(p, "state-mid-ideation.md");
      const quote = (value: string) => `'${value}'`;
      const command = `${[process.execPath, LOG].map(quote).join(" ")} decision --stage feasibility ` +
        `${fill(printed![1])} --project-dir ${quote(p)}`;
      const r = spawnSync(process.platform === "win32" ? gitBashPath() : "bash", ["-c", command], {
        cwd: p, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
      expect(recorded(p, "Decision")).toBe(QUESTION);
      expect(recorded(p, "Options")).toContain("Show $0.00");
    });
  }

  // A question whose choice holds a comma, recorded in the form the protocol
  // shows for it, then its choices read back as a resumed question reads them.
  // PowerShell (where it is installed) reads the same command line as well as
  // bash: the agent's shell on Windows may be either.
  const commaForm = (): string => {
    const printed = readFileSync(join(SHIPPED, "aidlc-common/protocols/stage-protocol.md"), "utf-8")
      .match(/When a choice holds a comma, [^(]*\(`([^`]+)`\)/);
    expect(printed, "the protocol shows the form for a choice that holds a comma").not.toBeNull();
    const form = printed![1].startsWith("--") ? printed![1] : `--options ${printed![1]}`;
    return form.replace("<A>", "Show $0.00, with tax").replace("<B>", "Hide it").replace("<C>", "Other");
  };
  const powerShell = ["pwsh", "powershell"].find((name) => spawnSync(name, ["-NoProfile", "-Command", "exit 0"]).status === 0);
  for (const shell of ["bash", "PowerShell"] as const) {
    const skipShell = shell === "bash" ? skip : powerShell === undefined ? "no PowerShell here" : null;
    test.skipIf(skipShell !== null)(`a choice that holds a comma and a price, run through ${shell}`, () => {
      const p = createTestProject();
      projects.push(p);
      seedStateFile(p, "state-mid-ideation.md");
      const quote = (value: string) => `'${value}'`;
      const args = `decision --stage feasibility --decision ${quote(QUESTION)} ${commaForm()} --project-dir ${quote(p)}`;
      const r = shell === "bash"
        ? spawnSync(process.platform === "win32" ? gitBashPath() : "bash", [
          "-c", `${[process.execPath, LOG].map(quote).join(" ")} ${args}`,
        ], { cwd: p, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) })
        : spawnSync(powerShell!, ["-NoProfile", "-Command", `& ${[process.execPath, LOG].map(quote).join(" ")} ${args}`], {
          cwd: p, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
        });
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
      expect(optionsList(recorded(p, "Options"))).toEqual(["Show $0.00, with tax", "Hide it", "Other"]);
    });
  }

  // A question and choices holding a $ and a backtick go in files the agent
  // writes, so no shell reads them and VS Code has nothing on the line to ask
  // about: the form the protocol shows, read back with each choice whole.
  test.skipIf(skip !== null)("a question and choices that hold a price and a backtick, from the files the protocol names", () => {
    const p = createTestProject();
    projects.push(p);
    seedStateFile(p, "state-mid-ideation.md");
    const printed = readFileSync(join(SHIPPED, "aidlc-common/protocols/stage-protocol.md"), "utf-8")
      .match(/write the question to `<record>\/([^`]+)` and the choices one a line to `<record>\/([^`]+)`[^`]*`(--decision-file [^`]+ --options-file [^`]+)`/);
    expect(printed, "the protocol names the two files").not.toBeNull();
    const record = join(p, "aidlc", "spaces", "default", "intents");
    const dir = readdirSync(record, { withFileTypes: true }).find((entry) => entry.isDirectory())!.name;
    const write = (rel: string, text: string) => {
      const file = join(record, dir, ...rel.split("/"));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text, "utf-8");
      return file;
    };
    const question = write(printed![1], "Q1: Should formatPrice(0) show $0.00 or `\"\"`?");
    const options = write(printed![2], "Show $0.00, with tax\nShow `\"\"` (empty)\nOther\n");
    const quote = (value: string) => `'${value}'`;
    const r = spawnSync(process.platform === "win32" ? gitBashPath() : "bash", [
      "-c", `${[process.execPath, LOG].map(quote).join(" ")} decision --stage feasibility ${printed![3]} --project-dir ${quote(p)}`,
    ], { cwd: p, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(recorded(p, "Decision")).toBe("Q1: Should formatPrice(0) show $0.00 or `\"\"`?");
    expect(optionsList(recorded(p, "Options"))).toEqual(["Show $0.00, with tax", "Show `\"\"` (empty)", "Other"]);
    expect(existsSync(question) || existsSync(options)).toBe(false);
  });

  // The answer form log answer's usage prints, which the agent copies with the person's pick.
  test.skipIf(skip !== null)("the answer form log answer's usage shows, run through bash", () => {
    const printed = readFileSync(LOG, "utf-8").match(/answer"\)\} --stage <slug> (--details \S*<their exact choice>\S*)`/);
    expect(printed, "aidlc-log.ts prints the answer form").not.toBeNull();
    const p = createTestProject();
    projects.push(p);
    seedStateFile(p, "state-mid-ideation.md");
    const quote = (value: string) => `'${value}'`;
    const run = (args: string) => spawnSync(process.platform === "win32" ? gitBashPath() : "bash", [
      "-c", `${[process.execPath, LOG].map(quote).join(" ")} ${args} --project-dir ${quote(p)}`,
    ], { cwd: p, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
    const asked = run(`decision --stage feasibility --decision ${quote(QUESTION)} --options ${quote(CHOICES)}`);
    expect(asked.status, `${asked.stdout}${asked.stderr}`).toBe(0);
    // The person replies, as the human-turn hook keeps it.
    const turn = spawnSync(process.execPath, [join(SHIPPED, "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"], {
      cwd: p, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "01995000-7a11-7000-8000-000000000001", prompt: "the first one" }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: p, AIDLC_PROJECT_DIR: p },
    });
    expect(turn.status, turn.stderr).toBe(0);
    const answered = run(`answer --stage feasibility ${printed![1].replace("<their exact choice>", "Q1: Show $0.00")}`);
    expect(answered.status, `${answered.stdout}${answered.stderr}`).toBe(0);
    const row = readAllAuditShards(p).split(/\n---\n/).filter((block) => block.includes("**Event**: QUESTION_ANSWERED")).at(-1);
    expect(row).toContain("Q1: Show $0.00");
  });
});
