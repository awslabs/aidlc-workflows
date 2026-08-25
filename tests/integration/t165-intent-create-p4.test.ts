// covers: subcommand:aidlc-utility:intent-create, subcommand:aidlc-utility:intent, subcommand:aidlc-utility:space, subcommand:aidlc-utility:space-create, function:createIntent, function:listSpaces, function:listIntents, function:slugify, function:updateIntentStatus, function:migrateFlatLayout, function:resolveBirthRepoSet, function:discoverSiblingRepos
//
// Mechanism: cli (spawned dist tools) + in-process pure-function asserts.
// P4 — retire the user-facing --init; the engine auto-births the first intent
// CONDUCTOR-SIDE (the read-only routing tool NAMES the move, the deterministic
// `intent-create` handler mutates), plus the intent/space verb families + the
// deterministic query layer (listSpaces/listIntents, --json) + the intent
// status lifecycle + the migration wiring.
//
// WHY a subprocess for birth: intent-create mutates the workspace under the
// WORKSPACE audit lock; spawning the dist tool exercises the real handler +
// the real lock + the real per-intent state/audit resolution end-to-end, the
// way the conductor runs it. The query layer (listSpaces/listIntents/slugify/
// updateIntentStatus) is asserted in-process against the dist lib (pure reads/
// transforms), then cross-checked against the spawned `intent`/`space --json`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  removeWorkspaceRecord,
  seedStateFile,
  seededStateFile,
} from "../harness/fixtures.ts";
import {
  activeIntent,
  activeSpace,
  listIntents,
  listSpaces,
  readAllAuditShards,
  readIntentRegistry,
  slugify,
  updateIntentStatus,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");
const UTIL = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-utility.ts");
const ORCH = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-orchestrate.ts");
const SESSION_START = join(REPO_ROOT, "dist", "claude", ".claude", "hooks", "aidlc-session-start.ts");
const SESSION_END = join(REPO_ROOT, "dist", "claude", ".claude", "hooks", "aidlc-session-end.ts");
const CONTINUE_WORKFLOW = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "hooks",
  "aidlc-continue-workflow.ts",
);
const REBUILD_STAGE_GRAPH = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "hooks",
  "aidlc-rebuild-stage-graph.ts",
);

let proj: string;
beforeEach(() => {
  proj = createTestProject();
  // P9: createTestProject seeds ONE default intent record + registry row. Every
  // case here asserts birth/discovery behaviour against a GENUINELY EMPTY
  // workspace (zero intents), so strip the seeded record + cursor + registry —
  // otherwise registry counts are off-by-one and the engine asks to select the
  // pre-seeded intent instead of birthing. (Mirrors t160's beforeEach.)
  removeWorkspaceRecord(proj);
});
afterEach(() => {
  cleanupTestProject(proj);
});

