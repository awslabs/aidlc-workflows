// covers: subcommand:aidlc-swarm:finalize
//
// A Unit built side by side whose approved plan also updates AI-DLC's design
// records (a contract, a business rule) brings those edits home when it lands,
// merged line by line into the project's own copy, as an inline build of the
// same plan leaves them. When the project's copy cannot take them (another Unit
// or the person changed the same lines first), the project's copy stays as it
// is, the Unit's version is saved beside its Code Generation documents, and
// finalize says so in one line. A clash never fails the landing. The state, the
// audit and AI-DLC's engine files keep their own merges, and in a workspace of
// several repositories a worker that writes only its stage's documents brings
// nothing home this way.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { boltSlugForUnit, recordDir } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { codeGenerationRecordDir } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import { AIDLC_SRC, seededStateFile } from "../harness/fixtures.ts";
import {
  ISOLATED_GIT_ENV, cleanupCheckpointFixtures, fixture, git, nextDirective, prepare, publish, reviewRevisedSource,
  runCheckpointTool, swarm, wt, writeUnitSource,
} from "../harness/swarm-checkpoint.ts";
import {
  NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupCheckpointFixtures);

const CONTRACTS = "inception/application-design/component-contracts.md";
const RULES = "construction/alpha/functional-design/business-rules.md";

type Finalized = {
  units: Array<{ unit: string; status: string; change_notices?: string[] }>;
  merge_failures: Array<{ unit: string; detail: string }>;
};

const record = (pd: string, path: string) => join(recordDir(pd)!, path);
const read = (pd: string, path: string) => readFileSync(record(pd, path), "utf-8");
// A path as the person's project names it: from its root, forward slashes.
const shown = (pd: string, path: string) => relative(pd, record(pd, path)).replace(/\\/g, "/");
const saved = (unit: string, path: string) => `construction/${unit}/code-generation/not-merged/${path}`;

function write(pd: string, path: string, text: string): void {
  mkdirSync(dirname(record(pd, path)), { recursive: true });
  writeFileSync(record(pd, path), text);
}

function commitRecords(pd: string, files: Record<string, string>, also: string[] = []): void {
  for (const [path, text] of Object.entries(files)) write(pd, path, text);
  git(pd, ["add", "--", ...Object.keys(files).map((path) => record(pd, path)), ...also]);
  git(pd, ["-c", "user.name=AI-DLC Tests", "-c", "user.email=tests@example.com", "commit", "-qm", "design records"]);
}

