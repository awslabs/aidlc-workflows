import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyLedger, type Ledger, lineAnchor, type LoadedLedger, reconcileLedger } from "../../.github/scripts/ai-pr-ledger.ts";
import {
  applyLedgerToReview,
  type ChangedFileManifest,
  parseStructuredReview,
  renderReview,
  type ReviewMetadata,
  type StructuredReview,
} from "../../.github/scripts/ai-pr-review.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

const BASE = "b".repeat(40);
const HEAD = "a".repeat(40);
const OLD_HEAD = "9".repeat(40);
const CONTEXT_ID = "c".repeat(64);
const AT = "2026-09-22T12:00:00Z";
const PATH = "core/example.ts";
const LINE_42 = "  const total = computeTotal(items);";
const LINE_43 = "  applyDiscount(total, coupon);";
const METADATA: ReviewMetadata = { title: "Add payment validation", body: "Please review." };
const MANIFEST: ChangedFileManifest = {
  base: BASE,
  head: HEAD,
  files: [{ path: PATH, status: "M", added: [{ start: 42, end: 44 }], deleted: [{ start: 40, end: 41 }], fileLevelEvidence: false, snapshot: `head/${PATH}` }],
};
const A42 = lineAnchor(PATH, "RIGHT", LINE_42);
const A43 = lineAnchor(PATH, "RIGHT", LINE_43);
const JUDGE_PROMPT = readFileSync(join(REPO_ROOT, ".github", "prompts", "ai-pr-review-judge.md"), "utf8");
const SCHEMA = JSON.parse(readFileSync(join(REPO_ROOT, ".github", "prompts", "ai-pr-review-judge-schema.json"), "utf8"));

function entry(id: string, priority: "P0" | "P1" | "P2" | "P3", anchors: Ledger["findings"][number]["anchors"]): Ledger["findings"][number] {
  return { id, priority, category: "correctness", title: `Finding ${id}`, anchors, status: "open", firstSeen: { head: OLD_HEAD, at: AT }, lastSeen: { head: OLD_HEAD, at: AT } };
}

function ledgerWith(...findings: Ledger["findings"]): LoadedLedger {
  const ledger = emptyLedger(42);
  ledger.findings = findings;
  ledger.nextId = findings.reduce((max, item) => Math.max(max, Number(item.id.slice(1))), 0) + 1;
  return { ledger, commentId: 900, digest: null, migrated: false };
}

function review(
  findings: Array<{ priority: "P0" | "P1" | "P2" | "P3"; line: number; ledgerId?: string }>,
  ledger: Array<{ id: string; disposition: "still-open" | "resolved"; findingIndex: number | null }> | undefined,
  decision: StructuredReview["decision"] = { actor: "author", action: "change", rationale: "The finding must be corrected." },
): string {
  return JSON.stringify({
    base: BASE,
    head: HEAD,
    inspection: { status: "complete", changedFiles: [PATH] },
    validation: ["Read every changed file."],
    assessment: { readiness: { score: 2, rationale: "Concrete completeness assessment." }, risk: { score: 4, rationale: "Concrete blast-radius assessment." } },
    userExperience: { status: "no-user-visible-change", change: "Internal validation only.", before: null, after: null, example: null, assessment: "No indirect user-experience risk." },
    decision,
    findings: findings.map((item, index) => ({
      priority: item.priority,
      category: "correctness",
      title: `Restated as number ${index + 1}`,
      ledgerId: item.ledgerId ?? null,
      evidence: [{ source: "DIFF", path: PATH, line: item.line, side: "RIGHT" }],
      problem: "The changed line sums items before discounts are applied.",
      impact: "Customers are overcharged.",
      requiredCorrection: "Apply the discount before computing the total.",
    })),
    ...(ledger ? { ledger } : {}),
    residualRisk: "None identified.",
  });
}

