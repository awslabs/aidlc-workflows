// covers: file:tests/harness/work-open.ts
//
// The update check leaves the person's work open at a gate on the previous
// release and carries it on after `aidlc update` (scripts/ci-update-from-previous.ts).
// These cases pin the parts that run without a release: the stand-in on a
// project a release set up runs the person's `aidlc` and the commands the
// installed engine names, parks the way the project's own skill says, and
// what the person lost is read from the facts of the run and their files.
//
// Mechanism: function - a recording host and git repositories in a scratch folder, no engine.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStandIn, PersonScript, type RunResult, ScopeHost } from "../harness/scope-run.ts";
import {
  GATE,
  installedAidlc,
  launcherFor,
  NEXT_STAGE,
  outsideMarkedParts,
  personChanges,
  type ResumeFacts,
  resumeProblems,
  untrackedRoots,
} from "../harness/work-open.ts";

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "t-work-open-"));
  scratch.push(dir);
  return dir;
}

/** A host that records each command line the agent runs and answers from a script. */
class Recorder extends ScopeHost {
  readonly lines: string[] = [];
  reply: (line: string) => string = () => "{}";
  override bash(line: string): RunResult {
    this.argv(line);
    this.lines.push(line);
    return { status: 0, stdout: this.reply(line), stderr: "" };
  }
  override hook(): RunResult {
    return { status: 0, stdout: "", stderr: "" };
  }
  override write(): void {}
}

const CODE_GENERATION = {
  kind: "run-stage",
  stage: "code-generation",
  unit: "core",
  produces: ["r/construction/core/code-generation/code-generation-plan.md", "r/construction/core/code-generation/unit-test-instructions.md"],
};

describe("the stand-in on a project a release set up", () => {
  test("runs the person's aidlc there, and bun on a tree from this repository", () => {
    const host = new ScopeHost(folder());
    expect(host.argv("bun .claude/tools/aidlc.ts engine orchestrate next")).toEqual([process.execPath, ".claude/tools/aidlc.ts", "engine", "orchestrate", "next"]);
    expect(() => host.argv("aidlc engine orchestrate next")).toThrow("runs only bun commands");
    host.launcher = ["/machine/bin/aidlc"];
    expect(host.argv('aidlc engine orchestrate report --stage x --user-input "Approve"'))
      .toEqual(["/machine/bin/aidlc", "engine", "orchestrate", "report", "--stage", "x", "--user-input", "Approve"]);
    expect(() => host.argv("bun .claude/tools/aidlc.ts engine orchestrate next")).toThrow("runs only aidlc commands");
  });

  test("acts on the `aidlc engine intent create` the installed engine names, and runs its own calls through the dispatcher", () => {
    const host = new Recorder(folder());
    host.launcher = ["/machine/bin/aidlc"];
    const agent = new AgentStandIn(host, new PersonScript(host));
    agent.createFromPrint({ kind: "print", message: 'Run `aidlc engine intent create --scope bugfix --request ab12 --label "<2-3 word kebab essence>"` to start the workflow' });
    agent.writeCodePlan(CODE_GENERATION);
    agent.handoffPrompt(CODE_GENERATION);
    expect(host.lines).toEqual([
      'aidlc engine intent create --scope bugfix --request ab12 --label "scope run"',
      "aidlc engine orchestrate next",
      "aidlc engine testing-posture render",
      "aidlc engine testing-posture brief --unit core",
    ]);
  });

  test("keeps a tree's own commands on a tree from this repository", () => {
    const host = new Recorder(folder());
    const agent = new AgentStandIn(host, new PersonScript(host));
    agent.createFromPrint({ kind: "print", message: 'Run `bun .claude/tools/aidlc.ts engine intent create --scope bugfix --request ab12 --label "<2-3 word kebab essence>"` to start' });
    agent.writeCodePlan(CODE_GENERATION);
    agent.handoffPrompt(CODE_GENERATION);
    expect(host.lines).toEqual([
      'bun .claude/tools/aidlc.ts engine intent create --scope bugfix --request ab12 --label "scope run"',
      "bun .claude/tools/aidlc.ts engine orchestrate next",
      "bun .claude/tools/aidlc-testing-posture.ts render",
      "bun .claude/tools/aidlc-testing-posture.ts brief --unit core",
    ]);
  });

  for (const [skill, park] of [
    ["run `aidlc engine orchestrate park --person-asked` to park", "aidlc engine orchestrate park --person-asked"],
    ["run `aidlc engine orchestrate park` to park", "aidlc engine orchestrate park"],
  ] as const) {
    test(`parks as the project's skill says (${park.slice("aidlc engine orchestrate ".length)}), waits, and resumes in a new chat`, () => {
      const proj = folder();
      mkdirSync(join(proj, ".claude", "skills", "aidlc"), { recursive: true });
      writeFileSync(join(proj, ".claude", "skills", "aidlc", "SKILL.md"), `To stop, ${skill}.\n`);
      const host = new Recorder(proj);
      host.launcher = ["/machine/bin/aidlc"];
      host.reply = (line) => (/\bpark\b/.test(line) ? '{"kind":"parked"}' : '{"kind":"done"}');
      const person = new PersonScript(host);
      const agent = new AgentStandIn(host, person, { pauseAtStop: true });
      host.sessionStart("startup");
      agent.stopForTheDay();
      expect(host.lines).toEqual([park]);
      const chat = host.session;
      expect(agent.resume()).toEqual({ kind: "done" });
      expect(host.session).not.toBe(chat);
      expect(person.said).toEqual(["let's stop here for today", "/aidlc --resume"]);
      expect(host.lines.at(-1)).toBe("aidlc engine orchestrate next --resume");
    });
  }

  test("the person's aidlc is the launcher, or on Windows the active aidlc.exe", () => {
    const machine = folder();
    writeFileSync(join(machine, "active-executable"), `${join(machine, "versions", "2.11.0", "aidlc.exe")}\r\n`);
    expect(installedAidlc(machine, false)).toEqual([join(machine, "bin", "aidlc")]);
    expect(installedAidlc(machine, true)).toEqual([join(machine, "versions", "2.11.0", "aidlc.exe")]);
  });

  test("a copied project has no aidlc: its agent runs the project's own `bun <dir>/tools/...`", () => {
    const machine = folder();
    writeFileSync(join(machine, "active-executable"), `${join(machine, "versions", "2.11.0", "aidlc.exe")}\n`);
    expect(launcherFor("copy")).toBeNull();
    expect(launcherFor(machine)).toEqual(installedAidlc(machine));
  });
});

