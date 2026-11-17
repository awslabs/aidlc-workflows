// covers: function:newerWorkOffer, function:takeUpdateAnswer, function:updateAnswerStep, function:newerStateStep, function:newerStateRelease, function:newerWorkInstall, function:refuseNewerWork
//
// Work a newer AI-DLC wrote (a State Version above the one this build reads):
// on a native install the person meets one question, never a dead end. Yes
// hands the agent the update, the project's refresh and the command that
// carries on with what the person typed, kept under the question's id; Not now
// says one line. Nothing is written under a record this build cannot read. A
// copy, a pinned project and a package manager's install hear their own step.
// The claim and release commands never act on such work.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  cleanupTestProject,
  createOrchestrationTestProject,
  REPO_ROOT,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);

const NATIVE = join(REPO_ROOT, "dist-release", "claude", ".claude", "tools");
const COPY = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
const OFFER = "This plan was set up with AI-DLC 2.12 or newer, and this computer has ";
const NOT_NOW = "Leaving it as it is. Ask me to update AI-DLC whenever you're ready, and I'll carry on.";
const VERSION = (readFileSync(join(REPO_ROOT, "core", "tools", "aidlc-version.ts"), "utf-8")
  .match(/AIDLC_VERSION = "([^"]+)"/) ?? [])[1];

const projects: string[] = [];
afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

function stateWithVersion(version: string): string {
  return `# AI-DLC State Tracking

## Project Information
- **Project**: newer work
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: ${version}
- **Skeleton Stance**: on

## Runtime State
- **Revision Count**: 0

## Stage Progress

### INCEPTION PHASE
- [-] domain-design \u2014 EXECUTE

## Current Status
- **Lifecycle Phase**: INCEPTION
- **Current Stage**: domain-design
- **Status**: Running
`;
}

function project(version = "9"): string {
  const proj = createOrchestrationTestProject();
  projects.push(proj);
  writeFileSync(seededStateFile(proj), stateWithVersion(version), "utf-8");
  return proj;
}

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ["AIDLC_UNATTENDED", "AWS_AIDLC_DEFAULT_SCOPE", "AIDLC_COMPILED_EXECUTABLE", "CLAUDE_PROJECT_DIR"]) delete env[key];
  return { ...env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1", ...extra };
}

type Step = Record<string, unknown> & {
  kind?: string;
  message?: string;
  question?: string;
  narration?: string;
  choices?: Array<{ label: string; detail?: string; command?: string }>;
};

// One engine command, with --project-dir in front of any words after `--`.
function run(tools: string, proj: string, args: string[], env = childEnv()): { status: number; step: Step; out: string } {
  const at = args.indexOf("--");
  const full = at < 0 ? [...args, "--project-dir", proj] : [...args.slice(0, at), "--project-dir", proj, ...args.slice(at)];
  const sub = full[0] === "report" || full[0] === "next" ? "aidlc-orchestrate.ts" : full.shift()!;
  const r = spawnSync(process.execPath, [join(tools, sub), ...full], {
    cwd: proj,
    encoding: "utf-8",
    env,
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  let step: Step = {};
  try {
    step = JSON.parse((r.stdout ?? "").trim());
  } catch {
    step = {};
  }
  return { status: r.status ?? -1, step, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// The command a choice runs, as `next` arguments.
function answerArgs(command: string | undefined): string[] {
  const tail = (command ?? "").split(" orchestrate next ")[1];
  if (!tail) throw new Error(`not a next command: ${command}`);
  return tail.split(" ");
}

// Every file git would keep under the work's record: the state, its audit and
// its artifacts, never the engine's own runtime folder.
function recordFiles(proj: string): Record<string, string> {
  const root = seededRecordDir(proj);
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name === ".aidlc-engine") continue;
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(root, path)] = readFileSync(path, "utf-8");
    }
  };
  walk(root);
  return out;
}

