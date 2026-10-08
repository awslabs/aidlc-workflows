// covers: function:DECISION_CLOSING_EVENTS, function:decisionAnsweredBy, function:nextOpenDecision
//
// t351 - the two readers that pair a DECISION_RECORDED with its answer must
// agree on which events close it. `hasPendingDecision` (aidlc-lib.ts, the Stop
// hook's logged-question carve-out) and `hasPendingDecisionAtGate`
// (aidlc-log.ts, the gate-time answer router) once kept separate closer lists:
// the Stop hook closed only on QUESTION_ANSWERED, so an answered Consolidated
// Summary Confirmation (SUMMARY_CONFIRMATION_RECORDED), a Plan Approval
// recorded on the legacy picker path (PLAN_APPROVAL_RECORDED, which neither
// list had), and an answered Swarm Batch or Construction Unit Approval (a
// GATE_APPROVED / GATE_REJECTED row of that checkpoint, which neither list had)
// still read as a pending human wait (#1466). Both now step one shared pairing,
// nextOpenDecision; this test pins what it closes on and fails if either
// reader grows its own closer list again. The behavioural half lives in t121
// (s1)-(s5), (p1)-(p3) and (c1)-(c8), plus the real commands in t342 and the
// gate-time answer router in t188. Mechanism: none (source + import).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DECISION_CLOSING_EVENTS,
  DECISION_GATE_ANSWER_EVENTS,
  decisionAnsweredBy,
  GATE_ANSWERED_DECISION_CHECKPOINTS,
  nextOpenDecision,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const ROOT = join(import.meta.dir, "..", "..");
const CLOSERS = [
  "QUESTION_ANSWERED",
  "SUMMARY_CONFIRMATION_RECORDED",
  "VERIFICATION_COMMAND_RECORDED",
  "CONSTRUCTION_POLICY_RECORDED",
  "PLAN_APPROVAL_RECORDED",
];
const GATE_EVENTS = ["GATE_APPROVED", "GATE_REJECTED"];

