// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-utility:detect
// covers: function:classifyTerminalCommand, function:composerProposalPath, subcommand:aidlc-graph:validate-grid
//
// t198 - the P0 compose surfaces (adaptive workflows):
//   - `compose` as a LEADING verb reaches the composer-dispatch branch (Branch
//     4c) in BOTH worlds: cold start (front) and with-state (in-flight). A
//     mid-flow bare `compose` must NOT fall through to Branch 10 and advance
//     the current stage.
//   - `--new-scope` and `--report <path>` are parsed flags: --report CONSUMES
//     its value (an unrecognized valued flag would leak the path into
//     flags.intent - the spike-F trap), and both force the composer dispatch.
//   - compose is NOT in WORKSPACE_VERBS / classifyTerminalCommand: on Kiro the
//     verb-intercept hook classifies every leading terminal verb and runs it
//     off-band as an aidlc-utility subcommand + arms the roll-forward latch. A
//     compose entry there would spawn a nonexistent subcommand and neuter the
//     same-turn creation `next` - so classifyTerminalCommand(["compose", ...])
//     must stay null (the Kiro-adapter regression pin).
//   - Branch 8 (cold-start freeform, no --scope) now routes by keyword
//     inference instead of the static static-default confirm: a clear keyword
//     hit (<=5 words) asks a one-line confirm NAMING THE MATCHED SCOPE; rich /
//     unmatched prose asks the COMPOSE OFFER (never a silent default).
//   - `detect --json` is a pure read: prints the workspace scan + the resolved
//     scopesDir/scopeGridPath (so the composer is TOLD where to write) and
//     leaves the project dir untouched.
//   - the composer's grid proposal file is `proposalPath` from detect: inside
//     the project and ignored by every shipped gitignore (Kiro IDE on Windows
//     could not write the OS temp dir the composer used), and `validate-grid`
//     with no --proposal reads it.
//
// Mechanism: CLI spawn of the shipped dist engine (same convention as t114/
// t179); no LLM, no network - unit tier.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  intentsDirOf,
  removeWorkspaceRecord,
  resetAidlcEnv,
  runOrchestrateNext,
  REPO_ROOT,
  seedAidlcMemory,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";
import { classifyTerminalCommand } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");

const MID_IDEATION = join(FIXTURES_DIR, "state-mid-ideation.md");

interface RunResult {
  rc: number;
  out: string;
}

function runNext(proj: string, args: string[]): RunResult {
  const res = runOrchestrateNext(ORCH, proj, args, {
    cwd: proj,
    env: process.env,
  });
  return { rc: res.status, out: res.out };
}