describe("work a newer AI-DLC wrote: the update offer on a native install", () => {
  test("a request on it is one question, with Arden's sentence, update-and-carry-on and Not now", () => {
    const proj = project();
    const { step } = run(NATIVE, proj, ["next", "--", "add a login page"]);
    expect(step.kind, JSON.stringify(step)).toBe("ask");
    expect(step.ask_type).toBe("ai-dlc-update");
    expect(step.response_route).toBe("command");
    expect(step.question).toBe(`${OFFER}${VERSION}. Want me to update AI-DLC now and carry on?`);
    expect(step.question_id).toBeUndefined();
    const [yes, notNow] = step.choices ?? [];
    expect(yes?.label).toBe("Update and carry on");
    expect(notNow?.label).toBe("Not now");
    const id = /--request ([0-9a-f]{8})$/.exec(yes?.command ?? "")?.[1];
    expect(id, yes?.command).toBeDefined();
    expect(yes?.command).toBe(`aidlc engine orchestrate next --update-ai-dlc now --request ${id}`);
    expect(notNow?.command).toBe(`aidlc engine orchestrate next --update-ai-dlc later --request ${id}`);
    expect(JSON.stringify(step)).not.toMatch(/Incompatible workflow state|Upgrade the framework|state schema|stage graph/);
  });

  test("yes hands out the update, the project's refresh and the carry-on, in that order", () => {
    const proj = project();
    const asked = run(NATIVE, proj, ["next", "--", "add a login page"]).step;
    const yes = answerArgs(asked.choices?.[0]?.command);
    const id = yes.at(-1);
    const { step } = run(NATIVE, proj, ["next", ...yes]);
    expect(step.kind).toBe("print");
    const message = step.message ?? "";
    const update = message.indexOf("`aidlc update`");
    const refresh = message.indexOf("`aidlc config --harness claude --yes`");
    const carry = message.indexOf(`\`aidlc engine orchestrate next --update-ai-dlc done --request ${id}\``);
    expect(update, message).toBeGreaterThan(-1);
    expect(refresh).toBeGreaterThan(update);
    expect(carry).toBeGreaterThan(refresh);
  });

  test("Not now says its one line and stops", () => {
    const proj = project();
    const asked = run(NATIVE, proj, ["next", "--", "add a login page"]).step;
    const { step } = run(NATIVE, proj, ["next", ...answerArgs(asked.choices?.[1]?.command)]);
    expect(step.kind).toBe("print");
    expect(step.message).toBe(`Tell the person in one line: ${JSON.stringify(NOT_NOW)} Then stop.`);
  });

  test("the offer, Not now, yes and a carry-on this build still cannot read leave the record as it was", () => {
    const proj = project();
    const before = recordFiles(proj);
    const asked = run(NATIVE, proj, ["next", "--", "add a login page"]).step;
    const yes = answerArgs(asked.choices?.[0]?.command);
    run(NATIVE, proj, ["next", ...answerArgs(asked.choices?.[1]?.command)]);
    run(NATIVE, proj, ["next", ...yes]);
    run(NATIVE, proj, ["next", "--update-ai-dlc", "done", ...yes.slice(2)]);
    expect(recordFiles(proj)).toEqual(before);
  });

  test("after an update that left this build in place, the carry-on says so once and never asks again", () => {
    const proj = project();
    const asked = run(NATIVE, proj, ["next", "--", "add a login page"]).step;
    const yes = answerArgs(asked.choices?.[0]?.command);
    const { step } = run(NATIVE, proj, ["next", "--update-ai-dlc", "done", ...yes.slice(2)]);
    expect(step.kind).toBe("print");
    expect(step.message).toBe(
      `Tell the person in one line: ${JSON.stringify(
        `AI-DLC is still ${VERSION} on this computer, so this plan, set up with AI-DLC 2.12 or newer, cannot carry ` +
          "on here until `aidlc update` brings that release to this computer.",
      )} Then stop.`,
    );
    expect(JSON.stringify(step)).not.toContain("Carrying on with your earlier request");
    expect(JSON.stringify(step)).not.toContain("add a login page");
  });

  test("once the record reads here, the carry-on runs what the person typed, once, in the chat that typed it", () => {
    const proj = project();
    // One Claude Code chat asks and carries on: the host names it in the agent's shell.
    const chat = childEnv({ CLAUDE_CODE_SESSION_ID: randomUUID(), CLAUDE_PID: String(process.pid) });
    const asked = run(NATIVE, proj, ["next", "--", "add a login page"], chat).step;
    const yes = answerArgs(asked.choices?.[0]?.command);
    // The update stands in: the release now running reads this record.
    writeFileSync(seededStateFile(proj), stateWithVersion("8"), "utf-8");
    const carried = run(NATIVE, proj, ["next", "--update-ai-dlc", "done", ...yes.slice(2)], chat).step;
    expect(carried.narration).toBe("Carrying on with your earlier request.");
    // The step is the one the words get when typed on work this build reads.
    const typed = run(NATIVE, project("8"), ["next", "--", "add a login page"]).step;
    const ids = (step: Step) => JSON.stringify({ ...step, narration: undefined }).replace(/--request [0-9a-f]{8}/g, "--request <id>");
    expect(ids(carried)).toBe(ids(typed));
    const again = run(NATIVE, proj, ["next", "--update-ai-dlc", "done", ...yes.slice(2)], chat).step;
    expect(again.message ?? "").toContain("already used once");
  });

  test("a report on it, a claim and a release are the same offer, never the claim", () => {
    for (const args of [
      ["report", "--stage", "domain-design", "--result", "approved"],
      ["next", "--claim", "u1"],
      ["next", "--release", "u1"],
    ]) {
      const { step } = run(NATIVE, project(), args);
      expect(step.ask_type, `${args.join(" ")}: ${JSON.stringify(step)}`).toBe("ai-dlc-update");
      expect(JSON.stringify(step)).not.toContain("--claim u1`");
    }
  });

  test("a request for new work names the work selected here", () => {
    const { step } = run(NATIVE, project(), ["next", "--new-intent", "--", "a separate thing"]);
    expect(step.ask_type, JSON.stringify(step)).toBe("ai-dlc-update");
    expect(step.question).toStartWith("The work selected here was set up with AI-DLC 2.12 or newer, and this computer has ");
  });

  test("a State Version no release on this build's list writes says a newer AI-DLC", () => {
    const { step } = run(NATIVE, project("10"), ["next"]);
    expect(step.question).toStartWith("This plan was set up with a newer AI-DLC, and this computer has ");
  });

  test("an answer the question did not supply runs nothing", () => {
    const { step } = run(NATIVE, project(), ["next", "--update-ai-dlc", "maybe"]);
    expect(step.kind).toBe("error");
    expect(step.message).toContain("--update-ai-dlc answers the AI-DLC update question");
  });
});

