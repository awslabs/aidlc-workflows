// covers: function:writeRecordFileNoFollow, function:removeRecordFileNoFollow, function:attemptEventDefinitelyBefore, function:maximalAttemptEvents, function:projectPlanApprovalContent, function:projectStateForDigest, function:stateDigest, function:refuseEngineObserverWrite, function:approvalFingerprintIsCurrentFormat, function:collectStalePlanApprovalReceipts, function:stalePlanApprovalReceiptsForTarget
//
// WHAT A PLAN APPROVAL IS BOUND TO, at the unit level.
//
// The framework's job here is to answer one question honestly: is this exactly
// what the human approved? Two projections decide that, and both have to be
// sensitive to what a person would call a change and blind to what they would
// not:
//
//   1. The PLAN projection, which the approval fingerprint hashes. The stage
//      itself orders two edits to the approved file AFTER approval (the developer
//      agent ticks its task markers, and the reviewer appends its verdict to the
//      plan because the plan IS the stage's review artifact), so hashing raw bytes
//      invalidated every approval as soon as the approved work began.
//   2. The STATE projection, which the active directive binds to. aidlc-state.md
//      carries a cache layer the template itself calls "never routing or
//      completion evidence", and hashing it made the directive unreadable after
//      writes no human would call a change, which in turn made a recorded approval
//      unreachable.
//
// Plus the two structural guarantees that keep either projection from being
// undone: the write barrier that stops an engine OBSERVER from touching durable
// state at all, and the receipt path that is derived from content and attempt so a
// re-issued directive finds the approval that already exists.
//
// The end-to-end sequences these properties exist to protect live in
// tests/integration/t328-authority-rebinding.test.ts.

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendAuditEntry } from "../../core/tools/aidlc-audit.ts";
import {
  attemptEventDefinitelyBefore,
  EngineModeViolationError,
  maximalAttemptEvents,
  projectStateForDigest,
  readPlanApprovalReceipt,
  stateDigest,
  writeFileAtomic,
  writeBufferAtomic,
  writeRecordFileNoFollow,
  removeRecordFileNoFollow,
  writePlanApprovalReceipt,
  writeStateFile,
  collectStalePlanApprovalReceipts,
  stalePlanApprovalReceiptsForTarget,
  type PlanApprovalRuntimeReceipt,
} from "../../core/tools/aidlc-lib.ts";
import {
  approvalFingerprint,
  approvalFingerprintIsCurrentFormat,
  projectInstructionsContent,
  projectPlanApprovalContent,
} from "../../core/tools/aidlc-testing-posture.ts";
import { resetAidlcEnv } from "../harness/fixtures.ts";

resetAidlcEnv();

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = join(
    tmpdir(),
    `aidlc-t330-${process.pid}-${scratch.length}-${Date.now()}`,
  );
  mkdirSync(dir, { recursive: true });
  scratch.push(dir);
  return dir;
}

// --- 1. The plan projection ---------------------------------------------------

const PLAN = [
  "# Code Generation Plan",
  "",
  "## Testing Contract",
  "",
  "```json",
  "{",
  '  "version": 1,',
  '  "contract_sha256": "sha256:0f9e8d7c",',
  '  "methodology": "tdd"',
  "}",
  "```",
  "",
  "## Implementation Steps",
  "",
  "- [ ] Step 1: Create the manifest (US-101)",
  "  - Validate against the schema",
  "- [ ] Step 2: Add the stage file (US-101)",
  "- [ ] Step 3: Retry the record read up to 3 retries on EBUSY (US-102)",
  "",
  "Example output (literal, do not execute):",
  "",
  "```text",
  "- [ ] pending: stage compiled",
  "## Review",
  "This heading is inside a fence and is not a section.",
  "```",
  "",
  "## Story Traceability",
  "",
  "| Story | Steps |",
  "| --- | --- |",
  "| US-101 | 1, 2 |",
  "",
].join("\n");

const INSTRUCTIONS = [
  "# Unit Test Instructions",
  "",
  "## Command",
  "",
  "`bun test unit.test.ts`",
  "",
].join("\n");

function reviewAppendix(iteration: number, extra = ""): string {
  return [
    "",
    "## Review",
    "",
    `**Verdict:** ${iteration === 1 ? "NOT-READY" : "READY"}`,
    `**Iteration:** ${iteration}`,
    "",
    "### Checklist",
    "",
    "- [x] manifest schema validated",
    "- [ ] compose fixture asserted",
    extra,
    "### Summary",
    "",
    `Iteration ${iteration} summary.`,
    "",
  ].join("\n");
}

