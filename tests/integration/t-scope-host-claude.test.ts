// covers: scope:classic, file:tests/harness/scope-hosts.ts
//
// The classic scope on the Claude Code tree, with no model, through a fresh
// clone and a second chat: two Units built one at a time with a checkpoint
// each; after the first Unit's checkpoint the person stops for the day, picks
// the work up from a fresh clone and carries on in a new chat
// (tests/harness/scope-hosts.ts says what the journey checks). The Codex and
// Copilot files run the same journey through their own trees' hooks.

import { expect, test } from "bun:test";
import { hostJourney, hostJourneySuite } from "../harness/scope-hosts.ts";
import { RESUME_AGAIN, SCOPE_RUN_TIMEOUT_MS } from "../harness/scope-run.ts";

hostJourneySuite("claude");

// In a fresh clone /aidlc --resume asks which work to carry on with; picking
// it runs plain `next`, which answers that the work is paused and to resume
// again. The journey lists that one detour (KNOWN_JOURNEY_DETOURS in
// tests/harness/scope-hosts.ts); the fix removes it there and turns this on.
test.todo(
  "picking parked work up in a fresh clone resumes it (blocked by: the pick's print sends the agent to plain next, which answers parked)",
  () => {
    expect(hostJourney("claude").run.agent.detours).not.toContain(RESUME_AGAIN);
  },
  SCOPE_RUN_TIMEOUT_MS,
);
