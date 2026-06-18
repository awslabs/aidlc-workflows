// covers: cli:aidlc-runtime(summary), contract:session-skills-summary-seam
//
// CLI-contract port of tests/integration/t111-session-skills-contract.sh (TAP plan
// 10), mechanism = cli. The .sh has NO `# covers:` header line; its subject is
// the behavioural seam between the three read-only session skills and the
// `aidlc-runtime.ts summary --json` data plane they consume. (The unrelated
// tests/unit/t111.none.test.ts is a DIFFERENT subject — the audit-append core —
// and is ignored per the same-number-different-tier rule.)
//
// WHAT IS UNDER TEST
//   1. `aidlc-runtime.ts summary --json` emits the 8 top-level keys the skills'
//      render templates depend on (workflow_id, scope, duration_minutes, stages,
//      by_phase, memory, sensors, learnings). Source shape: RuntimeSummary
//      (dist/claude/.claude/tools/aidlc-runtime.ts:880-905), produced by
//      summarize() (:907-979) and printed by handleSummary (:1282-1295) under
//      `--json` as JSON.stringify(summary, null, 2).
//   2. FORWARD drift: every dotted JSON field the three skills cite resolves in
//      real tool output — no skill names a phantom (renamed/typo'd) field.
//   3. REVERSE drift: every scalar leaf the tool emits is referenced by name in
//      at least one skill — no emitted field ships dark (the tool grows a field
//      the skills forget to surface).
//
// SOURCE UNDER TEST
//   - Tool:  dist/claude/.claude/tools/aidlc-runtime.ts
//       summarize / renderSummary are MODULE-PRIVATE (no `export`), and the
//       emitted JSON is only observable on the `summary --json` STDOUT after a
//       `compile` materialises runtime-graph.json. handleSummary terminates the
//       process (process.exit(1) on no-graph, :1288). => process-boundary seam,
//       so this is mechanism = cli (spawnSync BUN + the .ts path), exactly the
//       broadened cli arm the .sh used (it ran `bun "$RUNTIME_TS" compile` then
//       `bun "$RUNTIME_TS" summary --json`). An in-process import cannot reach
//       summarize() at all.
//   - Skills (read off disk, the same files the .sh grepped):
//       dist/claude/.claude/skills/aidlc-session-cost/SKILL.md
//       dist/claude/.claude/skills/aidlc-replay/SKILL.md
//       dist/claude/.claude/skills/aidlc-outcomes-pack/SKILL.md
//
// DRIFT-CHECK PARITY (the .sh's bash pipelines reproduced in TS, byte-faithful):
//   EMITTED   = JSON leaf scalar paths, with concrete phase names collapsed to
//               `<phase>` so by_phase.* compares as one shape regardless of
//               which phases ran (the .sh's `jq paths(scalars) | join(".")`
//               then `sed -E 's/\.(init…|operation)\./.<phase>./'`).
//   REFERENCED= dotted field paths grepped from the three skills under the known
//               JSON parents, `summary.` prefix stripped, `.md` prose filenames
//               excluded, `by_phase.<leaf>` normalised to the tool's
//               by_phase.<phase>.<leaf> (the .sh's grep|sed|grep -v|sed|sort -u).
//   The .sh's `started_at` carve-out (internal field the render does not
//   surface) is preserved in the reverse check.
//
// Old TAP -> new test parity (1:1, plan 10):
//   .sh tests 1-8 (top-level key present, one per key)
//        -> "summary --json emits all 8 top-level keys the skills depend on"
//           (test.each over the 8 keys: 8 distinct assertions, same as the .sh
//           loop's 8 `ok` lines — STRONGER: also asserts each value's JSON type
//           matches the render template's expectation, not merely `has(key)`).
//   .sh test 9  (every referenced field is emitted — no phantom)
//        -> "every summary field the skills reference is emitted by the tool"
//           (STRONGER: on failure names the exact phantom set, like the .sh,
//           AND independently pins that the referenced set is non-empty so a
//           grep that silently matched nothing can't pass vacuously).
//   .sh test 10 (every emitted field name is consumed — no orphan)
//        -> "every summary field the tool emits is consumed by at least one
//           skill" (same `started_at` carve-out; names the orphan set on fail).
//
// FIXTURE DISCIPLINE (mirrors the .sh's `mktemp -d` + trap rm -rf): one fresh
// temp project with the .sh's exact audit.md / state / memory.md heredocs,
// `compile`d once, then `summary --json` captured once. Torn down in afterAll.
// Nothing is written under tests/fixtures/** or dist/**.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AIDLC_SRC, toPortablePath } from "../harness/fixtures.ts";
import { auditFilePath } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

