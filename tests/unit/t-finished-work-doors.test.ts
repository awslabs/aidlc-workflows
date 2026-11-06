// covers: function:standingPersonTurn, function:turnKeptSinceFinished, function:personAskedSinceGate, function:recordedSwitchChangeAdmitted, function:configToolAdmitted, hook:aidlc-plan-approval-guard
//
// Every door that asks whether the person spoke since the last decision reads
// one owner (standingPersonTurn). On work finished at Code Generation the
// human-turn hook keeps their messages beside the record, so the owner reads
// the message kept since the finish (#3608). From a chat that joined the
// finished work, the plan-approval guard's doors for AI-DLC's own commands that
// keep a person condition, a check turned off and the config tool's forms that
// can take a check away or fetch a release (a project refresh, `--plugins`),
// pass once the person asked and still wait when they did not, under every
// Guard Policy. Park and a scope change on finished work answer as before (the
// work is done; a scope change already went through), so they are not here.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cleanupTestProject } from "../harness/fixtures.ts";
import { finishedAtCodeGeneration, next, reply, runNamed, SHAPES } from "../harness/code-generation-states.ts";

setDefaultTimeout(600_000);

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

// A chat other than the one that gave the finishing approval, as a person
// coming back the next day opens one; its first `next` joins it to the work.
const CHAT = "01995000-7a11-7000-8000-0000000065c7";
const IN_CHAT = { AIDLC_SESSION_OVERRIDE: CHAT };
const claude = SHAPES[0];

const DOORS = [
  {
    name: "a check turned off",
    ask: "Turn the review freeze off for this project, please.",
    command: "bun .claude/tools/aidlc.ts config flags --bypass AIDLC_DISABLE_REVIEW_FREEZE_HOOK --local --yes",
    runs: true,
  },
  { name: "a project refresh", ask: "Refresh AI-DLC in this project.", command: "bun .claude/tools/aidlc.ts config", runs: false },
  {
    name: "plugins switched",
    ask: "Turn every plugin off for this project.",
    command: "bun .claude/tools/aidlc.ts config --plugins none",
    runs: false,
  },
] as const;

function joined(policy: "strict" | "relaxed" | "off"): string {
  const proj = finishedAtCodeGeneration(policy, "on");
  created.push(proj);
  const first = runNamed(proj, "bun .claude/tools/aidlc-orchestrate.ts next", IN_CHAT);
  expect(first.status, first.stdout + first.stderr).toBe(0);
  return proj;
}

describe.each(["strict", "relaxed", "off"] as const)("Guard Policy %s, work finished at Code Generation, a new chat", (policy) => {
  for (const door of DOORS) {
    test(`${door.name}: waits until the person asks, then goes through`, async () => {
      const proj = joined(policy);
      const unasked = await claude.call(proj, CHAT, { tool: "Bash", command: door.command });
      expect(unasked.code, `${door.command} passed with nobody asking`).toBe(2);
      const said = reply(proj, door.ask, CHAT);
      expect(said.status).toBe(0);
      const asked = await claude.call(proj, CHAT, { tool: "Bash", command: door.command });
      expect(asked.code, asked.said).toBe(0);
      // The steps after it, no loop: the setter carries a switch out on the
      // message the person asked in, whose id the agent heard with it; the
      // command naming it passes the guard and runs; the work is still done.
      if (door.runs) {
        const id = /on record as ([0-9a-f]{8})/.exec(said.stdout)?.[1];
        expect(id, `the agent was not told the message id: ${said.stdout}`).toBeDefined();
        const named = `${door.command} --message ${id}`;
        const again = await claude.call(proj, CHAT, { tool: "Bash", command: named });
        expect(again.code, again.said).toBe(0);
        const ran = runNamed(proj, named, IN_CHAT);
        expect(ran.status, ran.stdout + ran.stderr).toBe(0);
      }
      expect(next(proj).kind).toBe("done");
    });
  }
});
