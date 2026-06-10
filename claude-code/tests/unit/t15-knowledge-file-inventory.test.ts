// covers: file:knowledge/aidlc-architect-agent, file:knowledge/aidlc-aws-platform-agent, file:knowledge/aidlc-compliance-agent, file:knowledge/aidlc-delivery-agent, file:knowledge/aidlc-design-agent, file:knowledge/aidlc-developer-agent, file:knowledge/aidlc-devsecops-agent, file:knowledge/aidlc-operations-agent, file:knowledge/aidlc-pipeline-deploy-agent, file:knowledge/aidlc-product-agent, file:knowledge/aidlc-quality-agent, file:knowledge/aidlc-shared/ai-dlc-principles.md, file:knowledge/aidlc-shared/audit-format.md, file:knowledge/aidlc-shared/brownfield.md, file:knowledge/aidlc-shared/knowledge-readme-template.md, file:knowledge/aidlc-shared/rules-reading.md, file:knowledge/aidlc-shared/state-template.md, file:knowledge/aidlc-shared/verification.md
//
// t15 — knowledge-file inventory + non-emptiness invariant. Migrated from
// tests/unit/t15-knowledge-file-inventory.sh (the .sh declared no `# covers:`
// header; these file: ids name the shipped knowledge tree the .sh inventoried).
//
// The .sh resolved KNOWLEDGE_DIR = $AIDLC_SRC/knowledge and made a dynamic
// TAP plan of `11 (per-agent existence) + 11 (per-agent counts) + 7 (shared
// specific files) + TOTAL_FILES (every .md non-empty)`. TOTAL_FILES is
// `find KNOWLEDGE_DIR -name '*.md' -type f | wc -l`, measured = 56 this session,
// so the .sh plan = 11 + 11 + 7 + 56 = 85.
//
// Mechanism: none. This is a pure structural / on-disk check — directory
// membership, file counts, and file sizes under the distributable knowledge/
// tree. No process boundary, no argv/exit/stdout seam, no LLM, zero tokens. We
// resolve the same tree the .sh resolved via the harness's AIDLC_SRC
// (= <repo>/dist/claude/.claude, fixtures.ts:42) — the TS canonical for the
// .sh's KNOWLEDGE_DIR=$AIDLC_SRC/knowledge — and assert in-process with
// existsSync / statSync / a recursive .md walk.
//
// Subject under test: the shipped knowledge/ corpus of dist/claude/.claude/ —
// per-agent knowledge dirs + the cross-agent aidlc-shared/ set. Counts and
// shared filenames verified present on disk this session against the worktree
// dist tree.
//
// Old TAP -> new test parity (1:1, every .sh assertion preserved; counts are
// EQUAL-OR-STRONGER):
//   .sh L20-23  11x assert_gt count 0 (each agent dir non-empty)
//        -> "each of the 11 agent knowledge dirs has at least one .md file"
//   .sh L29-39  11x assert_eq exact per-agent count (6/4/1/3/5/6/4/4/3/7/4)
//        -> "each agent dir ships EXACTLY its expected .md count" (per-agent block-scoped)
//   .sh L45-47  7x assert_file_exists aidlc-shared/<f>
//        -> "ships each of the 7 named aidlc-shared/ files"
//   .sh L53-57  TOTAL_FILES x assert_gt size 0 (every shipped .md non-empty)
//        -> "every shipped knowledge .md file is non-empty (byte size > 0)"
//   .sh L11-14  plan = 11 + 11 + 7 + TOTAL_FILES   (dynamic TAP plan)
//        -> "TAP-plan parity: 11 + 11 + 7 + TOTAL == 85 with TOTAL == 56"
//           (re-derives the plan arithmetic from the live tree, pinning both the
//            total .md count and the summed plan the .sh computed)
//
// STRENGTHENINGS over the .sh:
//   - the per-agent count test also pins that knowledge/ holds EXACTLY the 11
//     expected agent dirs (no 12th agent dir sneaking in), which the .sh's
//     fixed AGENT_NAMES loop never checked.
//   - the non-empty test re-walks the tree and pins the walked count == 56,
//     so a dropped file cannot silently shrink the surface the .sh enforced.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

// AIDLC_SRC === <repo>/dist/claude/.claude — the same tree the .sh resolved.
// KNOWLEDGE_DIR is its knowledge/ subtree.
const KNOWLEDGE_DIR = join(AIDLC_SRC, "knowledge");

