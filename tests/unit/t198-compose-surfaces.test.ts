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
      [["--new-scope", "--enable SSO"], "--enable SSO"],
      [["bugfix", "--enable"], "--enable"],
      [["bugfix", "Fix", "duplicate", "todo", "persistence"], "Fix duplicate todo persistence"],
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
      expect(String(d.message)).toContain("fast path is available only BEFORE calling next compose");
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
    expect(String(d.question)).toContain("compose");
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
    expect(String(d.question)).toContain("Say go ahead");
  });

  test.each([
    "Do not refactor anything; add a new login screen",
    "Build a production service, not a proof of concept",
  ])("negated scope in long prose -> compose offer: %s", (input) => {
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
