// covers: function:buildsFollow, function:buildClaimNotes, subcommand:aidlc-orchestrate:next, subcommand:aidlc-log:decision
//
// What the lead's plan says to a team building one of its Units, met at a step
// that starts a stage (a long turn): that the plan moved and where the build
// reads it now, and that the plan closed, by whom and when. Each is kept for
// the reply the person reads: it rides every step the agent speaks from in that
// turn, the question step that ends it included, and is gone once the person
// writes. It is one line, said once, never a second time at a later step.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";
import {
  cleanupTeamBuild,
  hook,
  HOME_RECORD,
  next,
  personsChat,
  refundsTaken,
  run,
  UNIT,
  UTILITY,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const notices = (step: Record<string, unknown> | null | undefined): string[] => (step?.change_notices ?? []) as string[];
const kept = (dir: string, session: string): Array<{ line: string; reply?: boolean }> => {
  try {
    return (JSON.parse(readFileSync(join(dir, "aidlc", ".aidlc-engine", "sessions", `${session}.person-lines`), "utf-8")) as {
      lines: Array<{ line: string; reply?: boolean }>;
    }).lines;
  } catch {
    return [];
  }
};

// The line the team's build hears at its next step after `act` at the lead's
// project, followed through one turn: the step that starts it, a question of
// its current stage that ends it, and the person's next message.
function throughATurn(act: (home: ReturnType<typeof refundsTaken>["home"]) => void, startsWith: string) {
  const { home, alice, record } = refundsTaken();
  act(home);
  const session = "alice-turn";
  const chat = personsChat(session);
  expect(hook(alice, chat, { hook_event_name: "UserPromptSubmit", session_id: session, prompt: "/aidlc" }).status).toBe(0);
  const first = next(alice, chat);
  const line = notices(first).find((entry) => entry.startsWith(startsWith)) ?? "";
  const stage = /- \*\*Current Stage\*\*: (\S+)/.exec(readFileSync(join(record, "aidlc-state.md"), "utf-8"))?.[1] ?? "";
  const question = run(LOG, ["decision", "--stage", stage, "--decision", "Q1", "--option", "A. one", "--option", "B. two"], alice, chat);
  expect(hook(alice, chat, { hook_event_name: "UserPromptSubmit", session_id: session, prompt: "A" }).status).toBe(0);
  const after = next(alice, chat);
  return { alice, session, first, line, question, after };
}

describe("a line of the lead's plan to a team building its Unit, at a step that starts a stage", () => {
  test("the plan moved: kept for the reply, carried by the question that ends the turn, gone once the person writes", () => {
    const { alice, session, first, line, question, after } = throughATurn((home) => {
      expect(run(UNIT, ["share", "--plan", "--repo", "billing"], home.dir).status).toBe(0);
    }, "The plan of fixture moved to billing (");
    expect(line, JSON.stringify(first).slice(0, 800)).toEndWith("; this build reads it there now.");
    expect(question.status, question.out).toBe(0);
    expect(notices(question.json)).toContain(line);
    expect(kept(alice, session).some((entry) => entry.line === line)).toBe(false);
    expect(notices(after)).not.toContain(line);
  });

  test("the plan closed: kept for the reply, carried by the question that ends the turn, gone once the person writes", () => {
    const { alice, session, first, line, question, after } = throughATurn((home) => {
      expect(run(UTILITY, ["intent", "archive", HOME_RECORD], home.dir).status).toBe(0);
    }, "The plan of fixture in checkout-api was closed by lead, ");
    expect(line, JSON.stringify(first).slice(0, 800)).toEndWith("still here: carry it on, or tell me and I will hand it back.");
    expect(question.status, question.out).toBe(0);
    expect(notices(question.json)).toContain(line);
    expect(kept(alice, session).some((entry) => entry.line === line)).toBe(false);
    expect(notices(after)).not.toContain(line);
  });
});