interface Run {
  status: number;
  stdout: string;
  out: string;
}
function util(args: string[], p = proj, extraEnv: Record<string, string> = {}): Run {
  const env = { ...process.env, ...extraEnv };
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  const r = Bun.spawnSync({
    cmd: [BUN, UTIL, ...args, "--project-dir", p],
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const stdout = r.stdout.toString();
  return { status: r.exitCode, stdout, out: `${stdout}${r.stderr.toString()}` };
}
function next(args: string[], p = proj): Run {
  const env = { ...process.env };
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  const r = Bun.spawnSync({
    cmd: [BUN, ORCH, "next", ...args, "--project-dir", p],
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const stdout = r.stdout.toString();
  return { status: r.exitCode, stdout, out: `${stdout}${r.stderr.toString()}` };
}

function runHook(hook: string, payload: Record<string, unknown>, p = proj): Run {
  const r = Bun.spawnSync({
    cmd: [BUN, hook],
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CLAUDE_PROJECT_DIR: p },
  });
  const stdout = r.stdout.toString();
  return { status: r.exitCode, stdout, out: `${stdout}${r.stderr.toString()}` };
}

function fireHook(hook: string, payload: Record<string, unknown>, p = proj): number {
  return runHook(hook, payload, p).status;
}

function bindCreatedSession(sessionId: string, created: Run, p = proj): number {
  return fireHook(
    REBUILD_STAGE_GRAPH,
    {
      hook_event_name: "PostToolUse",
      session_id: sessionId,
      tool_name: "Bash",
      tool_input: {
        command: "bun .claude/tools/aidlc-utility.ts intent-create --scope poc",
      },
      tool_response: created.stdout,
    },
    p,
  );
}

const intentsDir = (p: string, space = "default"): string =>
  join(p, "aidlc", "spaces", space, "intents");

function readIntentAudit(p: string, record: string): string {
  const auditDir = join(intentsDir(p), record, "audit");
  if (!existsSync(auditDir)) return "";
  return readdirSync(auditDir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => readFileSync(join(auditDir, name), "utf-8"))
    .join("\n");
}

function hookHeartbeat(p: string, record: string, name: string): string {
  return join(intentsDir(p), record, ".aidlc-hooks-health", name);
}

// ============================================================
// Auto-birth on an empty workspace
// ============================================================
describe("t164 auto-birth (intent-create) on an empty workspace", () => {
  test("intent-create help flags and the init alias are read-only", () => {
    for (const args of [
      ["intent-create", "--help"],
      ["intent-create", "-h"],
      ["init", "--help"],
    ]) {
      const r = util(args);
      expect(r.status, args.join(" ")).toBe(0);
      expect(r.stdout, args.join(" ")).toContain(
        "Usage: aidlc-utility intent-create --scope <scope>",
      );
    }
    expect(existsSync(intentsDir(proj))).toBe(false);
  });

  test("birth mints a per-intent record under spaces/default/intents/ with state", () => {
    const r = util(["intent-create", "--scope", "poc"]);
    expect(r.status).toBe(0);
    const records = readdirSync(intentsDir(proj)).filter((d) =>
      existsSync(join(intentsDir(proj), d, "aidlc-state.md")),
    );
    expect(records.length).toBe(1);
    // The born record carries a full state file routed to the first post-init
    // stage (not just the bind stub).
    const state = readFileSync(join(intentsDir(proj), records[0], "aidlc-state.md"), "utf-8");
    expect(state).toContain("## Current Status");
    expect(state).toContain("- **Scope**: poc");
    // The registry carries the in-flight row.
    const reg = readIntentRegistry(proj);
    expect(reg.length).toBe(1);
    expect(reg[0].status).toBe("in-flight");
    expect(reg[0].scope).toBe("poc");
    // WORKFLOW_STARTED landed in the born intent's audit shard.
    const auditDir = join(intentsDir(proj), records[0], "audit");
    const shards = existsSync(auditDir)
      ? readdirSync(auditDir).map((f) => readFileSync(join(auditDir, f), "utf-8")).join("\n")
      : "";
    expect(shards).toContain("**Event**: WORKFLOW_STARTED");
  });

  test("birth materializes the active-space cursor missing from a fresh clone", () => {
    const cursor = join(proj, "aidlc", "active-space");
    rmSync(cursor, { force: true });
    expect(existsSync(cursor)).toBe(false);

    const r = util(["intent-create", "--scope", "poc"]);
    expect(r.status).toBe(0);
    expect(readFileSync(cursor, "utf-8")).toBe("default\n");
    expect(activeIntent(proj)).not.toBeNull();
  });

  test("birth slugs the freeform --arguments description (SLUG_RE-valid)", () => {
    const r = util(["intent-create", "--scope", "feature", "--arguments", "Build the Auth Service!!"]);
    expect(r.status).toBe(0);
    const dir = activeIntent(proj);
    expect(dir).not.toBeNull();
    // <YYMMDD>-<short-label>; the label is the slugified description (≤24 chars,
    // so "build the auth service" survives whole). Date prefix → chronological
    // sort; no trailing hex (the canonical id is the UUIDv7 in the registry row).
    expect(dir).toMatch(/^\d{6}-build-the-auth-service$/);
  });

  test("the engine NAMES intent-create on a fresh workspace (read-only — no state written)", () => {
    const r = next(["--scope", "poc"]);
    const d = JSON.parse(r.stdout.trim());
    expect(d.kind).toBe("print");
    expect(d.message).toContain("intent-create --scope poc");
    // next is read-only: it must NOT have birthed anything.
    expect(existsSync(intentsDir(proj))).toBe(false);
    expect(existsSync(seededStateFile(proj))).toBe(false);
  });
});

// ============================================================
// intent-create fails CLOSED on a truly-bare invocation
// ============================================================
describe("t164 intent-create fails closed on a bare invocation", () => {
  // A bare `intent-create` (no --scope, no --arguments, no --label) used to
  // silently mint a garbage default-scope intent (scope resolved to the install
  // default, slug == the scope token, empty description), a routing fumble that
  // became actual corrupt workspace state. Birth is a mutation; a bare call is
  // almost always a mistake, so it must REFUSE, mutate nothing, and point at the
  // blessed entry points.
  test("bare intent-create is refused (exit 1) and mints NOTHING", () => {
    const r = util(["intent-create"]);
    expect(r.status).toBe(1);
    // Actionable refusal naming the missing flags + the blessed paths.
    expect(r.out).toContain("intent-create refused");
    expect(r.out).toContain("--scope");
    // No mutation: no intents dir, no state file, no registry.
    expect(existsSync(intentsDir(proj))).toBe(false);
    expect(existsSync(seededStateFile(proj))).toBe(false);
    expect(readIntentRegistry(proj).length).toBe(0);
  });

  test("every value-bearing birth flag rejects valueless or blank occurrences", () => {
    for (const args of [
      ["intent-create", "--scope"],
      ["intent-create", "--arguments"],
      ["intent-create", "--label"],
      ["intent-create", "--scope", "poc", "--depth"],
      ["intent-create", "--scope", "poc", "--test-strategy"],
      ["intent-create", "--scope", "poc", "--review"],
      ["intent-create", "--scope", "poc", "--repos"],
      ["intent-create", "--scope", "poc", "--project-dir"],
      ["intent-create", "--scope", "   "],
      ["intent-create", "--arguments", "   "],
      ["intent", "create", "--label", ""],
      ["intent-create", "--scope", "poc", "--depth", "   "],
      ["intent-create", "--scope", "poc", "--test-strategy", ""],
      ["intent-create", "--scope", "poc", "--review", "   "],
      ["intent-create", "--scope", "poc", "--repos", "   "],
      ["intent-create", "--scope", "poc", "--project-dir", ""],
    ]) {
      const r = util(args);
      expect(r.status, args.join(" ")).toBe(1);
      expect(r.out, args.join(" ")).toContain("requires a nonblank value");
      expect(existsSync(intentsDir(proj)), args.join(" ")).toBe(false);
      expect(readIntentRegistry(proj).length, args.join(" ")).toBe(0);
    }
  });

  // The guard keys on "no scope AND no args AND no label"; each of the three
  // signals independently satisfies it, so every blessed path still births.
  test("any one of --scope / --arguments / --label satisfies the guard (births)", () => {
    // --scope alone: the engine's birth print directive always supplies it.
    expect(util(["intent-create", "--scope", "poc"]).status).toBe(0);
    removeWorkspaceRecord(proj);
    // --arguments alone: the init runner forwards a freeform description here;
    // scope falls back to the install default (a legitimate, described birth).
    expect(util(["intent-create", "--arguments", "build a thing"]).status).toBe(0);
    removeWorkspaceRecord(proj);
    // --label alone: a described birth with an explicit dir-name essence.
    expect(util(["intent-create", "--label", "some work"]).status).toBe(0);
  });
});

// ============================================================
// The `done` directive on a COMPLETED intent hints at the new-work escape
// hatch. A scope-runner's forwarding loop stops at `done`; without the hint the
// conductor dead-ends there with no cue that genuinely new, unrelated work is
// startable via `next --new-intent`.
// ============================================================
describe("t164 done-on-completed carries the new-work hint", () => {
  test("next on a completed intent returns done whose reason names next --new-intent", () => {
    // beforeEach left an empty workspace; seed a single completed intent (Current
    // Stage = final stage, Status = Completed) so next finds no in-scope stage and
    // emits `done` (the engine is read-only; it never auto-births alongside it).
    seedStateFile(proj, join(FIXTURES_DIR, "state-completed.md"));
    const r = next([]);
    const d = JSON.parse(r.stdout.trim());
    expect(d.kind).toBe("done");
    // The completion reason is preserved AND the new-work hint is appended.
    expect(d.reason).toContain("Workflow complete");
    expect(d.reason).toContain("next --new-intent --scope");
    // It's a HINT, not an auto-birth: the reason still frames it as an offer
    // gated on a human yes, and next mutated nothing. seedStateFile writes only
    // the state file (no intents.json row), so the registry starts empty, and
    // next being read-only, it stays empty (no second intent auto-born).
    expect(d.reason.toLowerCase()).toContain("never auto-birth");
    expect(readIntentRegistry(proj).length).toBe(0);
  });
});

// ============================================================
// The birth directive has TWO tails: a fresh-start birth re-enters the loop in
// the same session ("re-run `next` to continue"), while a --new-intent birth (a
// 2nd, unrelated intent alongside an active/completed one) tells the conductor
// to STOP and hand off to a fresh session so the new intent doesn't inherit the
// prior intent's context.
// ============================================================
describe("t164 --new-intent birth directive hands off to a fresh session", () => {
  test("next --new-intent emits a command-neutral birth print that STOPs for a fresh session", () => {
    // Seed an active intent so this mirrors the real 'second intent while one is
    // live' path; Branch 4a fires before any continuation branch regardless.
    seedStateFile(proj, join(FIXTURES_DIR, "state-mid-ideation.md"));
    const r = next(["--new-intent", "--scope", "bugfix", "fix the flaky login test"]);
    const d = JSON.parse(r.stdout.trim());
    expect(d.kind).toBe("print");
    // Names the birth move for the CONFIRMED scope (not the active intent's scope).
    expect(d.message).toContain("intent-create --scope bugfix");
    // The shared engine names the handoff but leaves concrete entry/reset
    // commands to each harness SKILL.
    expect(d.message).toContain("STOP");
    expect(d.message).toContain("fresh session");
    expect(d.message).toContain("AI-DLC entry skill");
    expect(d.message).not.toContain("/clear");
    expect(d.message).not.toContain("run `/aidlc`");
    expect(d.message).not.toContain("invoke `/aidlc`");
    expect(d.message).not.toContain("$aidlc");
    // It must NOT carry the fresh-start continuation tail (that would keep the
    // new intent in the polluted session).
    expect(d.message).not.toContain("re-run `next` to continue");
    // next is read-only: naming the birth move mutates nothing.
    expect(readIntentRegistry(proj).length).toBe(0);
  });

  test("next --new-intent rejects a missing or blank description", () => {
    seedStateFile(proj, join(FIXTURES_DIR, "state-mid-ideation.md"));
    for (const args of [
      ["--new-intent", "--scope", "bugfix"],
      ["--new-intent", "--scope", "bugfix", "   "],
    ]) {
      const r = next(args);
      const d = JSON.parse(r.stdout.trim());
      expect(d.kind, args.join(" ")).toBe("error");
      expect(d.message, args.join(" ")).toContain("requires a nonblank new-work description");
      expect(readIntentRegistry(proj).length, args.join(" ")).toBe(0);
    }
  });

  test("the complete fresh-session handoff attributes SESSION_ENDED to the original intent", () => {
    // Real production order: the host starts a session before any workflow
    // exists, then the first /aidlc invocation births the initial intent.
    expect(
      fireHook(SESSION_START, { source: "startup", session_id: "handoff-session-1" }),
    ).toBe(0);
    const firstCreate = util([
      "intent-create",
      "--scope",
      "poc",
      "--arguments",
      "first intent",
    ]);
    expect(firstCreate.status).toBe(0);
    expect(bindCreatedSession("handoff-session-1", firstCreate)).toBe(0);
    const first = activeIntent(proj);
    expect(first).not.toBeNull();
    expect(
      existsSync(join(proj, "aidlc", ".aidlc-sessions", "handoff-session-1")),
    ).toBe(true);

    const directive = next([
      "--new-intent",
      "--scope",
      "bugfix",
      "fix the flaky login test",
    ]);
    expect(JSON.parse(directive.stdout.trim()).kind).toBe("print");
    const secondCreate = util([
      "intent-create",
      "--scope",
      "bugfix",
      "--arguments",
      "fix the flaky login test",
      "--label",
      "flaky login",
    ]);
    expect(secondCreate.status).toBe(0);
    expect(bindCreatedSession("handoff-session-1", secondCreate)).toBe(0);
    const second = activeIntent(proj);
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);

    // The real Stop hook must honor the explicit post-create handoff instead of
    // consulting the newly active intent and forcing this old conversation back
    // into its pending workflow.
    const stop = runHook(CONTINUE_WORKFLOW, {
      hook_event_name: "Stop",
      stop_hook_active: false,
      session_id: "handoff-session-1",
    });
    expect(stop.status).toBe(0);
    expect(stop.stdout.trim()).toBe("");

    expect(
      fireHook(SESSION_END, {
        reason: "clear",
        session_id: "handoff-session-1",
      }),
    ).toBe(0);
    expect(activeIntent(proj)).toBe(second);

    const firstAudit = readIntentAudit(proj, first!);
    const secondAuditBeforeStart = readIntentAudit(proj, second!);
    expect(firstAudit).toContain("**Event**: SESSION_ENDED");
    expect(firstAudit).toContain("**Reason**: clear");
    expect(secondAuditBeforeStart).not.toContain("**Event**: SESSION_ENDED");
    expect(existsSync(hookHeartbeat(proj, first!, "session-end.last"))).toBe(true);
    expect(existsSync(hookHeartbeat(proj, second!, "session-end.last"))).toBe(false);

    expect(
      fireHook(SESSION_START, { source: "clear", session_id: "handoff-session-2" }),
    ).toBe(0);
    const secondAudit = readIntentAudit(proj, second!);
    expect(secondAudit).toContain("**Event**: SESSION_STARTED");
    expect(secondAudit).not.toContain("**Event**: SESSION_ENDED");
  });

  test("concurrent pre-workflow sessions bind only the session that invoked birth", () => {
    expect(fireHook(SESSION_START, { source: "startup", session_id: "session-a" })).toBe(0);
    expect(fireHook(SESSION_START, { source: "startup", session_id: "session-b" })).toBe(0);

    const created = util([
      "intent-create",
      "--scope",
      "poc",
      "--arguments",
      "session A work",
    ]);
    expect(created.status).toBe(0);
    expect(bindCreatedSession("session-a", created)).toBe(0);

    const record = activeIntent(proj);
    const registry = readIntentRegistry(proj);
    expect(record).not.toBeNull();
    expect(registry.length).toBe(1);
    const sessions = join(proj, "aidlc", ".aidlc-sessions");
    expect(readFileSync(join(sessions, "session-a"), "utf-8").trim()).toBe(
      registry[0].uuid,
    );
    expect(existsSync(join(sessions, "session-b"))).toBe(false);

    // B has no ownership or handoff evidence. SessionEnd must not fall back to
    // A's active cursor.
    expect(existsSync(join(sessions, "session-b.handoff.json"))).toBe(false);
    expect(
      fireHook(SESSION_END, { reason: "logout", session_id: "session-b" }),
    ).toBe(0);
    expect(readIntentAudit(proj, record!)).not.toContain("**Event**: SESSION_ENDED");
    expect(
      fireHook(SESSION_END, { reason: "clear", session_id: "session-a" }),
    ).toBe(0);
    const audit = readIntentAudit(proj, record!);
    expect(audit).toContain("**Event**: SESSION_ENDED");
    expect(audit).toContain("**Reason**: clear");
  });

  test("a later birth cannot claim an unstamped session when an intent already exists", () => {
    expect(
      util(["intent-create", "--scope", "poc", "--arguments", "existing intent"]).status,
    ).toBe(0);
    const sessions = join(proj, "aidlc", ".aidlc-sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, ".current-session"), "legacy-unstamped\n", "utf-8");

    expect(
      util(["intent-create", "--scope", "bugfix", "--arguments", "later intent"]).status,
    ).toBe(0);
    expect(existsSync(join(sessions, "legacy-unstamped"))).toBe(false);
  });

  test("a fresh-start birth (no --new-intent) keeps the same-session continuation tail", () => {
    // Empty workspace (beforeEach stripped the record): a named scope on a fresh
    // workspace is the fresh-start birth, it should re-enter the loop in-session.
    const r = next(["--scope", "bugfix"]);
    const d = JSON.parse(r.stdout.trim());
    expect(d.kind).toBe("print");
    expect(d.message).toContain("intent-create --scope bugfix");
    // Fresh-start tail is unchanged (the birth-directive pins expect this too):
    // continue in-session, no fresh-session hand-off.
    expect(d.message).toContain("re-run `next` to continue");
    expect(d.message).not.toContain("STOP");
    expect(d.message).not.toContain("fresh session");
  });
});

// ============================================================
// P7 — an intent records its repo set at birth (--repos / sibling discovery)
// ============================================================
describe("t165 P7 intent repo set captured at birth", () => {
  // Make a child dir of the workspace look like a git repo (a .git dir is enough
  // for discoverSiblingRepos, which only probes existsSync(<dir>/.git)).
  const makeRepo = (p: string, name: string): void => {
    mkdirSync(join(p, name, ".git"), { recursive: true });
  };

  test("explicit --repos a,b is recorded (sorted, deduped) in intents.json", () => {
    const r = util(["intent-create", "--scope", "feature", "--repos", "repo-b,repo-a,repo-a"]);
    expect(r.status).toBe(0);
    const reg = readIntentRegistry(proj);
    expect(reg.length).toBe(1);
    // Sorted + deduped by resolveBirthRepoSet.
    expect(reg[0].repos).toEqual(["repo-a", "repo-b"]);
    // listIntents surfaces the same set through the query layer.
    expect(listIntents(proj)[0].repos).toEqual(["repo-a", "repo-b"]);
  });

  test("explicit --repos wins even when sibling repos are present on disk", () => {
    makeRepo(proj, "discovered-x");
    const r = util(["intent-create", "--scope", "feature", "--repos", "only-this"]);
    expect(r.status).toBe(0);
    expect(readIntentRegistry(proj)[0].repos).toEqual(["only-this"]);
  });

  test("absent --repos, sibling auto-discovery records the .git children", () => {
    makeRepo(proj, "svc-api");
    makeRepo(proj, "svc-web");
    // A non-repo child dir (no .git) is NOT discovered.
    mkdirSync(join(proj, "docs-only"), { recursive: true });
    const r = util(["intent-create", "--scope", "feature"]);
    expect(r.status).toBe(0);
    expect(readIntentRegistry(proj)[0].repos).toEqual(["svc-api", "svc-web"]);
  });

  test("no --repos and no sibling repos → no repos row (legacy single-repo inference)", () => {
    const r = util(["intent-create", "--scope", "poc"]);
    expect(r.status).toBe(0);
    // An empty set records NO repos row — the lone repo is inferred downstream.
    expect(readIntentRegistry(proj)[0].repos).toBeUndefined();
  });

  test("the engine dir and workspace-internal dirs are excluded from discovery", () => {
    // SEED ships a harness dir + the aidlc roof; neither is a code repo.
    mkdirSync(join(proj, ".claude", ".git"), { recursive: true });
    mkdirSync(join(proj, "aidlc", ".git"), { recursive: true });
    makeRepo(proj, "real-repo");
    const r = util(["intent-create", "--scope", "feature"]);
    expect(r.status).toBe(0);
    expect(readIntentRegistry(proj)[0].repos).toEqual(["real-repo"]);
  });

  test("an invalid --repos entry is rejected before any mutation", () => {
    const r = util(["intent-create", "--scope", "feature", "--repos", "../escape"]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("Invalid --repos entry");
    // Nothing was born.
    expect(existsSync(intentsDir(proj))).toBe(false);
  });
});

// ============================================================
// Concurrent-birth integrity (workspace-keyed append lock)
// ============================================================
describe("t164 concurrent-birth integrity", () => {
  test("two simultaneous births → 2 distinct intents, no lost intents.json update", async () => {
    // Fire two intent-create processes in parallel against the SAME empty
    // workspace. The workspace-bucket append lock serializes the empty-check +
    // the intents.json append, so the second sees the first's row — both births
    // land distinct uuids + dirs, and intents.json carries BOTH (no lost write).
    const env = { ...process.env };
    delete env.AWS_AIDLC_DEFAULT_SCOPE;
    const spawnBirth = (scope: string) =>
      Bun.spawn({
        cmd: [BUN, UTIL, "intent-create", "--scope", scope, "--project-dir", proj],
        stdout: "ignore",
        stderr: "ignore",
        env,
      });
    const procs = [spawnBirth("poc"), spawnBirth("bugfix")];
    const codes = await Promise.all(procs.map((c) => c.exited));
    expect(codes).toEqual([0, 0]);

    // Two distinct record dirs.
    const records = readdirSync(intentsDir(proj)).filter((d) =>
      existsSync(join(intentsDir(proj), d, "aidlc-state.md")),
    );
    expect(records.length).toBe(2);
    expect(new Set(records).size).toBe(2);

    // intents.json carries BOTH rows with distinct uuids (no lost update).
    const reg = readIntentRegistry(proj);
    expect(reg.length).toBe(2);
    expect(new Set(reg.map((e) => e.uuid)).size).toBe(2);
  });
});

// ============================================================
// New work while an intent is active
// ============================================================
describe("t164 new-work-while-active", () => {
  test("a second birth alongside an active intent adds a second intent", () => {
    expect(util(["intent-create", "--scope", "poc"]).status).toBe(0);
    const first = activeIntent(proj);
    expect(util(["intent-create", "--scope", "feature", "--arguments", "second feature"]).status).toBe(0);
    const reg = readIntentRegistry(proj);
    expect(reg.length).toBe(2);
    // The active-intent cursor now points at the SECOND (most recent) birth.
    const second = activeIntent(proj);
    expect(second).not.toBe(first);
  });

  test("bare /aidlc resumes the active intent (happy path, not a birth)", () => {
    expect(util(["intent-create", "--scope", "feature"]).status).toBe(0);
    // With state present, `next` resolves the happy path — never a birth print.
    const r = next([]);
    const d = JSON.parse(r.stdout.trim());
    expect(d.kind).not.toBe("print"); // not a birth
    expect(r.out).not.toContain("intent-create");
  });
});

// ============================================================
// slugify (free-text → SLUG_RE-valid, deterministic, idempotent)
// ============================================================
describe("t164 slugify", () => {
  const SLUG_RE = /^[a-z][a-z0-9-]*$/;
  test("free text → SLUG_RE-valid", () => {
    for (const input of [
      "Build the Auth Service",
      "  Fix #123: login!! ",
      "123 starts with a digit",
      "ALL CAPS PROJECT",
      "héllo wörld",
    ]) {
      expect(slugify(input)).toMatch(SLUG_RE);
    }
  });
  test("deterministic + idempotent (slugify(slugify(x)) === slugify(x))", () => {
    for (const input of ["Build the Auth Service", "a--b__c", "trailing---"]) {
      const once = slugify(input);
      expect(slugify(input)).toBe(once); // deterministic
      expect(slugify(once)).toBe(once); // idempotent
    }
  });
  test("empty-ish input falls back to a valid slug", () => {
    expect(slugify("")).toMatch(SLUG_RE);
    expect(slugify("!!!")).toMatch(SLUG_RE);
  });
});

// ============================================================
// Intent status lifecycle (birth in-flight; complete; abandoned stays in-flight)
// ============================================================
describe("t164 intent status lifecycle", () => {
  test("birth writes in-flight; updateIntentStatus flips to complete; an abandoned intent stays in-flight", () => {
    expect(util(["intent-create", "--scope", "poc"]).status).toBe(0);
    const dir = activeIntent(proj);
    expect(dir).not.toBeNull();
    expect(readIntentRegistry(proj)[0].status).toBe("in-flight");

    // The completion flip (the same call complete-workflow makes under the
    // workspace lock). Note: in-process here we are NOT under a held lock, but
    // updateIntentStatus only does a read-modify-write of intents.json — the
    // lock requirement is for concurrency, not correctness of a single write.
    const changed = updateIntentStatus(proj, dir as string, "complete");
    expect(changed).toBe(true);
    expect(readIntentRegistry(proj)[0].status).toBe("complete");

    // Birth a SECOND intent and leave it (abandon) — it stays in-flight, never
    // self-completes.
    expect(util(["intent-create", "--scope", "bugfix"]).status).toBe(0);
    const abandoned = readIntentRegistry(proj).find((e) => e.scope === "bugfix");
    expect(abandoned?.status).toBe("in-flight");
  });
});

// ============================================================
// The query layer: listSpaces / listIntents + --json shape
// ============================================================
describe("t164 query layer (listSpaces / listIntents + --json)", () => {
  test("empty workspace: one (default) space, zero intents; predicates", () => {
    const spaces = listSpaces(proj);
    expect(spaces.length).toBe(1);
    expect(spaces[0].name).toBe("default");
    expect(spaces[0].active).toBe(true);
    expect(listIntents(proj).length).toBe(0);
  });

  test("after birth: listIntents has the in-flight row, flagged active", () => {
    expect(util(["intent-create", "--scope", "poc"]).status).toBe(0);
    const intents = listIntents(proj);
    expect(intents.length).toBe(1);
    expect(intents[0].status).toBe("in-flight");
    expect(intents[0].active).toBe(true);
    expect(intents[0].dirName).toBe(activeIntent(proj));
  });

  test("human and --json agree (intent verb)", () => {
    expect(util(["intent-create", "--scope", "poc"]).status).toBe(0);
    const human = util(["intent"]).stdout;
    const jsonOut = util(["intent", "--json"]).stdout;
    const parsed = JSON.parse(jsonOut.trim());
    // --json carries the structured shape the gate/statusline consume.
    expect(parsed.active).toBe(activeIntent(proj));
    expect(parsed.space).toBe("default");
    expect(Array.isArray(parsed.intents)).toBe(true);
    expect(parsed.intents.length).toBe(1);
    expect(parsed.intents[0].status).toBe("in-flight");
    // The human listing names the same active record dir.
    expect(human).toContain(parsed.active);
  });

  test("space --json reports default active; space-create adds a >1-space predicate", () => {
    const before = JSON.parse(util(["space", "--json"]).stdout.trim());
    expect(before.active).toBe("default");
    expect(before.spaces.length).toBe(1);

    expect(util(["space-create", "payments"]).status).toBe(0);
    const after = JSON.parse(util(["space", "--json"]).stdout.trim());
    expect(after.spaces.length).toBe(2);
    expect(after.spaces.map((s: { name: string }) => s.name).sort()).toEqual(["default", "payments"]);
    // space-create seeds the new space's memory (org.md copied + fresh stubs).
    const mem = join(proj, "aidlc", "spaces", "payments", "memory");
    expect(existsSync(join(mem, "org.md"))).toBe(true);
    expect(existsSync(join(mem, "team.md"))).toBe(true);
    expect(existsSync(join(mem, "project.md"))).toBe(true);

    // Switching the active space writes the cursor AND surgically re-points the
    // harness-native rule includes so the next turn loads the switched space's
    // method. Here the temp project has no committed include files, so the
    // re-point is a graceful no-op — the cursor write is the load-bearing
    // assertion. (The include re-point itself is unit-tested in
    // t-active-space-includes against the real committed surfaces.)
    expect(util(["space", "payments"]).status).toBe(0);
    expect(activeSpace(proj)).toBe("payments");
  });

  test("space switch slugifies its target (raw multi-word name resolves to the stored slug)", () => {
    // space-create stores slugify(raw); the switch must slugify too, else a raw
    // multi-word name would miss ("Unknown space").
    expect(util(["space-create", "My Space"]).status).toBe(0);
    expect(slugify("My Space")).toBe("my-space");
    const r = util(["space", "My Space"]);
    expect(r.status).toBe(0);
    expect(activeSpace(proj)).toBe("my-space");
  });

  test("switching intents is a pure cursor write", () => {
    expect(util(["intent-create", "--scope", "poc"]).status).toBe(0);
    const a = activeIntent(proj) as string;
    expect(util(["intent-create", "--scope", "feature"]).status).toBe(0);
    const b = activeIntent(proj) as string;
    expect(b).not.toBe(a);
    // Switch back to the first by its record-dir name.
    expect(util(["intent", a]).status).toBe(0);
    expect(activeIntent(proj)).toBe(a);
  });

  test("`intent help` / `space help` print help, not a failed switch", () => {
    // The engine routes these to help upstream; this is the tool-level
    // backstop for a direct invocation. A failed switch here used to die with
    // an error whose recovery text steered the conductor into birthing.
    const i = util(["intent", "help"]);
    expect(i.status).toBe(0);
    expect(i.stdout).toContain("Utilities:");
    expect(i.out).not.toContain("Unknown intent");
    const s = util(["space", "help"]);
    expect(s.status).toBe(0);
    expect(s.stdout).toContain("Utilities:");
    expect(s.out).not.toContain("Unknown space");
  });

  test("'help' is refused at both creation chokepoints", () => {
    // The router treats `intent help` / `space help` as help requests, so a
    // record slugged "help" would be unswitchable by name. Creation refuses it.
    const b = util(["intent-create", "--scope", "poc", "--label", "help"]);
    expect(b.status).not.toBe(0);
    expect(b.out).toContain("reserved name");
    // The refusal fires before ANY mutation - the intents dir was never even
    // created on this stripped workspace, and if present it holds no record.
    const dirs = existsSync(intentsDir(proj)) ? readdirSync(intentsDir(proj)) : [];
    expect(dirs.filter((d) => d.endsWith("-help"))).toEqual([]);
    // space-create refuses help-shaped names with a help steer (before
    // slugify, so it also covers the "-h" case below).
    const c = util(["space-create", "help"]);
    expect(c.status).not.toBe(0);
    expect(c.out).toContain("Did you mean /aidlc --help");
  });

  test("`space-create -h` is a help request, not a space named h", () => {
    // slugify("-h") is "h", which is NOT a reserved name, so the reserved-name
    // guard alone would create a junk space. The handler refuses help-shaped
    // args before slugify.
    const c = util(["space-create", "-h"]);
    expect(c.status).not.toBe(0);
    expect(c.out).toContain("Did you mean /aidlc --help");
    // No space was created - neither "h" nor anything help-shaped.
    expect(existsSync(join(proj, "aidlc", "spaces", "h"))).toBe(false);
  });

  test("an unknown-space switch fails without inviting creation", () => {
    // Pins the wording the same way the unknown-intent case below is pinned:
    // the error must steer to switching between EXISTING spaces only, never
    // read as an instruction to create one.
    const r = util(["space", "no-such-space"]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("Unknown space");
    expect(r.out).toContain("no-such-space");
    expect(r.out).toContain("Do not create a space to recover");
  });

  test("an unknown-intent switch fails without inviting new work", () => {
    // The error must steer to the read-only listing ONLY - the old "describe
    // what to build to start a new one" tail read as an instruction to birth.
    // die() JSON-encodes the message, so inner quotes arrive escaped - match
    // on quote-free fragments.
    const r = util(["intent", "no-such-intent"]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("Unknown intent");
    expect(r.out).toContain("no-such-intent");
    expect(r.out).not.toContain("describe what to build");
    expect(r.out).toContain("Do not start a new workflow");
  });
});

// ============================================================
// Doctor readiness against the shipped shell (P4: no --init artifact)
// ============================================================
describe("t164 doctor readiness against the shipped shell", () => {
  test("a project with .claude/ + aidlc/spaces/default/memory/ passes the shell-ready row", () => {
    // P9: createTestProject seeds the shell (incl. aidlc/spaces/default/memory/);
    // add .claude/ so the readiness row has both halves it checks. (mkdir is
    // idempotent — memory/ already exists from the seed.)
    mkdirSync(join(proj, ".claude"), { recursive: true });
    mkdirSync(join(proj, "aidlc", "spaces", "default", "memory"), { recursive: true });
    const r = util(["doctor"]);
    expect(r.out).toContain("workspace shell ready");
    // The readiness row must NOT reference the retired --init.
    expect(r.out).not.toContain("run `/aidlc --init`");
  });

  test("a project missing the default memory dir fails the shell-ready row", () => {
    mkdirSync(join(proj, ".claude"), { recursive: true });
    // P9: createTestProject seeds the shipped shell INCLUDING
    // aidlc/spaces/default/memory/; this case needs it ABSENT so the readiness
    // row fails. Strip the seeded memory dir.
    rmSync(join(proj, "aidlc", "spaces", "default", "memory"), {
      recursive: true,
      force: true,
    });
    const r = util(["doctor"]);
    // The row fails and points at copying the shell from dist/.
    expect(r.out).toContain("workspace shell ready");
    expect(r.out).toMatch(/copy the workspace shell from `dist\/claude\//);
  });
});

// ============================================================
// Migration wiring: a flat aidlc-docs/ project migrates on first birth + git-rm
// ============================================================
describe("t164 migration wiring (flat → per-intent on first birth)", () => {
  test("intent-create migrates a flat project, git-rm's the flat tree, and is a no-op re-run", () => {
    // Seed a flat (pre-workspace) project: aidlc-docs/aidlc-state.md present, no
    // intent record, no .migrated marker.
    const flat = join(proj, "aidlc-docs");
    mkdirSync(flat, { recursive: true });
    writeFileSync(
      join(flat, "aidlc-state.md"),
      "# AI-DLC State Tracking\n## Project Information\n- **Scope**: feature\n- **Project**: Legacy App\n",
      "utf-8",
    );
    writeFileSync(join(flat, "audit.md"), "# AI-DLC Audit Log\n", "utf-8");
    const cursor = join(proj, "aidlc", "active-space");
    rmSync(cursor, { force: true });

    expect(
      fireHook(SESSION_START, {
        source: "startup",
        session_id: "migration-session",
      }),
    ).toBe(0);
    const r = util([
      "intent-create",
      "--scope",
      "feature",
      "--review",
      "none",
    ]);
    expect(r.status).toBe(0);
    expect(bindCreatedSession("migration-session", r)).toBe(0);
    expect(readFileSync(cursor, "utf-8")).toBe("default\n");

    // Migration moved the flat state into a per-intent record (NOT a second
    // freshly-minted intent on top).
    const records = readdirSync(intentsDir(proj)).filter((d) =>
      existsSync(join(intentsDir(proj), d, "aidlc-state.md")),
    );
    expect(records.length).toBe(1);
    expect(
      readFileSync(
        join(proj, "aidlc", ".aidlc-sessions", "migration-session"),
        "utf-8",
      ).trim(),
    ).toBe(readIntentRegistry(proj)[0]?.uuid);
    // The migrated record carries the flat project's state (Project field).
    const migrated = readFileSync(join(intentsDir(proj), records[0], "aidlc-state.md"), "utf-8");
    expect(migrated).toContain("Legacy App");
    expect(migrated).toContain("- **Review Override**: none");
    const migratedAudit = readAllAuditShards(proj);
    expect(migratedAudit).toContain("**Event**: REVIEW_CLASS_CHANGED");
    expect(migratedAudit).toContain("**Review Override**: none");
    // The .migrated marker was written (idempotency key).
    expect(existsSync(join(proj, "aidlc", ".migrated"))).toBe(true);
    // The flat tree was removed from the working tree post-move (git-rm step).
    expect(existsSync(join(flat, "aidlc-state.md"))).toBe(false);

    // No-op re-run: a second birth does NOT re-migrate (marker present) — it
    // births a fresh second intent instead.
    const r2 = util(["intent-create", "--scope", "poc"]);
    expect(r2.status).toBe(0);
    const records2 = readdirSync(intentsDir(proj)).filter((d) =>
      existsSync(join(intentsDir(proj), d, "aidlc-state.md")),
    );
    expect(records2.length).toBe(2);
  });
});
