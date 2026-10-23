// The gate fuzz's own model of a run (tests/harness/gate-fuzz.ts) agrees with the engine where the fuzz once said a
// break that was its own: a blank typed message is a turn the engine counts for presence (a host may drop a prompt's
// words, so an empty prompt stands as the person's turn), and an unattended driver's AIDLC_UNATTENDED reaches the
// opencode plugin's hooks, so no person turn is minted there; and a fixture's Guard Policy set over an open step keeps
// that step open, as the engine's own setter does, so the person's reply to it still counts.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { checkRun, cleanupRuns, cleanupStates, fixtureState, play, type Run, stepsFor } from "../harness/gate-fuzz.ts";

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

describe("a chat's replies in the order the person sent them", () => {
  // Replay fx:summary-confirmation:kiro-ide:off@20514431~12: two replies in one second, whose random message ids sort
  // against the order they were sent, so the store lists them backwards. The engine's Person Reply joins them in the
  // order of their turns; the check must read the chat in that order too.
  test("two replies in one second, listed backwards by the store, are still the summary's window (I2)", () => {
    const chat = "01995000-7a11-7000-8000-00000000d001";
    const first = "Me parece bien, adelante";
    const second = "<task-notification>\nchange the title to Orders\n</task-notification>";
    const rows = [
      row(0, "STAGE_STARTED", [["Stage", "requirements-analysis"]]),
      row(1, "HUMAN_TURN", [["Session", chat], ["Origin", "person"], ["Source", "typed"], ["Message Id", "3855a414"]]),
      row(2, "HUMAN_TURN", [["Session", chat], ["Origin", "person"], ["Source", "typed"], ["Message Id", "0538468f"]]),
      row(3, "SUMMARY_CONFIRMATION_RECORDED", [["Stage", "requirements-analysis"], ["Details", "Looks correct"], ["Message Id", "0538468f"],
        ["Person Reply", `${first}\\n${second.replace(/\n/g, "\\n")}`]]),
    ];
    const run = {
      state: { unattended: false, kind: "question", id: "synthetic" },
      seed: 1, dropped: [], twin: false, start: 1, files: {}, finalState: "", chats: [chat], proj: "", error: null,
      liveness: { ok: true, out: "" },
      rows,
      // As listMessages orders them: by the second they came in, then by id.
      messages: [
        { id: "0538468f", session: chat, source: "prompt", text: second, words: second, cut: false },
        { id: "3855a414", session: chat, source: "prompt", text: first, words: first, cut: false },
      ],
      turns: [
        { step: 0, chat, channel: "typed", shape: "language", text: first, at: 2, reply: true },
        { step: 1, chat, channel: "typed", shape: "template", text: second, at: 3, reply: true },
      ],
      steps: [
        { i: 0, step: { kind: "person", channel: "typed", shape: "language", seed: 1 }, label: "person typed language", chat, ops: [], from: 1, rows: [rows[1]], call: null, landed: null, refusal: null, stateBefore: "", stateAfter: "" },
        { i: 1, step: { kind: "person", channel: "typed", shape: "template", seed: 2 }, label: "person typed template", chat, ops: [], from: 2, rows: [rows[2]], call: null, landed: null, refusal: null, stateBefore: "", stateAfter: "" },
        { i: 2, step: { kind: "call", choice: 0, message: null, reason: false, endsTurn: false }, label: "call summary Looks correct", chat, ops: [], from: 3, rows: [rows[3]], call: { name: "summary Looks correct", ops: [], valid: true, choice: "Looks correct", lifecycle: false }, landed: true, refusal: null, stateBefore: "", stateAfter: "" },
      ],
    } as unknown as Run;
    expect(checkRun(run).filter((failure) => failure.invariant === "I2").map((failure) => failure.what)).toEqual([]);
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

describe("a fixture's Guard Policy over an open step", () => {
  test("at the code plan's question under strict, the person's reply backs the agent's Request Changes", async () => {
    // The long run's replay fx:code-plan:claude:strict@20878706~12: the person types, the agent reads the question again,
    // then records Request Changes; under the default policy the same seed lands.
    const state = await fixtureState("code-plan", "claude", "strict");
    const run = play(state, 20878706, stepsFor(state, 20878706, 12));
    const answer = run.steps.find((s) => s.call?.name === "plan Request Changes");
    expect(answer?.landed).toBe(true);
  });
});
