// covers: function:mutationIntent, function:evaluate, hook:aidlc-plan-approval-guard
//
// A read of the work's own files written with a shell variable or a `$(...)`
// runs wherever any other command whose writes cannot be seen runs. The record
// folder is `aidlc/`, and the guard used to read that word in a dynamic command
// as AI-DLC's own command, so the read was refused. Seen twice with Claude
// Code: on Windows Server, a resume at the waiting code plan, where the agent
// then told the person "AI-DLC blocks shell commands until the plan is
// approved"; on Linux, a new chat at the open Code Generation gate. AI-DLC's own
// command named through a variable or a substitution still waits.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { cleanupTestProject } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import {
  cleanupWorktreeFixtures,
  respell,
  SHAPES,
  STATES,
  stageDir,
  type BuiltState,
} from "../harness/code-generation-states.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 4);

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
  cleanupWorktreeFixtures();
});

function build(id: string): BuiltState {
  const state = STATES.find((builder) => builder.id === id)!.build();
  created.push(state.proj);
  return state;
}

/** The record folder, as the agent names it from the project. */
function record(state: BuiltState): string {
  return join(stageDir(state.proj), "..", "..").slice(state.proj.length + 1).replaceAll("\\", "/");
}

function reads(state: BuiltState): string[] {
  const r = record(state);
  return [
    // The Windows Server resume, as the agent ran it there.
    's=$(cat aidlc/active-space 2>/dev/null || echo default); i=$(cat aidlc/spaces/$s/intents/active-intent); ' +
      'echo "$i"; r=aidlc/spaces/$s/intents/$i; cat $r/aidlc-state.md; ls -R $r | grep -v audit | head -50',
    // The Linux new chat at the open gate.
    `git show --stat HEAD; R=${r}; cat "$R/aidlc-state.md"`,
    `R=${r}; cat $R/aidlc-state.md; ls -R $R | grep -v audit | head -50`,
    `cat "$(cat aidlc/spaces/default/intents/active-intent)" 2>/dev/null; cat ${r}/aidlc-state.md`,
    // The record folder alone, held in a variable or named beside one.
    `R=aidlc; cat "$R/${r.slice("aidlc/".length)}/aidlc-state.md"`,
    `R="$(pwd)/aidlc"; cat "$R/${r.slice("aidlc/".length)}/aidlc-state.md"`,
    `ls aidlc; R=${r}; cat $R/aidlc-state.md`,
  ];
}

// Where a command whose writes cannot be seen runs today: the plan question
// open, the person editing or handing back the plan files, a plan changed after
// approval under strict, the open gate (with and without a current step), and a
// chat that has not joined the work.
const READ_STATES = ["S3", "S6", "S6b", "S8", "S11a", "S11b", "S11c", "S12"];

describe("a read through a variable while the plan waits", () => {
  for (const id of READ_STATES) {
    test(`${id}: the read runs in every harness shape`, async () => {
      const state = build(id);
      const refused: string[] = [];
      for (const shape of SHAPES) {
        shape.install(state.proj);
        for (const command of reads(state)) {
          const verdict = await shape.call(state.proj, state.session, { tool: "Bash", command });
          if (verdict.code !== 0) refused.push(`[${shape.name}] ${command} -> ${verdict.said}`);
        }
      }
      expect(refused).toEqual([]);
    });
  }

  test("S3: AI-DLC's own command named through a variable or a substitution still waits", async () => {
    const state = build("S3");
    const engine = [
      "T=.claude/tools/aidlc.ts; bun $T engine orchestrate report --stage code-generation --result approved",
      "x=$(echo bun); $x .claude/tools/aidlc-orchestrate.ts report --stage code-generation --result approved",
      'A=aidlc; "$A" engine orchestrate report --stage code-generation --result approved',
      `"\${cmd:-aidlc}" jump execute --target requirements-analysis --direction backward`,
      'A=aidlc; eval "$A engine orchestrate report --stage code-generation --result approved"',
      'A=aidlc; echo "$A engine orchestrate report --stage code-generation --result approved" | sh',
      'echo "$(aidlc engine orchestrate report --stage code-generation --result approved)"',
      // The launcher by a Windows path, unquoted: the POSIX reading drops its backslashes.
      "C:\\Users\\me\\.aidlc\\bin\\aidlc.cmd jump execute --target requirements-analysis --direction backward $t",
    ];
    const admitted: string[] = [];
    for (const shape of SHAPES) {
      shape.install(state.proj);
      for (const command of engine) {
        const spelled = respell(command, shape.dir);
        const verdict = await shape.call(state.proj, state.session, { tool: "Bash", command: spelled });
        if (verdict.code !== 2) admitted.push(`[${shape.name}] ${spelled}`);
      }
    }
    expect(admitted).toEqual([]);
  });

  // A program run from a variable is judged as AI-DLC's command when the line
  // names aidlc, as before this change; a read that way waits.
  test("S3: a read whose program is itself a variable still waits", async () => {
    const state = build("S3");
    const verdict = await SHAPES[0].call(state.proj, state.session, { tool: "Bash", command: `c=cat; $c ${record(state)}/aidlc-state.md` });
    expect(verdict.code).toBe(2);
  });

  test("S1: before the plan is asked, a read through a variable waits with every command whose writes cannot be seen", async () => {
    const state = build("S1");
    const claude = SHAPES[0];
    const verdict = await claude.call(state.proj, state.session, { tool: "Bash", command: `R=${record(state)}; cat $R/aidlc-state.md` });
    expect(verdict.code).toBe(2);
    const plain = await claude.call(state.proj, state.session, { tool: "Bash", command: `cat ${record(state)}/aidlc-state.md` });
    expect(plain.code, plain.said).toBe(0);
  });
});
