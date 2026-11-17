// covers: subcommand:aidlc-utility:recompose, function:composeGateOpen
//
// The in-flight compose question is the engine's own record, and each answer
// to it carries the work on. `next compose` over running work publishes its
// step as the open question (the step on record, ask type compose), so the
// agent writes no file of its own for it. Approve runs recompose, which closes
// it and ends with the `next` to run (a nightly's Codex legs on Linux and
// Windows had ended the turn on recompose's counts, and the person typed
// again); that next starts the stage the work stands at and never comes back
// to the composer. A settings-only Approve goes through the setter, which keeps
// the question, then `next`; a Reject or a proposal with nothing to change goes
// straight to `next`; an edit (`next compose` again) keeps it open. With no
// question open, or only the file an earlier version had the agent write,
// recompose prints its counts and nothing else. Beneath the question: a
// running swarm's step is never replaced, so no question opens; the code plan
// question is shown again after a Reject, with no approval taken from the
// compose answer; during a build, the build's own write is admitted again once
// `next` names it.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { composeGateOpen } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  next as codeGenerationNext,
  reply,
  runNamed,
  SESSION,
  SHAPES,
  STATES,
  type ToolCall,
} from "../harness/code-generation-states.ts";
import { cleanupTestProject, runOrchestrateNext, seededRecordDir, setupIntegrationProject } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const env: Record<string, string | undefined> = {
  ...process.env,
  AIDLC_SESSION_OVERRIDE: "01995000-7a11-7000-8000-000000000035",
  AIDLC_SESSION_OVERRIDE_SOURCE: "payload",
};
delete env.AIDLC_SCOPE_MAPPING;

const REPO_ROOT = join(import.meta.dir, "..", "..");
const OLD_FILE = ".aidlc-compose-pending";
const tool = (proj: string, name: string): string => join(proj, ".claude", "tools", name);

function run(proj: string, name: string, args: string[]): { status: number; out: string } {
  const res = spawnSync(process.execPath, [tool(proj, name), ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: env as Record<string, string>,
    cwd: proj,
  });
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function recordDirOf(proj: string): string {
  const active = join(proj, "aidlc", "spaces", "default", "intents", "active-intent");
  return existsSync(active) ? join(dirname(active), readFileSync(active, "utf-8").trim()) : seededRecordDir(proj);
}
const readState = (proj: string): string => readFileSync(join(recordDirOf(proj), "aidlc-state.md"), "utf-8");
const stepOnRecord = (proj: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(recordDirOf(proj), ".aidlc-engine", "active-directive.json"), "utf-8"));

const projects: string[] = [];
afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
});

// Feature work with Initialization done and the cursor on Intent Capture, with
// Market Research and Team Formation pending ahead of it: the nightly's shape
// (its fixture, Intent Capture not started) and work just created (Intent
// Capture under way). This chat's hooks are running.
type Shape = "not started" | "under way";
function work(shape: Shape = "under way"): string {
  const proj = shape === "not started"
    ? setupIntegrationProject({ withState: "state-initialization-done.md", stripEnvScope: true })
    : setupIntegrationProject({ noAidlcDocs: true, stripEnvScope: true });
  projects.push(proj);
  if (shape === "under way") {
    const created = run(proj, "aidlc-utility.ts", ["intent-create", "--scope", "feature"]);
    expect(created.status, created.out).toBe(0);
  }
  const health = join(recordDirOf(proj), ".aidlc-engine", "hooks-health");
  mkdirSync(health, { recursive: true });
  writeFileSync(join(health, "pre-tool-use.last"), new Date().toISOString());
  const state = readState(proj);
  expect(state).toContain("- **Current Stage**: intent-capture");
  expect(state).toMatch(shape === "not started" ? /- \[ \] intent-capture \u2014 EXECUTE/ : /- \[-\] intent-capture \u2014 EXECUTE/);
  return proj;
}

