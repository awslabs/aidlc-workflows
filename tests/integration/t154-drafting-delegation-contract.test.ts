// covers: doc:aidlc-common/protocols/stage-protocol.md, doc:SKILL.md(routing)
//
// t154 — drafting-delegation prose contract (ralph-loop, issue #421). Locks in
// the Option A "protocol-driven" change that keeps the conductor THIN: gated
// artifact-generating inline stages stay `mode: inline`, but the artifact-
// DRAFTING sub-step is delegated to a throwaway `Task(directive.lead_agent)`
// subagent whose heavy context is discarded after it returns the §11 summary.
// No engine / schema / stage-body change was made — the contract lives entirely
// in prose, so the only durable guard is a content assertion over that prose.
//
// Mechanism: none. Every assertion is a readFileSync + substring / regex check
// over the HAND-AUTHORED source bytes — same shape as the sibling protocol-
// content family (t34, t37). No driver, no spawn, no tokens.
//
// FIXTURE DISCIPLINE: unlike t34/t37 (which read the GENERATED dist tree via
// AIDLC_SRC), the ralph-loop edit landed in core/ + harness/ and the task pins
// the assertion to the hand-authored source — so this test resolves both files
// from REPO_ROOT directly. That keeps the test green BEFORE `bun
// scripts/package.ts` regenerates dist/, and asserts the source of truth rather
// than its projection. Files are read-only; nothing is written.
//
// Source under test (paths relative to REPO_ROOT):
//   core/aidlc-common/protocols/stage-protocol.md
//     "### Drafting delegation for inline stages" — the new subsection
//     the no-draft-while-blank-tags hook-safety constraint
//     the subagent-must-not-write-the-questions-file hook-safety constraint
//   harness/claude/skills/aidlc/SKILL.md
//     the run-stage gate arm's Draft step that references the delegation
//     contract AND marks it DISTINCT from `mode: subagent`

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const PROTOCOL_PATH = join(
  REPO_ROOT,
  "core",
  "aidlc-common",
  "protocols",
  "stage-protocol.md",
);
const SKILL_PATH = join(
  REPO_ROOT,
  "harness",
  "claude",
  "skills",
  "aidlc",
  "SKILL.md",
);

const PROTOCOL = readFileSync(PROTOCOL_PATH, "utf-8");
const SKILL = readFileSync(SKILL_PATH, "utf-8");

/** Extract a markdown section: from the line matching `start` (anchored) up to
 *  but not including the next line matching `end`. Mirrors the sibling tests'
 *  `sed -n '/start/,/end/p'` slicing so the per-section asserts are scoped. */
function section(text: string, start: RegExp, end: RegExp): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (!inSection) {
      if (start.test(line)) {
        inSection = true;
        out.push(line);
      }
      continue;
    }
    if (end.test(line)) break;
    out.push(line);
  }
  return out.join("\n");
}