function contextDir(): string {
  const root = mkdtempSync(join(tmpdir(), "aida-dispositions-"));
  mkdirSync(join(root, "head", "core"), { recursive: true });
  const lines = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`);
  lines[41] = LINE_42;
  lines[42] = LINE_43;
  writeFileSync(join(root, "head", "core", "example.ts"), `${lines.join("\n")}\n`);
  return root;
}

describe("t347 AIDA judge dispositions of open ledger entries", () => {
  test("a still-open disposition binds the restatement to the ledger id; contradictions are rejected", () => {
    const parsed = parseStructuredReview(review([{ priority: "P1", line: 43 }], [{ id: "F2", disposition: "still-open", findingIndex: 0 }]), BASE, HEAD, MANIFEST, METADATA);
    expect(parsed.findings[0].ledgerId).toBe("F2");
    expect(parsed.dispositions).toEqual([{ id: "F2", disposition: "still-open", findingIndex: 0 }]);
    // Absent (older judge output) parses as no dispositions.
    expect(parseStructuredReview(review([], undefined), BASE, HEAD, MANIFEST, METADATA).dispositions).toEqual([]);
    const bad = (ledger: unknown, findings: Array<{ priority: "P1"; line: number; ledgerId?: string }> = [{ priority: "P1", line: 43 }]) =>
      parseStructuredReview(review(findings, ledger as never), BASE, HEAD, MANIFEST, METADATA);
    expect(() => bad([{ id: "x", disposition: "resolved", findingIndex: null }])).toThrow("ledger[0].id must be a ledger id");
    expect(() => bad([{ id: "F1", disposition: "fixed", findingIndex: null }])).toThrow("disposition must be still-open or resolved");
    expect(() => bad([{ id: "F1", disposition: "still-open", findingIndex: 3 }])).toThrow("findingIndex must name an entry of findings");
    expect(() => bad([{ id: "F1", disposition: "resolved", findingIndex: 0 }])).toThrow("resolves F1 but also restates it");
    expect(() => bad([{ id: "F1", disposition: "still-open", findingIndex: 0 }, { id: "F1", disposition: "resolved", findingIndex: null }])).toThrow("disposes of F1 twice");
    expect(() => bad([{ id: "F1", disposition: "still-open", findingIndex: 0 }], [{ priority: "P1", line: 43, ledgerId: "F2" }])).toThrow("binds F1 to findings[0], which already carries F2");
    // Direct ids are validated together with the dispositions: one finding per id, never resolved-and-restated, never bound elsewhere.
    expect(() => bad([], [{ priority: "P1", line: 43, ledgerId: "F1" }, { priority: "P1", line: 44, ledgerId: "F1" }])).toThrow("findings 0 and 1 both carry ledgerId F1");
    expect(() => bad([{ id: "F1", disposition: "resolved", findingIndex: null }], [{ priority: "P1", line: 43, ledgerId: "F1" }])).toThrow("ledger resolves F1 but findings[0] restates it");
    expect(() => bad([{ id: "F1", disposition: "still-open", findingIndex: 1 }], [{ priority: "P1", line: 43, ledgerId: "F1" }, { priority: "P1", line: 44 }])).toThrow("findings 0 and 1 both carry ledgerId F1");
    expect(() => bad([{ id: "F2", disposition: "still-open", findingIndex: 1 }], [{ priority: "P1", line: 43, ledgerId: "F1" }, { priority: "P1", line: 44, ledgerId: "F1" }])).toThrow("binds F2 to findings[1], which already carries F1");
    expect(() => bad("nope")).toThrow("ledger must be an array of dispositions");
  });

  test("dispositions decide the omitted pass: resolved needs evidence for blockers, still-open retains, undisposed falls back", () => {
    const loaded = ledgerWith(entry("F1", "P1", [A42]), entry("F2", "P1", [A43]), entry("F3", "P2", [A42]), entry("F4", "P1", [lineAnchor(PATH, "RIGHT", "gone")]), entry("F5", "P3", [A43]), entry("F6", "P1", [lineAnchor("core/other.ts", "RIGHT", "x")]));
    const presence = (anchor: { sha256: string }) => anchor.sha256 !== lineAnchor(PATH, "RIGHT", "gone").sha256;
    const dispositions = new Map<string, "resolved" | "still-open">([["F1", "resolved"], ["F2", "still-open"], ["F3", "resolved"], ["F5", "still-open"], ["F6", "resolved"]]);
    // Incremental review that changed only core/other.ts since the last review.
    const result = reconcileLedger(loaded, [], HEAD, AT, presence, dispositions, new Set(["core/other.ts"]));
    // F1 (P1, code and file unchanged) is NOT closed on the judge's word: retained for a maintainer.
    // F3 (P2) follows the judge. F6 (P1) closes because its file changed since the review.
    expect(result.resolvedIds).toEqual(["F3", "F4", "F6"]);
    expect(result.resolvedByJudgeIds).toEqual(["F3", "F6"]);
    expect(result.unverifiedResolutionIds).toEqual(["F1"]);
    // still-open retains whatever the priority; undisposed F4 resolved by presence (line gone).
    expect(result.retained.map(item => `${item.id}:${item.priority}`)).toEqual(["F1:P1", "F2:P1", "F5:P3"]);
    expect(result.undisposedIds).toEqual(["F4"]);
    expect(result.ledger.findings.find(item => item.id === "F1")?.status).toBe("open");
    expect(result.ledger.events.filter(event => event.kind === "resolved").map(event => `${event.id}:${event.reason}`)).toEqual([
      "F3:declared corrected by the judge (advisory: no change evidence required)",
      "F4:cited code is gone",
      "F6:declared corrected by the judge; cited files changed since the last review",
    ]);
    expect(result.ledger.events.find(event => event.id === "F1")?.reason).toBe("retained: declared corrected by the judge, but cited code and files are unchanged; a maintainer may accept");
    expect(result.ledger.events.find(event => event.id === "F2")?.reason).toBe("retained: still open per the judge, not restated");

    // A cited line gone is deterministic evidence too. A full review (first review, force-push,
    // /aida full) has no change set: unknown is never evidence, so the blocker stays retained.
    const gone = reconcileLedger(ledgerWith(entry("F1", "P1", [A42, lineAnchor(PATH, "RIGHT", "gone")])), [], HEAD, AT, presence, new Map([["F1", "resolved"]]), new Set());
    expect(gone.resolvedByJudgeIds).toEqual(["F1"]);
    expect(gone.ledger.events.at(-1)?.reason).toBe("declared corrected by the judge; a cited line is gone");
    const full = reconcileLedger(ledgerWith(entry("F1", "P1", [A42])), [], HEAD, AT, () => true, new Map([["F1", "resolved"]]), null);
    expect(full.resolvedByJudgeIds).toEqual([]);
    expect(full.unverifiedResolutionIds).toEqual(["F1"]);
    expect(full.retained.map(item => item.id)).toEqual(["F1"]);

    // Explicit bindings are processed before implicit fingerprint matches: the untagged finding on
    // A42 cannot consume F1, which the tagged finding names.
    const ordered = reconcileLedger(
      ledgerWith(entry("F1", "P1", [A42])),
      [
        { priority: "P1", category: "correctness", title: "untagged on the same line", anchors: [A42] },
        { priority: "P1", category: "correctness", title: "the restatement", anchors: [A43], ledgerId: "F1" },
      ],
      HEAD, AT, () => true,
    );
    // ...and since the untagged finding shares F1's fingerprint, it is a duplicate restatement and
    // folds into F1 rather than getting a second identity.
    expect(ordered.kept.map(item => `${item.ledgerId}:${item.title}`)).toEqual(["F1:the restatement"]);
    expect(ordered.ledger.findings.map(item => item.id)).toEqual(["F1"]);
    // An untagged duplicate of a restatement bound by id (same category, shared anchor) folds into
    // that entry instead of getting a second identity.
    const folded = reconcileLedger(
      ledgerWith(entry("F1", "P1", [A42])),
      [
        { priority: "P1", category: "correctness", title: "the restatement", anchors: [A43], ledgerId: "F1" },
        { priority: "P1", category: "correctness", title: "same defect, untagged", anchors: [A42, lineAnchor(PATH, "RIGHT", "line 9")] },
      ],
      HEAD, AT, () => true,
    );
    expect(folded.kept.map(item => `${item.ledgerId}:${item.title}`)).toEqual(["F1:the restatement"]);
    expect(folded.ledger.findings).toHaveLength(1);
    expect(folded.ledger.findings[0].anchors).toHaveLength(3);
    // Effective priority orders the publication: a restated P3 raised to its ledger P1 precedes a new P2.
    const raised = reconcileLedger(
      ledgerWith(entry("F1", "P1", [A42])),
      [
        { priority: "P2", category: "correctness", title: "new advisory", anchors: [A43] },
        { priority: "P3", category: "correctness", title: "restated softly", anchors: [A42], ledgerId: "F1" },
      ],
      HEAD, AT, () => true,
    );
    expect(raised.kept.map(item => `${item.priority}:${item.ledgerId}`)).toEqual(["P1:F1", "P2:F2"]);
  });

  test("end to end: a restatement under new wording keeps its id, a declared fix resolves, and the review says what happened", () => {
    const root = contextDir();
    try {
      const loaded = ledgerWith(entry("F1", "P1", [A42]), entry("F2", "P1", [A43]), entry("F3", "P1", [lineAnchor(PATH, "RIGHT", "line 7")]));
      // The judge restates F2 with new wording on a different line, declares F1 fixed, forgets F3.
      // This is a full review (no scope): F1's lines are intact and no change set exists, so the
      // judge's word alone does not retire the blocker.
      const raw = review([{ priority: "P1", line: 44 }], [{ id: "F2", disposition: "still-open", findingIndex: 0 }, { id: "F1", disposition: "resolved", findingIndex: null }]);
      const applied = applyLedgerToReview(parseStructuredReview(raw, BASE, HEAD, MANIFEST, METADATA), loaded, root, root, AT);
      expect(applied.review.findings.map(item => `${item.ledgerId}:${item.title}`)).toEqual(["F2:Restated as number 1"]);
      expect(applied.ledger.findings.map(item => `${item.id}:${item.status}`)).toEqual(["F1:open", "F2:open", "F3:open"]);
      expect(applied.ledger.findings[1].anchors).toHaveLength(2);
      expect(applied.ledger.nextId).toBe(4);
      expect(applied.review.ledger?.resolvedByJudge).toEqual([]);
      expect(applied.review.ledger?.unverifiedResolutions).toEqual(["F1"]);
      expect(applied.review.ledger?.undisposed).toEqual(["F3"]);
      expect(applied.review.ledger?.retained.map(item => item.id)).toEqual(["F1", "F3"]);
      const body = renderReview(applied.review, CONTEXT_ID).body;
      expect(body).toContain("**P1 [F2]: Restated as number 1**");
      expect(body).toContain("1 open entry left undisposed by the judge (F3); the judge declared F1 corrected but the cited code and files are unchanged, so it stays retained until a maintainer accepts.");
      expect(body).toContain("**P1 [F1]: Finding F1** — first reported at");
      expect(body).toContain("**P1 [F3]: Finding F3** — first reported at");
      expect(body).not.toContain("[F4]");

      // An open P1 restated as P2 keeps the ledger's P1 and the action follows the EFFECTIVE priority:
      // the judge's merge becomes author/change instead of aborting validation.
      const softened = applyLedgerToReview(
        parseStructuredReview(review([{ priority: "P2", line: 44 }], [{ id: "F2", disposition: "still-open", findingIndex: 0 }, { id: "F1", disposition: "still-open", findingIndex: null }, { id: "F3", disposition: "still-open", findingIndex: null }], { actor: "maintainer", action: "merge", rationale: "Only advisory work remains." }), BASE, HEAD, MANIFEST, METADATA),
        loaded, root, root, AT,
      );
      expect(softened.review.findings.map(item => `${item.priority}:${item.ledgerId}`)).toEqual(["P1:F2"]);
      expect(softened.review.decision.action).toBe("change");
      expect(softened.review.decision.rationale).toBe("Re-derived from the ledger: 2 open blocking findings (F1, F3) were not restated this run and the cited code is unchanged; F2 keeps the ledger's blocking priority, so the author still needs to act. Judge's note, superseded by finding severity: Only advisory work remains.");
      expect(softened.review.ledger?.decisionAdjusted).toBe(true);
      expect(renderReview(softened.review, CONTEXT_ID).event).toBe("REQUEST_CHANGES");

      // An untagged P1 that folds into an explicitly restated P2 raises the entry and the published
      // finding to P1, so the action is the author's, not the maintainer's.
      const advisoryOpen = ledgerWith({ ...entry("F1", "P2", [A42]), title: "Advisory as recorded" });
      const foldedUp = applyLedgerToReview(
        parseStructuredReview(review([{ priority: "P1", line: 42 }, { priority: "P2", line: 43 }], [{ id: "F1", disposition: "still-open", findingIndex: 1 }], { actor: "maintainer", action: "merge", rationale: "Only advisory work remains." }), BASE, HEAD, MANIFEST, METADATA),
        advisoryOpen, root, root, AT,
      );
      expect(foldedUp.review.findings.map(item => `${item.priority}:${item.ledgerId}:${item.title}`)).toEqual(["P1:F1:Restated as number 1"]);
      // ...and the published body is the P1's (its evidence), not the softer restatement's.
      expect(foldedUp.review.findings[0].evidence).toEqual([{ source: "DIFF", path: PATH, line: 42, side: "RIGHT" }]);
      expect(foldedUp.ledger.findings[0]).toMatchObject({ id: "F1", priority: "P1", title: "Restated as number 1" });
      expect(foldedUp.review.decision.action).toBe("change");
      expect(renderReview(foldedUp.review, CONTEXT_ID).event).toBe("REQUEST_CHANGES");

      // In an incremental review whose change set includes F1's file, the same disposition resolves it.
      const incremental = parseStructuredReview(raw, BASE, HEAD, MANIFEST, METADATA, { mode: "incremental", since: OLD_HEAD, reason: "r", files: [{ path: PATH, added: [{ start: 44, end: 44 }], deleted: [], deletedFile: false }] });
      const resolvedNow = applyLedgerToReview(incremental, loaded, root, root, AT);
      expect(resolvedNow.ledger.findings.map(item => `${item.id}:${item.status}`)).toEqual(["F1:resolved", "F2:open", "F3:open"]);
      expect(resolvedNow.review.ledger?.resolvedByJudge).toEqual(["F1"]);
      expect(renderReview(resolvedNow.review, CONTEXT_ID).body).toContain("resolved F1 (F1 declared corrected by the judge)");

      // A disposition naming a decided, resolved or unknown id is a validation error; a direct
      // ledgerId on a finding naming one is dropped and the finding recorded as new.
      const decided = ledgerWith({ ...entry("F1", "P1", [A42]), status: "accepted", decision: { by: "maint", at: AT, reason: "owned" } });
      expect(() => applyLedgerToReview(parseStructuredReview(review([], [{ id: "F1", disposition: "resolved", findingIndex: null }]), BASE, HEAD, MANIFEST, METADATA), decided, root, root, AT)).toThrow("ledger disposition names F1, which is not an open ledger entry");
      expect(() => applyLedgerToReview(parseStructuredReview(review([], [{ id: "F9", disposition: "still-open", findingIndex: null }]), BASE, HEAD, MANIFEST, METADATA), decided, root, root, AT)).toThrow("names F9, which is not an open ledger entry");
      const dropped = applyLedgerToReview(parseStructuredReview(review([{ priority: "P1", line: 43, ledgerId: "F1" }], []), BASE, HEAD, MANIFEST, METADATA), decided, root, root, AT);
      expect(dropped.review.findings.map(item => item.ledgerId)).toEqual(["F2"]);
      expect(dropped.ledger.findings[0].status).toBe("accepted");
      // An id that is not a ledger entry at all is a validation error, not a new finding.
      expect(() => applyLedgerToReview(parseStructuredReview(review([{ priority: "P1", line: 43, ledgerId: "F7" }], []), BASE, HEAD, MANIFEST, METADATA), decided, root, root, AT)).toThrow("carries ledgerId F7, which is not a ledger entry");

      // An advisory entry marked still-open without a restatement is retained and rendered, and
      // does not touch the decision.
      const advisory = ledgerWith(entry("F1", "P2", [A42]));
      const kept = applyLedgerToReview(parseStructuredReview(review([], [{ id: "F1", disposition: "still-open", findingIndex: null }]), BASE, HEAD, MANIFEST, METADATA), advisory, root, root, AT);
      expect(kept.review.ledger?.retained.map(item => item.id)).toEqual(["F1"]);
      // Not blocking: the action is the maintainer's merge decision and no blocking event is raised.
      expect(kept.review.decision.action).toBe("merge");
      expect(kept.review.decision.rationale).toContain("No P0 or P1 finding survives, so the next action is the maintainer's merge decision");
      expect(renderReview(kept.review, CONTEXT_ID).event).toBe("COMMENT");
      const advisoryBody = renderReview(kept.review, CONTEXT_ID).body;
      expect(advisoryBody).toContain("## Retained advisory findings");
      expect(advisoryBody).toContain("**P2 [F1]: Finding F1** — first reported at");
      expect(advisoryBody).toContain("0 retained blocking, 1 retained advisory");
      expect(advisoryBody).not.toContain("## Retained blocking findings");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the schema requires one disposition per open entry and the prompt explains the duty", () => {
    expect(SCHEMA.required).toContain("ledger");
    expect(SCHEMA.properties.ledger.items.required).toEqual(["id", "disposition", "findingIndex"]);
    expect(SCHEMA.properties.ledger.items.properties.disposition.enum).toEqual(["still-open", "resolved"]);
    expect(SCHEMA.properties.ledger.items.properties.findingIndex.type).toEqual(["integer", "null"]);
    expect(JUDGE_PROMPT).toContain("Dispose of every ledger entry whose `status` is `open` in the top-level\n  `ledger` array, exactly once each");
    expect(JUDGE_PROMPT).toContain("Never open a new finding for a defect an open entry already\n  names — bind it instead.");
    expect(JUDGE_PROMPT).toContain('{"id": "F3", "disposition": "still-open", "findingIndex": 0}');
    expect(JUDGE_PROMPT).toContain("The publisher honors `resolved` on a P0/P1 only with\n  deterministic evidence that the author acted");
  });
});
