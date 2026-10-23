// covers: file:skills/aidlc/SKILL.md
//
// t-acp-devin-journey.serial.test.ts — the full-intent journey through Devin
// CLI's ACP surface (`devin acp`), driven turn by turn by the scripted
// driver (tests/harness/devin-acp-drive.ts) with a rule-based answerer. The
// rules and labels come from a captured full-intent live run (verified on
// devin 3000.11.3 and re-run on 3000.11.92): plan offer → tailor → edit (free
// text) → approve → guide-me → clarifying batches → summary confirmation
// (free text) → stage gates (free-text Request Changes once) → plan approval
// → post-approval stage-gate decline/cancel ritual, answered by a typed
// approval → workflow completion.
//
// The answerer decides PER QUESTION on engine-fixed option labels — never on
// model-written headers, which vary run to run — and answers every question
// of a batched elicitation. The loop never sends a generic continuation: a
// typed "Please carry on." at an open gate reads as the person's go-ahead.
//
// What this proves end to end on the shipped dist/devin tree:
//   - elicitation/create is the question channel; answers keep the person's
//     words verbatim in stored messages — never the label "Other";
//   - declined and cancelled questions end their turn cleanly and the typed
//     follow-up is stored as a prompt message;
//   - the audit carries GATE_REJECTED, SUMMARY_CONFIRMATION_RECORDED and
//     PLAN_APPROVAL_RECORDED, and the work completes (WORKFLOW_COMPLETED).
//
// SPENDS Devin credits (about 30 min) — gated AIDLC_DEVIN_ACP_LIVE=1.

import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  driveDevinAcp,
  devinAcpSkipReason,
  openDevinAcpSession,
  storedPersonMessages,
  type DevinAnswer,
  type DevinAcpDriveResult,
  type DevinElicitation,
  type DevinElicitationRecord,
  type DevinQuestion,
} from "../harness/devin-acp-drive.ts";
import { setupDevinProject } from "../harness/exec-drive.ts";
import {
  fileCleanupReserveMs,
  liveCaseTimeoutMs,
  LIVE_LONG_OPERATION_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

const SKIP_REASON = devinAcpSkipReason();

// The whole intent takes about 30 minutes live: two long-operation budgets of
// work unless the caller pins AIDLC_TEST_TIMEOUT.
const TIMEOUT_S = Number(process.env.AIDLC_TEST_TIMEOUT);
const TEST_TIMEOUT_MS = Number.isSafeInteger(TIMEOUT_S) && TIMEOUT_S > 0
  ? TIMEOUT_S * 1000
  : liveCaseTimeoutMs(2 * LIVE_LONG_OPERATION_TIMEOUT_MS);
let caseDeadlineMs: number;
beforeEach(() => { caseDeadlineMs = Date.now() + TEST_TIMEOUT_MS; });
function remainingWorkMs(): number {
  return remainingOperationTimeoutMs(LIVE_LONG_OPERATION_TIMEOUT_MS, {
    deadlineMs: caseDeadlineMs,
    reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS),
    phase: "Devin ACP journey",
  })!;
}
// A turn can carry the whole intent (one prompt turn ran ~30 min / 280 tool
// calls live): each turn gets the remaining case budget, not the
// per-operation cap — the case deadline is the real bound.
function remainingTurnMs(): number {
  return remainingOperationTimeoutMs(TEST_TIMEOUT_MS, {
    deadlineMs: caseDeadlineMs,
    reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS),
    phase: "Devin ACP journey turn",
  })!;
}

const PROMPT =
  "/aidlc Build a small Python command-line tool for tracking personal expenses in a CSV file: " +
  "add an expense (date, amount, category, note), list expenses for a given month, " +
  "and show totals by category for a month. Include unit tests.";
const EDIT =
  "Keep it light, but turn plan approval and summary confirmation on, use Guard Policy strict, and have a reviewer check the requirements before I approve them";
const SUMMARY =
  "Request changes: also leave out recurring expenses for this first version";
const GATE =
  "Request Changes: say in the intent statement that CSV storage and command-line use are firm requirements";