// P9: with no intent cursor seeded, compile/summary resolve the BARE space
// record root (docsRoot -> spaceRecordRoot) at aidlc/spaces/default/intents/.
// State, runtime-graph, per-stage memory, and the per-clone audit SHARD all
// live under it (the flat aidlc-docs/ root is retired — there is no fallback).
const RECORD_REL = join("aidlc", "spaces", "default", "intents");
function recordRoot(proj: string): string {
  return join(proj, RECORD_REL);
}

const BUN = process.execPath; // the bun running this test
const RUNTIME_TS = join(AIDLC_SRC, "tools", "aidlc-runtime.ts");
const SKILLS_DIR = join(AIDLC_SRC, "skills");
const SKILL_FILES = [
  join(SKILLS_DIR, "aidlc-session-cost", "SKILL.md"),
  join(SKILLS_DIR, "aidlc-replay", "SKILL.md"),
  join(SKILLS_DIR, "aidlc-outcomes-pack", "SKILL.md"),
];

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/**
 * Build the .sh's synthetic compiled graph: one completed stage (intent-capture)
 * with two memory entries. Byte-for-byte the .sh heredocs (t111:44-74), then
 * `compile`. Returns the project dir (registered for afterAll teardown).
 */
function buildSyntheticProject(): string {
  const proj = toPortablePath(mkdtempSync(join(tmpdir(), "aidlc-t111-")));
  tempDirs.push(proj);
  mkdirSync(join(recordRoot(proj), "ideation", "intent-capture"), {
    recursive: true,
  });
  // Seed the DETERMINISTIC audit shard the compile tool resolves (auditFilePath).
  const shard = auditFilePath(proj);
  mkdirSync(dirname(shard), { recursive: true });
  writeFileSync(
    shard,
    [
      "## Workflow Start",
      "**Timestamp**: 2026-05-27T10:00:00Z",
      "**Event**: WORKFLOW_STARTED",
      "**Scope**: feature",
      "",
      "---",
      "",
      "## Stage Start",
      "**Timestamp**: 2026-05-27T10:01:00Z",
      "**Event**: STAGE_STARTED",
      "**Stage**: intent-capture",
      "**Agent**: aidlc-product-agent",
      "",
      "---",
      "",
      "## Stage Completion",
      "**Timestamp**: 2026-05-27T10:10:00Z",
      "**Event**: STAGE_COMPLETED",
      "**Stage**: intent-capture",
      "**Details**: done",
      "",
      "---",
      "",
    ].join("\n"),
    "utf-8",
  );
  writeFileSync(
    join(recordRoot(proj), "aidlc-state.md"),
    "- **Scope**: feature\n- **Current Stage**: intent-capture\n",
    "utf-8",
  );
  writeFileSync(
    join(recordRoot(proj), "ideation", "intent-capture", "memory.md"),
    "## Interpretations\n- one\n## Tradeoffs\n- a tradeoff\n",
    "utf-8",
  );
  const compile = spawnSync(BUN, [RUNTIME_TS, "compile"], {
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
  });
  if (compile.status !== 0) {
    throw new Error(
      `compile failed (exit ${compile.status}): ${compile.stderr ?? ""}`,
    );
  }
  return proj;
}

/** `summary --json` STDOUT, parsed (the .sh's `JSON=$(... summary --json)`). */
function summaryJson(proj: string): unknown {
  const res = spawnSync(BUN, [RUNTIME_TS, "summary", "--json"], {
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
  });
  if (res.status !== 0) {
    throw new Error(
      `summary --json failed (exit ${res.status}): ${res.stderr ?? ""}`,
    );
  }
  return JSON.parse(res.stdout ?? "");
}

const PHASES = /\.(initialization|ideation|inception|construction|operation)\./;

/**
 * EMITTED set: every scalar leaf path of the JSON, dot-joined, with concrete
 * phase names collapsed to `<phase>`, sorted-unique. Reproduces the .sh's
 *   jq -r 'paths(scalars) | join(".")' | sed -E 's/\.(…)\./.<phase>./' | sort -u
 */