/** The source text of `function <name>(` up to the next top-level `}`. */
function functionBody(file: string, name: string): string {
  const src = readFileSync(join(ROOT, file), "utf-8");
  const start = src.search(new RegExp(`^(export )?function ${name}\\(`, "m"));
  expect(start).toBeGreaterThanOrEqual(0);
  const end = src.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

/** An audit block with the given fields, in the shape emitAudit writes. */
const block = (fields: Record<string, string>) =>
  Object.entries(fields).map(([key, value]) => `**${key}**: ${value}`).join("\n");

describe("t351 decision closer parity (#1466)", () => {
  test("DECISION_CLOSING_EVENTS holds every event that answers any logged decision", () => {
    expect([...DECISION_CLOSING_EVENTS].sort()).toEqual([...CLOSERS].sort());
  });

  test("gate rows answer only the checkpoints whose tools answer with them", () => {
    expect([...DECISION_GATE_ANSWER_EVENTS].sort()).toEqual(GATE_EVENTS);
    expect(GATE_ANSWERED_DECISION_CHECKPOINTS).toEqual({
      "Swarm Batch Approval": { gateCheckpoints: ["swarm-batch"], key: "Batch number" },
      "Construction Unit Approval": { gateCheckpoints: ["construction-unit", "walking-skeleton"], key: "Unit" },
    });
  });

  test("a gate row closes its own checkpoint's decision and nothing else", () => {
    const batch1 = block({ Event: "DECISION_RECORDED", Checkpoint: "Swarm Batch Approval", "Batch number": "1" });
    const alpha = block({ Event: "DECISION_RECORDED", Checkpoint: "Construction Unit Approval", Unit: "alpha" });
    const ordinary = block({ Event: "DECISION_RECORDED", Decision: "Anything to add?" });
    for (const event of GATE_EVENTS) {
      expect(decisionAnsweredBy(batch1, event, block({ Checkpoint: "swarm-batch", "Batch number": "1" }))).toBe(true);
      expect(decisionAnsweredBy(batch1, event, block({ Checkpoint: "swarm-batch", "Batch number": "2" }))).toBe(false);
      expect(decisionAnsweredBy(batch1, event, block({ Checkpoint: "construction-unit", "Batch number": "1" }))).toBe(false);
      expect(decisionAnsweredBy(alpha, event, block({ Checkpoint: "construction-unit", Unit: "alpha" }))).toBe(true);
      expect(decisionAnsweredBy(alpha, event, block({ Checkpoint: "walking-skeleton", Unit: "alpha" }))).toBe(true);
      expect(decisionAnsweredBy(alpha, event, block({ Checkpoint: "construction-unit", Unit: "beta" }))).toBe(false);
      // An ordinary stage gate (no Checkpoint) or another checkpoint's gate row
      // must not answer an unrelated open question.
      expect(decisionAnsweredBy(ordinary, event, block({ Stage: "code-generation" }))).toBe(false);
      expect(decisionAnsweredBy(ordinary, event, block({ Checkpoint: "construction-unit", Unit: "alpha" }))).toBe(false);
      expect(decisionAnsweredBy(null, event, block({ Checkpoint: "swarm-batch", "Batch number": "1" }))).toBe(false);
    }
    for (const closer of CLOSERS) expect(decisionAnsweredBy(ordinary, closer, "")).toBe(true);
    expect(nextOpenDecision(null, "DECISION_RECORDED", alpha)).toBe(alpha);
    expect(nextOpenDecision(alpha, "GATE_APPROVED", block({ Checkpoint: "construction-unit", Unit: "alpha" }))).toBeNull();
    expect(nextOpenDecision(alpha, "GATE_APPROVED", block({ Checkpoint: "construction-unit", Unit: "beta" }))).toBe(alpha);
  });

  test("gate answers match the checkpoint kind and the evidence that was presented", () => {
    for (const event of GATE_EVENTS) {
      for (const [kind, checkpoint, otherCheckpoint] of [
        ["unit", "construction-unit", "walking-skeleton"],
        ["skeleton", "walking-skeleton", "construction-unit"],
      ]) {
        const decision = block({
          Checkpoint: "Construction Unit Approval", Unit: "alpha", Kind: kind, Fingerprint: "current",
        });
        expect(decisionAnsweredBy(decision, event, block({
          Checkpoint: checkpoint, Unit: "alpha", Fingerprint: "current",
        }))).toBe(true);
        expect(decisionAnsweredBy(decision, event, block({
          Checkpoint: otherCheckpoint, Unit: "alpha", Fingerprint: "current",
        }))).toBe(false);
        for (const fingerprint of ["previous", undefined]) {
          expect(decisionAnsweredBy(decision, event, block({
            Checkpoint: checkpoint, Unit: "alpha",
            ...(fingerprint === undefined ? {} : { Fingerprint: fingerprint }),
          }))).toBe(false);
        }
      }
      const batch = block({
        Checkpoint: "Swarm Batch Approval", "Batch number": "1", Fingerprint: "current",
      });
      expect(decisionAnsweredBy(batch, event, block({
        Checkpoint: "swarm-batch", "Batch number": "1", Fingerprint: "current",
      }))).toBe(true);
      expect(decisionAnsweredBy(batch, event, block({
        Checkpoint: "swarm-batch", "Batch number": "1", Fingerprint: "previous",
      }))).toBe(false);
    }
  });

  test("unknown checkpoint names leave the decision open", () => {
    for (const checkpoint of ["unknown", "constructor", "toString", "__proto__"]) {
      const decision = block({ Checkpoint: checkpoint, Unit: "alpha" });
      expect(nextOpenDecision(decision, "GATE_APPROVED", block({
        Checkpoint: "construction-unit", Unit: "alpha",
      }))).toBe(decision);
    }
  });

  for (const [file, name] of [
    ["core/tools/aidlc-lib.ts", "hasPendingDecision"],
    ["core/tools/aidlc-log.ts", "hasPendingDecisionAtGate"],
  ] as const) {
    test(`${name} steps the shared pairing and keeps no closer list of its own`, () => {
      const body = functionBody(file, name);
      expect(body).toContain("DECISION_PAIRING_EVENTS");
      expect(body).toContain("nextOpenDecision");
      for (const closer of [...CLOSERS, ...GATE_EVENTS]) {
        expect(body).not.toContain(`"${closer}"`);
      }
    });
  }
});