const next = (proj: string, args: string[] = []): Record<string, unknown> =>
  (runOrchestrateNext(tool(proj, "aidlc-orchestrate.ts"), proj, args, { env }).directive ?? {}) as Record<string, unknown>;

// The person asks for a reshape: the engine hands out the in-flight composer
// step, and the question it leads to is open with no file of the agent's.
function askCompose(proj: string, words = "drop market research and team formation, we already know the market and the team"): string {
  const compose = next(proj, ["compose", words]);
  expect(compose.kind).toBe("print");
  const print = String(compose.message);
  expect(print).toContain("aidlc-composer-agent");
  expect(print).not.toContain(OLD_FILE);
  expect(print).not.toMatch(/marker/i);
  expect(composeGateOpen(proj)).toBe(true);
  expect(stepOnRecord(proj)).toMatchObject({ kind: "ask", ask_type: "compose", stage: "intent-capture" });
  expect(existsSync(join(proj, "aidlc", OLD_FILE))).toBe(false);
  return print;
}

// The stage the work stands at starts, and the walk never hands the composer
// or the trim back (no self-loop).
function carriesOn(proj: string): void {
  for (let beat = 0; beat < 2; beat++) {
    const step = next(proj);
    expect(step.kind, JSON.stringify(step)).toBe("run-stage");
    expect(step.stage).toBe("intent-capture");
    expect(JSON.stringify(step)).not.toContain("aidlc-composer-agent");
    expect(JSON.stringify(step)).not.toContain("recompose");
    expect(composeGateOpen(proj)).toBe(false);
  }
}