function emittedLeafSet(json: unknown): Set<string> {
  const leaves: string[] = [];
  const walk = (node: unknown, path: string[]): void => {
    if (node !== null && typeof node === "object" && !Array.isArray(node)) {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        walk(v, [...path, k]);
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => {
        walk(v, [...path, String(i)]);
      });
      return;
    }
    // scalar (string | number | boolean | null) — a jq `scalars` leaf.
    leaves.push(path.join("."));
  };
  walk(json, []);
  const normalised = leaves.map((p) => p.replace(PHASES, ".<phase>."));
  return new Set(normalised);
}

/**
 * REFERENCED set: dotted field paths the three skills cite. Reproduces the .sh's
 *   grep -ohE "(summary\.)?(stages|memory|sensors|learnings|by_phase)\.[a-z_]+
 *               |(summary\.)?(workflow_id|scope|duration_minutes)" <skills>
 *     | sed -E 's/^summary\.//'
 *     | grep -vE '\.md$'
 *     | sed -E 's/^by_phase\.(.+)$/by_phase.<phase>.\1/'
 *     | sort -u
 */
function referencedFieldSet(): Set<string> {
  const re =
    /(summary\.)?(stages|memory|sensors|learnings|by_phase)\.[a-z_]+|(summary\.)?(workflow_id|scope|duration_minutes)/g;
  const out = new Set<string>();
  for (const file of SKILL_FILES) {
    const text = readFileSync(file, "utf-8");
    for (const m of text.matchAll(re)) {
      let ref = m[0].replace(/^summary\./, "");
      if (/\.md$/.test(ref)) continue; // prose filenames (memory.md / summary.md)
      ref = ref.replace(/^by_phase\.(.+)$/, "by_phase.<phase>.$1");
      out.add(ref);
    }
  }
  return out;
}

/** Whether `name` appears anywhere in any skill file (the .sh's `grep -qhE "$name"`). */
function nameMentionedInAnySkill(name: string): boolean {
  const re = new RegExp(name);
  return SKILL_FILES.some((f) => re.test(readFileSync(f, "utf-8")));
}

describe("t111 session-skills <-> summary --json seam (migrated from t111-session-skills-contract.sh, plan 10)", () => {
  const proj = buildSyntheticProject();
  const json = summaryJson(proj) as Record<string, unknown>;

  // --- .sh tests 1-8: the 8 top-level keys the render templates depend on ----
  // STRONGER than `jq has(key)`: also pin each value's JSON type against the
  // shape the SKILL.md render templates assume (scalar headers vs nested
  // objects), so a key present-but-retyped still trips.
  const TOP_LEVEL: Array<[string, "string" | "number-or-null" | "object"]> = [
    ["workflow_id", "string"],
    ["scope", "string"],
    ["duration_minutes", "number-or-null"],
    ["stages", "object"],
    ["by_phase", "object"],
    ["memory", "object"],
    ["sensors", "object"],
    ["learnings", "object"],
  ];

  test.each(TOP_LEVEL)(
    "summary --json emits top-level key: %s [.sh tests 1-8]",
    (key, kind) => {
      expect(Object.hasOwn(json, key)).toBe(true);
      const v = json[key];
      if (kind === "string") {
        expect(typeof v).toBe("string");
      } else if (kind === "number-or-null") {
        expect(v === null || typeof v === "number").toBe(true);
      } else {
        expect(v !== null && typeof v === "object" && !Array.isArray(v)).toBe(
          true,
        );
      }
    },
  );

  // --- .sh test 9: forward drift — no skill cites a phantom field ------------
  test("every summary field the skills reference is emitted by the tool (no phantom) [.sh test 9]", () => {
    const emitted = emittedLeafSet(json);
    const referenced = referencedFieldSet();
    // Guard against a vacuous pass: a grep that silently matched nothing would
    // make the drift check trivially green. The skills DO cite fields.
    expect(referenced.size).toBeGreaterThan(0);
    const phantom = [...referenced].filter((r) => !emitted.has(r)).sort();
    expect(phantom).toEqual([]);
  });

  // --- .sh test 10: reverse drift — no emitted field ships unconsumed --------
  test("every summary field the tool emits is consumed by at least one skill (no orphan) [.sh test 10]", () => {
    const emitted = emittedLeafSet(json);
    expect(emitted.size).toBeGreaterThan(0);
    const orphan: string[] = [];
    for (const leaf of emitted) {
      const name = leaf.split(".").pop() ?? leaf;
      // started_at is an internal field the human/JSON render does not surface
      // — the .sh skips it explicitly; preserve the carve-out.
      if (name === "started_at") continue;
      if (!nameMentionedInAnySkill(name)) orphan.push(leaf);
    }
    expect(orphan.sort()).toEqual([]);
  });
});