describe("what the person lost when they carried their work on after the update", () => {
  const clean: ResumeFacts = {
    after: { kind: "run-stage", stage: NEXT_STAGE },
    askedSince: [`approval ${GATE}`],
    workedSince: [],
    approvals: ["Approve"],
    said: ["/aidlc --resume", "Approve"],
    unbacked: [],
    refusals: [],
    hookFailures: [],
    blockedHandoffs: [],
    changed: [],
  };

  test("nothing, when the gate came back, they approved and the next stage started", () => {
    expect(resumeProblems(clean)).toEqual([]);
  });

  test("the stage run again, an answer asked again, or the gate never shown", () => {
    expect(resumeProblems({ ...clean, workedSince: [GATE], askedSince: [`question mode ${GATE}`, `question ${GATE}`, `approval ${GATE}`] })).toEqual([
      `after the update the agent ran ${GATE} again instead of showing the open ${GATE} gate`,
      `after the update the person was asked again: question mode ${GATE}; question ${GATE}`,
    ]);
    expect(resumeProblems({ ...clean, askedSince: [] })).toEqual([`after the update the person was never shown the open ${GATE} gate`]);
  });

  test("an approval that is not the person's one, or no next stage", () => {
    expect(resumeProblems({ ...clean, approvals: [] })).toEqual([`the record holds 0 approvals of ${GATE}, not the person's one`]);
    expect(resumeProblems({ ...clean, approvals: ["Approve", "Approve"] })).toEqual([`the record holds 2 approvals of ${GATE}, not the person's one`]);
    expect(resumeProblems({ ...clean, approvals: ["Approve all"] })).toEqual([`the approval of ${GATE} records "Approve all", which the person never sent`]);
    expect(resumeProblems({ ...clean, after: { kind: "run-stage", stage: GATE } })[0]).toStartWith(`after the approval the next step is {"kind":"run-stage","stage":"${GATE}"}`);
  });

  test("a refusal, a failed hook, a turn that could not end, or a file of theirs", () => {
    expect(resumeProblems({ ...clean, refusals: ["Bash x: no"], hookFailures: ["Stop: y"], blockedHandoffs: ["approval z: carry on"], changed: ["AGENTS.md changed outside AI-DLC's marked part"] })).toEqual([
      "a guard refused a step the engine directed: Bash x: no",
      "a hook failed: Stop: y",
      "the turn could not end when the person was asked: approval z: carry on",
      "a file of the person's changed: AGENTS.md changed outside AI-DLC's marked part",
    ]);
  });
});

describe("the person's files", () => {
  test("a file's text outside AI-DLC's marked parts, in either marker form", () => {
    expect(outsideMarkedParts("node_modules/\n\n# BEGIN AI-DLC:gitignore\naidlc/active-space\n# END AI-DLC:gitignore\ndist/\n"))
      .toEqual(["node_modules/", "dist/"]);
    expect(outsideMarkedParts("# Todo app\r\n<!-- BEGIN AI-DLC:agents -->\r\nAI-DLC part\r\n<!-- END AI-DLC:agents -->\r\nRun the tests.\r\n"))
      .toEqual(["# Todo app", "Run the tests."]);
  });

  test("only a change outside AI-DLC's part, or a new path outside its folders, is the person's", () => {
    const proj = folder();
    const git = (...args: string[]) => spawnSync("git", args, {
      cwd: proj,
      encoding: "utf-8",
      env: { ...process.env, GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@example.invalid", GIT_COMMITTER_NAME: "A", GIT_COMMITTER_EMAIL: "a@example.invalid" },
    });
    git("init", "-q", "-b", "main");
    mkdirSync(join(proj, "src"));
    writeFileSync(join(proj, "src", "app.ts"), "export const app = 1;\n");
    writeFileSync(join(proj, ".gitignore"), "node_modules/\n");
    writeFileSync(join(proj, "AGENTS.md"), "# Todo app\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    writeFileSync(join(proj, ".gitignore"), "node_modules/\n\n# BEGIN AI-DLC:gitignore\naidlc/active-space\n# END AI-DLC:gitignore\n");
    mkdirSync(join(proj, ".claude"));
    writeFileSync(join(proj, ".claude", "settings.json"), "{}\n");
    const setup = untrackedRoots(proj);
    expect(setup).toEqual([".claude"]);
    mkdirSync(join(proj, "aidlc"));
    writeFileSync(join(proj, "aidlc", "state.md"), "x\n");
    expect(personChanges(proj, setup)).toEqual([]);
    writeFileSync(join(proj, "AGENTS.md"), "# Todo app, rewritten\n");
    writeFileSync(join(proj, "notes.txt"), "x\n");
    rmSync(join(proj, "src", "app.ts"));
    expect(personChanges(proj, setup)).toEqual(["AGENTS.md changed outside AI-DLC's marked part", "src/app.ts is gone", "notes.txt appeared"]);
  });
});
