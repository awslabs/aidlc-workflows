// covers: file:knowledge/aidlc-architect-agent, file:knowledge/aidlc-aws-platform-agent, file:knowledge/aidlc-compliance-agent, file:knowledge/aidlc-delivery-agent, file:knowledge/aidlc-design-agent, file:knowledge/aidlc-developer-agent, file:knowledge/aidlc-devsecops-agent, file:knowledge/aidlc-operations-agent, file:knowledge/aidlc-pipeline-deploy-agent, file:knowledge/aidlc-product-agent, file:knowledge/aidlc-quality-agent, file:knowledge/aidlc-shared/ai-dlc-principles.md, file:knowledge/aidlc-shared/audit-format.md, file:knowledge/aidlc-shared/brownfield.md, file:knowledge/aidlc-shared/knowledge-readme-template.md, file:knowledge/aidlc-shared/rules-reading.md, file:knowledge/aidlc-shared/state-template.md, file:knowledge/aidlc-shared/verification.md
//
// t15 — knowledge-file inventory + non-emptiness invariant. Migrated from
// tests/unit/t15-knowledge-file-inventory.sh (the .sh declared no `# covers:`
// header; these file: ids name the shipped knowledge tree the .sh inventoried).
//
// Mechanism: none. This is a pure structural / on-disk check — directory
// membership, file counts, and file sizes under the distributable knowledge/
// tree. No process boundary, no argv/exit/stdout seam, no LLM, zero tokens. We
// resolve the same tree the .sh resolved via the harness's AIDLC_SRC
// (= <repo>/dist/claude/.claude, fixtures.ts) - the TS canonical for the
// .sh's KNOWLEDGE_DIR=$AIDLC_SRC/knowledge — and assert in-process with
// existsSync / statSync / a recursive .md walk.
//

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

const KNOWLEDGE_DIR = join(AIDLC_SRC, "knowledge");

const AGENT_COUNTS: ReadonlyArray<readonly [string, number]> = [
  ["aidlc-architect-agent", 6],
  ["aidlc-architecture-reviewer-agent", 1],
  ["aidlc-aws-platform-agent", 4],
  ["aidlc-compliance-agent", 1],
  ["aidlc-composer-agent", 1],
  ["aidlc-delivery-agent", 3],
  ["aidlc-design-agent", 5],
  ["aidlc-developer-agent", 6],
  ["aidlc-devsecops-agent", 4],
  ["aidlc-operations-agent", 4],
  ["aidlc-pipeline-deploy-agent", 3],
  ["aidlc-product-agent", 8],
  ["aidlc-product-lead-agent", 1],
  ["aidlc-quality-agent", 4],
];

const SHARED_FILES = [
  "ai-dlc-principles.md",
  "audit-format.md",
  "brownfield.md",
  "knowledge-readme-template.md",
  "rules-reading.md",
  "state-template.md",
  "verification.md",
] as const;

// Recursive .md file walk. Returns absolute paths.
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
  test("each of the 14 agent knowledge dirs has at least one .md file [.sh L20-23]", () => {
    for (const [agent] of AGENT_COUNTS) {
      const dir = join(KNOWLEDGE_DIR, agent);
      expect(existsSync(dir)).toBe(true);
      expect(findMd(dir).length).toBeGreaterThan(0);
    }
  });

  // Exact .md count per agent dir. One test per agent so a failure pins WHICH
  // agent drifted (block-scoped field check, house style).
  for (const [agent, expectedCount] of AGENT_COUNTS) {
    test(`${agent} ships EXACTLY ${expectedCount} knowledge .md file(s) [.sh L29-39]`, () => {
      const dir = join(KNOWLEDGE_DIR, agent);
      expect(findMd(dir).length).toBe(expectedCount);
    });
  }

  test("knowledge/ holds EXACTLY the 14 agent dirs + aidlc-shared/ [.sh L10 — membership strengthening]", () => {
    const dirs = readdirSync(KNOWLEDGE_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    const expected = [...AGENT_COUNTS.map(([a]) => a), "aidlc-shared"].sort();
    expect(dirs).toEqual(expected);
  });

  test("ships each of the 7 named aidlc-shared/ files [.sh L45-47]", () => {
    for (const f of SHARED_FILES) {
      expect(existsSync(join(KNOWLEDGE_DIR, "aidlc-shared", f))).toBe(true);
    }
  });

  test("every shipped knowledge .md file is non-empty (byte size > 0) [.sh L53-57]", () => {
    const files = findMd(KNOWLEDGE_DIR);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const size = statSync(f).size;
      const rel = f.slice(KNOWLEDGE_DIR.length + 1);
      expect(size, `${rel} is empty`).toBeGreaterThan(0);
    }
  });

  // Re-derive the arithmetic from the live tree so the suite cannot silently
  // shrink the surface: pin the total .md count at 60 and the summed plan at 95.
  test("TAP-plan parity: 14 + 14 + 7 + TOTAL == 95 with TOTAL == 60 [.sh L11-14]", () => {
    const total = findMd(KNOWLEDGE_DIR).length;
    expect(total).toBe(60);
    const plan = 14 + 14 + 7 + total;
    expect(plan).toBe(95);
  });
});
