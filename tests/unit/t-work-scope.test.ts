// covers: function:withWorkPinned, function:pinnedWork, function:activeSpace, function:activeIntent, function:resolveWorkflowSelection
//
// The scope a step acts on a piece of work by name in, while its chat is on
// another: every reading of the work here is that one while it runs; one inside
// another gives the outer one back when it ends; a throw inside leaves none; an
// explicit --space or --intent still wins; and the chat is never bound by it.

import { afterEach, describe, expect, test } from "bun:test";
import { activeSpace, pinnedWork, withWorkPinned } from "../../dist/claude/.claude/tools/aidlc-locks.ts";
import { activeIntent, resolveWorkflowSelection } from "../../dist/claude/.claude/tools/aidlc-record-core.ts";
import { cleanupTestProject, createTestProject } from "../harness/fixtures.ts";

const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop()!);
});

describe("a work named for one step", () => {
  test("is the work here while it runs; one inside another gives the outer back; a throw leaves none; an explicit selector wins", () => {
    const dir = createTestProject();
    projects.push(dir);
    const lead = { space: "default", intent: "fixture-8000000000000001" };
    const other = { space: "pay", intent: "refunds-8000000000000002" };
    expect(pinnedWork()).toBeNull();
    withWorkPinned(lead, () => {
      expect(resolveWorkflowSelection(dir)).toMatchObject({ ...lead, binding: null });
      withWorkPinned(other, () => {
        expect(activeSpace(dir)).toBe("pay");
        expect(activeIntent(dir, "pay")).toBe("refunds-8000000000000002");
        expect(resolveWorkflowSelection(dir, { space: "pay" })).toMatchObject(other);
      });
      expect(pinnedWork()).toEqual(lead);
      expect(resolveWorkflowSelection(dir, { space: "default", intent: "named-8000000000000003" }).intent).toBe("named-8000000000000003");
      expect(activeIntent(dir, "default", "named-8000000000000003")).toBe("named-8000000000000003");
    });
    expect(pinnedWork()).toBeNull();
    expect(() => withWorkPinned(lead, () => {
      throw new Error("inside the scope");
    })).toThrow("inside the scope");
    expect(pinnedWork()).toBeNull();
  });
});
