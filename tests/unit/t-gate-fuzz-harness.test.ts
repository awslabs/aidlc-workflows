// The gate fuzz's own model of a run (tests/harness/gate-fuzz.ts) agrees with the engine where the fuzz once said a
// break that was its own: a blank typed message is a turn the engine counts for presence (a host may drop a prompt's
// words, so an empty prompt stands as the person's turn), and an unattended driver's AIDLC_UNATTENDED reaches the
// opencode plugin's hooks, so no person turn is minted there.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { checkRun, cleanupRuns, cleanupStates, fixtureState, play, type Run } from "../harness/gate-fuzz.ts";

setDefaultTimeout(10 * 60_000);

afterAll(() => {
  cleanupRuns();
  cleanupStates();
});

const row = (index: number, event: string, fields: Array<[string, string]>) => ({ index, event, fields: [["Event", event], ...fields] as Array<[string, string]> });

describe("presence as the engine counts it", () => {
  test("an answer backed only by a blank typed message has a turn behind it (I1)", () => {
    const chat = "01995000-7a11-7000-8000-00000000d001";
    const rows = [
      row(0, "STAGE_STARTED", [["Stage", "requirements-analysis"]]),
      row(1, "HUMAN_TURN", [["Session", chat], ["Origin", "person"], ["Source", "typed"], ["Message Id", "0000000a"]]),
      row(2, "QUESTION_ANSWERED", [["Stage", "requirements-analysis"], ["Details", "Guide me"], ["Message Id", "0000000a"]]),
    ];
    const run = {
      state: { unattended: false, kind: "question", id: "synthetic" },
      seed: 1, dropped: [], twin: false, start: 1, files: {}, finalState: "", chats: [chat], proj: "", error: null,
      liveness: { ok: true, out: "" },
      rows,
      messages: [{ id: "0000000a", session: chat, source: "prompt", text: "", words: null, cut: false }],
      turns: [{ step: 0, chat, channel: "typed", shape: "blank", text: "", at: 2, reply: false }],
      steps: [
        { i: 0, step: { kind: "person", channel: "typed", shape: "blank", seed: 1 }, label: "person typed blank", chat, ops: [], from: 1, rows: [rows[1]], call: null, landed: null, refusal: null, stateBefore: "", stateAfter: "" },
        { i: 1, step: { kind: "call", choice: 0, message: null, reason: false, endsTurn: false }, label: "call answer Guide me", chat, ops: [], from: 2, rows: [rows[2]], call: { name: "answer Guide me", ops: [], valid: true, choice: "Guide me", lifecycle: false }, landed: true, refusal: null, stateBefore: "", stateAfter: "" },
      ],
    } as unknown as Run;
    expect(checkRun(run).filter((failure) => failure.invariant === "I1").map((failure) => failure.what)).toEqual([]);
  });
});

describe("an unattended driver's variable reaches the tool's hooks", () => {
  test("on opencode, a person's typed line under AIDLC_UNATTENDED mints no person turn", async () => {
    const state = await fixtureState("stage-gate", "opencode", "strict", true);
    const run = play(state, 7, [{ kind: "person", channel: "typed", shape: "sentence", seed: 11 }]);
    expect(run.error).toBeNull();
    expect(run.rows.slice(run.start).filter((r) => r.event === "HUMAN_TURN").length).toBe(0);
  });
});
