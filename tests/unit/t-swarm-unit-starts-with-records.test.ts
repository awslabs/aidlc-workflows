// covers: subcommand:aidlc-swarm:prepare subcommand:aidlc-swarm:finalize
//
// A Unit built side by side starts with the intent's design records as the
// project has them when its folder is made, committed or not, so its builder
// reads the Unit's functional design. They are the records its landing brings
// home (never the state, the audit, the runtime graph, AI-DLC's `.aidlc-*` files
// or any Unit's own Code Generation folder), and the landing merges the
// builder's edits against that copy: an edit to a record never committed comes
// home line by line, and a record the builder left alone says nothing, however
// the person changed it since. In a workspace of several repositories the Unit
// gets the roof's records the same way.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { recordDir } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { codeGenerationRecordDir } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import { AIDLC_SRC } from "../harness/fixtures.ts";
import {
  ISOLATED_GIT_ENV, cleanupCheckpointFixtures, fixture, git, prepare, reviewRevisedSource, swarm, wt, writeUnitSource,
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

function write(pd: string, path: string, text: string): void {
  mkdirSync(dirname(record(pd, path)), { recursive: true });
  writeFileSync(record(pd, path), text);
}

function commitRecords(pd: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) write(pd, path, text);
  git(pd, ["add", "--", ...Object.keys(files).map((path) => record(pd, path))]);
  git(pd, ["-c", "user.name=AI-DLC Tests", "-c", "user.email=tests@example.com", "commit", "-qm", "design records"]);
}

function finalize(pd: string, units: string[]) {
  const r = Bun.spawnSync([process.execPath, join(AIDLC_SRC, "tools", "aidlc-swarm.ts"), "finalize", "--batch", "1",
    "--units", units.join(","), "--claimed", units.join(","), "--project-dir", pd], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    cwd: pd, env: { ...ISOLATED_GIT_ENV, AIDLC_PROJECT_DIR: pd, CLAUDE_PROJECT_DIR: pd },
    stdout: "pipe", stderr: "pipe",
  });
  const out = r.stdout.toString();
  return { code: r.exitCode, out, err: r.stderr.toString(), envelope: JSON.parse(out) as Finalized };
}

// Each Unit's builder writes its code and edits its folder's records, then the
// Units are checked, reviewed and finalized together.
function build(pd: string, units: string[], edit: (unit: string, child: string) => void) {
  units.forEach((unit, index) => {
    writeUnitSource(pd, unit, index + 2);
    edit(unit, wt(pd, unit));
    const checked = swarm(pd, ["check", unit]);
    expect(checked.code, `${checked.out}\n${checked.err}`).toBe(0);
    reviewRevisedSource(pd, unit);
  });
  const finalized = finalize(pd, units);
  expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
  expect(finalized.envelope.merge_failures).toEqual([]);
  return finalized.envelope;
}

function prepared(pd: string, units = ["alpha"]): void {
  const result = prepare(pd, units);
  expect(result.code, `${result.out}\n${result.err}`).toBe(0);
}

const notices = (finalized: Finalized, unit: string) =>
  finalized.units.find((row) => row.unit === unit)?.change_notices ?? [];
const notMerged = (pd: string, unit: string) => record(pd, `construction/${unit}/code-generation/not-merged`);

