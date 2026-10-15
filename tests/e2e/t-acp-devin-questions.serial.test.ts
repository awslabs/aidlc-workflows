// covers: file:skills/aidlc/SKILL.md
//
// t-acp-devin-questions.serial.test.ts — the Devin ACP elicitation channel at
// the workflow's first decision. The person-facing contract the adapter fix
// was built for: an "Other"-typed free-text answer keeps the person's words
// end to end (elicitation reply → ask tool output → stored picker message),
// and a declined question stays open for a typed reply.
//
//   1. Own words kept: the plan-offer picker answered with free text must be
//      stored verbatim as a picker message — never the literal label "Other" —
//      and the intent gets created (stopAfterCommand ends the turn there).
//   2. A declined question stays open: declining the offer ends the turn
//      cleanly with no intent and no stored picker reply; the person's typed
//      follow-up prompt carries the same words as a "prompt" message and the
//      intent is created without the question being re-asked.
//
// SPENDS Devin credits — gated AIDLC_DEVIN_ACP_LIVE=1 (see devinAcpSkipReason).

import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  driveDevinAcp,
  devinAcpSkipReason,
  openDevinAcpSession,
  storedPersonMessages,
  type DevinElicitation,
} from "../harness/devin-acp-drive.ts";
import { setupDevinProject } from "../harness/exec-drive.ts";
import {
  fileCleanupReserveMs,
  liveCaseTimeoutMs,
  LIVE_LONG_OPERATION_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

const SKIP_REASON = devinAcpSkipReason();

const TIMEOUT_S = Number(process.env.AIDLC_TEST_TIMEOUT);
const TEST_TIMEOUT_MS = Number.isSafeInteger(TIMEOUT_S) && TIMEOUT_S > 0
  ? TIMEOUT_S * 1000
  : liveCaseTimeoutMs(LIVE_LONG_OPERATION_TIMEOUT_MS);
let caseDeadlineMs: number;
beforeEach(() => { caseDeadlineMs = Date.now() + TEST_TIMEOUT_MS; });
function remainingWorkMs(): number {
  return remainingOperationTimeoutMs(LIVE_LONG_OPERATION_TIMEOUT_MS, {
    deadlineMs: caseDeadlineMs,
    reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS),
    phase: "Devin ACP questions",
  })!;
}

const PROMPT = "/aidlc Build a tiny Python script that prints today's date, with one unit test.";
const OWN_WORDS = "Yes, go ahead with the plan you suggested.";
// The boundary the turn is stopped at: the exec call that creates the intent
// (`bun .devin/tools/aidlc.ts engine intent create …`) completed.
const INTENT_CREATED = /\bintent\s+create\b/;

function intentRecordCount(proj: string): number {
  const file = join(proj, "aidlc", "spaces", "default", "intents", "intents.json");
  if (!existsSync(file)) return 0;
  try {
    const rows = JSON.parse(readFileSync(file, "utf-8")) as unknown[];
    return Array.isArray(rows) ? rows.length : 0;
  } catch {
    return 0;
  }
}

/** The plan-offer elicitation is the one whose options offer to go ahead. */
function isPlanOffer(e: DevinElicitation): boolean {
  return e.questions.some((q) => q.options.some((o) => o.label.startsWith("Go ahead with")));
}

describe("t-acp-devin-questions — the person's words through the elicitation channel", () => {
  test.skipIf(SKIP_REASON !== null)(
    `1. own words kept: a free-text plan-offer answer is stored verbatim, never "Other"${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const { proj, root } = setupDevinProject();
      try {
        const r = await driveDevinAcp({
          projectDir: proj,
          prompt: PROMPT,
          timeoutMs: remainingWorkMs(),
          stopAfterCommand: INTENT_CREATED,
          answer: (e) =>
            isPlanOffer(e)
              ? { action: "accept", answers: { q0: OWN_WORDS } }
              : undefined,
        });
        expect(r.toolCallIssues).toEqual([]);
        // The offer was a real question: answered once, allowOther on, and the
        // "Go ahead with …" option was on it (the free text was a legal Other).
        const offer = r.elicitations.find((record) => isPlanOffer(record.elicitation));
        expect(offer).toBeDefined();
        expect(offer!.elicitation.allowOther).toBe(true);
        expect(offer!.outcome).toBe("answered");
        expect(r.elicitations.filter((record) => record.outcome === "unanswered")).toEqual([]);
        // The intent exists on disk.
        expect(intentRecordCount(proj)).toBeGreaterThanOrEqual(1);
        // The stored person message is a picker reply carrying the exact words.
        const messages = storedPersonMessages(proj);
        const picker = messages.filter((m) => m.source === "picker");
        expect(
          picker.some((m) => m.picker?.some((entry) => entry.reply === OWN_WORDS)),
          JSON.stringify(messages.map((m) => ({ source: m.source, text: m.text.slice(0, 80), picker: m.picker }))),
        ).toBe(true);
        // The live-run defect: "Other" must not stand in for the words anywhere.
        for (const m of messages) {
          expect(m.text).not.toBe("Other");
          for (const entry of m.picker ?? []) expect(entry.reply).not.toBe("Other");
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test.skipIf(SKIP_REASON !== null)(
    `2. a declined question stays open: the turn ends, no intent is made, and a typed follow-up answers it${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const { proj, root } = setupDevinProject();
      const session = await openDevinAcpSession(proj);
      try {
        // Turn 1: decline the plan offer. Declining is not an answer — the
        // turn ends, nothing is stored as the person's reply, no intent.
        const declined = await driveDevinAcp({
          projectDir: proj,
          session,
          prompt: PROMPT,
          timeoutMs: remainingWorkMs(),
          answer: (e) => (isPlanOffer(e) ? { action: "decline" } : undefined),
        });
        expect(declined.stopReason).toBe("end_turn");
        expect(declined.elicitations.map((r) => r.outcome)).toContain("declined");
        expect(intentRecordCount(proj)).toBe(0);
        expect(storedPersonMessages(proj).filter((m) => m.source === "picker")).toEqual([]);
        // The declined question ends its ask call as a host rejection, not a
        // tool failure.
        expect(
          declined.rejectedToolCalls.some((c) => c.tool === "ask_user_question"),
        ).toBe(true);
        expect(declined.toolCallIssues).toEqual([]);

        // Turn 2: the person types their reply. A re-ask is a defect — any
        // elicitation answered/cancelled/unanswered fails; after-stop records
        // (post-cancel stragglers) are the only tolerated outcome.
        const followed = await driveDevinAcp({
          projectDir: proj,
          session,
          prompt: OWN_WORDS,
          timeoutMs: remainingWorkMs(),
          stopAfterCommand: INTENT_CREATED,
          answer: () => undefined,
        });
        expect(
          followed.elicitations.filter((r) => r.outcome !== "after-stop"),
          JSON.stringify(followed.elicitations.map((r) => r.outcome)),
        ).toEqual([]);
        expect(followed.toolCallIssues).toEqual([]);
        expect(intentRecordCount(proj)).toBeGreaterThanOrEqual(1);
        const typed = storedPersonMessages(proj).filter(
          (m) => m.source === "prompt" && m.text === OWN_WORDS,
        );
        expect(typed, JSON.stringify(storedPersonMessages(proj))).toHaveLength(1);
      } finally {
        session.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