const AUTHORITY = {
  targetId: "unit:alpha",
  intentId: "intent-1",
  runFloor: "STAGE_STARTED:2026-09-01T00:00:00Z#1",
};
const CONTRACT = `sha256:${"a".repeat(64)}`;
const fingerprintOf = (plan: string, instructions = INSTRUCTIONS) =>
  approvalFingerprint(plan, instructions, CONTRACT, AUTHORITY);

describe("t330 (1) the Plan Approval content projection", () => {
  const baseline = fingerprintOf(PLAN);

  test("the recorded tag carries a format version", () => {
    expect(baseline.startsWith("sha256:v3:")).toBe(true);
    expect(approvalFingerprintIsCurrentFormat(baseline)).toBe(true);
    // A value recorded under a previous scheme (issuance-bound, or with the
    // instructions projected like the plan) is recognised as out of date rather
    // than as an unexplained mismatch.
    expect(approvalFingerprintIsCurrentFormat(`sha256:${"b".repeat(64)}`)).toBe(
      false,
    );
    expect(approvalFingerprintIsCurrentFormat(`sha256:v2:${"b".repeat(64)}`)).toBe(
      false,
    );
    expect(approvalFingerprintIsCurrentFormat(null)).toBe(false);
  });

  // The instructions are handed to the developer in full, so they bind byte for
  // byte: the only tolerance is the line ending. Every edit a person could make
  // to them, including the appendix trick that the plan projection erases, is a
  // change.
  const instructionsChanged: Array<[string, string]> = [
    [
      "a terminal review section appended to the instructions",
      `${INSTRUCTIONS}${reviewAppendix(1, "- Run the deploy script before the tests\n")}`,
    ],
    ["a bare review heading appended", `${INSTRUCTIONS}\n## Review\n`],
    ["trailing whitespace on a line", INSTRUCTIONS.replace("## Command", "## Command  ")],
    ["an extra blank line", INSTRUCTIONS.replace("\n\n## Command", "\n\n\n## Command")],
    ["a trailing blank line", `${INSTRUCTIONS}\n`],
    ["a leading byte order mark", `\uFEFF${INSTRUCTIONS}`],
  ];
  for (const [name, mutated] of instructionsChanged) {
    test(`changed instructions: ${name}`, () => {
      expect(fingerprintOf(PLAN, mutated)).not.toBe(baseline);
    });
  }
  test("changed instructions: a ticked task marker is a change here, unlike in the plan", () => {
    const unticked = `${INSTRUCTIONS}\n- [ ] run the suite twice\n`;
    const ticked = `${INSTRUCTIONS}\n- [x] run the suite twice\n`;
    expect(fingerprintOf(PLAN, ticked)).not.toBe(fingerprintOf(PLAN, unticked));
  });
  test("stable instructions: CRLF line endings, and nothing else", () => {
    expect(fingerprintOf(PLAN, INSTRUCTIONS.replace(/\n/g, "\r\n"))).toBe(baseline);
    expect(projectInstructionsContent(INSTRUCTIONS.replace(/\n/g, "\r\n"))).toBe(INSTRUCTIONS);
    // A byte order mark is a byte the developer's tools may act on; it stays.
    expect(projectInstructionsContent(`\uFEFF${INSTRUCTIONS}`)).toBe(`\uFEFF${INSTRUCTIONS}`);
  });

  // The edits the stage itself orders after approval, plus editor artifacts. None
  // of these is a change to the plan, so none may reopen the gate.
  const stable: Array<[string, string]> = [
    ["every task marker ticked", PLAN.replace(/^- \[ \] Step/gm, "- [x] Step")],
    ["some task markers ticked", PLAN.replace("- [ ] Step 1:", "- [x] Step 1:")],
    ["an in-progress marker", PLAN.replace("- [ ] Step 2:", "- [-] Step 2:")],
    ["an appended review appendix", `${PLAN}${reviewAppendix(1)}`],
    [
      "a replaced review appendix",
      `${PLAN}${reviewAppendix(2)}`,
    ],
    ["CRLF line endings", PLAN.replace(/\n/g, "\r\n")],
    // Outside a fence, trailing whitespace is an editor artifact. Inside one it is
    // content, which the "whitespace-only line inside a fence" case below pins.
    [
      "trailing whitespace on every prose line",
      (() => {
        let inFence = false;
        return PLAN.split("\n")
          .map((line) => {
            if (line.startsWith("```")) {
              inFence = !inFence;
              return line;
            }
            return inFence ? line : `${line}  `;
          })
          .join("\n");
      })(),
    ],
    ["extra trailing newlines", `${PLAN}\n\n\n`],
    ["a byte-order mark", `﻿${PLAN}`],
    [
      "extra blank lines between sections",
      PLAN.replace("\n## Implementation Steps", "\n\n\n## Implementation Steps"),
    ],
    [
      "the realistic end state: ticked, reviewed, and CRLF",
      `${PLAN.replace(/^- \[ \] Step/gm, "- [x] Step")}${reviewAppendix(2)}`
        .replace(/\n/g, "\r\n"),
    ],
    [
      "a review appendix holding a fenced heading",
      `${PLAN}${reviewAppendix(1, "```md\n## Implementation Steps\n- [ ] fake\n```\n")}`,
    ],
    [
      "a review heading with trailing spaces",
      `${PLAN}${reviewAppendix(1).replace("## Review\n", "## Review   \n")}`,
    ],
  ];
  for (const [name, mutated] of stable) {
    test(`stable: ${name}`, () => {
      expect(fingerprintOf(mutated)).toBe(baseline);
    });
  }

  // Anything a person would call a change to the plan, including every attempt to
  // pass an edit off as a review appendix.
  const changed: Array<[string, string, string?]> = [
    ["a reworded step", PLAN.replace("Step 1: Create", "Step 1: Generate")],
    ["a deleted step", PLAN.replace("- [ ] Step 2: Add the stage file (US-101)\n", "")],
    [
      "an added step",
      PLAN.replace("\nExample output", "- [ ] Step 4: Add a changelog entry\n\nExample output"),
    ],
    ["a changed number", PLAN.replace("3 retries", "5 retries")],
    ["a changed contract hash", PLAN.replace("sha256:0f9e8d7c", "sha256:1f9e8d7c")],
    ["text inside a fence", PLAN.replace("stage compiled", "stage recompiled")],
    ["a task marker inside a fence", PLAN.replace("- [ ] pending", "- [x] pending")],
    // Trailing whitespace is an editor artifact in prose and content in a fence: a
    // unified diff whose context line for a blank source line is a single space
    // applies a different patch from one whose line is empty.
    [
      "a whitespace-only line inside a fence",
      PLAN.replace(
        "- [ ] pending: stage compiled",
        "- [ ] pending: stage compiled\n ",
      ),
    ],
    [
      "trailing whitespace on a fenced content line",
      PLAN.replace(
        "- [ ] pending: stage compiled",
        "- [ ] pending: stage compiled  ",
      ),
    ],
    ["a new section", `${PLAN}\n## Rollback plan\n\n- [ ] revert\n`],
    ["changed instructions", PLAN, INSTRUCTIONS.replace("unit.test.ts", "other.test.ts")],
    [
      "a review section in the MIDDLE of the plan",
      PLAN.replace("## Story Traceability", `${reviewAppendix(1).trimStart()}\n## Story Traceability`),
    ],
    [
      "a lower-case review heading",
      `${PLAN}${reviewAppendix(1).replace("## Review\n", "## review\n")}`,
    ],
    [
      "a review heading without its space",
      `${PLAN}${reviewAppendix(1).replace("## Review\n", "##Review\n")}`,
    ],
    [
      "a setext review heading",
      `${PLAN}${reviewAppendix(1).replace("## Review\n", "Review\n------\n")}`,
    ],
    [
      "a review heading hidden in an HTML comment, then a step edit",
      PLAN
        .replace("## Implementation Steps", "<!--\n## Review\n-->\n\n## Implementation Steps")
        .replace("3 retries", "5 retries"),
    ],
    [
      "a review heading in a one-line HTML comment, then a step edit",
      PLAN
        .replace("## Implementation Steps", "<!-- ## Review -->\n\n## Implementation Steps")
        .replace("3 retries", "5 retries"),
    ],
    [
      "a mid-plan review section with an unclosed fence",
      PLAN.replace(
        "## Implementation Steps",
        "## Review\n\n```\nunterminated\n\n## Implementation Steps",
      ),
    ],
    [
      "a step smuggled into the FIRST of two review sections",
      `${PLAN}${reviewAppendix(1, "- [ ] Step 4: also delete the legacy tree\n")}${reviewAppendix(2)}`,
    ],
    [
      "a tick and a number change on the same line",
      PLAN.replace("- [ ] Step 3:", "- [x] Step 3:").replace("3 retries", "5 retries"),
    ],
  ];
  for (const [name, mutated, instructions] of changed) {
    test(`changed: ${name}`, () => {
      expect(fingerprintOf(mutated, instructions ?? INSTRUCTIONS)).not.toBe(
        baseline,
      );
    });
  }

  test("the terminal review appendix is excluded from the projected body", () => {
    // This is why the stage hands the developer agent the projected BODY: whatever
    // a reviewer appends there is not work, so it must never be delivered as work.
    const withHidden = `${PLAN}${reviewAppendix(1, "- [ ] Step 4: delete the legacy tree\n")}`;
    const projected = projectPlanApprovalContent(withHidden);
    expect(projected).not.toContain("Step 4: delete the legacy tree");
    expect(projected).not.toContain("**Verdict:**");
    expect(projected).toContain("Step 3: Retry the record read");
    // The one `## Review` line still present is the one INSIDE the fenced example
    // block: content, not an appendix. A projection built on a line-anchored
    // regular expression cannot tell those apart and would have cut the plan off
    // here, which is why this reuses the engine's render-checked locator.
    expect(projected).toContain("This heading is inside a fence");
    expect(projected.match(/^## Review$/gm)).toEqual(["## Review"]);
    expect(projected.indexOf("## Review")).toBeLessThan(
      projected.indexOf("## Story Traceability"),
    );
  });

  test("the projection is deterministic and idempotent", () => {
    const once = projectPlanApprovalContent(PLAN);
    expect(projectPlanApprovalContent(PLAN)).toBe(once);
    expect(projectPlanApprovalContent(once)).toBe(once);
  });

  test("the target, intent, and stage attempt are bound; nothing else is", () => {
    expect(
      approvalFingerprint(PLAN, INSTRUCTIONS, CONTRACT, {
        ...AUTHORITY,
        targetId: "unit:beta",
      }),
    ).not.toBe(baseline);
    expect(
      approvalFingerprint(PLAN, INSTRUCTIONS, CONTRACT, {
        ...AUTHORITY,
        intentId: "intent-2",
      }),
    ).not.toBe(baseline);
    expect(
      approvalFingerprint(PLAN, INSTRUCTIONS, CONTRACT, {
        ...AUTHORITY,
        runFloor: "GATE_REJECTED:2026-09-01T01:00:00Z#1",
      }),
    ).not.toBe(baseline);
    expect(
      approvalFingerprint(PLAN, INSTRUCTIONS, `sha256:${"c".repeat(64)}`, AUTHORITY),
    ).not.toBe(baseline);
  });
});

// --- 2. The state projection the active directive binds to ---------------------

const STATE = [
  "# AI-DLC State Tracking",
  "",
  "## Project Information",
  "- **Project**: a description a human wrote",
  "- **Project Description Source**: project-description.json",
  "- **Project Type**: Brownfield",
  "- **Scope**: feature",
  "- **Start Date**: 2026-09-01T09:00:00Z",
  "- **State Version**: 8",
  "- **Active Agent**: aidlc-developer-agent",
  "- **Worktree Path**:",
  "- **Bolt Refs**:",
  "- **Practices Affirmed Timestamp**: 2026-09-01T09:30:00Z",
  "",
  "## Workspace State",
  "- **Project Root**: .",
  "- **Languages**: TypeScript",
  "",
  "## Execution Plan Summary",
  "- **Total Stages**: 32",
  "- **Completed**: 12",
  "- **In Progress**: code-generation",
  "",
  "## Runtime State",
  "- **Revision Count**: 0",
  "- **Unit Ownership**: team",
  "- **Active Unit**: alpha",
  "- **Unit State**: in-progress",
  "",
  "## Stage Progress",
  "",
  "### CONSTRUCTION PHASE",
  "- [-] code-generation \u2014 EXECUTE",
  "",
  "## Unit Progress",
  "",
  "| unit | owner | code-generation | gate |",
  "| --- | --- | --- | --- |",
  "| alpha | - | [-] | [ ] |",
  "",
  "## Current Status",
  "- **Lifecycle Phase**: CONSTRUCTION",
  "- **Current Stage**: code-generation",
  "- **Status**: Running",
  "- **Last Updated**: 2026-09-01T10:15:00Z",
  "",
  "## Session Resume Point",
  "- **Last Completed Stage**: infrastructure-design",
  "- **Next Action**: continue generating",
  "",
].join("\n");

describe("t330 (2) the state digest the active directive binds to", () => {
  const baseline = stateDigest(STATE);

  const invisible: Array<[string, string]> = [
    ["Last Updated", STATE.replace("2026-09-01T10:15:00Z", "2026-09-01T23:59:59Z")],
    ["Active Agent", STATE.replace("aidlc-developer-agent", "aidlc-quality-agent")],
    ["the active Unit lifecycle mirror", STATE.replace("- **Unit State**: in-progress", "- **Unit State**: paused")],
    ["the active Unit itself", STATE.replace("- **Active Unit**: alpha", "- **Active Unit**: beta")],
    ["a new pause-reason mirror field", STATE.replace("- **Unit State**: in-progress", "- **Unit State**: paused\n- **Unit Pause Reason**: session ending")],
    ["the derived Unit Progress rows", STATE.replace("| alpha | - | [-] | [ ] |", "| alpha | - | [x] | [x] |")],
    ["the derived completed count", STATE.replace("- **Completed**: 12", "- **Completed**: 13")],
    ["detected workspace facts", STATE.replace("- **Languages**: TypeScript", "- **Languages**: TypeScript, Python")],
    ["the resume-point breadcrumb", STATE.replace("- **Next Action**: continue generating", "- **Next Action**: something else")],
    ["the project description", STATE.replace("a description a human wrote", "a description someone rewrote")],
    ["the worktree breadcrumb", STATE.replace("- **Worktree Path**:", "- **Worktree Path**: ../wt")],
  ];
  for (const [name, mutated] of invisible) {
    test(`ignored: ${name}`, () => {
      expect(stateDigest(mutated)).toBe(baseline);
    });
  }

  const visible: Array<[string, string]> = [
    ["Current Stage", STATE.replace("- **Current Stage**: code-generation", "- **Current Stage**: build-and-test")],
    ["a Stage Progress checkbox", STATE.replace("- [-] code-generation", "- [x] code-generation")],
    ["Status", STATE.replace("- **Status**: Running", "- **Status**: Completed")],
    ["Lifecycle Phase", STATE.replace("CONSTRUCTION\n- **Current Stage**", "OPERATION\n- **Current Stage**")],
    ["Scope", STATE.replace("- **Scope**: feature", "- **Scope**: express")],
    ["Unit Ownership", STATE.replace("- **Unit Ownership**: team", "- **Unit Ownership**: solo")],
    ["Revision Count", STATE.replace("- **Revision Count**: 0", "- **Revision Count**: 1")],
    ["In Progress", STATE.replace("- **In Progress**: code-generation", "- **In Progress**: build-and-test")],
    ["Project Type", STATE.replace("- **Project Type**: Brownfield", "- **Project Type**: Greenfield")],
    // The projection names the fields it ignores rather than skipping whole
    // sections, so content it has never seen still binds -- including content
    // appended at the very end of the file, after the last cache section.
    ["an unrecognised field inside a cache section", STATE.replace("- **Languages**: TypeScript", "- **Languages**: TypeScript\n- **Deployment Target**: aws")],
    ["a line appended at the end of the file", `${STATE}\n<!-- something appended -->\n`],
    // `getField` reads the state with the `m` flag, so a bare CR (and U+2028 /
    // U+2029) opens a new line for the ENGINE. A routing field placed there is live,
    // so it has to bind, even though it shares a physical LF-delimited line with an
    // ignored field.
    [
      "a routing field after a bare CR on an ignored field's line",
      STATE.replace(
        "- **Languages**: TypeScript",
        "- **Languages**: TypeScript\r- **Current Stage**: build-and-test",
      ),
    ],
    [
      "a routing field after U+2028 on an ignored field's line",
      STATE.replace(
        "- **Languages**: TypeScript",
        "- **Languages**: TypeScript\u2028- **Status**: Completed",
      ),
    ],
    ["prose added inside the derived grid", STATE.replace("| alpha | - | [-] | [ ] |", "| alpha | - | [-] | [ ] |\nhand-written note")],
  ];
  for (const [name, mutated] of visible) {
    test(`bound: ${name}`, () => {
      expect(stateDigest(mutated)).not.toBe(baseline);
    });
  }

  test("the projection keeps every routing line byte-exact", () => {
    const projected = projectStateForDigest(STATE);
    expect(projected).toContain("- **Current Stage**: code-generation");
    expect(projected).toContain("- [-] code-generation \u2014 EXECUTE");
    expect(projected).toContain("- **Unit Ownership**: team");
    expect(projected).not.toContain("Last Updated");
    expect(projected).not.toContain("| alpha |");
    // Section headings survive, so removing a whole section is still a change.
    expect(projected).toContain("## Unit Progress");
    expect(stateDigest(STATE.replace("## Unit Progress\n", ""))).not.toBe(baseline);
  });

  test("an empty state file projects to an empty string", () => {
    expect(projectStateForDigest("")).toBe("");
  });
});

// --- 3. The write barrier -----------------------------------------------------

describe("t330 (3) engine observers cannot reach a durable write", () => {
  const OBSERVER_MODES = ["AIDLC_STOP_HOOK_PROBE", "AIDLC_ROUTE_CHECK"] as const;

  function underMode<T>(mode: string, body: () => T): T {
    process.env[mode] = "1";
    try {
      return body();
    } finally {
      delete process.env[mode];
    }
  }

  for (const mode of OBSERVER_MODES) {
    test(`${mode} refuses every durable write primitive`, () => {
      const dir = scratchDir();
      mkdirSync(join(dir, "aidlc", "spaces", "default", "intents", "x-00000000"), {
        recursive: true,
      });
      const primitives: Array<[string, () => void]> = [
        ["writeStateFile", () => writeStateFile(dir, "# state\n")],
        ["writeFileAtomic", () => writeFileAtomic(join(dir, "barred.txt"), "x")],
        [
          "writeBufferAtomic",
          () => writeBufferAtomic(join(dir, "barred.bin"), Buffer.from("x")),
        ],
        [
          "appendAuditEntry",
          () =>
            appendAuditEntry(
              "ERROR_LOGGED",
              { Tool: "fixture", Message: "fixture" },
              dir,
            ),
        ],
        [
          "writeRecordFileNoFollow",
          () => writeRecordFileNoFollow(dir, ".aidlc-reviews/barred.json", "{}"),
        ],
        [
          "removeRecordFileNoFollow",
          () => removeRecordFileNoFollow(dir, "kept.txt"),
        ],
      ];
      writeFileSync(join(dir, "kept.txt"), "kept", "utf-8");
      for (const [name, call] of primitives) {
        let thrown: unknown;
        underMode(mode, () => {
          try {
            call();
          } catch (error) {
            thrown = error;
          }
        });
        expect(thrown, `${name} under ${mode}`).toBeInstanceOf(
          EngineModeViolationError,
        );
        expect((thrown as Error).message).toContain(
          name === "appendAuditEntry"
            ? "appendAuditBlockAtPath"
            : name === "writeRecordFileNoFollow"
              ? "writeBufferAtomic"
              : name,
        );
      }
      // And the refusal leaves nothing behind: a barrier that half-wrote would be
      // worse than no barrier.
      expect(existsSync(join(dir, "barred.txt"))).toBe(false);
      expect(existsSync(join(dir, "barred.bin"))).toBe(false);
      expect(existsSync(join(dir, ".aidlc-reviews", "barred.json"))).toBe(false);
      expect(readFileSync(join(dir, "kept.txt"), "utf-8")).toBe("kept");
    });
  }

  test("outside observer mode the same primitives write normally", () => {
    const dir = scratchDir();
    writeFileAtomic(join(dir, "allowed.txt"), "x");
    expect(readFileSync(join(dir, "allowed.txt"), "utf-8")).toBe("x");
  });
});

// --- 4. Causal order inside an append-only shard -------------------------------

describe("t330 (4) audit rows are ordered by where they landed", () => {
  // A Bolt merge appends the worktree's delta into the main intent shard, and those
  // rows keep their ORIGINAL, older timestamps. So inside one append-only shard the
  // timestamps can run backwards while the append order cannot. Position is the
  // truth there; timestamps only decide across shards, where there is no shared
  // order to appeal to. Every other consumer in the engine already worked this way;
  // the review brief was the one place that compared timestamps first, which is why
  // a merged review could be classified onto the wrong side of an attempt boundary.
  const row = (
    shard: string,
    pos: number,
    timestamp: string,
  ): { shard: string; shardIndex: number; pos: number; timestamp: string; event: string; block: string } => ({
    shard,
    shardIndex: shard === "main.md" ? 0 : 1,
    pos,
    timestamp,
    event: "REVIEW_COMPLETED",
    block: `**Event**: REVIEW_COMPLETED\n**Timestamp**: ${timestamp}\n`,
  });

  test("within one shard, append position decides even when timestamps disagree", () => {
    const appendedFirst = row("main.md", 4, "2026-09-01T10:00:00Z");
    const mergedDeltaAppendedLater = row("main.md", 9, "2026-08-30T08:00:00Z");
    expect(
      attemptEventDefinitelyBefore(appendedFirst, mergedDeltaAppendedLater),
    ).toBe(true);
    expect(
      attemptEventDefinitelyBefore(mergedDeltaAppendedLater, appendedFirst),
    ).toBe(false);
    // The later-appended row is therefore the frontier, which is what decides
    // whether a review counts for the current attempt.
    expect(
      maximalAttemptEvents([appendedFirst, mergedDeltaAppendedLater]),
    ).toEqual([mergedDeltaAppendedLater]);
  });

  test("across shards there is no shared order, so timestamps decide", () => {
    const inMain = row("main.md", 9, "2026-09-01T10:00:00Z");
    const inWorktree = row("worktree.md", 1, "2026-09-01T11:00:00Z");
    expect(attemptEventDefinitelyBefore(inMain, inWorktree)).toBe(true);
    expect(attemptEventDefinitelyBefore(inWorktree, inMain)).toBe(false);
  });

  test("a cycle in the mixed order still yields a frontier, never an empty one", () => {
    // Position-inside-a-shard and timestamp-across-shards are two different orders,
    // so the relation is not transitive and three rows can chase each other. An empty
    // frontier is the dangerous answer: every "after the frontier" test is an `every`
    // call, so no floor would read as "every row belongs to this attempt".
    const first = row("main.md", 10, "2026-09-01T10:00:05Z");
    const appendedLater = row("main.md", 11, "2026-09-01T10:00:01Z");
    const otherShard = row("worktree.md", 2, "2026-09-01T10:00:03Z");
    expect(attemptEventDefinitelyBefore(first, appendedLater)).toBe(true);
    expect(attemptEventDefinitelyBefore(appendedLater, otherShard)).toBe(true);
    expect(attemptEventDefinitelyBefore(otherShard, first)).toBe(true);
    const frontier = maximalAttemptEvents([first, appendedLater, otherShard]);
    expect(frontier.length).toBeGreaterThan(0);
    // The fallback is the coarser order: the timestamp-maximal rows.
    expect(frontier).toEqual([first]);
  });

  test("two rows tied across shards order neither way, so both stay on the frontier", () => {
    const tied = "2026-09-01T10:00:00Z";
    const inMain = row("main.md", 3, tied);
    const inWorktree = row("worktree.md", 7, tied);
    expect(attemptEventDefinitelyBefore(inMain, inWorktree)).toBe(false);
    expect(attemptEventDefinitelyBefore(inWorktree, inMain)).toBe(false);
    expect(maximalAttemptEvents([inMain, inWorktree]).length).toBe(2);
  });
});

// --- 5. The receipt path is derived from content and attempt -------------------

describe("t330 (5) the Plan Approval receipt path", () => {
  const IDENTITY = {
    targetId: "unit:alpha",
    intentId: "intent-1",
    runFloor: "STAGE_STARTED:2026-09-01T00:00:00Z#1",
    fingerprint: `sha256:v2:${"a".repeat(64)}`,
    questionsFile: "aidlc/x/code-generation-questions.md",
    promptSha256: "b".repeat(64),
  };
  const PROVENANCE = {
    directiveEpoch: `sha256:${"c".repeat(64)}`,
    sourceFloor: "d".repeat(64),
    markerRevision: 7,
    plannedSourceSha256: "d".repeat(64),
  };
  const receipt = (
    overrides: Partial<PlanApprovalRuntimeReceipt> = {},
  ): PlanApprovalRuntimeReceipt => ({
    version: 1,
    ...IDENTITY,
    ...PROVENANCE,
    session: "fixture-session",
    challengeId: "fixture-challenge",
    choice: "Approve Plan",
    questionsSha256: "e".repeat(64),
    certifiedSourceSha256: "d".repeat(64),
    status: "approved",
    ...overrides,
  });
  function project(): string {
    const dir = scratchDir();
    mkdirSync(join(dir, "aidlc"), { recursive: true });
    return dir;
  }

  test("a receipt is found again after the directive is re-issued", () => {
    const dir = project();
    writePlanApprovalReceipt(dir, receipt());
    // A different marker revision and a different directive epoch are exactly what
    // a re-issued directive produces, and they must not move the receipt.
    expect(
      readPlanApprovalReceipt(dir, IDENTITY)?.session,
    ).toBe("fixture-session");
    writePlanApprovalReceipt(
      dir,
      receipt({ markerRevision: 99, directiveEpoch: `sha256:${"f".repeat(64)}` }),
    );
    expect(readdirSync(join(dir, "aidlc", ".aidlc-sessions", "plan-approval"))
      .filter((name) => name.startsWith("receipt-")).length).toBe(1);
  });

  test("a different target, attempt, or content resolves to a different receipt", () => {
    const dir = project();
    writePlanApprovalReceipt(dir, receipt());
    expect(
      readPlanApprovalReceipt(dir, { ...IDENTITY, targetId: "unit:beta" }),
    ).toBeNull();
    expect(
      readPlanApprovalReceipt(dir, { ...IDENTITY, runFloor: "STAGE_JUMPED:x#1" }),
    ).toBeNull();
    expect(
      readPlanApprovalReceipt(dir, {
        ...IDENTITY,
        fingerprint: `sha256:v2:${"9".repeat(64)}`,
      }),
    ).toBeNull();
  });

  test("stale receipts for this target are reported and swept, others are left alone", () => {
    const dir = project();
    const current = receipt();
    const previousAttempt = receipt({
      runFloor: "STAGE_STARTED:2026-08-31T00:00:00Z#1",
      fingerprint: `sha256:v2:${"1".repeat(64)}`,
    });
    const otherUnit = receipt({
      targetId: "unit:beta",
      runFloor: "STAGE_STARTED:2026-08-31T00:00:00Z#1",
    });
    // Same target, same ended attempt, DIFFERENT intent. The store is per workspace,
    // so a second intent's receipt sits beside this one and must survive the sweep.
    const otherIntent = receipt({
      intentId: "11111111-2222-3333-4444-555555555555",
      runFloor: "STAGE_STARTED:2026-08-31T00:00:00Z#1",
    });
    for (const value of [current, previousAttempt, otherUnit, otherIntent]) {
      writePlanApprovalReceipt(dir, value);
    }
    const stale = stalePlanApprovalReceiptsForTarget(
      dir,
      IDENTITY.intentId,
      IDENTITY.targetId,
      IDENTITY.runFloor,
    );
    expect(stale.map((value) => value.runFloor)).toEqual([
      previousAttempt.runFloor,
    ]);
    expect(
      collectStalePlanApprovalReceipts(
        dir,
        IDENTITY.intentId,
        IDENTITY.targetId,
        IDENTITY.runFloor,
      ),
    ).toBe(1);
    expect(readPlanApprovalReceipt(dir, IDENTITY)?.runFloor).toBe(
      IDENTITY.runFloor,
    );
    expect(readPlanApprovalReceipt(dir, previousAttempt)).toBeNull();
    expect(readPlanApprovalReceipt(dir, otherUnit)?.targetId).toBe("unit:beta");
    expect(readPlanApprovalReceipt(dir, otherIntent)?.intentId).toBe(
      otherIntent.intentId,
    );
  });

  test("the receipt file name is a digest, not a readable identity", () => {
    const dir = project();
    writePlanApprovalReceipt(dir, receipt());
    const [name] = readdirSync(
      join(dir, "aidlc", ".aidlc-sessions", "plan-approval"),
    );
    expect(name).toMatch(/^receipt-[0-9a-f]{64}\.json$/);
    expect(name).toBe(
      `receipt-${
        createHash("sha256")
          .update(
            `${IDENTITY.targetId}\n${IDENTITY.runFloor}\n${IDENTITY.fingerprint}`,
            "utf-8",
          )
          .digest("hex")
      }.json`,
    );
  });
});
