import { describe, expect, test } from "bun:test";
// @ts-expect-error browser module without a declaration file; Bun runs it as plain ESM
import { diffOps, wordDiffHtml } from "../../core/tools/data/review-ui/diff.js";

// The browser's word diff drives three surfaces: the inline tracked changes
// shown in the document for a suggested edit, the compact edit-card summary,
// and History's inline r0 -> r1 panels. Pinned here because a readable diff is
// the difference between "I can see what I changed" and a wall of fragments.
describe("t363 review UI word diff", () => {
  const flat = (ops: Array<{ type: string; text: string }>) =>
    ops.map((op) => (op.type === "eq" ? op.text : `[${op.type}:${op.text}]`)).join("");

  test("clean insertions keep their exact position", () => {
    const before = "The user can mark a task complete and uncomplete it. Completed tasks move.";
    const after = "The user can mark a task complete and uncomplete (re-open) it. Undo lasts five seconds. Completed tasks move.";
    expect(flat(diffOps(before, after))).toBe(
      "The user can mark a task complete and uncomplete [ins:(re-open) ]it. [ins:Undo lasts five seconds. ]Completed tasks move.",
    );
  });

  test("a rewritten sentence collapses to one removal and one insertion", () => {
    const before = "If storage is unavailable the app shows an error and refuses to start.";
    const after = "If storage is unavailable the app runs in memory for the session and warns that nothing will be saved.";
    expect(flat(diffOps(before, after))).toBe(
      "If storage is unavailable the app [del:shows an error and refuses to start][ins:runs in memory for the session and warns that nothing will be saved].",
    );
  });

  test("pure deletion and pure insertion", () => {
    expect(diffOps("Deletion asks for confirmation.", "")).toEqual([{ type: "del", text: "Deletion asks for confirmation." }]);
    expect(diffOps("", "New line.")).toEqual([{ type: "ins", text: "New line." }]);
    expect(diffOps("same", "same")).toEqual([{ type: "eq", text: "same" }]);
  });

  test("wordDiffHtml escapes and wraps", () => {
    expect(wordDiffHtml("a <b> c", "a <i> c")).toBe("a &lt;<del>b</del><ins>i</ins>&gt; c");
  });
});