// The typed follow-up after a declined/cancelled stage gate is the person
// approving in their own words — a generic "carry on" reads as a go-ahead.
const TYPED_FOLLOWUP = "I approve this stage, please continue.";
const PART_TWO_FREE_TEXT = "None of these, my answer is in part 1";

const has = (q: DevinQuestion, label: string) => q.options.some((o) => o.label === label);
const opt = (q: DevinQuestion, re: RegExp) => q.options.find((o) => re.test(o.label))?.label;

/** Was an elicitation whose options include `optionLabel` answered with it? */
function answeredWith(previous: DevinElicitationRecord[], optionLabel: string): boolean {
  return previous.some(
    (r) =>
      r.outcome === "answered" &&
      Object.values((r.answer as { answers?: Record<string, string | string[]> }).answers ?? {}).includes(
        optionLabel,
      ),
  );
}

/** A rule-based person who decides PER QUESTION on engine-fixed option
 *  labels (model-written headers vary run to run). One rule per question;
 *  decline/cancel are whole-elicitation answers decided up front. */
function makeAnswerer(fallbacks: string[]) {
  let composerEditPicked = false;
  let editTextDue = false;
  let summaryFreeTextDone = false;
  let gateFreeTextDone = false;
  let gatesAfterPlanApproval = 0;

  const perQuestion = (q: DevinQuestion): string | string[] => {
    // Plan offer.
    const tailor = opt(q, /^Tailor a plan/);
    if (tailor) return tailor;
    // Composer gate: Edit once (free text follows on the next elicitation),
    // then Approve.
    if (has(q, "Approve") && opt(q, /^Edit/) && has(q, "Reject")) {
      if (!composerEditPicked) {
        composerEditPicked = true;
        editTextDue = true;
        return opt(q, /^Edit/)!;
      }
      return "Approve";
    }
    // Answer mode.
    if (has(q, "Guide me")) return "Guide me";
    // Summary confirmation: free text once, then confirm.
    if (has(q, "Looks correct") && has(q, "Request changes")) {
      if (!summaryFreeTextDone) {
        summaryFreeTextDone = true;
        return SUMMARY;
      }
      return "Looks correct";
    }
    // Plan approval.
    if (has(q, "Approve Plan")) return "Approve Plan";
    // Stage gate: free-text request-changes once, then approve.
    if (has(q, "Approve") && has(q, "Request Changes")) {
      if (!gateFreeTextDone) {
        gateFreeTextDone = true;
        return GATE;
      }
      return "Approve";
    }
    // Learnings ritual.
    if (has(q, "Keep none of these")) return "Keep none of these";
    if (has(q, "Nothing to add")) return "Nothing to add";
    if (
      q.options.length === 4 &&
      ["Deviation", "Interpretation", "Open question", "Tradeoff"].every((l) => has(q, l))
    ) {
      return "Interpretation";
    }
    // Default: clarifying questions and anything unknown.
    const recommended = opt(q, /Use recommendation|\(Recommended\)/);
    let pick: string | undefined;
    if (recommended) {
      pick = recommended;
    } else if (/\(part [2-9] of \d+\)|more choices/.test(q.question)) {
      pick = PART_TWO_FREE_TEXT;
    } else {
      pick = q.options[0]?.label;
    }
    fallbacks.push(
      `header=${JSON.stringify(q.header)} q=${JSON.stringify(q.question.slice(0, 80))} ` +
        `opts=${JSON.stringify(q.options.map((o) => o.label))} → ${JSON.stringify(pick)}`,
    );
    return pick ?? "";
  };

  return (e: DevinElicitation, ctx: { turn: number; previous: DevinElicitationRecord[] }): DevinAnswer | undefined => {
    const questions = e.questions;
    // Decline/cancel ritual (whole elicitation): the first elicitation
    // containing a stage-gate question after "Approve Plan" was answered →
    // decline; the next → cancel; later gates are answered normally.
    const isGate = questions.some((q) => has(q, "Approve") && has(q, "Request Changes"));
    if (isGate && answeredWith(ctx.previous, "Approve Plan")) {
      gatesAfterPlanApproval += 1;
      if (gatesAfterPlanApproval === 1) return { action: "decline" };
      if (gatesAfterPlanApproval === 2) return { action: "cancel" };
    }
    const answers: Record<string, string | string[]> = {};
    questions.forEach((q, index) => {
      let value: string | string[];
      // The composer free-text reply rides the FIRST question of the
      // elicitation right after the Edit pick.
      if (index === 0 && editTextDue) {
        editTextDue = false;
        value = EDIT;
      } else {
        value = perQuestion(q);
      }
      answers[q.key] = q.multiSelect
        ? (Array.isArray(value) ? value : [value])
        : (Array.isArray(value) ? value.join(", ") : value);
    });
    return { action: "accept", answers };
  };
}

