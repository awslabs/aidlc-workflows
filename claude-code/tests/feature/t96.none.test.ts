// covers: subcommand:aidlc-runtime:compile
//
// Pure-function port of tests/feature/t96-runtime-instances-compile.sh
// (TAP plan 10), mechanism = none. The .sh shelled out to
// `bun aidlc-runtime.ts --project-dir <p> compile` per case, then read the
// resulting runtime-graph.json back with a `bun -e` JSONPath projection.
// In v0.6.1, `aidlc-runtime.ts` keeps compile private behind the CLI handler,
// so these contracts drive the deterministic shipped tool via `bun
// aidlc-runtime.ts --project-dir <p> compile` and then JSON.parse the graph the
// command wrote. This preserves the .sh's observable boundary without touching
// shipped runtime exports: zero LLM, zero tokens, temp-project file effects only.
//
// EQUAL-OR-STRONGER PARITY: the .sh's graph_query helper reduced each
// JSONPath probe to a single string for bash to compare (e.g.
// `'instances' in (...)` → "false"). In-process we JSON.parse the graph
// the tool wrote and assert against the real object shape — same observable
// (the materialised field value), expressed against the actual return
// rather than its stringification. STRONGER additions are noted inline.
//
// PARITY MAP (every .sh `ok` line -> a test() with the same observable):
//   - .sh 1  Single-Bolt: no `instances` key + outcome:"approved"   -> "1:"
//       (STRONGER: also pins exact instances === undefined, not just
//        `'instances' in row === false`).
//   - .sh 2  3-Bolt: instances.length===3, parent started_at/agent null,
//       memory_path kept, sensor_firings:[]                          -> "2:".
//   - .sh 3  Rollup all-approved: parent outcome:"approved" + every
//       instance approved                                            -> "3:".
//   - .sh 4  Alpha ordering: instances[].bolt === [auth,cart,pay]    -> "4:".
//   - .sh 5  Determinism: byte-equal runtime-graph.json on recompile -> "5:"
//       (sha256 of the file bytes, mirroring the .sh's shasum check).
//   - .sh 6  Every BoltInstance sensor_firings:[] (audit has no SENSOR
//       rows)                                                        -> "6:".
//   - .sh 7  Every BoltInstance memory_entries:null + memory_breakdown:null
//                                                                    -> "7:".
//   - .sh 8  Rollup any-failed: len 3, parent:failed, pay:failed,
//       auth:approved                                                -> "8:".
//   - .sh 9  Rollup pending-mix: strip pay's STATE_MERGED/AUDIT_MERGED/
//       BOLT_COMPLETED -> pay:pending, parent:pending                -> "9:".
//   - .sh 10 Alpha ordering with shuffled STATE_FORKED timestamps: still
//       [auth,cart,pay]                                              -> "10:".
//
// FIXTURE DISCIPLINE (mirrors the .sh's make_project_with_audit + mktemp -d
// + FIXTURES trap rm -rf): each case builds a FRESH temp project dir via
// mkdtempSync wrapped in toPortablePath (fixtures.ts) — the tool resolves
// audit/graph paths through forward-slash helpers, so on native Windows the
// raw mktemp path can't round-trip; toPortablePath cygpath-rewrites it,
// mirroring createTestProject. The static audit fixtures under
// tests/fixtures/v05-mr11-bolt-runtime-graph/ + tests/fixtures/
// state-construction.md are READ-ONLY here (copied into the temp project,
// never mutated in place) — the pending-mix (case 9) and shuffle (case 10)
// audit edits are applied to the temp project's COPY, exactly as the .sh
// rewrote $PROJ/aidlc-docs/audit.md, never the fixture source. All temp
// dirs cleaned in afterAll.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, toPortablePath } from "../harness/fixtures.ts";

const BUN = process.execPath;
const RUNTIME_TS = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-runtime.ts",
);

const STATE_FIXTURE = join(REPO_ROOT, "tests", "fixtures", "state-construction.md");
const FIXTURES_DIR = join(
  REPO_ROOT,
  "tests",
  "fixtures",
  "v05-mr11-bolt-runtime-graph",
);

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/**
 * make_project_with_audit (t96.sh:69-83): fresh temp project with the
 * state-construction.md fixture as aidlc-state.md and the named audit
 * fixture (under FIXTURES_DIR) as audit.md. toPortablePath mirrors the .sh's
 * bun_path cygpath conversion so the embedded paths round-trip on Windows.
 */
function makeProjectWithAudit(auditFixtureName: string): string {
  const proj = toPortablePath(mkdtempSync(join(tmpdir(), "aidlc-t96f-")));
  tempDirs.push(proj);
  mkdirSync(join(proj, "aidlc-docs"), { recursive: true });
  copyFileSync(STATE_FIXTURE, join(proj, "aidlc-docs", "aidlc-state.md"));
  copyFileSync(
    join(FIXTURES_DIR, auditFixtureName),
    join(proj, "aidlc-docs", "audit.md"),
  );
  return proj;
}