describe("a side-by-side Unit starts with the intent's design records as the project has them", () => {
  test("a record never committed and one changed since its commit are in the Unit's folder as the project has them", () => {
    const pd = fixture(["alpha"]);
    commitRecords(pd, { [RULES]: "# Business rules\n\n- BR-1: one\n" });
    write(pd, RULES, "# Business rules\n\n- BR-1: one\n- BR-2: approved at Functional Design, not committed\n");
    write(pd, CONTRACTS, "# Contracts\r\n\r\n- C1: one\r\n");
    prepared(pd);
    expect(read(wt(pd), RULES)).toBe(read(pd, RULES));
    expect(read(wt(pd), CONTRACTS)).toBe("# Contracts\r\n\r\n- C1: one\r\n");
  });

  test("a record the project removed since its commit is not in the Unit's folder, and the landing leaves it removed", () => {
    const pd = fixture(["alpha"]);
    commitRecords(pd, { "inception/application-design/old-notes.md": "# Old notes\n" });
    rmSync(record(pd, "inception/application-design/old-notes.md"));
    prepared(pd);
    expect(existsSync(record(wt(pd), "inception/application-design/old-notes.md"))).toBe(false);
    const finalized = build(pd, ["alpha"], () => {});
    expect(notices(finalized, "alpha")).toEqual([]);
    expect(existsSync(record(pd, "inception/application-design/old-notes.md"))).toBe(false);
  });

  test("prepare run again for a Unit whose folder is kept leaves the builder's edits, and they come home merged", () => {
    const pd = fixture(["alpha"]);
    write(pd, CONTRACTS, "# Contracts\n\n- C1: one\n\n## Notes\n\n- N1: a note\n");
    prepared(pd);
    write(wt(pd), CONTRACTS, read(wt(pd), CONTRACTS).replace("- C1: one\n", "- C1: one\n- C2: two\n"));
    write(pd, CONTRACTS, "# Contracts\n\n- C1: one\n\n## Notes\n\n- N1: a note the person changed\n");
    const again = prepare(pd);
    expect(again.code, `${again.out}\n${again.err}`).toBe(0);
    expect((JSON.parse(again.out) as { units: Array<{ retained?: boolean }> }).units[0].retained).toBe(true);
    expect(read(wt(pd), CONTRACTS)).toBe("# Contracts\n\n- C1: one\n- C2: two\n\n## Notes\n\n- N1: a note\n");
    const finalized = build(pd, ["alpha"], () => {});
    expect(notices(finalized, "alpha")).toEqual([]);
    expect(read(pd, CONTRACTS)).toBe("# Contracts\n\n- C1: one\n- C2: two\n\n## Notes\n\n- N1: a note the person changed\n");
  });

  test("a copy that cannot be written fails that Unit's preparation the way a failed plan handover does, and leaves no start file", () => {
    const pd = fixture(["alpha"]);
    write(pd, CONTRACTS, "# Contracts\n\n- C1: one\n");
    write(pd, RULES, "# Business rules\n\n- BR-1: one\n");
    const r = Bun.spawnSync([process.execPath, join(AIDLC_SRC, "tools", "aidlc-swarm.ts"), "prepare", "--batch", "1",
      "--units", "alpha", "--base", "main", "--project-dir", pd], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), cwd: pd, stdout: "pipe", stderr: "pipe",
      env: { ...ISOLATED_GIT_ENV, AIDLC_PROJECT_DIR: pd, CLAUDE_PROJECT_DIR: pd, AIDLC_TEST: "1", AIDLC_TEST_RECORD_COPY_FAIL: RULES },
    });
    expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(2);
    const row = (JSON.parse(r.stdout.toString()) as { units: Array<{ ok: boolean; error?: string }> }).units[0];
    expect(row.ok).toBe(false);
    expect(row.error).toContain("injected copy failure");
    expect(row.error).toContain("source was preserved; run aidlc-worktree discard --slug");
    expect(existsSync(record(wt(pd), ".aidlc-engine/unit-start-records.json"))).toBe(false);
  });

  test("the state, the audit, AI-DLC's own files and every Unit's Code Generation folder are not copied", () => {
    const pd = fixture(["alpha", "beta"]);
    write(pd, "construction/beta/code-generation/beta-notes.md", "# beta's own notes\n");
    write(pd, ".aidlc-engine/project-only.json", "{}\n");
    write(pd, "construction/alpha/code-generation/alpha-scratch.md", "# alpha's scratch in the project\n");
    prepared(pd, ["alpha"]);
    expect(existsSync(record(wt(pd), "construction/beta/code-generation/beta-notes.md"))).toBe(false);
    expect(existsSync(record(wt(pd), ".aidlc-engine/project-only.json"))).toBe(false);
    expect(existsSync(record(wt(pd), "construction/alpha/code-generation/alpha-scratch.md"))).toBe(false);
    expect(read(wt(pd), "aidlc-state.md")).not.toBe(read(pd, "aidlc-state.md"));
  });
});