describe("t-acp-devin-journey — a full intent through devin acp", () => {
  test.skipIf(SKIP_REASON !== null)(
    `the person's words survive every question kind to WORKFLOW_COMPLETED${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const { proj, root } = setupDevinProject();
      const session = await openDevinAcpSession(proj, { timeoutMs: remainingWorkMs() });
      const fallbacks: string[] = [];
      const turns: DevinAcpDriveResult[] = [];
      let stalled: string | undefined;
      try {
        const answer = makeAnswerer(fallbacks);
        for (let turn = 0; turn < 6; turn++) {
          // The only legitimate typed follow-up answers a declined/cancelled
          // question; anything else is a stall — a generic "carry on" at an
          // open gate reads as the person's go-ahead.
          const prompt = turn === 0 ? PROMPT : TYPED_FOLLOWUP;
          const r = await driveDevinAcp({
            projectDir: proj,
            session,
            prompt,
            timeoutMs: remainingTurnMs(),
            answer,
          });
          turns.push(r);
          console.log(
            `turn ${turn + 1}: stopReason=${r.stopReason} tools=${r.toolCalls.length} ` +
              `elicits=${r.elicitations
                .map((e) => `${e.outcome}(${e.elicitation.questions.map((q) => q.header).join("+")})`)
                .join(", ") || "none"}`,
          );
          console.log(`turn ${turn + 1} assistant tail: ${r.assistantText.slice(-800)}`);
          const audit = r.auditEvents ?? [];
          if (audit.includes("WORKFLOW_COMPLETED")) break;
          const lastE = r.elicitations.at(-1);
          if (!(lastE && (lastE.outcome === "declined" || lastE.outcome === "cancelled"))) {
            stalled =
              `turn ${turn + 1} ended (${r.stopReason}) with no declined/cancelled ` +
              "elicitation and no WORKFLOW_COMPLETED — the run stalled";
            break;
          }
        }

        // Diagnostics first, always — a failure must show why a turn ended.
        if (fallbacks.length > 0) {
          console.log(`default answers used (${fallbacks.length}):\n  ${fallbacks.join("\n  ")}`);
        }
        const audit = turns.at(-1)?.auditEvents ?? [];
        console.log(`audit tail: ${JSON.stringify(audit.slice(-30))}`);
        const blocked = audit.filter((e) => e === "PLAN_APPROVAL_BLOCKED").length;
        const subagents = turns.flatMap((t) => t.subagents);
        console.log(`PLAN_APPROVAL_BLOCKED=${blocked} subagents=${subagents.length}`);
        if (stalled) throw new Error(stalled);

        expect(audit).toContain("WORKFLOW_COMPLETED");
        expect(audit).toContain("GATE_REJECTED");
        expect(audit).toContain("SUMMARY_CONFIRMATION_RECORDED");
        expect(audit).toContain("PLAN_APPROVAL_RECORDED");

        const elicitations = turns.flatMap((t) => t.elicitations);
        expect(elicitations.filter((e) => e.outcome === "unanswered")).toEqual([]);
        const issues = turns.flatMap((t) => t.toolCallIssues);
        if (issues.length > 0) {
          console.log("toolCallIssues:", JSON.stringify(issues.map((i) => ({ id: i.toolCallId, tool: i.tool, status: i.status, out: i.output.slice(0, 300) }))));
        }
        expect(issues).toEqual([]);

        // The person's words, verbatim, in the stored record — never "Other".
        const messages = storedPersonMessages(proj);
        for (const m of messages) {
          expect(m.text).not.toBe("Other");
          for (const entry of m.picker ?? []) expect(entry.reply).not.toBe("Other");
        }
        const pickerReplies = messages.flatMap((m) => (m.picker ?? []).map((p) => p.reply));
        for (const words of [EDIT, SUMMARY, GATE]) {
          expect(pickerReplies, JSON.stringify(pickerReplies.slice(0, 20))).toContain(words);
        }

        // Batch answers: every accepted elicitation with ≥2 questions has a
        // stored picker message with that many entries; single replies equal
        // what was sent; each sent multi-select label is in its reply.
        for (const record of elicitations) {
          if (record.outcome !== "answered" || record.elicitation.questions.length < 2) continue;
          const e = record.elicitation;
          const match = messages.find(
            (m) =>
              m.source === "picker" &&
              (m.picker?.length ?? 0) === e.questions.length &&
              e.questions.every((q) => {
                const entry = m.picker?.find((p) => p.question === q.question);
                if (!entry || typeof entry.reply !== "string") return false;
                const sent = (record.answer as { answers: Record<string, string | string[]> }).answers[q.key];
                if (typeof sent === "string") return entry.reply === sent;
                if (Array.isArray(sent)) return sent.every((label) => entry.reply!.includes(label));
                return false;
              }),
          );
          expect(
            match,
            `no stored picker message for batch: ${JSON.stringify(e.questions.map((q) => q.header))}`,
          ).toBeDefined();
        }

        // The plan-approval question names a real artifact path.
        const planQuestion = elicitations
          .map((r) => r.elicitation)
          .flatMap((e) => e.questions)
          .find((q) => has(q, "Approve Plan"));
        expect(planQuestion).toBeDefined();
        const mdMatch = planQuestion!.question.match(/[\w./-]*\.md/);
        expect(mdMatch, planQuestion!.question.slice(0, 300)).not.toBeNull();
        expect(existsSync(join(proj, mdMatch![0])), mdMatch![0]).toBe(true);

        // Stage gates name the completed stage ("<Stage> complete. How would
        // you like to proceed?" — casing varies by conductor phrasing);
        // summary confirmations say "Confirming".
        for (const e of elicitations.flatMap((x) => x.elicitation.questions)) {
          if (has(e, "Approve") && has(e, "Request Changes")) {
            expect(e.question).toMatch(/\bcomplete\b/i);
          }
          if (has(e, "Looks correct") && has(e, "Request changes")) {
            expect(e.question).toContain("Confirming");
          }
        }

        // Non-vacuously: the journey exercised one decline and one cancel.
        expect(elicitations.filter((e) => e.outcome === "declined").length).toBeGreaterThanOrEqual(1);
        expect(elicitations.filter((e) => e.outcome === "cancelled").length).toBeGreaterThanOrEqual(1);
        // The declined and cancelled questions each ended their turn; the typed
        // follow-up is on record as the person's prompt once per closed turn,
        // and the typed approval lands as a GATE_APPROVED in the audit.
        let closedTurns = 0;
        for (const [index, r] of turns.entries()) {
          const closed = r.elicitations.filter((e) => e.outcome === "declined" || e.outcome === "cancelled");
          if (closed.length === 0) continue;
          closedTurns += 1;
          expect(r.stopReason).toBe("end_turn");
          expect(
            r.rejectedToolCalls.filter((c) => c.tool === "ask_user_question").length,
          ).toBeGreaterThanOrEqual(closed.length);
          const next = turns[index + 1];
          expect(next).toBeDefined();
          const gatesBefore = (r.auditEvents ?? []).filter((e) => e === "GATE_APPROVED").length;
          const gatesAfter = (next?.auditEvents ?? []).filter((e) => e === "GATE_APPROVED").length;
          expect(gatesAfter).toBeGreaterThan(gatesBefore);
        }
        const typed = storedPersonMessages(proj).filter(
          (m) => m.source === "prompt" && m.text === TYPED_FOLLOWUP,
        );
        expect(typed.length).toBeGreaterThanOrEqual(closedTurns);
      } finally {
        session.close();
        if (process.env.AIDLC_KEEP_TEMP === "1") {
          process.stderr.write(`[t-acp-devin-journey] AIDLC_KEEP_TEMP=1 — preserved ${root}\n`);
        } else {
          rmSync(root, { recursive: true, force: true });
        }
      }
    },
    TEST_TIMEOUT_MS,
  );
});
