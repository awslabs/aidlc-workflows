// covers: function:guardPolicyAcceptsChanges
// covers: audit:CHANGE_ACCEPTED
//
// Guard Policy off means off: with relaxed or off, a changed input after a
// review is recorded and said once, never a stop. Strict keeps its stop, and
// the step that stop names is one AI-DLC accepts in that state.

import {
  NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  auditBlockField,
  guardPolicyAcceptsChanges,
  readAllAuditShards,
  workspaceSourceListing,
  writeBaselineSourceSnapshot,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { AIDLC_MEMORY_SRC, AIDLC_SRC, FIXTURES_DIR } from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const REVIEWER = "aidlc-architecture-reviewer-agent";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Policy = "strict" | "relaxed" | "off";

function git(dir: string, args: string[]): void {
  const result = spawnSync("git", ["-C", dir, ...args], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

// Code Generation at its gate for two Units, alpha and beta, with the policy
// line the work carries. `source` names where that line came from.
function project(policy: Policy, source = "from scope feature"): { project: string; record: string } {
  const project = mkdtempSync(join(tmpdir(), "aidlc-t-off-means-off-"));
  dirs.push(project);
  cpSync(AIDLC_MEMORY_SRC, join(project, "aidlc"), { recursive: true });
  const intents = join(project, "aidlc", "spaces", "default", "intents");
  const record = join(intents, "fixture-intent");
  mkdirSync(record, { recursive: true });
  writeFileSync(
    join(intents, "intents.json"),
    `${JSON.stringify([{ uuid: "80000000-0000-4000-8000-000000000001", slug: "fixture", dirName: "fixture-intent", status: "active", repos: [] }])}\n`,
  );
  writeFileSync(join(intents, ".active-intent"), "fixture-intent\n");
  git(project, ["init", "-q"]);
  git(project, ["config", "user.email", "t@test"]);
  git(project, ["config", "user.name", "t"]);
  writeFileSync(join(project, "app.ts"), "export const app = 1;\n");
  git(project, ["add", "-A"]);
  git(project, ["commit", "-qm", "seed"]);
  const state = readFileSync(join(FIXTURES_DIR, "state-mid-ideation.md"), "utf-8")
    .replace("- **Change Control**: strict (from scope feature)", `- **Guard Policy**: ${policy} (${source})`)
    .replace("- **Current Stage**: feasibility", "- **Current Stage**: code-generation\n- **Construction Iteration**: stage-major")
    .replace("- [ ] code-generation — EXECUTE", "- [?] code-generation — EXECUTE");
  writeFileSync(join(record, "aidlc-state.md"), state, "utf-8");
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
  return { project, record };
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

// One READY review of a Unit's Code Generation, claiming `writes`.
function review(dir: string, record: string, unit: string, writes: string[]): void {
  const unitPath = unitDir(record, unit);
  writeFileSync(
    join(unitPath, "source-manifest.json"),
    `${JSON.stringify({ stage: "code-generation", unit, version: 1, writes: writes.map((path) => ({ path })) }, null, 2)}\n`,
  );
  const prior = (readAllAuditShards(dir).match(new RegExp(`\\*\\*Event\\*\\*: REVIEW_REQUESTED[\\s\\S]*?\\*\\*Unit\\*\\*: ${unit}`, "g")) ?? []).length;
  const iteration = String(prior + 1);
  const plan = join(unitPath, "code-generation-plan.md");
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

function approve(dir: string): { rc: number; out: string } {
  return cli(STATE, ["approve", "code-generation", "--user-input", "ship"], dir);
}

function acceptedRows(dir: string): string[] {
  return readAllAuditShards(dir)
    .split(/\n---\n/)
    .filter((block) => auditBlockField(block, "Event") === "CHANGE_ACCEPTED");
}

describe("the one reader", () => {
  test("relaxed and off accept changes from any source; strict and an unreadable line do not", () => {
    for (const [line, accepts] of [
      ["off (from scope feature)", true],
      ["off (set by you)", true],
      ["relaxed (from scope test-pro-validation)", true],
      ["off (from scope a-composed-plan)", true],
      ["strict (from scope enterprise)", false],
      ["sideways (set by you)", false],
    ] as const) {
      const empty = mkdtempSync(join(tmpdir(), "aidlc-t-off-reader-"));
      dirs.push(empty);
      const state = `# State\n- **Scope**: feature\n- **Guard Policy**: ${line}\n`;
      expect(guardPolicyAcceptsChanges(empty, state), line).toBe(accepts);
    }
  });
});

describe("a file no unit claims", () => {
  for (const policy of ["off", "relaxed"] as const) {
    test(`${policy}: it is kept, said once, recorded once, and the stage completes`, () => {
      const { project: dir, record } = project(policy);
      review(dir, record, "alpha", ["app.ts"]);
      review(dir, record, "beta", []);
      writeFileSync(join(dir, "extra.ts"), "export const extra = 1;\n");
      review(dir, record, "beta", []);
      const done = approve(dir);
      expect(done.rc, done.out).toBe(0);
      expect(done.out).toContain("These files changed outside any unit's work in Code Generation: extra.ts. Kept them.");
      const rows = acceptedRows(dir).filter((block) => auditBlockField(block, "Changed")?.includes("extra.ts"));
      expect(rows.length).toBe(1);
    });
  }

  test("strict: it still stops, and the step it names clears it", () => {
    const { project: dir, record } = project("strict", "from scope enterprise");
    review(dir, record, "alpha", ["app.ts"]);
    review(dir, record, "beta", []);
    writeFileSync(join(dir, "extra.ts"), "export const extra = 1;\n");
    review(dir, record, "beta", []);
    const refused = approve(dir);
    expect(refused.rc).toBe(1);
    expect(refused.out).toContain("Add each path to the owning unit's source-manifest.json");
    // The named step: claim the path in its Unit and record that Unit's review.
    review(dir, record, "alpha", ["app.ts", "extra.ts"]);
    const done = approve(dir);
    expect(done.rc, done.out).toBe(0);
  });
});

describe("the record of where the stage started is missing on this machine", () => {
  function dropBaseline(record: string): void {
    const snapshots = join(record, ".aidlc-engine", "source-review", "code-generation");
    for (const name of readdirSync(snapshots)) {
      if (name.startsWith("baseline-")) rmSync(join(snapshots, name));
    }
  }

  test("off: the stage completes with one line", () => {
    const { project: dir, record } = project("off");
    review(dir, record, "alpha", ["app.ts"]);
    review(dir, record, "beta", []);
    dropBaseline(record);
    const done = approve(dir);
    expect(done.rc, done.out).toBe(0);
    expect(done.out).toContain("I could not check Code Generation for files changed outside the units on this machine; carrying on.");
  });

  test("strict: it stops naming a restart, and that restart is accepted", () => {
    const { project: dir, record } = project("strict", "from scope enterprise");
    review(dir, record, "alpha", ["app.ts"]);
    review(dir, record, "beta", []);
    dropBaseline(record);
    const refused = approve(dir);
    expect(refused.rc).toBe(1);
    expect(refused.out).toContain("--stage code-generation` to check again from here");
    expect(refused.out).not.toContain("AIDLC_SKIP_SOURCE_FRESHNESS");
    const restart = cli(ORCHESTRATE, ["next", "--stage", "code-generation"], dir);
    expect(restart.rc, restart.out).toBe(0);
    expect(restart.out).not.toContain('"kind":"error"');
  });
});