describe("the landing merges the builder's edits against what the Unit started with", () => {
  test("an edit to a record never committed comes home line by line beside the person's change since, and nothing is said", () => {
    const pd = fixture(["alpha"]);
    write(pd, CONTRACTS, "# Contracts\n\n- C1: one\n\n## Notes\n\n- N1: a note\n");
    prepared(pd);
    write(pd, CONTRACTS, "# Contracts\n\n- C1: one\n\n## Notes\n\n- N1: a note the person changed\n");
    const finalized = build(pd, ["alpha"], (_unit, child) => {
      write(child, CONTRACTS, read(child, CONTRACTS).replace("- C1: one\n", "- C1: one\n- C2: two\n"));
    });
    expect(notices(finalized, "alpha")).toEqual([]);
    expect(read(pd, CONTRACTS)).toBe("# Contracts\n\n- C1: one\n- C2: two\n\n## Notes\n\n- N1: a note the person changed\n");
    expect(existsSync(notMerged(pd, "alpha"))).toBe(false);
  });

  test("records the builder left alone stay as the person has them since, and nothing is said", () => {
    const pd = fixture(["alpha"]);
    commitRecords(pd, { [RULES]: "# Business rules\n\n- BR-1: one\n" });
    write(pd, RULES, "# Business rules\n\n- BR-1: one\n- BR-2: two\n");
    write(pd, CONTRACTS, "# Contracts\n\n- C1: one\n");
    prepared(pd);
    write(pd, RULES, "# Business rules\n\n- BR-1: one, as the person put it later\n- BR-2: two\n");
    write(pd, CONTRACTS, "# Contracts\n\n- C1: one, as the person put it later\n");
    const finalized = build(pd, ["alpha"], () => {});
    expect(notices(finalized, "alpha")).toEqual([]);
    expect(read(pd, RULES)).toBe("# Business rules\n\n- BR-1: one, as the person put it later\n- BR-2: two\n");
    expect(read(pd, CONTRACTS)).toBe("# Contracts\n\n- C1: one, as the person put it later\n");
    expect(existsSync(notMerged(pd, "alpha"))).toBe(false);
  });

  test("two Units each adding to a different part of a record never committed both come home", () => {
    const pd = fixture(["alpha", "beta"]);
    write(pd, CONTRACTS, "# Contracts\n\n## Alpha\n\n- A1: one\n\n## Beta\n\n- B1: one\n");
    prepared(pd, ["alpha", "beta"]);
    const finalized = build(pd, ["alpha", "beta"], (unit, child) => {
      const anchor = unit === "alpha" ? "- A1: one\n" : "- B1: one\n";
      write(child, CONTRACTS, read(child, CONTRACTS).replace(anchor, `${anchor}- ${unit}'s contract\n`));
    });
    expect(notices(finalized, "alpha")).toEqual([]);
    expect(notices(finalized, "beta")).toEqual([]);
    expect(read(pd, CONTRACTS))
      .toBe("# Contracts\n\n## Alpha\n\n- A1: one\n- alpha's contract\n\n## Beta\n\n- B1: one\n- beta's contract\n");
  });

  test("in a workspace of several repositories the Unit gets the roof's records, and its edit comes home", () => {
    const pd = fixture(["alpha"], undefined, false, "repo-a");
    write(pd, RULES, "# Business rules\n\n- BR-1: one\n");
    write(pd, CONTRACTS, "# Contracts\n\n- C1: one\n");
    const result = swarm(pd, ["prepare", "--batch", "1", "--units", "alpha", "--base", "main"]);
    expect(result.code, `${result.out}\n${result.err}`).toBe(0);
    expect(read(wt(pd), RULES)).toBe("# Business rules\n\n- BR-1: one\n");
    const finalized = build(pd, ["alpha"], (unit, child) => {
      // The worker writes the stage's documents in its worktree, as the swarm protocol has it.
      cpSync(codeGenerationRecordDir(pd, unit), codeGenerationRecordDir(child, unit), { recursive: true, force: false });
      appendFileSync(record(child, RULES), "- BR-2: two\n");
    });
    expect(notices(finalized, "alpha")).toEqual([]);
    expect(read(pd, RULES)).toBe("# Business rules\n\n- BR-1: one\n- BR-2: two\n");
    expect(read(pd, CONTRACTS)).toBe("# Contracts\n\n- C1: one\n");
  });
});