function finalize(pd: string, units: string[], env: Record<string, string> = {}) {
  const r = Bun.spawnSync([process.execPath, join(AIDLC_SRC, "tools", "aidlc-swarm.ts"), "finalize", "--batch", "1",
    "--units", units.join(","), "--claimed", units.join(","), "--project-dir", pd], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    cwd: pd, env: { ...ISOLATED_GIT_ENV, AIDLC_PROJECT_DIR: pd, CLAUDE_PROJECT_DIR: pd, ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const out = r.stdout.toString();
  return { code: r.exitCode, out, err: r.stderr.toString(), envelope: JSON.parse(out) as Finalized };
}

// Each Unit's worker builds its code and edits its worktree's records, then the
// Units are checked, reviewed and finalized together.
function build(pd: string, units: string[], edit: (unit: string, child: string) => void, env: Record<string, string> = {}) {
  units.forEach((unit, index) => {
    writeUnitSource(pd, unit, index + 2);
    edit(unit, wt(pd, unit));
    const checked = swarm(pd, ["check", unit]);
    expect(checked.code, `${checked.out}\n${checked.err}`).toBe(0);
    reviewRevisedSource(pd, unit);
  });
  return finalize(pd, units, env);
}

function land(pd: string, unit: string): void {
  const merged = runCheckpointTool(pd, "tools/aidlc-worktree.ts", [
    "merge", "--slug", boltSlugForUnit(unit), "--target", "main", "--strategy", "squash", "--project-dir", pd,
  ]);
  expect(merged.code, `${merged.out}\n${merged.err}`).toBe(0);
  expect(existsSync(wt(pd, unit))).toBe(false);
}

const notices = (finalized: Finalized, unit: string) =>
  finalized.units.find((row) => row.unit === unit)?.change_notices ?? [];

function prepared(pd: string, units = ["alpha"]): void {
  const result = prepare(pd, units);
  expect(result.code, `${result.out}\n${result.err}`).toBe(0);
}

describe("a side-by-side Unit's record edits come home when it lands", () => {
  test("its edits to two records and a record it adds are in the project, and nothing is said", () => {
    const pd = fixture(["alpha"]);
    commitRecords(pd, {
      [RULES]: "# Business rules\n\n- BR-1: one\n",
      [CONTRACTS]: "# Contracts\n\n- C1: one\n",
    });
    prepared(pd);
    const finalized = build(pd, ["alpha"], (_unit, child) => {
      appendFileSync(record(child, RULES), "- BR-2: two\n");
      appendFileSync(record(child, CONTRACTS), "- C2: two\n");
      write(child, "inception/application-design/alpha-notes.md", "# Notes\n\nalpha is 2.\n");
    });
    expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
    expect(notices(finalized.envelope, "alpha")).toEqual([]);
    land(pd, "alpha");
    expect(read(pd, RULES)).toBe("# Business rules\n\n- BR-1: one\n- BR-2: two\n");
    expect(read(pd, CONTRACTS)).toBe("# Contracts\n\n- C1: one\n- C2: two\n");
    expect(read(pd, "inception/application-design/alpha-notes.md")).toBe("# Notes\n\nalpha is 2.\n");
    expect(existsSync(record(pd, "construction/alpha/code-generation/not-merged"))).toBe(false);
    expect((nextDirective(pd) as { kind: string }).kind).toBe("run-stage");
  });

  test("a change the person made elsewhere in the same record since the Unit started is kept beside the Unit's", () => {
    const pd = fixture(["alpha"]);
    commitRecords(pd, { [CONTRACTS]: "# Contracts\n\n- C1: one\n\n## Notes\n\n- N1: a note\n" });
    prepared(pd);
    write(pd, CONTRACTS, "# Contracts\n\n- C1: one\n\n## Notes\n\n- N1: a note the person changed\n");
    const finalized = build(pd, ["alpha"], (_unit, child) => {
      write(child, CONTRACTS, read(child, CONTRACTS).replace("- C1: one\n", "- C1: one\n- C2: two\n"));
    });
    expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
    expect(notices(finalized.envelope, "alpha")).toEqual([]);
    land(pd, "alpha");
    expect(read(pd, CONTRACTS)).toBe("# Contracts\n\n- C1: one\n- C2: two\n\n## Notes\n\n- N1: a note the person changed\n");
  });

  test("records checked out with CRLF line endings merge line by line and keep them", () => {
    const pd = fixture(["alpha"]);
    // AI-DLC's own folder, so the approved source is unchanged.
    writeFileSync(join(pd, "aidlc", ".gitattributes"), "*.md text eol=crlf\n");
    commitRecords(pd, { [CONTRACTS]: "# Contracts\r\n\r\n- C1: one\r\n\r\n## Notes\r\n\r\n- N1: a note\r\n" },
      [join(pd, "aidlc", ".gitattributes")]);
    prepared(pd);
    expect(read(wt(pd), CONTRACTS)).toContain("\r\n");
    write(pd, CONTRACTS, read(pd, CONTRACTS).replace("- N1: a note\r\n", "- N1: a note the person changed\r\n"));
    const finalized = build(pd, ["alpha"], (_unit, child) => {
      write(child, CONTRACTS, read(child, CONTRACTS).replace("- C1: one\r\n", "- C1: one\r\n- C2: two\r\n"));
    });
    expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
    expect(notices(finalized.envelope, "alpha")).toEqual([]);
    expect(read(pd, CONTRACTS))
      .toBe("# Contracts\r\n\r\n- C1: one\r\n- C2: two\r\n\r\n## Notes\r\n\r\n- N1: a note the person changed\r\n");
  });

  test("two Units adding to the same lines: the first comes home, the second is saved and said once, and both land", () => {
    const pd = fixture(["alpha", "beta"]);
    commitRecords(pd, { [CONTRACTS]: "# Contracts\n\n- C1: one\n" });
    prepared(pd, ["alpha", "beta"]);
    const finalized = build(pd, ["alpha", "beta"], (unit, child) => {
      appendFileSync(record(child, CONTRACTS), `- C-${unit}: ${unit}'s contract\n`);
    });
    expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
    expect(finalized.envelope.merge_failures).toEqual([]);
    expect(finalized.envelope.units.map((row) => row.status)).toEqual(["converged", "converged"]);
    expect(read(pd, CONTRACTS)).toBe("# Contracts\n\n- C1: one\n- C-alpha: alpha's contract\n");
    expect(read(pd, saved("beta", CONTRACTS))).toBe("# Contracts\n\n- C1: one\n- C-beta: beta's contract\n");
    expect(notices(finalized.envelope, "alpha")).toEqual([]);
    expect(notices(finalized.envelope, "beta")).toEqual([
      `The beta Unit's version of ${shown(pd, CONTRACTS)} could not be merged into your project's copy, so your copy ` +
        `is unchanged; the Unit's version is saved at ${shown(pd, saved("beta", CONTRACTS))}.`,
    ]);
    land(pd, "alpha");
    land(pd, "beta");
    expect(read(pd, CONTRACTS)).toBe("# Contracts\n\n- C1: one\n- C-alpha: alpha's contract\n");
  });

  test("a record the Unit removed goes, unless the project changed it since, when it stays and that is said", () => {
    const pd = fixture(["alpha"]);
    commitRecords(pd, {
      "inception/application-design/old-notes.md": "# Old notes\n",
      "inception/application-design/older-notes.md": "# Older notes\n",
    });
    prepared(pd);
    write(pd, "inception/application-design/older-notes.md", "# Older notes\n\nThe person still uses these.\n");
    const finalized = build(pd, ["alpha"], (_unit, child) => {
      rmSync(record(child, "inception/application-design/old-notes.md"));
      rmSync(record(child, "inception/application-design/older-notes.md"));
    });
    expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
    expect(existsSync(record(pd, "inception/application-design/old-notes.md"))).toBe(false);
    expect(read(pd, "inception/application-design/older-notes.md")).toBe("# Older notes\n\nThe person still uses these.\n");
    expect(notices(finalized.envelope, "alpha")).toEqual([
      `The alpha Unit removed ${shown(pd, "inception/application-design/older-notes.md")}, but your project's copy ` +
        "differs from what the Unit started with, so it stays as it is.",
    ]);
  });

  test("a record never committed whose same lines the person changed since the Unit started: the project's copy stays and the Unit's is saved", () => {
    const pd = fixture(["alpha"]);
    write(pd, CONTRACTS, "# Contracts\n\n- C1: one\n");
    prepared(pd);
    expect(read(wt(pd), CONTRACTS)).toBe("# Contracts\n\n- C1: one\n");
    write(pd, CONTRACTS, "# Contracts\n\n- C1: one, as the person put it\n");
    const finalized = build(pd, ["alpha"], (_unit, child) => write(child, CONTRACTS, "# Contracts\n\n- C2: two\n"));
    expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
    expect(read(pd, CONTRACTS)).toBe("# Contracts\n\n- C1: one, as the person put it\n");
    expect(read(pd, saved("alpha", CONTRACTS))).toBe("# Contracts\n\n- C2: two\n");
    expect(notices(finalized.envelope, "alpha")).toEqual([
      `The alpha Unit's version of ${shown(pd, CONTRACTS)} could not be merged into your project's copy, so your copy ` +
        `is unchanged; the Unit's version is saved at ${shown(pd, saved("alpha", CONTRACTS))}.`,
    ]);
  });

  test("a worktree moved on to a later project commit merges from where it moved, not from where it was made", () => {
    const pd = fixture(["alpha"]);
    commitRecords(pd, { [CONTRACTS]: "# Contracts\n\n- C1: one\n" });
    prepared(pd);
    commitRecords(pd, { [CONTRACTS]: "# Contracts\n\n- C1: one\n- C1b: committed in the project\n" });
    // The shape prepare's approval transfer leaves when it fast-forwards a kept worktree to the project's commit.
    git(wt(pd), ["merge", "-q", "--ff-only", git(pd, ["rev-parse", "HEAD"])]);
    const finalized = build(pd, ["alpha"], (_unit, child) => appendFileSync(record(child, CONTRACTS), "- C2: two\n"));
    expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
    expect(notices(finalized.envelope, "alpha")).toEqual([]);
    expect(read(pd, CONTRACTS)).toBe("# Contracts\n\n- C1: one\n- C1b: committed in the project\n- C2: two\n");
  });

  test("finalize run again for a Unit whose code changed after it: the merge is not applied twice and a clash is said again", () => {
    const pd = fixture(["alpha"]);
    const state = seededStateFile(pd);
    writeFileSync(state, readFileSync(state, "utf-8").replace(/^- \*\*Change Control\*\*: .*$/m, "- **Guard Policy**: off (set by you)"));
    publish(pd, ["alpha"]);
    commitRecords(pd, { [CONTRACTS]: "# Contracts\n\n- C1: one\n", [RULES]: "# Business rules\n\n- BR-1: one\n" });
    prepared(pd);
    write(pd, RULES, "# Business rules\n\n- BR-1: one, as the person put it\n");
    const first = build(pd, ["alpha"], (_unit, child) => {
      appendFileSync(record(child, CONTRACTS), "- C2: two\n");
      write(child, RULES, "# Business rules\n\n- BR-1: one, as the Unit put it\n");
    });
    expect(first.code, `${first.out}\n${first.err}`).toBe(0);
    const clash = `The alpha Unit's version of ${shown(pd, RULES)} could not be merged into your project's copy, so ` +
      `your copy is unchanged; the Unit's version is saved at ${shown(pd, saved("alpha", RULES))}.`;
    expect(notices(first.envelope, "alpha")).toEqual([clash]);
    writeUnitSource(pd, "alpha", 3);
    const again = swarm(pd, ["finalize", "--batch", "1", "--units", "alpha", "--claimed", "alpha"]);
    expect(again.code, `${again.out}\n${again.err}`).toBe(0);
    expect(notices(JSON.parse(again.out) as Finalized, "alpha")).toEqual([
      "The alpha Unit's code changed after it was reviewed. Kept the change.",
      clash,
    ]);
    expect(read(pd, CONTRACTS)).toBe("# Contracts\n\n- C1: one\n- C2: two\n");
    expect(read(pd, RULES)).toBe("# Business rules\n\n- BR-1: one, as the person put it\n");
    expect(read(pd, saved("alpha", RULES))).toBe("# Business rules\n\n- BR-1: one, as the Unit put it\n");
  });

  test("a landing whose record write fails changes nothing, and finalize run again lands the edits and says the clash", () => {
    const pd = fixture(["alpha"]);
    commitRecords(pd, { [CONTRACTS]: "# Contracts\n\n- C1: one\n", [RULES]: "# Business rules\n\n- BR-1: one\n" });
    prepared(pd);
    write(pd, RULES, "# Business rules\n\n- BR-1: one, as the person put it\n");
    // The saved copy is written before the contracts merge, so both are undone.
    const failed = build(pd, ["alpha"], (_unit, child) => {
      appendFileSync(record(child, CONTRACTS), "- C2: two\n");
      write(child, RULES, "# Business rules\n\n- BR-1: one, as the Unit put it\n");
    }, { AIDLC_TEST: "1", AIDLC_TEST_RECORD_VERIFY_FAIL: CONTRACTS });
    expect(failed.code, `${failed.out}\n${failed.err}`).toBe(2);
    expect(failed.envelope.merge_failures.map((failure) => failure.detail).join("\n")).toContain("injected verification failure");
    expect(read(pd, CONTRACTS)).toBe("# Contracts\n\n- C1: one\n");
    expect(existsSync(record(pd, saved("alpha", RULES)))).toBe(false);
    expect(notices(failed.envelope, "alpha")).toEqual([]);
    const again = finalize(pd, ["alpha"]);
    expect(again.code, `${again.out}\n${again.err}`).toBe(0);
    expect(notices(again.envelope, "alpha")).toEqual([
      `The alpha Unit's version of ${shown(pd, RULES)} could not be merged into your project's copy, so your copy ` +
        `is unchanged; the Unit's version is saved at ${shown(pd, saved("alpha", RULES))}.`,
    ]);
    expect(read(pd, CONTRACTS)).toBe("# Contracts\n\n- C1: one\n- C2: two\n");
    expect(read(pd, saved("alpha", RULES))).toBe("# Business rules\n\n- BR-1: one, as the Unit put it\n");
  });
});

describe("what other merges own, and a workspace of several repositories", () => {
  test("the worker's engine files and runtime graph never come home this way", () => {
    const pd = fixture(["alpha"]);
    commitRecords(pd, { [CONTRACTS]: "# Contracts\n\n- C1: one\n" });
    prepared(pd);
    const graphBefore = existsSync(record(pd, "runtime-graph.json")) ? read(pd, "runtime-graph.json") : null;
    const finalized = build(pd, ["alpha"], (_unit, child) => {
      write(child, ".aidlc-engine/worker-note.json", "{}\n");
      write(child, "runtime-graph.json", "{\"worker\": true}\n");
      appendFileSync(record(child, CONTRACTS), "- C2: two\n");
    });
    expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
    expect(notices(finalized.envelope, "alpha")).toEqual([]);
    expect(existsSync(record(pd, ".aidlc-engine/worker-note.json"))).toBe(false);
    expect(existsSync(record(pd, "runtime-graph.json")) ? read(pd, "runtime-graph.json") : null).toBe(graphBefore);
    expect(read(pd, CONTRACTS)).toBe("# Contracts\n\n- C1: one\n- C2: two\n");
  });

  test("in a workspace of several repositories a worker that writes only its stage's documents brings nothing home and nothing is said", () => {
    const pd = fixture(["alpha"], undefined, false, "repo-a");
    const prepared = swarm(pd, ["prepare", "--batch", "1", "--units", "alpha", "--base", "main"]);
    expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
    const finalized = build(pd, ["alpha"], (unit, child) => {
      // The worker writes the stage's documents in its worktree, as the swarm protocol has it.
      cpSync(codeGenerationRecordDir(pd, unit), codeGenerationRecordDir(child, unit), { recursive: true, force: false });
    });
    expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
    expect(notices(finalized.envelope, "alpha")).toEqual([]);
    expect(existsSync(record(pd, "construction/alpha/code-generation/not-merged"))).toBe(false);
  });
});