describe("work a newer AI-DLC wrote: installs AI-DLC does not update itself", () => {
  test("an unattended run hears the step, never a question nobody is there to answer, and keeps nothing", () => {
    const proj = project();
    const { step } = run(NATIVE, proj, ["next", "--", "add a login page"], childEnv({ AIDLC_UNATTENDED: "1" }));
    expect(step.kind, JSON.stringify(step)).toBe("print");
    expect(step.message).toContain(`${OFFER}${VERSION}. To carry on: \`aidlc update\``);
    expect(existsSync(join(proj, "aidlc", ".aidlc-sessions", "restarts"))).toBe(false);
  });

  test("a copy installed by hand hears its own setup command from the newer release, never the question", () => {
    const { step } = run(COPY, project(), ["next", "--", "add a login page"]);
    expect(step.kind, JSON.stringify(step)).toBe("print");
    const message = step.message ?? "";
    expect(message).toContain("This plan was set up with AI-DLC 2.12 or newer, and this project has AI-DLC");
    expect(message).toContain("copied in by hand");
    expect(message).toContain("`bun .claude/tools/aidlc.ts config --harness claude --from <that file>`");
    expect(message).toEndWith(" Then stop.");
  });

  test("a pinned project hears that the pin is the team's, never the question", () => {
    const proj = project();
    writeFileSync(join(proj, ".aidlc-version"), `${VERSION}\n`);
    const { step } = run(NATIVE, proj, ["next"]);
    expect(step.kind, JSON.stringify(step)).toBe("print");
    expect(step.message).toContain(`this project is pinned to AI-DLC ${VERSION} in .aidlc-version`);
    expect(step.message).toContain("the pin changes for everyone on the project");
  });

  // Homebrew and Nix own an install only on macOS and Linux, where their paths are absolute as written.
  test.skipIf(process.platform === "win32")("a package manager's install hears the manager's own upgrade", () => {
    const { step } = run(NATIVE, project(), ["next"], childEnv({ AIDLC_COMPILED_EXECUTABLE: "/opt/homebrew/bin/aidlc" }));
    expect(step.kind, JSON.stringify(step)).toBe("print");
    expect(step.message).toContain("from Homebrew. To carry on: brew upgrade aidlc, then `aidlc config --harness claude --yes`");
  });
});

describe("work a newer AI-DLC wrote: the unit commands", () => {
  for (const verb of ["claim", "release"]) {
    test(`unit ${verb} fails with the step and writes nothing`, () => {
      const proj = project();
      const before = recordFiles(proj);
      const r = run(NATIVE, proj, ["aidlc-unit.ts", verb, "u1"]);
      expect(r.status).not.toBe(0);
      expect(r.out).toContain("This plan was set up with AI-DLC 2.12 or newer, and this computer has ");
      expect(r.out).toContain("`aidlc update`");
      expect(recordFiles(proj)).toEqual(before);
      expect(existsSync(join(proj, ".git", "refs", "aidlc"))).toBe(false);
    });
  }
});
