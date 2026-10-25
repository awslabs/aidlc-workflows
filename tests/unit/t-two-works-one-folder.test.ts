// covers: function:otherOpenWorkClaims, function:otherWorkNote, function:withAgentNotes
//
// Two pieces of work building in one folder: two chats, each on its own piece
// of work in the same checkout, both in Code Generation. A file the other open
// work's Units list in their source manifests is that work's: this work's
// completion check never counts it as a change of its own (strict neither
// refuses nor asks the review again over it; relaxed and off name only what is
// nobody's), and this work's Code Generation step names it to the agent to
// leave as it is. A complete or archived work's claims count for nothing.
// Mechanism: the shipped tools spawned over a temp project (review, approve,
// next), and the step's notes in-process.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { otherWorkNote, validateDirective, withAgentNotes } from "../../dist/claude/.claude/tools/aidlc-directive.ts";
import {
  auditBlockField,
  otherOpenWorkClaims,
  readAllAuditShards,
  sourceClaimCovers,
  workspaceSourceListing,
  writeBaselineSourceSnapshot,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { AIDLC_MEMORY_SRC, AIDLC_SRC, FIXTURES_DIR } from "../harness/fixtures.ts";

// The stage's checks run before each review and gate (completionChecksStep,
// t-checks-before-review); this file's fixture documents are not written for
// them and its subject is not them, so they stay off here.
process.env.AIDLC_DISABLE_SENSORS = "1";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const REVIEWER = "aidlc-architecture-reviewer-agent";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, args: string[]): void {
  const result = spawnSync("git", ["-C", dir, ...args], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

// Code Generation at its gate, or still to build.
function stateAt(policy: string, atGate = true): string {
  return readFileSync(join(FIXTURES_DIR, "state-mid-ideation.md"), "utf-8")
    .replace("- **Change Control**: strict (from scope feature)", `- **Guard Policy**: ${policy} (from scope feature)`)
    .replace("- **Current Stage**: feasibility", "- **Current Stage**: code-generation\n- **Construction Iteration**: stage-major")
    .replace("- [ ] units-generation \u2014 EXECUTE", "- [x] units-generation \u2014 EXECUTE")
    .replace("- [ ] code-generation \u2014 EXECUTE", `- [${atGate ? "?" : " "}] code-generation \u2014 EXECUTE`);
}

interface Setup {
  project: string;
  record: string;
  other: string;
}

// This work (Units alpha and beta) at Code Generation, with the other piece of
// work recorded beside it: in this space, or in a second one, with the status
// its registry row carries.
function project(policy: string, other: { status?: string; space?: string; atGate?: boolean } = {}): Setup {
  const project = mkdtempSync(join(tmpdir(), "aidlc-t-two-works-"));
  dirs.push(project);
  cpSync(AIDLC_MEMORY_SRC, join(project, "aidlc"), { recursive: true });
  const intents = join(project, "aidlc", "spaces", "default", "intents");
  const otherIntents = join(project, "aidlc", "spaces", other.space ?? "default", "intents");
  const record = join(intents, "fixture-intent");
  const otherRecord = join(otherIntents, "other-work");
  mkdirSync(record, { recursive: true });
  mkdirSync(otherRecord, { recursive: true });
  const self = { uuid: "80000000-0000-4000-8000-000000000001", slug: "fixture", dirName: "fixture-intent", status: "in-flight", repos: [] };
  const theirs = { uuid: "80000000-0000-4000-8000-000000000002", slug: "export-fix", dirName: "other-work", status: other.status ?? "in-flight", repos: [] };
  if (otherIntents === intents) {
    writeFileSync(join(intents, "intents.json"), `${JSON.stringify([self, theirs])}\n`);
  } else {
    writeFileSync(join(intents, "intents.json"), `${JSON.stringify([self])}\n`);
    writeFileSync(join(otherIntents, "intents.json"), `${JSON.stringify([theirs])}\n`);
  }
  writeFileSync(join(intents, "active-intent"), "fixture-intent\n");
  git(project, ["init", "-q"]);
  git(project, ["config", "user.email", "t@test"]);
  git(project, ["config", "user.name", "t"]);
  writeFileSync(join(project, "app.ts"), "export const app = 1;\n");
  git(project, ["add", "-A"]);
  git(project, ["commit", "-qm", "seed"]);
  writeFileSync(join(record, "aidlc-state.md"), stateAt(policy, other.atGate), "utf-8");
  writeFileSync(join(otherRecord, "aidlc-state.md"), stateAt(policy), "utf-8");
  const dag = join(record, "inception", "units-generation");
  mkdirSync(dag, { recursive: true });
  writeFileSync(
    join(dag, "unit-of-work-dependency.md"),
    "```yaml\nunits:\n  - name: alpha\n    depends_on: []\n  - name: beta\n    depends_on: []\n```\n",
  );
  const listing = workspaceSourceListing(project);
  if (listing === null) throw new Error("fixture source listing missing");
  const baseline = writeBaselineSourceSnapshot(project, "code-generation", listing);
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature", "Source Baseline": baseline }, project);
  appendAuditEntry("STAGE_STARTED", { Stage: "code-generation", Agent: "aidlc-developer-agent", "Source Baseline": baseline }, project);
  // Audit timestamps are second-precision; the next rows come from child
  // processes, so wait out this second rather than tie with them.
  const second = Math.floor(Date.now() / 1000);
  while (Math.floor(Date.now() / 1000) === second) {}
  return { project, record, other: otherRecord };
}

function cli(tool: string, args: string[], dir: string): { rc: number; out: string } {
  const env = {
    ...process.env,
    AIDLC_SKIP_ARTIFACT_GUARD: "1",
    AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
    AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
    AIDLC_SKIP_REVISION_BACKSTOP: "1",
  };
  const r = spawnSync(process.execPath, [tool, ...args, "--project-dir", dir], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env,
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function unitDir(record: string, unit: string): string {
  const dir = join(record, "construction", unit, "code-generation");
  mkdirSync(dir, { recursive: true });
  for (const name of ["code-generation-plan.md", "unit-test-instructions.md", "code-summary.md", "traceability.json"]) {
    if (!existsSync(join(dir, name))) writeFileSync(join(dir, name), name.endsWith(".json") ? "{}\n" : `# ${name}\n`);
  }
  return dir;
}

function manifest(record: string, unit: string, writes: string[]): void {
  writeFileSync(
    join(unitDir(record, unit), "source-manifest.json"),
    `${JSON.stringify({ stage: "code-generation", unit, version: 1, writes: writes.map((path) => ({ path })) }, null, 2)}\n`,
  );
}

// One READY review of this work's Unit, claiming `writes`.
function review(dir: string, record: string, unit: string, writes: string[]): void {
  manifest(record, unit, writes);
  const plan = join(unitDir(record, unit), "code-generation-plan.md");
  const prior = (readAllAuditShards(dir).match(new RegExp(`\\*\\*Event\\*\\*: REVIEW_REQUESTED[\\s\\S]*?\\*\\*Unit\\*\\*: ${unit}`, "g")) ?? []).length;
  const iteration = String(prior + 1);
  const body = readFileSync(plan, "utf-8");
  const cut = body.search(/^## Review[ \t]*$/m);
  if (cut !== -1) writeFileSync(plan, `${body.slice(0, cut).replace(/\s+$/, "")}\n`);
  const args = ["review", "--stage", "code-generation", "--reviewer", REVIEWER, "--unit", unit, "--iteration", iteration];
  const request = cli(LOG, args, dir);
  expect(request.rc, request.out).toBe(0);
  appendFileSync(plan, `\n## Review\n\n**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Iteration:** ${iteration}\n\n### Findings\n\nNo blocking findings.\n`);
  const verdict = cli(LOG, [...args, "--verdict", "READY"], dir);
  expect(verdict.rc, verdict.out).toBe(0);
}

// The other chat builds its Unit gamma: the file, and gamma's manifest listing it.
function otherBuilds(setup: Setup, file = "version.ts", claim = file): void {
  mkdirSync(join(setup.project, file, ".."), { recursive: true });
  writeFileSync(join(setup.project, file), "export const version = 2;\n");
  manifest(setup.other, "gamma", [claim]);
}

function approve(dir: string): { rc: number; out: string } {
  return cli(STATE, ["approve", "code-generation", "--user-input", "ship"], dir);
}

function acceptedNaming(dir: string, file: string): string[] {
  return readAllAuditShards(dir)
    .split(/\n---\n/)
    .filter((block) => auditBlockField(block, "Event") === "CHANGE_ACCEPTED" && (block.includes(file)));
}

describe("the other work's file, at this work's completion", () => {
  test("strict: built before this work's last review, it is that work's and the stage completes", () => {
    const setup = project("strict");
    review(setup.project, setup.record, "alpha", ["app.ts"]);
    otherBuilds(setup);
    review(setup.project, setup.record, "beta", []);
    const done = approve(setup.project);
    expect(done.rc, done.out).toBe(0);
    expect(done.out).not.toContain("version.ts");
  });

  test("strict: built after this work's last review, no review is asked again and the stage completes", () => {
    const setup = project("strict");
    review(setup.project, setup.record, "alpha", ["app.ts"]);
    review(setup.project, setup.record, "beta", []);
    otherBuilds(setup);
    const done = approve(setup.project);
    expect(done.rc, done.out).toBe(0);
    expect(done.out).not.toContain("SOURCE_REVIEW_STALE");
  });

  for (const policy of ["relaxed", "off"] as const) {
    test(`${policy}: the stage completes and no line or record names the other work's file`, () => {
      for (const order of ["before", "after"] as const) {
        const setup = project(policy);
        review(setup.project, setup.record, "alpha", ["app.ts"]);
        if (order === "before") otherBuilds(setup);
        review(setup.project, setup.record, "beta", []);
        if (order === "after") otherBuilds(setup);
        const done = approve(setup.project);
        expect(done.rc, `${order}: ${done.out}`).toBe(0);
        expect(done.out, order).not.toContain("version.ts");
        expect(acceptedNaming(setup.project, "version.ts"), order).toEqual([]);
      }
    });
  }

  test("a folder the other work claims covers what is built under it", () => {
    const setup = project("strict");
    review(setup.project, setup.record, "alpha", ["app.ts"]);
    otherBuilds(setup, "export/timeout.ts", "export/");
    review(setup.project, setup.record, "beta", []);
    const done = approve(setup.project);
    expect(done.rc, done.out).toBe(0);
  });

  test("the other work recorded in a second space is still in this folder", () => {
    const setup = project("strict", { space: "side" });
    review(setup.project, setup.record, "alpha", ["app.ts"]);
    otherBuilds(setup);
    review(setup.project, setup.record, "beta", []);
    const done = approve(setup.project);
    expect(done.rc, done.out).toBe(0);
  });
});

describe("what is still this work's to account for", () => {
  test("strict: a file nobody claims, beside the other work's, is refused and named alone", () => {
    const setup = project("strict");
    review(setup.project, setup.record, "alpha", ["app.ts"]);
    otherBuilds(setup);
    writeFileSync(join(setup.project, "extra.ts"), "export const extra = 1;\n");
    review(setup.project, setup.record, "beta", []);
    const refused = approve(setup.project);
    expect(refused.rc).toBe(1);
    expect(refused.out).toContain("1 change made during Code Generation that no Unit's review covers (extra.ts)");
  });

  test("relaxed: a file nobody claims, beside the other work's, is the one kept and said", () => {
    const setup = project("relaxed");
    review(setup.project, setup.record, "alpha", ["app.ts"]);
    otherBuilds(setup);
    writeFileSync(join(setup.project, "extra.ts"), "export const extra = 1;\n");
    review(setup.project, setup.record, "beta", []);
    const done = approve(setup.project);
    expect(done.rc, done.out).toBe(0);
    expect(done.out).toContain("These files changed outside any unit's work in Code Generation: extra.ts. Kept them.");
  });

  for (const status of ["complete", "archived"]) {
    test(`a ${status} piece of work's claims count for nothing`, () => {
      const setup = project("strict", { status });
      review(setup.project, setup.record, "alpha", ["app.ts"]);
      otherBuilds(setup);
      review(setup.project, setup.record, "beta", []);
      const refused = approve(setup.project);
      expect(refused.rc).toBe(1);
      expect(refused.out).toContain("no Unit's review covers (version.ts)");
      expect(otherOpenWorkClaims(setup.project, "code-generation")).toEqual([]);
    });
  }

  test("a manifest of the other work that does not read is left out, and nothing is said about it", () => {
    const setup = project("strict");
    review(setup.project, setup.record, "alpha", ["app.ts"]);
    writeFileSync(join(setup.project, "version.ts"), "export const version = 2;\n");
    writeFileSync(join(unitDir(setup.other, "gamma"), "source-manifest.json"), "{ not json\n");
    review(setup.project, setup.record, "beta", []);
    expect(otherOpenWorkClaims(setup.project, "code-generation")).toEqual([]);
    const refused = approve(setup.project);
    expect(refused.rc).toBe(1);
    expect(refused.out).toContain("no Unit's review covers (version.ts)");
    expect(refused.out).not.toContain("source-manifest.json");
  });

  test("a record no registry row names is live work, named by its folder", () => {
    const setup = project("strict");
    otherBuilds(setup);
    const registry = join(setup.project, "aidlc", "spaces", "default", "intents", "intents.json");
    const rows = JSON.parse(readFileSync(registry, "utf-8")) as { dirName: string }[];
    writeFileSync(registry, `${JSON.stringify(rows.filter((row) => row.dirName !== "other-work"))}\n`);
    expect(otherOpenWorkClaims(setup.project, "code-generation").map((work) => [work.work, work.paths])).toEqual([["other-work", ["version.ts"]]]);
  });

  test("in a Bolt worktree, one Unit's own folder, there is no other work", () => {
    const setup = project("strict");
    otherBuilds(setup);
    mkdirSync(join(setup.project, ".aidlc"), { recursive: true });
    writeFileSync(join(setup.project, ".aidlc", "worktree-meta.json"), "{}\n");
    expect(otherOpenWorkClaims(setup.project, "code-generation")).toEqual([]);
  });

  test("a write of the other work that does not read here drops only that write", () => {
    const setup = project("strict");
    writeFileSync(join(setup.project, "version.ts"), "export const version = 2;\n");
    writeFileSync(
      join(unitDir(setup.other, "gamma"), "source-manifest.json"),
      `${JSON.stringify({ stage: "code-generation", unit: "gamma", version: 1, writes: [{ repo: "elsewhere", path: "x.ts" }, { path: "version.ts" }] })}\n`,
    );
    const works = otherOpenWorkClaims(setup.project, "code-generation");
    expect(works.map((work) => [work.work, work.paths])).toEqual([["export-fix", ["version.ts"]]]);
  });
});

// Sibling repositories, one recorded by each piece of work: a claim is keyed to
// the repository its own work records, never to this work's.
describe("two pieces of work, each on its own sibling repository", () => {
  function siblings(own: string[], theirs: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "aidlc-t-two-works-repos-"));
    dirs.push(dir);
    const intents = join(dir, "aidlc", "spaces", "default", "intents");
    for (const name of ["fixture-intent", "other-work"]) {
      mkdirSync(join(intents, name), { recursive: true });
      writeFileSync(join(intents, name, "aidlc-state.md"), "# State\n- **Scope**: feature\n");
    }
    writeFileSync(join(intents, "intents.json"), `${JSON.stringify([
      { uuid: "80000000-0000-4000-8000-000000000001", slug: "fixture", dirName: "fixture-intent", status: "in-flight", repos: own },
      { uuid: "80000000-0000-4000-8000-000000000002", slug: "export-fix", dirName: "other-work", status: "in-flight", repos: theirs },
    ])}\n`);
    writeFileSync(join(intents, "active-intent"), "fixture-intent\n");
    for (const repo of ["repo-a", "repo-b"]) {
      const path = join(dir, repo);
      mkdirSync(join(path, "src"), { recursive: true });
      git(path, ["init", "-q"]);
      git(path, ["config", "user.email", "t@test"]);
      git(path, ["config", "user.name", "t"]);
      writeFileSync(join(path, "src", "index.ts"), `export const name = "${repo}";\n`);
      git(path, ["add", "-A"]);
      git(path, ["commit", "-qm", "seed"]);
    }
    manifest(join(intents, "other-work"), "gamma", ["src/index.ts"]);
    return dir;
  }

  test("the other work's path is its own repository's, not the same path in this work's", () => {
    const works = otherOpenWorkClaims(siblings(["repo-a"], ["repo-b"]), "code-generation");
    expect(works.map((work) => work.paths)).toEqual([["repo-b/src/index.ts"]]);
    expect(sourceClaimCovers("repo-b\0src/index.ts", works[0].claims)).toBe(true);
    expect(sourceClaimCovers("repo-a\0src/index.ts", works[0].claims)).toBe(false);
    expect(otherWorkNote(works)).toContain("export-fix (`repo-b/src/index.ts`)");
  });

  test("this work records both repositories: the other work's claim in its one repository still reads", () => {
    const works = otherOpenWorkClaims(siblings(["repo-a", "repo-b"], ["repo-b"]), "code-generation");
    expect(works.map((work) => work.paths)).toEqual([["repo-b/src/index.ts"]]);
    expect(sourceClaimCovers("repo-b\0src/index.ts", works[0].claims)).toBe(true);
  });
});

describe("this work's Code Generation step", () => {
  // `next`, then `continue <receipt>` for each rules part, as the conductor runs
  // them. The person has answered what Code Generation asks first: the folder
  // had code when the work started as a new project, and it stays one; one
  // session builds the Units.
  function step(dir: string): Record<string, unknown> {
    const kept = cli(DISPATCHER, ["engine", "workspace", "reclassify", "--project-type", "greenfield", "--intent", "fixture-intent", "--space", "default"], dir);
    expect(kept.rc, kept.out).toBe(0);
    const solo = cli(STATE, ["set-unit-ownership", "solo"], dir);
    expect(solo.rc, solo.out).toBe(0);
    let args = ["next"];
    for (let hop = 0; hop < 20; hop++) {
      const next = cli(ORCHESTRATE, args, dir);
      expect(next.rc, next.out).toBe(0);
      const line = next.out.split("\n").find((row) => row.startsWith("{") && row.includes('"kind"'));
      expect(line, next.out).toBeDefined();
      const directive = JSON.parse(line as string) as Record<string, unknown>;
      if (directive.kind !== "load-steering") return directive;
      args = ["continue", String(directive.receipt ?? "")];
    }
    throw new Error("the rules parts did not reach the step in 20 hops");
  }

  test("names the other work's files, to leave as they are", () => {
    const setup = project("off", { atGate: false });
    otherBuilds(setup);
    const directive = step(setup.project);
    expect(directive.kind).toBe("run-stage");
    expect(directive.stage).toBe("code-generation");
    const note = String(directive.other_work_note ?? "");
    expect(note).toContain("export-fix (`version.ts`)");
    expect(note).toContain("Leave them as they are unless this work's plan changes one of them.");
  });

  test("a gate shown again, whose body does not run, carries no such note", () => {
    const setup = project("off");
    otherBuilds(setup);
    const directive = step(setup.project);
    expect(directive.gate_only).toBe(true);
    expect(directive.other_work_note).toBeUndefined();
  });

  test("with no other open work, or only a complete one, it carries no such note", () => {
    const alone = project("off", { atGate: false });
    expect(step(alone.project).other_work_note).toBeUndefined();
    const finished = project("off", { status: "complete", atGate: false });
    otherBuilds(finished);
    expect(step(finished.project).other_work_note).toBeUndefined();
  });
});

describe("this work's Code Generation review", () => {
  function request(setup: Setup): string {
    manifest(setup.record, "alpha", ["app.ts"]);
    const r = cli(LOG, ["review", "--stage", "code-generation", "--reviewer", REVIEWER, "--unit", "alpha", "--iteration", "1"], setup.project);
    expect(r.rc, r.out).toBe(0);
    const line = r.out.split("\n").find((row) => row.includes('"emitted":"REVIEW_REQUESTED"'));
    return String((JSON.parse(line as string) as { agent_note?: unknown }).agent_note ?? "");
  }

  test("the reviewer's brief names the other work's files, as not this work's to review", () => {
    const setup = project("strict");
    otherBuilds(setup);
    expect(request(setup)).toContain(
      "Its brief carries this line word for word: Another piece of work is under way in this same folder, and these " +
        "files are its own: export-fix (`version.ts`). They are not this work's to review: raise no finding about one " +
        "unless this work's plan changes it.",
    );
  });

  test("with no other open work, the request says nothing of it", () => {
    expect(request(project("strict"))).not.toContain("Its brief carries");
  });
});

describe("the note's words", () => {
  const works = [{ work: "export-fix", record: "aidlc/spaces/default/intents/other-work", paths: ["version.ts", "src/b.ts"] }];
  const runStage = (fields: Record<string, unknown>): Record<string, unknown> => ({
    kind: "run-stage",
    stage: "code-generation",
    phase: "construction",
    stage_file: ".claude/aidlc-common/stages/construction/code-generation.md",
    ceremony: { summary_confirmation: "off" },
    ...fields,
  });

  test("a dispatched step's brief carries the note; an inline step's brief does not exist", () => {
    const note = otherWorkNote(works);
    const dispatched = withAgentNotes(runStage({ mode: "subagent", other_work_note: note }), "bun x.ts") as Record<string, unknown>;
    expect(String(dispatched.brief_note)).toContain(note);
    const inline = withAgentNotes(runStage({ mode: "inline", other_work_note: note }), "bun x.ts") as Record<string, unknown>;
    expect(inline.brief_note).toBeUndefined();
    expect(inline.other_work_note).toBe(note);
  });

  test("names at most five pieces of work, then how many more and where their files are listed", () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ work: `w${i}`, record: `aidlc/spaces/default/intents/w${i}`, paths: [`f${i}.ts`] }));
    const note = otherWorkNote(many);
    expect(note).toContain("w4 (`f4.ts`); and 2 more, each listing its files in its Units' source manifests");
    expect(note).not.toContain("w5");
  });

  test("names no field, and caps a long list with where the rest are", () => {
    const note = otherWorkNote([{ ...works[0], paths: Array.from({ length: 25 }, (_, i) => `f${i}.ts`) }]);
    expect(note).toContain("`f19.ts`, and 5 more, listed in its Units' source manifests under `aidlc/spaces/default/intents/other-work/construction/`");
    expect(note).not.toContain("`f20.ts`");
    expect(note.replace(/`[^`]*`/g, " ")).not.toMatch(/[a-z]+_[a-z_]+/);
  });

  test("rides only a run-stage", () => {
    const note = otherWorkNote(works);
    const errorsNaming = (result: ReturnType<typeof validateDirective>): string[] =>
      result.valid ? [] : result.errors.filter((error) => error.includes("other_work_note"));
    expect(errorsNaming(validateDirective(runStage({ mode: "inline", other_work_note: note })))).toEqual([]);
    expect(errorsNaming(validateDirective({ kind: "print", message: "x", other_work_note: note })).length).toBeGreaterThan(0);
  });
});