// What recompose has always printed, and nothing after it.
const COUNTS_ONLY = /^Recomposed: 2 skipped \(market-research, team-formation\), 0 added \(none\)\nStages in scope: \d+\nCompleted: \d+\/\d+\n$/;
const NEXT_STEP = /`([^`]*aidlc-orchestrate\.ts next)` and follow what it returns, so the work carries on from where it stands/;

describe("t-compose-approve-carries-on: every answer to the in-flight compose question carries the work on", () => {
  test.each<Shape>(["not started", "under way"])("Approve at the in-flight compose question carries on into the stage the work stands at (%s), never back to the trim", (shape) => {
    const proj = work(shape);
    expect(askCompose(proj)).toMatch(/On approve run `[^`]*recompose /);

    // Approve: the trim lands, closes the question, and its output ends with
    // the step that carries on.
    const approved = run(proj, "aidlc-utility.ts", ["recompose", "--skip", "market-research,team-formation"]);
    expect(approved.status, approved.out).toBe(0);
    const lines = approved.out.trimEnd().split("\n");
    expect(lines[0]).toBe("Recomposed: 2 skipped (market-research, team-formation), 0 added (none)");
    const tail = lines.at(-1) ?? "";
    expect(tail).not.toContain(OLD_FILE);
    expect(/`([^`]*aidlc-orchestrate\.ts next)`/.exec(tail)?.[1], approved.out).toBeDefined();
    expect(composeGateOpen(proj)).toBe(false);

    carriesOn(proj);
    const after = readState(proj);
    expect(after).toMatch(/- \[ \] market-research \u2014 SKIP/);
    expect(after).toMatch(/- \[ \] team-formation \u2014 SKIP/);
    expect(after).toContain("- **Current Stage**: intent-capture");
  });

  test("Reject, and a proposal with nothing to change, run next: the question closes and the work carries on", () => {
    for (const answer of ["reject", "nothing to change"] as const) {
      const proj = work();
      const print = askCompose(proj);
      // Both answers name the same step, said once in the print.
      const named = print.match(new RegExp(NEXT_STEP, "g")) ?? [];
      expect(named.length, print).toBe(2);
      expect(print).toMatch(/first tell the person its answer in your own words \(what stays and why\), then run `[^`]*aidlc-orchestrate\.ts next`/);
      expect(print).toMatch(/On Reject, at any of these gates, apply nothing and tell the person in one line that the plan stays as it is, then run `[^`]*aidlc-orchestrate\.ts next`/);
      carriesOn(proj);
      expect(readState(proj), answer).toMatch(/- \[ \] market-research \u2014 EXECUTE/);
    }
  });

  test("an edit (next compose again) keeps the question open until it is answered", () => {
    const proj = work();
    askCompose(proj);
    askCompose(proj, "keep team formation, only drop market research");
    expect(composeGateOpen(proj)).toBe(true);
    const approved = run(proj, "aidlc-utility.ts", ["recompose", "--skip", "market-research"]);
    expect(approved.status, approved.out).toBe(0);
    expect(composeGateOpen(proj)).toBe(false);
    carriesOn(proj);
  });

  test("a settings-only Approve goes through next, whose setter step names what follows: next after an approval, which closes the question", () => {
    const proj = work();
    const print = askCompose(proj);
    expect(print).toContain("on approve, apply them by running next with the matching flags and follow what it returns; run no recompose");
    // A setting while the question is open: the setter, then the agent reads
    // which question their message answered.
    const setting = next(proj, ["--review", "none"]);
    const step = String(setting.message);
    expect(step).toMatch(/^Run `[^`]*config set review none[^`]*` to update the configuration and print its output verbatim\./);
    expect(step).toMatch(/When their message approved the settings the plan change proposed, then run `[^`]*aidlc-orchestrate\.ts next` and follow what it returns, so the work carries on; when it set something beside the plan change, which still waits for their answer, stop\./);
    const set = run(proj, "aidlc.ts", ["config", "set", "review", "none"]);
    expect(set.status, set.out).toBe(0);
    expect(readState(proj)).toMatch(/Review.*none/i);
    // The setter's write keeps the question; the `next` after it closes it.
    expect(composeGateOpen(proj)).toBe(true);
    carriesOn(proj);
  });

  test("a setting that needs their words names their message while the question is open, so their approval is recorded as theirs", () => {
    const proj = work();
    askCompose(proj);
    const said = spawnSync(process.execPath, [tool(proj, "aidlc.ts"), "engine", "hook", "record-human-turn"], {
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: env.AIDLC_SESSION_OVERRIDE, prompt: "1, approve" }),
      encoding: "utf-8", cwd: proj, env: { ...env, CLAUDE_PROJECT_DIR: proj } as Record<string, string>,
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(said.status, `${said.stdout}${said.stderr}`).toBe(0);
    const step = String(next(proj, ["--sensors", "off"]).message);
    expect(step).toMatch(/config set sensors off --message '<id>'/);
    expect(step).toMatch(/with <id> the id of the person's message that asked for it \([0-9a-z-]+, sent [^)]+\)/);
    expect(step).toContain("When their message approved the settings the plan change proposed, then run");
    expect(composeGateOpen(proj)).toBe(true);
  });

  test("with no compose question open, recompose prints only its counts", () => {
    const proj = work();
    expect(composeGateOpen(proj)).toBe(false);
    const flipped = run(proj, "aidlc-utility.ts", ["recompose", "--skip", "market-research,team-formation"]);
    expect(flipped.status, flipped.out).toBe(0);
    expect(flipped.out).toMatch(COUNTS_ONLY);
  });

  test("the file an earlier version had the agent write opens no question, and is left where it is", () => {
    const proj = work();
    const old = join(proj, "aidlc", OLD_FILE);
    writeFileSync(old, "{}\n", "utf-8");
    expect(composeGateOpen(proj)).toBe(false);
    const flipped = run(proj, "aidlc-utility.ts", ["recompose", "--skip", "market-research,team-formation"]);
    expect(flipped.status, flipped.out).toBe(0);
    expect(flipped.out).toMatch(COUNTS_ONLY);
    expect(existsSync(old)).toBe(true);
  });

  test("a running swarm's step on record is never replaced: the composer still runs, no question opens, recompose prints its counts", () => {
    const proj = work();
    expect(next(proj).kind).toBe("run-stage");
    const path = join(recordDirOf(proj), ".aidlc-engine", "active-directive.json");
    writeFileSync(path, `${JSON.stringify({ ...stepOnRecord(proj), kind: "invoke-swarm", units: ["unit-a", "unit-b"] })}\n`);
    const compose = next(proj, ["compose", "drop market research and team formation"]);
    expect(String(compose.message)).toContain("aidlc-composer-agent");
    expect(stepOnRecord(proj).kind).toBe("invoke-swarm");
    expect(composeGateOpen(proj)).toBe(false);
    const flipped = run(proj, "aidlc-utility.ts", ["recompose", "--skip", "market-research,team-formation"]);
    expect(flipped.status, flipped.out).toBe(0);
    expect(flipped.out).toMatch(COUNTS_ONLY);
  });

  test("no file AI-DLC ships for an agent, and no doc, names the file an earlier version had the agent write", () => {
    const named: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        // Doctor names it as left over; that is its one reader.
        else if (entry.name !== "aidlc-utility.ts" && readFileSync(path).includes(OLD_FILE)) named.push(path);
      }
    };
    for (const root of ["dist", "harness", "docs"]) walk(join(REPO_ROOT, root));
    expect(named).toEqual([]);
  });
});

// The step beneath the question at Code Generation, the real engine, the real
// human-turn hook and the real plan-approval guard.
describe("t-compose-approve-carries-on: the compose question over Code Generation", () => {
  const writes = async (proj: string): Promise<number> =>
    (await SHAPES[0].call(proj, SESSION, { tool: "Write", path: join(proj, "src", "slugify.ts") } as ToolCall)).code;

  test("over the open code plan question: Approve and Reject show that question again, with no approval taken from the compose answer", async () => {
    const { proj } = STATES.find((state) => state.id === "S3")!.build();
    projects.push(proj);
    reply(proj, "what else can we cut?");
    expect(codeGenerationNext(proj, ["compose", "what else can we cut?"]).kind).toBe("print");
    expect(composeGateOpen(proj)).toBe(true);
    reply(proj, "approve");
    expect(runNamed(proj, "bun .claude/tools/aidlc-utility.ts recompose --skip feedback-optimization").status).toBe(0);
    expect(composeGateOpen(proj)).toBe(false);
    const asked = codeGenerationNext(proj);
    expect(asked.kind).toBe("ask");
    expect(asked.ask_type).toBe("plan-approval");
    expect(asked.plan_approval?.status).not.toBe("approved");
    expect(await writes(proj)).toBe(2);
    // Asked once more, it is the same question, not a new one.
    expect(codeGenerationNext(proj).ask_type).toBe("plan-approval");

    const { proj: rejected } = STATES.find((state) => state.id === "S3")!.build();
    projects.push(rejected);
    expect(codeGenerationNext(rejected, ["compose", "what else can we cut?"]).kind).toBe("print");
    reply(rejected, "reject");
    const again = codeGenerationNext(rejected);
    expect(again.ask_type).toBe("plan-approval");
    expect(again.plan_approval?.status).not.toBe("approved");
    expect(composeGateOpen(rejected)).toBe(false);
  });

  test("during an approved build: the build's write is admitted again once next names the build, after Approve and after Reject", async () => {
    for (const answer of ["approve", "reject"] as const) {
      const { proj } = STATES.find((state) => state.id === "S4")!.build();
      projects.push(proj);
      expect(await writes(proj)).toBe(0);
      expect(codeGenerationNext(proj, ["compose", "what else can we cut?"]).kind).toBe("print");
      expect(composeGateOpen(proj)).toBe(true);
      reply(proj, answer);
      if (answer === "approve") {
        expect(runNamed(proj, "bun .claude/tools/aidlc-utility.ts recompose --skip feedback-optimization").status).toBe(0);
      }
      const build = codeGenerationNext(proj);
      expect(build.kind, answer).toBe("run-stage");
      expect(build.plan_approval?.status, answer).toBe("approved");
      expect(composeGateOpen(proj)).toBe(false);
      expect(await writes(proj), answer).toBe(0);
    }
  });
});
