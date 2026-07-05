// covers: subcommand:aidlc-utility:intent-birth, subcommand:aidlc-utility:intent, subcommand:aidlc-utility:space, subcommand:aidlc-utility:space-create, function:birthIntent, function:listSpaces, function:listIntents, function:slugify, function:updateIntentStatus, function:migrateFlatLayout, function:resolveBirthRepoSet, function:discoverSiblingRepos
//
// Mechanism: cli (spawned dist tools) + in-process pure-function asserts.
// P4 — retire the user-facing --init; the engine auto-births the first intent
// CONDUCTOR-SIDE (the read-only routing tool NAMES the move, the deterministic
// `intent-birth` handler mutates), plus the intent/space verb families + the
// deterministic query layer (listSpaces/listIntents, --json) + the intent
// status lifecycle + the migration wiring.
//
// WHY a subprocess for birth: intent-birth mutates the workspace under the
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
  removeWorkspaceRecord,
  seededStateFile,
} from "../harness/fixtures.ts";
import {
  activeIntent,
  activeSpace,
  listIntents,
  listSpaces,
  readIntentRegistry,
  slugify,
  updateIntentStatus,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");
const UTIL = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-utility.ts");
const ORCH = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-orchestrate.ts");

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

const intentsDir = (p: string, space = "default"): string =>
  join(p, "aidlc", "spaces", space, "intents");

// ============================================================
// Auto-birth on an empty workspace
// ============================================================
describe("t164 auto-birth (intent-birth) on an empty workspace", () => {
  test("birth mints a per-intent record under spaces/default/intents/ with state", () => {
    const r = util(["intent-birth", "--scope", "poc"]);
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

  test("birth slugs the freeform --arguments description (SLUG_RE-valid)", () => {
    const r = util(["intent-birth", "--scope", "feature", "--arguments", "Build the Auth Service!!"]);
    expect(r.status).toBe(0);
    const dir = activeIntent(proj);
    expect(dir).not.toBeNull();
    // <YYMMDD>-<short-label>; the label is the slugified description (≤24 chars,
    // so "build the auth service" survives whole). Date prefix → chronological
    // sort; no trailing hex (the canonical id is the UUIDv7 in the registry row).
    expect(dir).toMatch(/^\d{6}-build-the-auth-service$/);
  });

  test("the engine NAMES intent-birth on a fresh workspace (read-only — no state written)", () => {
    const r = next(["--scope", "poc"]);
    const d = JSON.parse(r.stdout.trim());
    expect(d.kind).toBe("print");
    expect(d.message).toContain("intent-birth --scope poc");
    // next is read-only: it must NOT have birthed anything.
    expect(existsSync(intentsDir(proj))).toBe(false);
    expect(existsSync(seededStateFile(proj))).toBe(false);
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
    const r = util(["intent-birth", "--scope", "feature", "--repos", "repo-b,repo-a,repo-a"]);
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
    const r = util(["intent-birth", "--scope", "feature", "--repos", "only-this"]);
    expect(r.status).toBe(0);
    expect(readIntentRegistry(proj)[0].repos).toEqual(["only-this"]);
  });

  test("absent --repos, sibling auto-discovery records the .git children", () => {
    makeRepo(proj, "svc-api");
    makeRepo(proj, "svc-web");
    // A non-repo child dir (no .git) is NOT discovered.
    mkdirSync(join(proj, "docs-only"), { recursive: true });
    const r = util(["intent-birth", "--scope", "feature"]);
    expect(r.status).toBe(0);
    expect(readIntentRegistry(proj)[0].repos).toEqual(["svc-api", "svc-web"]);
  });

  test("no --repos and no sibling repos → no repos row (legacy single-repo inference)", () => {
    const r = util(["intent-birth", "--scope", "poc"]);
    expect(r.status).toBe(0);
    // An empty set records NO repos row — the lone repo is inferred downstream.
    expect(readIntentRegistry(proj)[0].repos).toBeUndefined();
  });

  test("the engine dir and workspace-internal dirs are excluded from discovery", () => {
    // SEED ships a harness dir + the aidlc roof; neither is a code repo.
    mkdirSync(join(proj, ".claude", ".git"), { recursive: true });
    mkdirSync(join(proj, "aidlc", ".git"), { recursive: true });
    makeRepo(proj, "real-repo");
    const r = util(["intent-birth", "--scope", "feature"]);
    expect(r.status).toBe(0);
    expect(readIntentRegistry(proj)[0].repos).toEqual(["real-repo"]);
  });

  test("an invalid --repos entry is rejected before any mutation", () => {
    const r = util(["intent-birth", "--scope", "feature", "--repos", "../escape"]);
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
    // Fire two intent-birth processes in parallel against the SAME empty
    // workspace. The workspace-bucket append lock serializes the empty-check +
    // the intents.json append, so the second sees the first's row — both births
    // land distinct uuids + dirs, and intents.json carries BOTH (no lost write).
    const env = { ...process.env };
    delete env.AWS_AIDLC_DEFAULT_SCOPE;
    const spawnBirth = (scope: string) =>
      Bun.spawn({
        cmd: [BUN, UTIL, "intent-birth", "--scope", scope, "--project-dir", proj],
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
    expect(util(["intent-birth", "--scope", "poc"]).status).toBe(0);
    const first = activeIntent(proj);
    expect(util(["intent-birth", "--scope", "feature", "--arguments", "second feature"]).status).toBe(0);
    const reg = readIntentRegistry(proj);
    expect(reg.length).toBe(2);
    // The active-intent cursor now points at the SECOND (most recent) birth.
    const second = activeIntent(proj);
    expect(second).not.toBe(first);
  });

  test("bare /aidlc resumes the active intent (happy path, not a birth)", () => {
    expect(util(["intent-birth", "--scope", "feature"]).status).toBe(0);
    // With state present, `next` resolves the happy path — never a birth print.
    const r = next([]);
    const d = JSON.parse(r.stdout.trim());
    expect(d.kind).not.toBe("print"); // not a birth
    expect(r.out).not.toContain("intent-birth");
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
    expect(util(["intent-birth", "--scope", "poc"]).status).toBe(0);
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
    expect(util(["intent-birth", "--scope", "bugfix"]).status).toBe(0);
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
    expect(util(["intent-birth", "--scope", "poc"]).status).toBe(0);
    const intents = listIntents(proj);
    expect(intents.length).toBe(1);
    expect(intents[0].status).toBe("in-flight");
    expect(intents[0].active).toBe(true);
    expect(intents[0].dirName).toBe(activeIntent(proj));
  });

  test("human and --json agree (intent verb)", () => {
    expect(util(["intent-birth", "--scope", "poc"]).status).toBe(0);
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
    expect(util(["intent-birth", "--scope", "poc"]).status).toBe(0);
    const a = activeIntent(proj) as string;
    expect(util(["intent-birth", "--scope", "feature"]).status).toBe(0);
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
    const b = util(["intent-birth", "--scope", "poc", "--label", "help"]);
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
  test("intent-birth migrates a flat project, git-rm's the flat tree, and is a no-op re-run", () => {
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

    const r = util(["intent-birth", "--scope", "feature"]);
    expect(r.status).toBe(0);

    // Migration moved the flat state into a per-intent record (NOT a second
    // freshly-minted intent on top).
    const records = readdirSync(intentsDir(proj)).filter((d) =>
      existsSync(join(intentsDir(proj), d, "aidlc-state.md")),
    );
    expect(records.length).toBe(1);
    // The migrated record carries the flat project's state (Project field).
    const migrated = readFileSync(join(intentsDir(proj), records[0], "aidlc-state.md"), "utf-8");
    expect(migrated).toContain("Legacy App");
    // The .migrated marker was written (idempotency key).
    expect(existsSync(join(proj, "aidlc", ".migrated"))).toBe(true);
    // The flat tree was removed from the working tree post-move (git-rm step).
    expect(existsSync(join(flat, "aidlc-state.md"))).toBe(false);

    // No-op re-run: a second birth does NOT re-migrate (marker present) — it
    // births a fresh second intent instead.
    const r2 = util(["intent-birth", "--scope", "poc"]);
    expect(r2.status).toBe(0);
    const records2 = readdirSync(intentsDir(proj)).filter((d) =>
      existsSync(join(intentsDir(proj), d, "aidlc-state.md")),
    );
    expect(records2.length).toBe(2);
  });
});