// The 11 agent knowledge dirs, in the order the .sh's AGENT_NAMES listed them
// (.sh L10), each paired with the exact .md count the .sh asserted (.sh L29-39).
const AGENT_COUNTS: ReadonlyArray<readonly [string, number]> = [
  ["aidlc-architect-agent", 6],
  ["aidlc-aws-platform-agent", 4],
  ["aidlc-compliance-agent", 1],
  ["aidlc-delivery-agent", 3],
  ["aidlc-design-agent", 5],
  ["aidlc-developer-agent", 6],
  ["aidlc-devsecops-agent", 4],
  ["aidlc-operations-agent", 4],
  ["aidlc-pipeline-deploy-agent", 3],
  ["aidlc-product-agent", 7],
  ["aidlc-quality-agent", 4],
];

// The 7 named cross-agent files the .sh existence-checked (.sh L45).
const SHARED_FILES = [
  "ai-dlc-principles.md",
  "audit-format.md",
  "brownfield.md",
  "knowledge-readme-template.md",
  "rules-reading.md",
  "state-template.md",
  "verification.md",
] as const;

// Recursive .md file walk — the TS equivalent of the .sh's
// `find "$KNOWLEDGE_DIR" -name '*.md' -type f` (used for both TOTAL_FILES and
// the per-block counts). Returns absolute paths.
function findMd(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findMd(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

describe("t15 — knowledge-file inventory + non-emptiness (mechanism: none)", () => {
  // .sh Part 1 (L16-23): each of the 11 agent dirs has at least one .md file.
  test("each of the 11 agent knowledge dirs has at least one .md file [.sh L20-23]", () => {
    for (const [agent] of AGENT_COUNTS) {
      const dir = join(KNOWLEDGE_DIR, agent);
      expect(existsSync(dir)).toBe(true);
      expect(findMd(dir).length).toBeGreaterThan(0);
    }
  });

  // .sh Part 2 (L25-39): exact .md count per agent dir. One test per agent so a
  // failure pins WHICH agent drifted (block-scoped field check, house style).
  for (const [agent, expectedCount] of AGENT_COUNTS) {
    test(`${agent} ships EXACTLY ${expectedCount} knowledge .md file(s) [.sh L29-39]`, () => {
      const dir = join(KNOWLEDGE_DIR, agent);
      expect(findMd(dir).length).toBe(expectedCount);
    });
  }

  // STRENGTHENING: knowledge/ holds EXACTLY the 11 expected agent dirs plus
  // aidlc-shared/ — no extra agent dir. The .sh's fixed loop never pinned this.
  test("knowledge/ holds EXACTLY the 11 agent dirs + aidlc-shared/ [.sh L10 — membership strengthening]", () => {
    const dirs = readdirSync(KNOWLEDGE_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    const expected = [...AGENT_COUNTS.map(([a]) => a), "aidlc-shared"].sort();
    expect(dirs).toEqual(expected);
  });

  // .sh Part 3 (L41-47): the 7 named aidlc-shared/ files exist.
  test("ships each of the 7 named aidlc-shared/ files [.sh L45-47]", () => {
    for (const f of SHARED_FILES) {
      expect(existsSync(join(KNOWLEDGE_DIR, "aidlc-shared", f))).toBe(true);
    }
  });

  // .sh Part 4 (L49-57): every shipped knowledge .md file is non-empty. The .sh
  // ran one assert_gt size 0 per file (TOTAL_FILES assertions); here we walk the
  // same set and assert byte size > 0 on each, naming any zero-byte offender.
  test("every shipped knowledge .md file is non-empty (byte size > 0) [.sh L53-57]", () => {
    const files = findMd(KNOWLEDGE_DIR);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const size = statSync(f).size;
      const rel = f.slice(KNOWLEDGE_DIR.length + 1);
      // Surface the offending relative path the way the .sh's message did.
      expect(size, `${rel} is empty`).toBeGreaterThan(0);
    }
  });

  // .sh L11-14: dynamic TAP plan = 11 + 11 + 7 + TOTAL_FILES. Re-derive that
  // arithmetic from the live tree so the migrated suite cannot silently shrink
  // the surface: pin the total .md count at 56 and the summed plan at 85.
  test("TAP-plan parity: 11 + 11 + 7 + TOTAL == 85 with TOTAL == 56 [.sh L11-14]", () => {
    const total = findMd(KNOWLEDGE_DIR).length;
    expect(total).toBe(56);
    const plan = 11 + 11 + 7 + total;
    expect(plan).toBe(85);
  });
});