function runUtility(proj: string, args: string[]): RunResult {
  const res = spawnSync(BUN, [UTIL, ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    cwd: proj,
  });
  return { rc: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function directiveOf(out: string): Record<string, unknown> {
  const line = out.split("\n").find((l) => l.trim().startsWith("{"));
  expect(line).toBeDefined();
  return JSON.parse(line as string) as Record<string, unknown>;
}

let proj = "";
beforeAll(() => {
  resetAidlcEnv();
});
afterEach(() => {
  resetAidlcEnv();
  cleanupTestProject(proj);
  proj = "";
});

// ===========================================================================
// The Kiro verb-intercept regression pin (review trap 1). compose must never
// classify as a terminal command - a WORKSPACE_VERBS entry would make the Kiro
// hook run `aidlc-utility.ts compose` off-band and arm the roll-forward latch.
// ===========================================================================
describe("t198 compose is NOT a terminal command (Kiro seam regression)", () => {
  test("classifyTerminalCommand null for compose in every arg shape", () => {
    expect(classifyTerminalCommand(["compose"])).toBeNull();
    expect(classifyTerminalCommand(["compose", "fix", "the", "bug"])).toBeNull();
    expect(classifyTerminalCommand(["compose", "--report", "sonar.json"])).toBeNull();
    expect(classifyTerminalCommand(["--new-scope"])).toBeNull();
    expect(classifyTerminalCommand(["--report", "sonar.json"])).toBeNull();
  });

  test("workspace verbs still classify (the set itself is untouched)", () => {
    expect(classifyTerminalCommand(["space", "teamB"])).toEqual({
      subcommand: "space",
      arg: "teamB",
      source: "workspace-verb",
    });
  });
});

// ===========================================================================
// Cold start (front): compose / --new-scope / --report each reach the
// composer-dispatch print - never the freeform confirm, never a creation.
// ===========================================================================
describe("t198 cold-start compose surfaces -> composer dispatch", () => {
  test("leading compose verb + freeform text -> print naming the composer agent", () => {
    proj = createTestProject();
    const task = "fix the token bug";
    const d = directiveOf(runNext(proj, ["compose", task]).out);
    expect(d.kind).toBe("print");
    expect(String(d.message)).toContain("aidlc-composer-agent");
    // Front mode, not in-flight: no state file exists.
    expect(String(d.message)).not.toContain("RUNNING workflow");
    // Creation carries an approved relaxed plan on an off base; only a lowering reroutes a matched plan.
    expect(String(d.message)).toContain("pass `--guard-policy <value>` for `strict` or `relaxed`, never for `off`");
    expect(String(d.message)).toContain("flips a matched plan's value below its stock default");
    expect(String(d.message)).toContain("a flip above the default keeps the plan matched");
  });

  test("--report <path> consumes its value (no leak into the intent text)", () => {
    proj = createTestProject();
    const d = directiveOf(runNext(proj, ["compose", "--report", "sonar.json"]).out);
    expect(d.kind).toBe("print");
    expect(String(d.message)).toContain('scan report at "sonar.json"');
    // The spike-F leak shape was intent text "compose sonar.json" - the path
    // must ride the report slot, not the task-text slot.
    expect(String(d.message)).not.toContain('for: "sonar.json"');
    expect(String(d.message)).toContain("nonblank `creationDescription`");
    expect(String(d.message)).toContain("derive it from the report's actual findings");
    expect(String(d.message)).toContain("Never approve a proposal that would continue into a scope-only creation");
  });



  test("flag-like compose task survives approval and creation via its question id", () => {
    proj = createTestProject();
    removeWorkspaceRecord(proj);
    const task = "--enable SSO for admins";
    const compose = directiveOf(runNext(proj, ["compose", task]).out);
    const id = String(compose.message).match(/--request ([0-9a-f]{8})/)?.[1];
    expect(id).toBeDefined();
    const creation = directiveOf(runNext(proj, ["--scope", "feature", "--request", id!]).out);
    expect(creation.kind).toBe("print");
    const created = runUtility(proj, [
      "intent-create", "--scope", "feature", "--request", id!, "--label", "enable-sso",
    ]);
    expect(created.rc, created.out).toBe(0);
    const intentsDir = join(proj, "aidlc", "spaces", "default", "intents");
    const record = readFileSync(join(intentsDir, "active-intent"), "utf-8").trim();
    const state = readFileSync(join(intentsDir, record, "aidlc-state.md"), "utf-8");
    expect(state).toContain(`- **Project**: ${task}`);
  });

  test("literal delimiter, --new-scope, and positional-scope tasks preserve flag tokens at creation", () => {
    for (const [args, description] of [
      [["compose", "--", "--scope", "migration"], "--scope migration"],
      [["compose", "--", "--project-dir", "/tmp/not-a-project"], "--project-dir /tmp/not-a-project"],
      // The engine takes no `--enable`, and what the person meant by it is the
      // agent's to read, so the delimiter is what keeps it theirs at creation.
      [["--new-scope", "--", "--enable SSO"], "--enable SSO"],
      [["bugfix", "--", "--enable"], "--enable"],
      // A plan named with the colon mark keeps their words whole; the same words
      // after a bare plan word are ambiguous with their own first word, and go
      // to the agent as a reading step (t-three-ways-to-read-a-line).
      [["bugfix:", "Fix duplicate todo persistence"], "Fix duplicate todo persistence"],
      [["--scope", "feature", "feature", "flags", "for", "billing"], "feature flags for billing"],
      [["bugfix", "Fix", "duplicate", "todo", "--scope", "mvp"], "bugfix Fix duplicate todo"],
    ] as const) {
      proj = createTestProject();
      removeWorkspaceRecord(proj);
      const dispatch = directiveOf(runNext(proj, [...args]).out);
      const id = String(dispatch.message).match(/--request ([0-9a-f]{8})/)?.[1];
      expect(id).toBeDefined();
      const created = runUtility(proj, ["intent-create", "--scope", "bugfix", "--request", id!]);
      expect(created.rc, created.out).toBe(0);
      const intentsDir = join(proj, "aidlc", "spaces", "default", "intents");
      const record = readFileSync(join(intentsDir, "active-intent"), "utf-8").trim();
      expect(readFileSync(join(intentsDir, record, "aidlc-state.md"), "utf-8")).toContain(`- **Project**: ${description}`);
      cleanupTestProject(proj);
      proj = "";
    }
  });

  test("composer schema requires creationDescription for front/report proposals", () => {
    const composer = readFileSync(
      join(REPO_ROOT, "core", "agents", "aidlc-composer-agent.md"),
      "utf-8",
    );
    expect(composer).toContain('"creationDescription":');
    expect(composer).toContain("creationDescription` is REQUIRED and nonblank");
    expect(composer).toContain("derive a concise description from the report's actual findings");
  });

  test("--new-scope forces synthesis wording and dispatches without the verb", () => {
    proj = createTestProject();
    const d = directiveOf(
      runNext(proj, ["--new-scope", "build a payment reconciliation service"]).out,
    );
    expect(d.kind).toBe("print");
    expect(String(d.message)).toContain("aidlc-composer-agent");
    expect(String(d.message)).toContain("--new-scope");
    expect(String(d.message)).toContain("SYNTHESIZE");
  });

  test("compose + --stage is rejected (plan-shape vs cursor-move confusion)", () => {
    proj = createTestProject();
    const d = directiveOf(runNext(proj, ["compose", "--stage", "feasibility"]).out);
    expect(d.kind).toBe("error");
  });
});

// ===========================================================================
// With-state (in-flight): a bare mid-flow compose reaches the IN-FLIGHT
// composer dispatch - NOT Branch 10 (which would silently advance the current
// stage: the spike-F trap this branch exists to close).
// ===========================================================================
describe("t198 mid-flow compose -> in-flight dispatch, not an advance", () => {
  test.each(["dist", "dist-release"])(
    "%s: the emitted approval command applies the approved stage change",
    (channel) => {
      proj = createTestProject();
      const harnessRoot = join(REPO_ROOT, channel, "claude", ".claude");
      cpSync(harnessRoot, join(proj, ".claude"), { recursive: true });
      seedAidlcMemory(proj);
      seedStateFile(proj, MID_IDEATION);
      const native = channel === "dist-release";
      const binDir = join(proj, "bin");
      const executable = native
        ? join(binDir, process.platform === "win32" ? "aidlc.exe" : "aidlc")
        : BUN;
      if (native) {
        mkdirSync(binDir);
        const built = spawnSync(BUN, [
          "build", "--compile", join(harnessRoot, "tools", "aidlc.ts"),
          "--outfile", executable,
        ], { encoding: "utf-8", timeout: 60_000 });
        expect(built.status, `${built.stdout}\n${built.stderr}`).toBe(0);
      }
      // The native command and its children must work with no Bun on PATH.
      const env = {
        ...process.env,
        AIDLC_HARNESS_DIR: ".claude",
        ...(native ? { PATH: binDir } : {}),
      };
      const next = spawnSync(executable, [
        ...(native ? [] : [join(proj, ".claude", "tools", "aidlc.ts")]),
        "engine", "orchestrate", "next", "compose", "drop team-formation",
      ], { cwd: proj, env, encoding: "utf-8", timeout: 20_000 });
      expect(next.status, `${next.stdout}\n${next.stderr}`).toBe(0);
      const directive = directiveOf(next.stdout);
      expect(directive.kind).toBe("print");
      const command = /on approve run `([^`]+)`/.exec(String(directive.message))?.[1];
      expect(command).toBeDefined();
      // Fill only the approved proposal placeholders; execute the launcher
      // and route supplied to the conductor, so an invalid route cannot pass.
      const argv = command!
        .replace(" [--skip <changes.skip>]", " --skip team-formation")
        .replace(" [--add <changes.add>]", "")
        // No settings were approved with this stage change.
        .replace(" [approved setting flags]", "")
        .split(/\s+/);
      expect(argv.shift()).toBe(native ? "aidlc" : "bun");
      const before = readFileSync(seededStateFile(proj), "utf-8");
      expect(before).toContain("- [ ] team-formation — EXECUTE");
      const applied = spawnSync(executable, argv, {
        cwd: proj, env, encoding: "utf-8", timeout: 20_000,
      });
      expect(applied.status, `${applied.stdout}\n${applied.stderr}`).toBe(0);
      const after = readFileSync(seededStateFile(proj), "utf-8");
      expect(after).toContain("- [ ] team-formation — SKIP");
      expect(after).toContain("- **Current Stage**: feasibility");
    },
    90_000,
  );

  test.each(["", "drop market-research and team-formation"])(
    "compose over an active workflow commits to the in-flight composer: %s",
    (task) => {
      proj = createTestProject();
      seedAidlcMemory(proj);
      seedStateFile(proj, MID_IDEATION);
      const d = directiveOf(runNext(proj, ["compose", ...(task ? [task] : [])]).out);
      expect(d.kind).toBe("print");
      expect(String(d.message)).toContain("aidlc-composer-agent");
      expect(String(d.message)).toContain("RUNNING workflow");
      expect(String(d.message)).toContain("mode in-flight");
      expect(String(d.message)).toContain("stock-distance rankings are advisory only");
      expect(String(d.message)).toContain("changes.skip and changes.add");
      expect(String(d.message)).toContain("Never write scope registry files");
      expect(String(d.message)).toContain("go through next --skip or --add only BEFORE calling next compose");
      expect(String(d.message)).toContain("Dispatch the composer subagent with this message as its task");
      expect(String(d.message)).toContain("use its validated proposal at the approval gate");
      // The counterfactual: a guard-less engine routes this to the current
      // run-stage. Pin the absence.
      expect(d.kind).not.toBe("run-stage");
    },
  );

  test("bare next (no compose) still advances - the dispatch branch is inert when unused", () => {
    proj = createTestProject();
    seedAidlcMemory(proj);
    seedStateFile(proj, MID_IDEATION);
    const d = directiveOf(runNext(proj, []).out);
    expect(d.kind).toBe("run-stage");
  });
});

// ===========================================================================
// Branch 8 rewiring: inference-driven confirm vs the compose offer. The old
// behavior was a static static-default confirm for ALL freeform prose.
// ===========================================================================
describe("t198 Branch 8: inference confirm + compose offer", () => {
  test("clear keyword hit (<=5 words) -> one-line confirm naming the MATCHED scope", () => {
    proj = createTestProject();
    const d = directiveOf(runNext(proj, ["fix login bug"]).out);
    expect(d.kind).toBe("ask");
    // bugfix carries keyword "fix"; the old code would have said "feature".
    expect(String(d.question)).toContain('"bugfix"');
    expect(String(d.question)).toContain("tailor one to this task");
  });

  test("rich prose (no clear hit) -> the compose offer, never a silent default", () => {
    proj = createTestProject();
    const d = directiveOf(
      runNext(proj, ["build a distributed cache layer with consistency guarantees"]).out,
    );
    expect(d.kind).toBe("ask");
    expect(String(d.question)).toContain("compose");
    expect(String(d.question)).not.toContain('"feature" workflow');
  });

  test("long affirmative refactor description -> confirm the refactor plan", () => {
    proj = createTestProject();
    const d = directiveOf(
      runNext(proj, ["Please refactor the authentication module without changing its behavior"]).out,
    );
    expect(d.kind).toBe("ask");
    expect(String(d.question)).toContain('This looks like "refactor" work');
    expect(String(d.question)).toContain("Do you want me to go ahead with it");
  });

  test("long bug description -> confirm the bugfix plan", () => {
    proj = createTestProject();
    const d = directiveOf(
      runNext(proj, ["Fix a filter bug found while optimising a Power BI report"]).out,
    );
    expect(d.kind).toBe("ask");
    expect(d.ask_type).toBe("scope-confirm");
    expect(d.proposed_scope).toBe("bugfix");
    expect(String(d.question)).toContain('This looks like "bugfix" work');
    expect(String(d.question)).toContain("Do you want me to go ahead with it");
    // The answers a host shows as options, worded for the person.
    expect(d.choices).toEqual([
      { label: 'Go ahead with the "bugfix" plan', command: d.confirm_command },
      { label: "Tailor a plan to this task", command: d.compose_command },
    ]);
  });

  test("depth and test strategy typed with the description survive the plan offer", () => {
    proj = createTestProject();
    removeWorkspaceRecord(proj);
    const ask = directiveOf(runNext(proj, [
      "--depth", "comprehensive", "--test-strategy", "minimal",
      "Fix the login crash when the session expires",
    ]).out);
    expect(ask.ask_type).toBe("scope-confirm");
    const confirm = String(ask.confirm_command);
    expect(confirm).toContain("--depth comprehensive --test-strategy minimal");
    const featureCommand = (ask.scope_commands as Array<{ scope: string; command: string }>)
      .find((entry) => entry.scope === "feature")?.command;
    expect(featureCommand).toContain("--depth comprehensive --test-strategy minimal");
    // The confirmed answer names the creation with the person's own levels.
    const created = directiveOf(runNext(proj, confirm.slice(confirm.indexOf(" next ") + 6).split(" ")).out);
    expect(created.kind).toBe("print");
    expect(String(created.message)).toContain("intent create --scope bugfix");
    expect(String(created.message)).toContain("--depth comprehensive --test-strategy minimal");
  });

  // bugfix asks no learnings question and no summary confirmation. A switch
  // typed with the description is the person's choice: the offer previews it,
  // and "go ahead", another plan, or compose carry it on to the saved work.
  test.each([
    ["--learnings", "on", "Learnings"],
    ["--summary-confirmation", "on", "Summary Confirmation"],
    ["--sensors", "off", "Sensors"],
  ])("%s %s typed with the description survives go ahead into the saved work", (flag, value, field) => {
    proj = createTestProject();
    removeWorkspaceRecord(proj);
    const typed = `${flag} ${value}`;
    const ask = directiveOf(runNext(proj, [flag, value, "Fix the login crash when the session expires"]).out);
    expect(ask.ask_type).toBe("scope-confirm");
    expect(ask.proposed_scope).toBe("bugfix");
    const confirm = String(ask.confirm_command);
    expect(confirm).toContain(typed);
    for (const entry of ask.scope_commands as Array<{ scope: string; command: string }>) {
      expect(entry.command, entry.scope).toContain(typed);
    }
    // The compose answer keeps it too, and the composer is told it is the person's.
    const compose = String(ask.compose_command);
    expect(compose).toContain(typed);
    const dispatch = directiveOf(runNext(proj, compose.slice(compose.indexOf(" next ") + 6).split(" ")).out);
    expect(dispatch.kind, String(dispatch.message)).toBe("print");
    expect(String(dispatch.message)).toContain(`This request carries ${typed}: add exactly that to the approval's \`next\` command`);
    expect(String(dispatch.message)).toContain("A switch typed here is the person's choice");
    // "go ahead": the creation the engine names carries the switch, and the saved work has it.
    const created = directiveOf(runNext(proj, confirm.slice(confirm.indexOf(" next ") + 6).split(" ")).out);
    expect(created.kind).toBe("print");
    const message = String(created.message);
    expect(message).toContain("intent create --scope bugfix");
    expect(message).toContain(typed);
    const requestId = /--request (\S+)/.exec(message)?.[1];
    expect(requestId, message).toBeDefined();
    const made = runUtility(proj, ["intent-create", "--scope", "bugfix", "--request", requestId as string, "--label", "login-crash", flag, value]);
    expect(made.rc, made.out).toBe(0);
    const intents = join(proj, "aidlc", "spaces", "default", "intents");
    const record = readFileSync(join(intents, "active-intent"), "utf-8").trim();
    const state = readFileSync(join(intents, record, "aidlc-state.md"), "utf-8");
    expect(state).toContain(`- **${field}**: ${value} (set by a command)`);
  });

  // `/aidlc-init "<description>"` asks for new work with no scope: the person
  // gets the plan offer, never the active intent's scope or the default.
  test("new work with no scope on a fresh workspace -> the plan offer, then a normal start", () => {
    proj = createTestProject();
    removeWorkspaceRecord(proj);
    const ask = directiveOf(runNext(proj, ["--new-intent", "Fix the login page timeout bug"]).out);
    expect(ask.ask_type).toBe("scope-confirm");
    expect(ask.proposed_scope).toBe("bugfix");
    const confirm = String(ask.confirm_command);
    const created = directiveOf(runNext(proj, confirm.slice(confirm.indexOf(" next ") + 6).split(" ")).out);
    expect(String(created.message)).toContain("intent create --scope bugfix");
    expect(String(created.message)).toContain("then re-run `next` to continue");
  });

  test("new work with no scope beside an active workflow -> the plan offer, levels kept, current work untouched", () => {
    proj = createTestProject();
    seedAidlcMemory(proj);
    seedStateFile(proj, MID_IDEATION);
    const ask = directiveOf(runNext(proj, [
      "--new-intent", "--depth", "comprehensive", "Fix the login crash when the session expires",
    ]).out);
    // Not "config set depth": the depth belongs to the new work.
    expect(ask.kind).toBe("ask");
    expect(ask.ask_type).toBe("scope-confirm");
    expect(ask.proposed_scope).toBe("bugfix");
    const confirm = String(ask.confirm_command);
    expect(confirm).toContain("--depth comprehensive");
    const created = directiveOf(runNext(proj, confirm.slice(confirm.indexOf(" next ") + 6).split(" ")).out);
    expect(created.kind).toBe("print");
    expect(String(created.message)).toContain("intent create --scope bugfix");
    expect(String(created.message)).toContain("--depth comprehensive");
    expect(String(created.message)).toContain("to start the new intent");
  });

  // poc builds its code plans without asking. Typing plan approval back on with
  // the request keeps it on after "go ahead". Only the person's own words turn
  // it off, so the offer never re-issues an off.
  test("--plan-approval on typed with a prototype request survives go ahead into the saved work", () => {
    proj = createTestProject();
    removeWorkspaceRecord(proj);
    const ask = directiveOf(runNext(proj, ["--plan-approval", "on", "prototype the export pipeline"]).out);
    expect(ask.ask_type).toBe("scope-confirm");
    expect(ask.proposed_scope).toBe("poc");
    const confirm = String(ask.confirm_command);
    expect(confirm).toContain("--plan-approval on");
    expect(String(ask.compose_command)).toContain("--plan-approval on");
    const created = directiveOf(runNext(proj, confirm.slice(confirm.indexOf(" next ") + 6).split(" ")).out);
    expect(created.kind).toBe("print");
    const message = String(created.message);
    expect(message).toContain("intent create --scope poc");
    expect(message).toContain("--plan-approval on");
    const requestId = /--request (\S+)/.exec(message)?.[1];
    expect(requestId, message).toBeDefined();
    const made = runUtility(proj, ["intent-create", "--scope", "poc", "--request", requestId as string, "--label", "export-spike", "--plan-approval", "on"]);
    expect(made.rc, made.out).toBe(0);
    const intents = join(proj, "aidlc", "spaces", "default", "intents");
    const record = readFileSync(join(intents, "active-intent"), "utf-8").trim();
    const state = readFileSync(join(intents, record, "aidlc-state.md"), "utf-8");
    expect(state).toContain("- **Plan Approval**: on (set by a command)");
  });

  // The person typed plan approval off with the work they were describing, so
  // it belongs to the work they pick: every answer the offer names carries it,
  // and creation takes it from the command (t-flags-next-does-not-take holds
  // the whole path). Before this it rode only as `on`, and an `off` reached the
  // new work through the human-turn hook's grant alone.
  test("a typed plan approval off rides every answer the offer names", () => {
    proj = createTestProject();
    removeWorkspaceRecord(proj);
    const ask = directiveOf(runNext(proj, ["--plan-approval", "off", "Fix the login crash when the session expires"]).out);
    expect(ask.ask_type).toBe("scope-confirm");
    expect(String(ask.confirm_command)).toContain("--plan-approval off");
    expect(String(ask.compose_command)).toContain("--plan-approval off");
    for (const entry of ask.scope_commands as Array<{ scope: string; command: string }>) {
      expect(entry.command, entry.scope).toContain("--plan-approval off");
    }
  });

  test("a switch typed with new work beside an active workflow belongs to the new work", () => {
    proj = createTestProject();
    seedAidlcMemory(proj);
    seedStateFile(proj, MID_IDEATION);
    const before = readFileSync(seededStateFile(proj), "utf-8");
    const ask = directiveOf(runNext(proj, [
      "--new-intent", "--learnings", "on", "Fix the login crash when the session expires",
    ]).out);
    expect(ask.kind).toBe("ask");
    expect(ask.ask_type).toBe("scope-confirm");
    const confirm = String(ask.confirm_command);
    expect(confirm).toContain("--learnings on");
    const created = directiveOf(runNext(proj, confirm.slice(confirm.indexOf(" next ") + 6).split(" ")).out);
    expect(created.kind).toBe("print");
    expect(String(created.message)).toContain("intent create --scope bugfix");
    expect(String(created.message)).toContain("--learnings on");
    expect(String(created.message)).toContain("to start the new intent");
    expect(readFileSync(seededStateFile(proj), "utf-8")).toBe(before);
  });

  // The recommended answer ("compose") keeps the levels the person typed too.
  test.each([
    ["fresh workspace", false],
    ["beside an active workflow", true],
  ])("typed levels ride the compose answer into the composer dispatch (%s)", (_label, active) => {
    proj = createTestProject();
    if (active) {
      seedAidlcMemory(proj);
      seedStateFile(proj, MID_IDEATION);
    } else {
      removeWorkspaceRecord(proj);
    }
    const ask = directiveOf(runNext(proj, [
      ...(active ? ["--new-intent"] : []),
      "--depth", "comprehensive", "--test-strategy", "minimal",
      "Users get a 500 error when uploading big files to the portal",
    ]).out);
    expect(ask.ask_type).toBe("compose-offer");
    const compose = String(ask.compose_command);
    expect(compose).toContain("--depth comprehensive --test-strategy minimal");
    const dispatch = directiveOf(runNext(proj, compose.slice(compose.indexOf(" next ") + 6).split(" ")).out);
    expect(dispatch.kind).toBe("print");
    expect(String(dispatch.message)).toContain("propose the workflow plan for");
    expect(String(dispatch.message)).toContain(
      "This request carries --depth comprehensive --test-strategy minimal: add exactly that to the approval's `next` command, in place of any creationDepth.",
    );
  });

  // A typed test strategy alone keeps the depth of the plan the person approves.
  test("a typed test strategy alone keeps the composed plan's depth", () => {
    proj = createTestProject();
    removeWorkspaceRecord(proj);
    const ask = directiveOf(runNext(proj, [
      "--test-strategy", "minimal",
      "Users get a 500 error when uploading big files to the portal",
    ]).out);
    const compose = String(ask.compose_command);
    expect(compose).toContain("--test-strategy minimal");
    expect(compose).not.toContain("--depth");
    const dispatch = directiveOf(runNext(proj, compose.slice(compose.indexOf(" next ") + 6).split(" ")).out);
    const message = String(dispatch.message);
    expect(message).toContain(
      "This request carries --test-strategy minimal: add exactly that to the approval's `next` command, alongside --depth <creationDepth> when the proposal carries one.",
    );
    expect(message).not.toContain("in place of any creationDepth");
  });

  // A fresh clone: two records on disk, none selected (the cursor is per user).
  const seedTwoRecordsNoneSelected = (): void => {
    proj = createTestProject();
    removeWorkspaceRecord(proj);
    for (const scope of ["poc", "feature"]) {
      expect(runUtility(proj, ["intent-create", "--scope", scope]).rc).toBe(0);
    }
    rmSync(join(intentsDirOf(proj), "active-intent"), { force: true });
  };

  // New work the person asked for is started on their answer, not asked about again.
  test("new work with no scope in an unselected workspace -> the offer, then creation, no record pick", () => {
    seedTwoRecordsNoneSelected();
    const ask = directiveOf(runNext(proj, [
      "--new-intent", "--depth", "comprehensive", "Fix the login crash when the session expires",
    ]).out);
    expect(ask.ask_type).toBe("scope-confirm");
    const confirm = String(ask.confirm_command);
    const created = directiveOf(runNext(proj, confirm.slice(confirm.indexOf(" next ") + 6).split(" ")).out);
    expect(created.kind).toBe("print");
    expect(String(created.message)).toContain("intent create --scope bugfix");
    expect(String(created.message)).toContain("--depth comprehensive");
  });

  test("plain prose in an unselected workspace still asks which work it is (unchanged)", () => {
    seedTwoRecordsNoneSelected();
    const ask = directiveOf(runNext(proj, ["Fix the login crash when the session expires"]).out);
    const confirm = String(ask.confirm_command);
    const next = directiveOf(runNext(proj, confirm.slice(confirm.indexOf(" next ") + 6).split(" ")).out);
    expect(next.kind).toBe("ask");
    expect(next.ask_type).toBe("new-work-routing");
  });

  // Settings typed with a new description beside other work go with the work
  // the person picks on the routing question, and the description is kept.
  const runEmitted = (command: string): Record<string, unknown> =>
    directiveOf(runNext(proj, command.slice(command.indexOf(" next ") + 6).split(" ")).out);

  test("a setting typed with a new description beside active work asks first and goes with the answer", () => {
    proj = createTestProject();
    seedAidlcMemory(proj);
    seedStateFile(proj, MID_IDEATION);
    const before = readFileSync(seededStateFile(proj), "utf-8");
    const ask = directiveOf(runNext(proj, [
      "--depth", "minimal", "--learnings", "off", "Fix the login crash when the session expires",
    ]).out);
    // Not "config set": the description is asked about, never dropped.
    expect(ask.ask_type).toBe("new-work-routing");
    expect(ask.new_work_description).toBe("Fix the login crash when the session expires");
    const commands = [
      String(ask.new_intent_command),
      String(ask.continue_command),
      String(ask.compose_command),
      ...(ask.scope_commands as Array<{ command: string }>).map((entry) => entry.command),
    ];
    for (const command of commands) expect(command).toContain("--depth minimal --learnings off");
    const created = runEmitted(String(ask.new_intent_command));
    expect(created.kind).toBe("print");
    expect(String(created.message)).toContain("intent create --scope bugfix");
    expect(String(created.message)).toContain("--depth minimal --learnings off");
    expect(String(created.message)).toContain("to start the new intent");
    const kept = runEmitted(String(ask.continue_command));
    expect(kept.kind).toBe("print");
    expect(String(kept.message)).toContain("config set depth minimal --learnings off` to update the configuration");
    expect(readFileSync(seededStateFile(proj), "utf-8")).toBe(before);
    // A setting typed alone is still for the active work.
    const alone = directiveOf(runNext(proj, ["--learnings", "off"]).out);
    expect(String(alone.message)).toContain("config set learnings off` to update the configuration");
  });

  test("the reshape answer applies the typed settings to the active work first, then composes", () => {
    proj = createTestProject();
    seedAidlcMemory(proj);
    seedStateFile(proj, MID_IDEATION);
    const ask = directiveOf(runNext(proj, [
      "--review", "none", "--learnings", "off", "Drop the documentation stages from the plan",
    ]).out);
    expect(ask.ask_type).toBe("new-work-routing");
    const compose = String(ask.compose_command);
    expect(compose).toContain("--learnings off --review none");
    const first = runEmitted(compose);
    expect(first.kind).toBe("print");
    const message = String(first.message);
    expect(message).toContain("config set review none --learnings off` to apply the settings typed with this request to the work being reshaped");
    const then = /then run `([^`]+)` and follow what it returns/.exec(message)?.[1];
    expect(then, message).toBeDefined();
    expect(then).not.toContain("--learnings");
    const dispatch = runEmitted(then as string);
    expect(String(dispatch.message)).toContain("mode in-flight");
  });

  test("a review level and a raised Guard Policy typed with new work are part of its creation", () => {
    proj = createTestProject();
    seedAidlcMemory(proj);
    seedStateFile(proj, MID_IDEATION);
    const ask = directiveOf(runNext(proj, [
      "--review", "none", "--guard-policy", "strict", "Fix the login crash when the session expires",
    ]).out);
    expect(ask.ask_type).toBe("new-work-routing");
    expect(String(ask.new_intent_command)).toContain("--review none --guard-policy strict");
    expect(String(ask.continue_command)).toContain("--review none --guard-policy strict");
    const created = runEmitted(String(ask.new_intent_command));
    const message = String(created.message);
    const create = /Run `([^`]+)` to start the new intent/.exec(message)?.[1] ?? "";
    // One step: nothing is left to apply once the work exists.
    expect(create).toContain("intent create --scope bugfix");
    expect(create).toContain("--review none --guard-policy strict");
    expect(message).not.toContain("config set");
    // Run it: the new work has them, the active work keeps its own.
    const before = readFileSync(seededStateFile(proj), "utf-8");
    const requestId = /--request (\S+)/.exec(create)?.[1] as string;
    const made = runUtility(proj, [
      "intent-create", "--scope", "bugfix", "--request", requestId, "--label", "login-crash",
      "--review", "none", "--guard-policy", "strict",
    ]);
    expect(made.rc, made.out).toBe(0);
    const intents = intentsDirOf(proj);
    const record = readFileSync(join(intents, "active-intent"), "utf-8").trim();
    expect(record).toContain("login-crash");
    const state = readFileSync(join(intents, record, "aidlc-state.md"), "utf-8");
    expect(state).toMatch(/- \*\*Review Override\*\*: none/);
    expect(readFileSync(seededStateFile(proj), "utf-8")).toBe(before);
  });

  // The person may answer the question by its number in chat; that reply is
  // the option's own command, settings included.
  test("a reply that only names an option keeps the settings typed with the request", () => {
    proj = createTestProject();
    seedAidlcMemory(proj);
    seedStateFile(proj, MID_IDEATION);
    const ask = directiveOf(runNext(proj, [
      "--depth", "minimal", "--guard-policy", "relaxed", "Fix the login crash when the session expires",
    ]).out);
    expect(ask.ask_type).toBe("new-work-routing");
    const separate = directiveOf(runNext(proj, ["2"]).out);
    const create = /Run `([^`]+)` to start the new intent/.exec(String(separate.message))?.[1] ?? "";
    expect(create).toContain("intent create --scope bugfix");
    expect(create).toContain("--depth minimal");
    expect(create).not.toContain("--guard-policy");
    expect(String(separate.narration)).toContain("The new work starts at the default Guard Policy");
    // Continuing the active work instead takes the typed Guard Policy with it.
    const kept = directiveOf(runNext(proj, ["1"]).out);
    expect(String(kept.message)).toContain("config set depth minimal --guard-policy relaxed` to update the configuration");
  });

  test("a plan named with a setting before a new description beside active work asks first, proposing that plan", () => {
    proj = createTestProject();
    seedAidlcMemory(proj);
    seedStateFile(proj, MID_IDEATION);
    const before = readFileSync(seededStateFile(proj), "utf-8");
    const typed = ["--learnings", "off"];
    const ask = directiveOf(runNext(proj, [...typed, "bugfix", "Fix the login crash when the session expires"]).out);
    expect(ask.ask_type).toBe("new-work-routing");
    expect(ask.proposed_scope).toBe("bugfix");
    expect(ask.new_work_description).toBe("Fix the login crash when the session expires");
    expect(String(ask.new_intent_command)).toContain(`--scope bugfix --request`);
    expect(String(ask.new_intent_command)).toContain("--learnings off");
    expect(readFileSync(seededStateFile(proj), "utf-8")).toBe(before);
  });

  test("a bare plan word before a new description beside active work goes to the agent, with nothing asked of them", () => {
    // Settled 2026-10-10: a plan's name at the START of their own sentence,
    // with nothing marking which it is, has two readings and only the agent can
    // tell. With a setting typed first (above) the line is a command and the
    // plan still acts; the mark (`bugfix:`, or `--`) makes it a command too.
    proj = createTestProject();
    seedAidlcMemory(proj);
    seedStateFile(proj, MID_IDEATION);
    const before = readFileSync(seededStateFile(proj), "utf-8");
    const step = directiveOf(runNext(proj, ["bugfix", "Fix the login crash when the session expires"]).out);
    expect(step.kind).toBe("print");
    expect(step.narration).toBeUndefined();
    expect(step.ask_type).toBeUndefined();
    expect(String(step.message)).toContain("--scope bugfix");
    expect(String(step.message)).toContain("Fix the login crash when the session expires");
    expect(readFileSync(seededStateFile(proj), "utf-8")).toBe(before);
  });

  test("a late answer still says where a lowered Guard Policy landed, after other work was selected", () => {
    proj = createTestProject();
    seedAidlcMemory(proj);
    seedStateFile(proj, MID_IDEATION);
    const stateFile = seededStateFile(proj);
    writeFileSync(stateFile, readFileSync(stateFile, "utf-8").replace(
      "- **Change Control**: strict (from scope feature)", "- **Guard Policy**: relaxed (set by you)",
    ));
    const ask = directiveOf(runNext(proj, ["--guard-policy", "relaxed", "Fix the login crash when the session expires"]).out);
    expect(ask.ask_type).toBe("new-work-routing");
    // Other work is selected before the answer runs.
    expect(runUtility(proj, ["intent-create", "--scope", "poc", "--label", "spike"]).rc).toBe(0);
    const created = runEmitted(String(ask.new_intent_command));
    expect(String(created.narration)).toContain(
      "Guard Policy relaxed (AI-DLC carries on with a note when something you approved changes) is on for \"Test widget feature for e-commerce platform\", as you typed it with the request",
    );
  });

  test.each([
    ["is on for the active work", "- **Guard Policy**: relaxed (set by you)",
      "Guard Policy relaxed (AI-DLC carries on with a note when something you approved changes) is on for \"Test widget feature for e-commerce platform\", as you typed it with the " +
        "request; the new work starts at the default. Do you want relaxed for the new work too?"],
    ["did not land", "- **Change Control**: strict (from scope feature)",
      "The new work starts at the default Guard Policy, not relaxed (AI-DLC carries on with a note when something you approved changes) as you typed with the request. " +
        "Do you want relaxed for it?"],
  ])("a lowered Guard Policy typed with new work is never tried on it: the person hears where it %s", (_label, line, note) => {
    proj = createTestProject();
    seedAidlcMemory(proj);
    seedStateFile(proj, MID_IDEATION);
    const stateFile = seededStateFile(proj);
    writeFileSync(stateFile, readFileSync(stateFile, "utf-8").replace("- **Change Control**: strict (from scope feature)", line));
    const ask = directiveOf(runNext(proj, [
      "--guard-policy", "relaxed", "Fix the login crash when the session expires",
    ]).out);
    expect(ask.ask_type).toBe("new-work-routing");
    expect(String(ask.new_intent_command)).toContain("--guard-policy relaxed");
    // It lands on the work the person picks: continuing or reshaping the active
    // work applies it there.
    expect(String(ask.continue_command)).toContain("--guard-policy relaxed");
    expect(String(ask.compose_command)).toContain("--guard-policy relaxed");
    const created = runEmitted(String(ask.new_intent_command));
    expect(String(created.message)).not.toContain("--guard-policy");
    expect(String(created.message)).not.toContain("config set");
    expect(String(created.narration)).toContain(note);
  });

  test("in an unselected workspace the typed settings ride the new-work and reshape answers", () => {
    seedTwoRecordsNoneSelected();
    const ask = directiveOf(runNext(proj, [
      "--scope", "bugfix", "--learnings", "off", "Fix the login crash when the session expires",
    ]).out);
    expect(ask.ask_type).toBe("new-work-routing");
    expect(String(ask.new_intent_command)).toContain("--learnings off");
    const reshape = (ask.reshape_commands as Array<{ selector: string; command: string }>)[0];
    expect(reshape.command).toContain("--learnings off");
    const switched = runEmitted(reshape.command);
    expect(String(switched.message)).toContain(`To reshape ${reshape.selector}, run`);
    const then = /then run `([^`]+)` and follow what it returns/.exec(String(switched.message))?.[1];
    expect(then).toContain("next compose --request");
    expect(then).toContain("--learnings off");
  });

  // Work in progress that is archived or parked never blocks the new work the
  // person asked for, compose answer included.
  test.each([
    ["archived", "- **Status**: Archived"],
    ["parked", "- **Status**: Running\n- **Parked**: yes\n- **Parked At Stage**: feasibility"],
  ])("compose answer for new work beside %s work reaches the composer", (_label, status) => {
    proj = createTestProject();
    seedAidlcMemory(proj);
    seedStateFile(proj, MID_IDEATION);
    const stateFile = seededStateFile(proj);
    const before = readFileSync(stateFile, "utf-8").replace("- **Status**: Running", status);
    writeFileSync(stateFile, before);
    const ask = directiveOf(runNext(proj, ["--new-intent", "Users get a 500 error when uploading big files to the portal"]).out);
    expect(ask.ask_type).toBe("compose-offer");
    const compose = String(ask.compose_command);
    const dispatch = directiveOf(runNext(proj, compose.slice(compose.indexOf(" next ") + 6).split(" ")).out);
    expect(dispatch.kind).toBe("print");
    expect(String(dispatch.message)).toContain("propose the workflow plan for");
    expect(readFileSync(stateFile, "utf-8")).toBe(before);
  });

  test("new work with no scope and no keyword -> the compose offer", () => {
    proj = createTestProject();
    seedAidlcMemory(proj);
    seedStateFile(proj, MID_IDEATION);
    const ask = directiveOf(runNext(proj, ["--new-intent", "Users get a 500 error when uploading big files"]).out);
    expect(ask.ask_type).toBe("compose-offer");
    expect(String(ask.question)).toContain("bugfix = ");
  });

  test.each([
    "Do not refactor anything; add a new login screen",
    "Build a production service, not a proof of concept",
    // Not negated: "fix-up" names a step, it does not ask for a fix.
    "add a fix-up step to the importer",
  ])("negated or incidental scope word in long prose -> compose offer: %s", (input) => {
    proj = createTestProject();
    const d = directiveOf(runNext(proj, [input]).out);
    expect(d.kind).toBe("ask");
    expect(String(d.question)).toContain("None of the ready-made plans is an obvious fit");
    expect(String(d.question)).toContain("compose");
  });

  test("known-scope positional still creates (Branch 7b untouched)", () => {
    proj = createTestProject();
    // The creation path needs a GENUINELY empty workspace (zero intents), else the
    // engine asks to select the seeded record instead of creating (t118's
    // pattern).
    removeWorkspaceRecord(proj);
    const d = directiveOf(runNext(proj, ["bugfix"]).out);
    expect(d.kind).toBe("print");
    expect(String(d.message)).toContain("intent create --scope bugfix");
  });
});

// ===========================================================================
// detect --json: pure read, prints the scan + the resolved registry paths.
// ===========================================================================
describe("t198 detect --json is a pure read that names the write target", () => {
  test("returns scan fields + scopesDir + scopeGridPath + the 11 stock scopes, writes nothing", () => {
    proj = createTestProject();
    const before = readdirSync(proj).sort().join(",");
    const r = runUtility(proj, ["detect", "--json"]);
    expect(r.rc).toBe(0);
    const payload = JSON.parse(r.out.trim()) as Record<string, unknown>;
    expect(["Greenfield", "Brownfield"]).toContain(String(payload.projectType));
    expect(typeof payload.languages).toBe("string");
    expect(String(payload.scopesDir)).toContain("scopes");
    expect(String(payload.scopeGridPath)).toContain("scope-grid.json");
    expect(payload.scopes as string[]).toContain("bugfix");
    expect((payload.scopes as string[]).length).toBe(11);
    const after = readdirSync(proj).sort().join(",");
    expect(after).toBe(before); // no dir created, no file written
  });
});

// ===========================================================================
// The composer's proposal file (F45): Kiro IDE on Windows could not write the
// OS temp dir the composer used for its grid, and the failed write ended the
// composer's turn. detect now names a file inside the project that git
// ignores, and validate-grid reads it when no --proposal is passed.
// ===========================================================================
describe("t198 the composer's grid proposal lives in the project, not the temp dir", () => {
  const PROPOSAL = "aidlc/spaces/default/intents/.aidlc-engine/composer-proposal.json";

  function runGraph(project: string, args: string[]): RunResult {
    const res = spawnSync(BUN, [join(AIDLC_SRC, "tools", "aidlc-graph.ts"), ...args], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      encoding: "utf-8",
      // Another cwd: the default path must not depend on where the shell is.
      cwd: REPO_ROOT,
      env: { ...process.env, AIDLC_PROJECT_DIR: project, CLAUDE_PROJECT_DIR: project },
    });
    return { rc: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
  }

  test("detect --json names a project-relative proposal file every shipped gitignore ignores", () => {
    proj = createTestProject();
    const r = runUtility(proj, ["detect", "--json"]);
    expect(r.rc).toBe(0);
    const payload = JSON.parse(r.out.trim()) as Record<string, unknown>;
    // The space's engine dir, not an intent record: a front composition runs
    // before any intent exists.
    expect(payload.proposalPath).toBe(PROPOSAL);
    for (const harness of HARNESS_MATRIX) {
      const repo = mkdtempSync(join(tmpdir(), `aidlc-t198-ignore-${harness.name}-`));
      try {
        expect(spawnSync("git", ["init", "-q"], { cwd: repo }).status, harness.name).toBe(0);
        writeFileSync(join(repo, ".gitignore"), readFileSync(join(harness.distRoot, ".gitignore")));
        const ignored = spawnSync("git", ["check-ignore", "-q", PROPOSAL], { cwd: repo });
        expect(ignored.status, `${harness.name}: ${PROPOSAL} is ignored`).toBe(0);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }
  });

  test("validate-grid with no --proposal reads that file and names it when it is missing", () => {
    proj = createTestProject();
    const missing = runGraph(proj, ["validate-grid"]);
    expect(missing.rc).toBe(1);
    expect(missing.out).toContain("composer-proposal.json");
    expect(missing.out).toContain("Write the grid to the proposalPath that `workspace detect --json` prints");

    const grid = JSON.parse(
      readFileSync(join(AIDLC_SRC, "tools", "data", "scope-grid.json"), "utf-8"),
    ) as Record<string, { stages: Record<string, string> }>;
    const target = join(proj, PROPOSAL);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify({ stages: grid.bugfix.stages }), "utf-8");
    const read = runGraph(proj, ["validate-grid"]);
    expect(read.rc, read.out).toBe(0);
    const body = JSON.parse(read.out) as { valid: boolean; nearest_stock: { scope: string; diff: number }[] };
    expect(body.valid).toBe(true);
    // The grid it checked is the one written there.
    expect(body.nearest_stock.find((s) => s.scope === "bugfix")?.diff).toBe(0);
    expect(body.nearest_stock.find((s) => s.scope === "feature")?.diff).toBeGreaterThan(0);
  });

  test("every shipped composer writes its grid to proposalPath, never a temp file", () => {
    for (const harness of HARNESS_MATRIX) {
      const composer = readFileSync(join(harness.engineRoot, "agents", "aidlc-composer-agent.md"), "utf-8");
      expect(composer, harness.name).toContain("Write your ARS-derived grid to the `proposalPath` Step 1 printed");
      expect(composer, harness.name).toContain("Never use a system temp directory");
      expect(composer, harness.name).not.toContain("temp file");
      expect(composer, harness.name).not.toContain("--proposal <path>");
    }
  });
});