/** run_compile (t96.sh:85-87): invoke the shipped runtime compile command. */
function runCompile(proj: string): void {
  const res = spawnSync(BUN, [RUNTIME_TS, "--project-dir", proj, "compile"], {
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
  });
  expect(res.status ?? -1).toBe(0);
}

const graphPath = (proj: string): string =>
  join(proj, "aidlc-docs", "runtime-graph.json");
const auditPath = (proj: string): string =>
  join(proj, "aidlc-docs", "audit.md");

// biome-ignore lint/suspicious/noExplicitAny: test reads arbitrary graph shape
function readGraph(proj: string): any {
  return JSON.parse(readFileSync(graphPath(proj), "utf-8"));
}

/** The code-generation stage row — the construction-phase stage the audit fixtures drive. */
// biome-ignore lint/suspicious/noExplicitAny: test reads arbitrary graph shape
function codeGen(proj: string): any {
  return readGraph(proj).stages.find(
    // biome-ignore lint/suspicious/noExplicitAny: arbitrary graph shape
    (s: any) => s.stage_slug === "code-generation",
  );
}

const sha256 = (proj: string): string =>
  createHash("sha256").update(readFileSync(graphPath(proj))).digest("hex");

describe("t96 aidlc-runtime compile — instances[] populator (migrated from t96-runtime-instances-compile.sh, plan 10)", () => {
  // --- 1. Single-Bolt -> no instances[] ----------------------------------
  test("1: single-Bolt -> no instances[]; row stays single-instance, outcome:approved", () => {
    const proj = makeProjectWithAudit("audit-single-bolt.md");
    runCompile(proj);
    const row = codeGen(proj);
    // .sh: `'instances' in row === false`. STRONGER: the optional key is
    // absent entirely (undefined), not merely falsy.
    expect("instances" in row).toBe(false);
    expect(row.instances).toBeUndefined();
    expect(row.outcome).toBe("approved");
  });

  // --- 2. 3-Bolt parallel -> instances[] shape + parent null-out ----------
  test("2: 3-Bolt parallel -> instances.length=3, parent started_at/agent null, memory_path kept, sensor_firings:[]", () => {
    const proj = makeProjectWithAudit("audit-3-bolts-parallel.md");
    runCompile(proj);
    const row = codeGen(proj);
    expect(row.instances).toHaveLength(3);
    expect(row.started_at).toBeNull();
    expect(row.agent).toBeNull();
    expect(row.memory_path).not.toBeNull();
    // STRONGER than the .sh's `!= "null"`: exact parent memory.md path.
    expect(row.memory_path).toBe(
      "aidlc-docs/construction/code-generation/memory.md",
    );
    expect(row.sensor_firings).toEqual([]);
    // STRONGER: completed_at + per-Bolt memory fields nulled on the parent too.
    expect(row.completed_at).toBeNull();
    expect(row.memory_entries).toBeNull();
    expect(row.memory_breakdown).toBeNull();
  });

  // --- 3. Outcome rollup — all approved -----------------------------------
  test("3: outcome rollup all-approved -> parent outcome:approved, every instance approved", () => {
    const proj = makeProjectWithAudit("audit-3-bolts-parallel.md");
    runCompile(proj);
    const row = codeGen(proj);
    expect(row.outcome).toBe("approved");
    // biome-ignore lint/suspicious/noExplicitAny: arbitrary graph shape
    expect(row.instances.every((i: any) => i.outcome === "approved")).toBe(true);
  });

  // --- 4. Alphabetical ordering (L6) --------------------------------------
  test("4: alphabetical ordering -> instances[].bolt = [auth, cart, pay]", () => {
    const proj = makeProjectWithAudit("audit-3-bolts-parallel.md");
    runCompile(proj);
    const row = codeGen(proj);
    // biome-ignore lint/suspicious/noExplicitAny: arbitrary graph shape
    expect(row.instances.map((i: any) => i.bolt)).toEqual(["auth", "cart", "pay"]);
  });

  // --- 5. Determinism (L11) — byte-equal output on recompile --------------
  test("5: determinism -> re-compile produces byte-equivalent runtime-graph.json", () => {
    const proj = makeProjectWithAudit("audit-3-bolts-parallel.md");
    runCompile(proj);
    const before = sha256(proj);
    runCompile(proj);
    const after = sha256(proj);
    expect(after).toBe(before);
  });

  // --- 6. sensor_firings:[] contract on every BoltInstance ----------------
  test("6: every BoltInstance has sensor_firings:[] (audit carries no SENSOR rows)", () => {
    const proj = makeProjectWithAudit("audit-3-bolts-parallel.md");
    runCompile(proj);
    const row = codeGen(proj);
    expect(
      row.instances.every(
        // biome-ignore lint/suspicious/noExplicitAny: arbitrary graph shape
        (i: any) => Array.isArray(i.sensor_firings) && i.sensor_firings.length === 0,
      ),
    ).toBe(true);
  });

  // --- 7. memory_entries:null + memory_breakdown:null per BoltInstance ----
  test("7: milestone 11 contract -> every BoltInstance memory_entries:null + memory_breakdown:null", () => {
    const proj = makeProjectWithAudit("audit-3-bolts-parallel.md");
    runCompile(proj);
    const row = codeGen(proj);
    expect(
      row.instances.every(
        // biome-ignore lint/suspicious/noExplicitAny: arbitrary graph shape
        (i: any) => i.memory_entries === null && i.memory_breakdown === null,
      ),
    ).toBe(true);
  });

  // --- 8. Outcome rollup — any failed -> parent failed --------------------
  test("8: outcome rollup any-failed -> len 3, parent:failed, pay:failed, auth:approved", () => {
    const proj = makeProjectWithAudit("audit-3-bolts-1-failed.md");
    runCompile(proj);
    const row = codeGen(proj);
    expect(row.instances).toHaveLength(3);
    expect(row.outcome).toBe("failed");
    // biome-ignore lint/suspicious/noExplicitAny: arbitrary graph shape
    const pay = row.instances.find((i: any) => i.bolt === "pay");
    // biome-ignore lint/suspicious/noExplicitAny: arbitrary graph shape
    const auth = row.instances.find((i: any) => i.bolt === "auth");
    expect(pay.outcome).toBe("failed");
    expect(auth.outcome).toBe("approved");
  });

  // --- 9. Outcome rollup — pending mix -> parent pending ------------------
  // Strip pay's STATE_MERGED + AUDIT_MERGED + BOLT_COMPLETED blocks from the
  // temp project's audit COPY (mirrors the .sh's `bun -e` block filter), so
  // pay has STATE_FORKED but no merge / no fail -> outcome:pending. Parent
  // then rolls up to pending (no failures, >=1 pending). The fixture source
  // under tests/fixtures/** is untouched.
  test("9: outcome rollup pending-mix -> pay:pending, parent:pending", () => {
    const proj = makeProjectWithAudit("audit-3-bolts-parallel.md");
    const path = auditPath(proj);
    const blocks = readFileSync(path, "utf-8").split("\n---\n");
    const filtered = blocks.filter((b) => {
      const slug = b.match(/\*\*Bolt slug\*\*:\s*(.+)/)?.[1]?.trim();
      const ev = b.match(/\*\*Event\*\*:\s*(.+)/)?.[1]?.trim();
      if (
        slug === "pay" &&
        ev !== undefined &&
        ["STATE_MERGED", "AUDIT_MERGED", "BOLT_COMPLETED"].includes(ev)
      ) {
        return false;
      }
      return true;
    });
    writeFileSync(path, filtered.join("\n---\n"), "utf-8");
    runCompile(proj);
    const row = codeGen(proj);
    // biome-ignore lint/suspicious/noExplicitAny: arbitrary graph shape
    const pay = row.instances.find((i: any) => i.bolt === "pay");
    expect(pay.outcome).toBe("pending");
    expect(row.outcome).toBe("pending");
  });

  // --- 10. Alphabetical ordering with shuffled STATE_FORKED timestamps ----
  // Re-stamp the three STATE_FORKED Timestamps so pay forks earliest, then
  // auth, then cart (non-alphabetical chronological order). Output
  // instances[] must still read [auth, cart, pay] (L6: ordering is by slug,
  // not by fork timestamp). Mirrors the .sh's `bun -e` re-stamp on the temp
  // project's audit COPY.
  test("10: alphabetical ordering stable across shuffled STATE_FORKED timestamps -> [auth, cart, pay]", () => {
    const proj = makeProjectWithAudit("audit-3-bolts-parallel.md");
    const path = auditPath(proj);
    const blocks = readFileSync(path, "utf-8").split("\n---\n");
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const slug = b.match(/\*\*Bolt slug\*\*:\s*(.+)/)?.[1]?.trim();
      const ev = b.match(/\*\*Event\*\*:\s*(.+)/)?.[1]?.trim();
      if (ev !== "STATE_FORKED") continue;
      if (slug === "pay")
        blocks[i] = b.replace(
          /\*\*Timestamp\*\*:.*$/m,
          "**Timestamp**: 2026-05-28T08:01:01Z",
        );
      if (slug === "auth")
        blocks[i] = b.replace(
          /\*\*Timestamp\*\*:.*$/m,
          "**Timestamp**: 2026-05-28T08:02:01Z",
        );
      if (slug === "cart")
        blocks[i] = b.replace(
          /\*\*Timestamp\*\*:.*$/m,
          "**Timestamp**: 2026-05-28T08:03:01Z",
        );
    }
    writeFileSync(path, blocks.join("\n---\n"), "utf-8");
    runCompile(proj);
    const row = codeGen(proj);
    // biome-ignore lint/suspicious/noExplicitAny: arbitrary graph shape
    expect(row.instances.map((i: any) => i.bolt)).toEqual(["auth", "cart", "pay"]);
  });
});