describe("t154 stage-protocol.md carries the drafting-delegation contract", () => {
  // The new subsection must exist as a real H3 heading (anchored at line start),
  // not a mid-line mention.
  test("§5: '### Drafting delegation for inline stages' subsection exists", () => {
    expect(/^### Drafting delegation for inline stages\s*$/m.test(PROTOCOL)).toBe(
      true,
    );
  });

  // Scope the remaining contract asserts to the subsection so an unrelated match
  // elsewhere in the protocol can't satisfy them. The section runs to the next
  // H3 (`### Multi-agent stages:` follows it).
  const DELEGATION = section(
    PROTOCOL,
    /^### Drafting delegation for inline stages\s*$/,
    /^### /,
  );

  test("delegation section is non-empty (heading resolved + body captured)", () => {
    expect(DELEGATION.length).toBeGreaterThan(200);
  });

  test("contract: delegates ONLY the artifact-drafting sub-step", () => {
    // Robust to wording: require the "drafting" + "sub-step" concept and the
    // throwaway/discard-context intent. Match stable fragments, not a sentence.
    expect(/artifact-DRAFTING sub-step/.test(DELEGATION)).toBe(true);
  });

  test("contract: the stage stays mode: inline (not whole-stage subagent)", () => {
    expect(DELEGATION.includes("`mode: inline`")).toBe(true);
  });

  test("contract: delegates via one Task(directive.lead_agent)", () => {
    // The subagent_type is the directive's lead_agent; the persona auto-loads.
    expect(DELEGATION.includes("subagent_type = directive.lead_agent")).toBe(
      true,
    );
  });

  test("contract: subagent returns ONLY the §11 Subagent Return Summary", () => {
    expect(/return ONLY/i.test(DELEGATION)).toBe(true);
    expect(DELEGATION.includes("§11")).toBe(true);
  });

  test("contract: drafting is DISTINCT from whole-stage mode: subagent", () => {
    expect(DELEGATION.includes("`mode: subagent`")).toBe(true);
    // The exclusion must explicitly say a mode:subagent stage delegates the
    // ENTIRE stage including the gate — the line that keeps the two distinct.
    expect(/ENTIRE stage including the gate/.test(DELEGATION)).toBe(true);
  });

  // --- HOOK-SAFETY constraint 1: no draft while any [Answer]: tag is blank ---
  test("hook-safety: do NOT draft while any [Answer]: tag is still blank", () => {
    expect(DELEGATION.includes("[Answer]:")).toBe(true);
    // Stable concept: a still-blank tag blocks the draft; §3 Step 4 must pass.
    expect(/blank/.test(DELEGATION)).toBe(true);
    expect(/Step 4/.test(DELEGATION)).toBe(true);
  });

  // --- HOOK-SAFETY constraint 2: subagent must not write the questions file ---
  test("hook-safety: subagent treats <slug>-questions.md as read-only", () => {
    expect(/read-only/.test(DELEGATION)).toBe(true);
    // It must never write/create ANY questions file — the conductor owns them.
    // Broadened to any `*-questions.md` because aidlc-stop.ts matches the suffix.
    expect(
      /MUST NOT write or create ANY `\*-questions\.md`/.test(DELEGATION) ||
        /never write to or create that file/.test(DELEGATION) ||
        /MUST never write/.test(DELEGATION),
    ).toBe(true);
    expect(/\*-questions\.md/.test(DELEGATION)).toBe(true);
  });

  test("hook-safety: cites the aidlc-stop.ts Tier-2 human-wait carve-out", () => {
    expect(DELEGATION.includes("aidlc-stop.ts")).toBe(true);
    expect(/Tier-2/.test(DELEGATION)).toBe(true);
  });

  // --- Failure fallback: retry then Run inline / Skip and revisit ---
  test("fallback: offers 'Run inline' and 'Skip and revisit' on Task failure", () => {
    expect(DELEGATION.includes("Run inline")).toBe(true);
    expect(DELEGATION.includes("Skip and revisit")).toBe(true);
  });
});

describe("t154 SKILL.md run-stage gate arm references the draft step", () => {
  // The gate: true arm of "Branching a run-stage on its gate" gained a step 0
  // Draft step. Scope to that arm so the asserts can't be satisfied by an
  // unrelated mention. The numbered sub-steps run 0. (Draft) → 1. (Reviewer §12a).
  const DRAFT_STEP_LINE =
    SKILL.split("\n").find(
      (l) => /^\s*0\.\s+\*\*Draft step/.test(l),
    ) ?? "";

  test("gate arm has a '0. Draft step (inline artifact-generating stages)'", () => {
    expect(DRAFT_STEP_LINE.length).toBeGreaterThan(0);
    expect(/Draft step \(inline artifact-generating stages\)/.test(
      DRAFT_STEP_LINE,
    )).toBe(true);
  });

  test("draft step delegates via Task(directive.lead_agent)", () => {
    expect(DRAFT_STEP_LINE.includes("Task(directive.lead_agent)")).toBe(true);
  });

  test("draft step references the protocol's delegation section", () => {
    expect(
      DRAFT_STEP_LINE.includes("Drafting delegation for inline stages"),
    ).toBe(true);
    // and names the protocol file it lives in.
    expect(DRAFT_STEP_LINE.includes("stage-protocol.md")).toBe(true);
  });

  test("draft step is marked DISTINCT from mode: subagent", () => {
    expect(/DISTINCT from `mode: subagent`/.test(DRAFT_STEP_LINE)).toBe(true);
  });

  test("draft step restates the two hook-safety guards (read-only + no blank tag)", () => {
    expect(DRAFT_STEP_LINE.includes("read-only")).toBe(true);
    // never spawned while a tag is blank — the no-draft-while-blank guard.
    expect(/never spawned while a tag is blank/.test(DRAFT_STEP_LINE)).toBe(
      true,
    );
  });

  test("draft step precedes the §12a reviewer step in the gate arm", () => {
    const lines = SKILL.split("\n");
    const draftIdx = lines.findIndex((l) => /^\s*0\.\s+\*\*Draft step/.test(l));
    const reviewerIdx = lines.findIndex((l) =>
      /^\s*1\.\s+\*\*Reviewer step \(§12a\)/.test(l),
    );
    expect(draftIdx).toBeGreaterThanOrEqual(0);
    expect(reviewerIdx).toBeGreaterThan(draftIdx);
  });
});
