// covers: directive:guard-recovery, function:consumeSharedDirectiveAsk,
// function:guardRecoveryFeedbackStatus, function:currentGuardRecoveryAskMarker,
// function:recordGuardRefusal, function:recordGuardRecoveryChoice,
// subcommand:aidlc-orchestrate:next, subcommand:aidlc-log:answer
//
// A GUARD-RECOVERY ASK IS A HUMAN WAIT, AND THE HUMAN'S SELECTION SURVIVES.
//
// The scenario: per-Unit Construction routes functional-design for a Unit whose
// design artifacts exist but whose summary was never confirmed. `next` refuses
// at routing time and emits a guard-recovery ask. The human picks the
// action-only remedy ("ask what should change and end the turn"), the
// conductor asks and ends the turn.
//
// The failure this pins: the Stop hook re-probed, found the same ask, blocked
// with "render the ask", and the conductor's obedient `next` rewrote the
// marker and discarded the selection: the byte-identical question was asked
// again on every cycle until the no-progress cap released the turn. Here the
// Stop hook releases on the ask, and a repeated `next` for the same state
// returns the same ask without touching the marker, so the consumed selection
// is still there when the human's feedback arrives and the Request Changes
// report binds to it.
//
// A request typed at the open question keeps the person's pick too. The person
// typed `/aidlc <their pick>`, and the agent handed their words to `next`, as
// the skill's loop does with an `/aidlc` line. `next` read them as words over
// work in progress and named the routing question, never the recovery
// question; asking it replaced the recovery question, which then came back
// with their reply gone. Here `next` names the recovery question's own
// commands, the agent's record of the pick lands, and the pick is carried out,
// under every Guard Policy; once a pick's own step has asked its question
// (Confirm the summary again shows the summary), words are not read as a
// recovery pick.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { setDefaultTimeout, afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { hookChildEnv, setGuardPolicyLine } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupTestProject,
  resetAidlcEnv,
  seededRecordDir,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

resetAidlcEnv();

const BUN = process.execPath;
const SESSION = "01995000-0995-7000-8000-000000000329";
const UNIT = "saved-search";
const projects: string[] = [];
// Retiring every staged project shares the fixture cleanup backstop.
afterAll(() => {
  for (const project of projects) {
    cleanupTestProject(project);
  }
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

type Run = { code: number | null; stdout: string; stderr: string };

function spawn(
  argv: string[],
  env: Record<string, string | undefined>,
  cwd: string,
  stdin?: string,
): Run {
  const result = Bun.spawnSync(argv, {
    cwd,
    env,
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function directive(run: Run): Record<string, unknown> {
  const line = run.stdout.trim().split("\n").at(-1) ?? "";
  return JSON.parse(line) as Record<string, unknown>;
}

function rejectedReport(p: Project, userInput: string, feedback: string): Run {
  return p.report([
    "--stage",
    "functional-design",
    "--result",
    "rejected",
    "--user-input",
    userInput,
    "--reason",
    feedback,
  ]);
}

// The Claude transcript shape the Stop hook reads to decide whether the ending
// turn was conversational. Every cycle carries an engine call, so the
// conversational carve-out never releases the stop; only the ask wait may.
type TranscriptEntry = Record<string, unknown>;
const transcript = {
  human: (text: string): TranscriptEntry => ({
    type: "user",
    message: { role: "user", content: text },
  }),
  bash: (command: string): TranscriptEntry => ({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", name: "Bash", input: { command } }],
    },
  }),
  toolResult: (text: string): TranscriptEntry => ({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", content: text }] },
  }),
  askTool: (question: string, labels: string[]): TranscriptEntry => ({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          name: "AskUserQuestion",
          input: { questions: [{ question, options: labels.map((label) => ({ label })) }] },
        },
      ],
    },
  }),
  text: (text: string): TranscriptEntry => ({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  }),
};

interface Project {
  dir: string;
  env: Record<string, string>;
  markerPath: string;
  marker: () => Record<string, unknown> | null;
  next: () => Run;
  // `next` with the person's words, as the skill hands them on.
  nextWith: (args: string[]) => Run;
  continueWith: (token: string) => Run;
  probeNext: () => Run;
  report: (args: string[]) => Run;
  stopHook: (entries: TranscriptEntry[], stopHookActive: boolean) => Run;
  // A pick in the question box; `labels` are the options it showed (only the picked one by default).
  humanPick: (question: string, label: string, labels?: string[]) => Run;
  humanPrompt: (text: string) => Run;
  // The agent's record of the remedy it read from the person's reply.
  record: (details: string) => Run;
  log: (args: string[]) => Run;
}

const RUNNER_GUARD_SKIPS = [
  "AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD",
  "AIDLC_SKIP_HUMAN_PRESENCE_GUARD",
] as const;

function project(policy?: "off" | "relaxed" | "strict"): Project {
  const dir: string = setupIntegrationProject({
    withState: "state-brownfield-feature.md",
    withInceptionArtifacts: true,
  });
  projects.push(dir);
  const record = seededRecordDir(dir);
  const statePath = join(record, "aidlc-state.md");
  const state = readFileSync(statePath, "utf-8")
    .replace(/^- \*\*In Progress\*\*:.*$/m, "- **In Progress**: functional-design")
    .replace(/^- \*\*Inception\*\*:.*$/m, "- **Inception**: Verified")
    .replace(/^- \*\*Construction\*\*:.*$/m, "- **Construction**: Active")
    .replace(/^- \*\*Lifecycle Phase\*\*:.*$/m, "- **Lifecycle Phase**: CONSTRUCTION")
    .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: functional-design")
    .replace(/^- \*\*Next Stage\*\*:.*$/m, "- **Next Stage**: nfr-requirements")
    .replace(
      /^- \[-\] requirements-analysis(\s+\S\s+)EXECUTE$/m,
      "- [x] requirements-analysis$1EXECUTE",
    )
    .replace(
      /^- \[ \] (user-stories|refined-mockups|domain-design|units-generation|contract-design|delivery-planning)(\s+\S\s+)EXECUTE$/gm,
      "- [x] $1$2EXECUTE",
    )
    .replace(
      /^- \[ \] functional-design(\s+\S\s+)EXECUTE$/m,
      "- [-] functional-design$1EXECUTE",
    );
  // The Guard Policy as the person sets it, when a case names one.
  writeFileSync(statePath, policy ? setGuardPolicyLine(state, `${policy} (set by you)`) : state, "utf-8");
  // One Unit, every produced functional-design artifact present, and NO summary
  // confirmation: the routing-time refusal this scenario is about.
  const unitsDir = join(record, "inception", "units-generation");
  mkdirSync(unitsDir, { recursive: true });
  writeFileSync(
    join(unitsDir, "unit-of-work-dependency.md"),
    `# Unit Dependencies\n\n\`\`\`yaml\nunits:\n  - name: ${UNIT}\n    depends_on: []\n\`\`\`\n`,
  );
  const designDir = join(record, "construction", UNIT, "functional-design");
  mkdirSync(designDir, { recursive: true });
  writeFileSync(join(designDir, "entities.md"), "# Entities\n\n```yaml\nentities: []\n```\n");
  writeFileSync(join(designDir, "rules.md"), "# Rules\n\n```yaml\nrules: []\n```\n");
  writeFileSync(
    join(designDir, "functional-spec.md"),
    "# Functional Spec\n\n## Workflows\n\n- save search\n",
  );
  writeFileSync(join(designDir, "traceability.json"), '{"links":[]}\n');
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "base.ts"), "export const base = 1;\n");
  // The suite runner disables the summary-confirmation and human-presence
  // guards for every test; this scenario is those guards' routing-time refusal
  // and recovery, so every child here runs with the production guards on.
  const env = { ...process.env, CLAUDE_PROJECT_DIR: dir } as Record<string, string>;
  for (const key of RUNNER_GUARD_SKIPS) delete env[key];
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "tests@example.com"],
    ["config", "user.name", "AI-DLC Tests"],
    ["add", "-A"],
    ["commit", "-qm", "baseline"],
  ]) {
    const run = spawn(["git", ...args], env, dir);
    if (run.code !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  }
  appendAuditEntry("SESSION_STARTED", { Source: "startup", Session: SESSION }, dir);
  const tool = (name: string) => join(dir, ".claude", "tools", `aidlc-${name}.ts`);
  const hook = (name: string) => join(dir, ".claude", "hooks", `aidlc-${name}.ts`);
  const markerPath = join(record, ".aidlc-engine/active-directive.json");
  const transcriptPath = join(dir, "..", `${dir.split("/").at(-1)}.transcript.jsonl`);
  const probeEnv: Record<string, string> = {
    ...(hookChildEnv(dir, SESSION, { AIDLC_STOP_HOOK_PROBE: "1" }) as Record<string, string>),
    CLAUDE_PROJECT_DIR: dir,
  };
  for (const key of RUNNER_GUARD_SKIPS) delete probeEnv[key];
  return {
    dir,
    env,
    markerPath,
    marker: () =>
      existsSync(markerPath)
        ? (JSON.parse(readFileSync(markerPath, "utf-8")) as Record<string, unknown>)
        : null,
    next: () => spawn([BUN, tool("orchestrate"), "next", "--project-dir", dir], env, dir),
    nextWith: (args) => spawn([BUN, tool("orchestrate"), "next", ...args], env, dir),
    continueWith: (token) =>
      spawn([BUN, tool("orchestrate"), "continue", token, "--project-dir", dir], env, dir),
    probeNext: () => {
      let run = spawn([BUN, tool("orchestrate"), "next", "--project-dir", dir], probeEnv, dir);
      let d = directive(run);
      while (d.kind === "load-steering") {
        run = spawn(
          [BUN, tool("orchestrate"), "continue", d.receipt as string, "--project-dir", dir],
          probeEnv,
          dir,
        );
        d = directive(run);
      }
      return run;
    },
    report: (args) =>
      spawn([BUN, tool("orchestrate"), "report", ...args, "--project-dir", dir], env, dir),
    stopHook: (entries, stopHookActive) => {
      writeFileSync(
        transcriptPath,
        `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      );
      return spawn(
        [BUN, hook("continue-workflow")],
        env,
        dir,
        JSON.stringify({
          hook_event_name: "Stop",
          session_id: SESSION,
          stop_hook_active: stopHookActive,
          transcript_path: transcriptPath,
        }),
      );
    },
    humanPick: (question, label, labels = [label]) =>
      spawn(
        [BUN, join(dir, ".claude", "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"],
        env,
        dir,
        JSON.stringify({
          hook_event_name: "PostToolUse",
          session_id: SESSION,
          tool_name: "AskUserQuestion",
          tool_input: { questions: [{ question, options: labels.map((option) => ({ label: option })) }] },
          tool_response: {
            questions: [{ question, options: labels.map((option) => ({ label: option })) }],
            answers: { [question]: label },
          },
        }),
      ),
    humanPrompt: (text) =>
      spawn(
        [BUN, join(dir, ".claude", "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"],
        env,
        dir,
        JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: SESSION,
          prompt: text,
        }),
      ),
    record: (details) =>
      spawn(
        [BUN, join(dir, ".claude", "tools", "aidlc-log.ts"), "answer", "--stage", "functional-design",
          "--checkpoint", "guard-recovery", "--details", details, "--project-dir", dir],
        env,
        dir,
      ),
    log: (args) => spawn([BUN, tool("log"), ...args, "--project-dir", dir], env, dir),
  };
}

// A remedy as the recovery question shows it.
const shown = (remedy: Record<string, unknown> | undefined): string => (remedy?.label ?? remedy?.action) as string;
const shownAll = (ask: Record<string, unknown>): string[] => (ask.remedies as Array<Record<string, unknown>>).map(shown);

// Route the way a conductor does, following rule delivery to its run-stage or
// ask, until the guard-recovery ask appears: the first `next` may present the
// walking-skeleton classification round-trip first.
function routeToAsk(p: Project, entries: TranscriptEntry[]): Record<string, unknown> {
  const drive = (): Record<string, unknown> => {
    let run = p.next();
    let d = directive(run);
    entries.push(
      transcript.bash("bun .claude/tools/aidlc-orchestrate.ts next"),
      transcript.toolResult(run.stdout.trim()),
    );
    for (let i = 0; i < 30 && d.kind === "load-steering"; i++) {
      run = p.continueWith(d.receipt as string);
      d = directive(run);
      entries.push(
        transcript.bash("bun .claude/tools/aidlc-orchestrate.ts continue <token>"),
        transcript.toolResult(run.stdout.trim()),
      );
    }
    return d;
  };
  let d = drive();
  if (d.kind === "run-stage" && d.gate === "unresolved") {
    const stance = p.report(["--skeleton-stance", "off"]);
    expect(stance.code, stance.stderr).toBe(0);
    entries.push(
      transcript.bash("bun .claude/tools/aidlc-orchestrate.ts report --skeleton-stance off"),
      transcript.toolResult(stance.stdout.trim()),
    );
    d = drive();
  }
  return d;
}

describe("t329 a guard-recovery ask holds the turn and keeps the human's selection", () => {
  test("the routing-time refusal is a typed ask with op-bearing remedies and a published marker", () => {
    const p = project();
    const entries: TranscriptEntry[] = [transcript.human("Continue the AIDLC workflow")];
    const ask = routeToAsk(p, entries);
    expect(ask.kind).toBe("ask");
    expect(ask.ask_type).toBe("guard-recovery");
    expect(ask.stage).toBe("functional-design");
    expect(ask.unit).toBe(UNIT);
    expect(ask.reason_codes).toEqual(["SUMMARY_QUESTIONS_MISSING"]);
    const remedies = ask.remedies as Array<Record<string, unknown>>;
    expect(remedies.length).toBeGreaterThan(0);
    for (const remedy of remedies) {
      expect(typeof remedy.op).toBe("string");
      expect(remedy.executableNow).toBe(true);
      expect(remedy.interaction).toBe("human-input");
    }
    expect(remedies.some((remedy) => remedy.op === "reconfirm-summary")).toBe(true);
    expect(remedies.some((remedy) => remedy.op === "request-changes")).toBe(true);

    const marker = p.marker();
    expect(marker?.kind).toBe("ask");
    expect(marker?.ask_type).toBe("guard-recovery");
    expect(marker?.stage).toBe("functional-design");
    expect(marker?.unit).toBe(UNIT);
    expect(marker?.delivery).toBe("issued");
    expect(marker?.guard_recovery_response).toBeUndefined();
    // The marker keeps the name the person was shown, so typing it picks it.
    expect(marker?.remedies).toEqual(
      remedies.map(({ op, label, action }) => ({ op, label, action, interaction: "human-input" })),
    );
    expect(remedies.map((remedy) => remedy.label)).toEqual(["Confirm the summary again", "Request Changes"]);

    // The observer sees the same ask and publishes nothing.
    const before = readFileSync(p.markerPath, "utf-8");
    const probed = directive(p.probeNext());
    expect(probed.kind).toBe("ask");
    expect(probed.ask_type).toBe("guard-recovery");
    expect(readFileSync(p.markerPath, "utf-8")).toBe(before);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("after the human picks the action-only remedy the Stop hook releases and a repeated next keeps the selection", () => {
    const p = project();
    const entries: TranscriptEntry[] = [transcript.human("Continue the AIDLC workflow")];
    const ask = routeToAsk(p, entries);
    expect(ask.ask_type).toBe("guard-recovery");
    const remedies = ask.remedies as Array<Record<string, unknown>>;
    const actionOnly = remedies.find(
      (remedy) => remedy.op === "request-changes" && remedy.command === undefined,
    );
    expect(actionOnly).toBeDefined();
    const question = ask.question as string;
    const label = shown(actionOnly);

    // The human picks through the same-turn question widget; the conductor asks
    // "What should change?" and ends the turn.
    expect(p.humanPick(question, label, shownAll(ask)).code).toBe(0);
    entries.push(
      transcript.askTool(question, remedies.map((remedy) => remedy.action as string)),
      transcript.toolResult(JSON.stringify({ answers: { [question]: label } })),
      transcript.text("What should change?"),
    );
    const consumed = p.marker();
    expect(consumed?.delivery).toBe("consumed");
    expect(consumed?.guard_recovery_response).toMatchObject({
      status: "awaiting-feedback",
      selected_op: "request-changes",
    });
    const revisionAfterPick = consumed?.revision;
    const markerRemediesAfterPick = consumed?.remedies;

    // The Stop hook lets the turn end: the engine is waiting on the human.
    for (const stopHookActive of [false, true]) {
      const stopped = p.stopHook(entries, stopHookActive);
      expect(stopped.code).toBe(0);
      expect(stopped.stdout.trim()).toBe("");
    }

    // A real `next` for the unchanged state answers with the same ask and does
    // not rewrite the marker, so the selection is still recorded.
    const again = directive(p.next());
    expect(again.kind).toBe("ask");
    expect(again.ask_type).toBe("guard-recovery");
    expect(again.reason_codes).toEqual(ask.reason_codes);
    // Same ask by identity: the exact ordered op/action offer is unchanged.
    // Incidental human-presence state must not rewrite visible offer text.
    expect(again.state_signature).toBe(ask.state_signature);
    expect(
      (again.remedies as Array<Record<string, unknown>>).map(({ op, action }) => ({
        op,
        action,
      })),
    ).toEqual(remedies.map(({ op, action }) => ({ op, action })));
    const afterNext = p.marker();
    expect(afterNext?.delivery).toBe("consumed");
    expect(afterNext?.guard_recovery_response).toMatchObject({
      status: "awaiting-feedback",
      selected_op: "request-changes",
    });
    expect(afterNext?.revision).toBe(revisionAfterPick);
    expect(afterNext?.remedies).toEqual(markerRemediesAfterPick);

    // Before the human's feedback exists, the conductor cannot submit Request
    // Changes on their behalf: the pick is a choice, not revision feedback.
    const premature = rejectedReport(
      p,
      "Request Changes",
      "anything the conductor made up",
    );
    const prematureDirective = directive(premature);
    expect(prematureDirective.kind, JSON.stringify(prematureDirective)).toBe("print");
    expect(String(prematureDirective.message)).toContain("is not on the recovery record yet");

    // The human answers; the conductor records what they said should change,
    // and the marker binds the feedback text.
    const feedback = "Split the save-search workflow into two steps";
    expect(p.humanPrompt(feedback).code).toBe(0);
    const withWords = p.record(`Request Changes: ${feedback}`);
    expect(withWords.code, withWords.stdout + withWords.stderr).toBe(0);
    expect(p.marker()?.guard_recovery_response).toMatchObject({
      status: "ready",
      selected_op: "request-changes",
    });

    // A paraphrase is refused; the human's own words, re-wrapped and with the
    // label typed casually, are accepted and open the revision.
    const paraphrased = rejectedReport(
      p,
      "Request Changes",
      "Please split the save-search flow in two",
    );
    expect(String(directive(paraphrased).message)).toContain("does not exactly match");
    const accepted = rejectedReport(
      p,
      "request changes.",
      "Split the\n  save-search workflow   into two steps",
    );
    expect(accepted.code, accepted.stderr).toBe(0);
    const state = readFileSync(join(seededRecordDir(p.dir), "aidlc-state.md"), "utf-8");
    expect(state).toMatch(/^- \[R\] functional-design/m);
    const stateAfterReject = p.stopHook(entries, false);
    expect(stateAfterReject.stdout.trim()).toBe("");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("a Request Changes choice cannot stand in for a separate nonblank rejection reason", () => {
    const p = project();
    const entries: TranscriptEntry[] = [transcript.human("Continue the AIDLC workflow")];
    const ask = routeToAsk(p, entries);
    const requestChanges = (ask.remedies as Array<Record<string, unknown>>).find(
      (remedy) => remedy.op === "request-changes",
    );
    expect(requestChanges).toBeDefined();
    expect(
      p.humanPick(ask.question as string, shown(requestChanges), shownAll(ask)).code,
    ).toBe(0);

    const statePath = join(seededRecordDir(p.dir), "aidlc-state.md");
    const stateBeforeReport = readFileSync(statePath, "utf-8");
    const rejected = p.report([
      "--stage",
      "functional-design",
      "--result",
      "rejected",
      "--user-input",
      "Request Changes",
    ]);
    const rejection = directive(rejected);
    expect(rejection.kind, JSON.stringify(rejection)).toBe("print");
    expect(String(rejection.message)).toContain("is not on the recovery record yet");
    expect(String(rejection.message)).toContain("What should change?");
    expect(readFileSync(statePath, "utf-8")).toBe(stateBeforeReport);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("a typed Request Changes the conductor recorded binds later exact feedback", () => {
    const p = project();
    const entries: TranscriptEntry[] = [transcript.human("Continue the AIDLC workflow")];
    const ask = routeToAsk(p, entries);
    expect(
      (ask.remedies as Array<Record<string, unknown>>).some(
        (remedy) => remedy.op === "request-changes",
      ),
    ).toBe(true);

    // Typed loosely, the reply picks nothing; the conductor records the remedy it read.
    expect(p.humanPrompt("B.  Request   Changes").code).toBe(0);
    expect(p.marker()?.guard_recovery_response).toMatchObject({ selected_op: null });
    expect(p.record("request-changes").code).toBe(0);
    expect(p.marker()?.guard_recovery_response).toMatchObject({
      status: "awaiting-feedback",
      selected_op: "request-changes",
    });
    const feedback = "Keep saved searches private until their owner shares them";
    expect(p.humanPrompt(feedback).code).toBe(0);
    expect(p.record(`Request Changes: ${feedback}`).code).toBe(0);
    const accepted = rejectedReport(p, "Request Changes", feedback);
    expect(accepted.code, accepted.stderr).toBe(0);
    const state = readFileSync(join(seededRecordDir(p.dir), "aidlc-state.md"), "utf-8");
    expect(state).toMatch(/^- \[R\] functional-design/m);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("a different recovery choice does not carry over to a later rejection", () => {
    const p = project();
    const entries: TranscriptEntry[] = [transcript.human("Continue the AIDLC workflow")];
    const ask = routeToAsk(p, entries);
    const reconfirm = (ask.remedies as Array<Record<string, unknown>>).find(
      (remedy) => remedy.op === "reconfirm-summary",
    );
    expect(reconfirm).toBeDefined();
    expect(p.humanPick(ask.question as string, shown(reconfirm), shownAll(ask)).code).toBe(0);
    expect(p.marker()?.guard_recovery_response).toMatchObject({
      status: "awaiting-feedback",
      selected_op: "reconfirm-summary",
    });

    const laterMessage = "The current consolidated summary is accurate";
    expect(p.humanPrompt(laterMessage).code).toBe(0);
    const stateBeforeRefusal = readFileSync(
      join(seededRecordDir(p.dir), "aidlc-state.md"),
      "utf-8",
    );
    const refused = rejectedReport(p, "Request Changes", laterMessage);
    expect(refused.code, refused.stderr).toBe(0);
    const refusal = directive(refused);
    expect(refusal.kind, JSON.stringify(refusal)).toBe("print");
    // Their later message is a new reply: the conductor records what it read
    // from it before a rejection stands on it.
    expect(String(refusal.message)).toContain(
      "no recovery choice is recorded on the person's latest reply yet",
    );
    // The state tool's refusal reaches the agent as plain text, never its JSON.
    expect(String(refusal.message)).toContain("--checkpoint guard-recovery");
    const state = readFileSync(join(seededRecordDir(p.dir), "aidlc-state.md"), "utf-8");
    expect(state).toBe(stateBeforeRefusal);
    expect(state).toMatch(/^- \[-\] functional-design/m);
    expect(state).not.toMatch(/^- \[R\] functional-design/m);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("a legacy consumed selection without its selected remedy cannot authorize rejection", () => {
    const p = project();
    const entries: TranscriptEntry[] = [transcript.human("Continue the AIDLC workflow")];
    const ask = routeToAsk(p, entries);
    const requestChanges = (ask.remedies as Array<Record<string, unknown>>).find(
      (remedy) => remedy.op === "request-changes",
    );
    expect(requestChanges).toBeDefined();
    expect(p.humanPick(ask.question as string, shown(requestChanges), shownAll(ask)).code).toBe(0);
    const feedback = "Separate query validation from persistence";
    expect(p.humanPrompt(feedback).code).toBe(0);
    expect(p.record(`Request Changes: ${feedback}`).code).toBe(0);

    const legacyMarker = p.marker();
    const legacyResponse = {
      ...(legacyMarker?.guard_recovery_response as Record<string, unknown>),
    };
    delete legacyResponse.selected_op;
    writeFileSync(
      p.markerPath,
      `${JSON.stringify({
        ...legacyMarker,
        guard_recovery_response: legacyResponse,
      })}\n`,
      "utf-8",
    );

    const stateBeforeRefusal = readFileSync(
      join(seededRecordDir(p.dir), "aidlc-state.md"),
      "utf-8",
    );
    const refused = rejectedReport(p, "Request Changes", feedback);
    expect(refused.code, refused.stderr).toBe(0);
    const refusal = directive(refused);
    expect(refusal.kind, JSON.stringify(refusal)).toBe("print");
    expect(String(refusal.message)).toContain(
      "no recovery choice is recorded on the person's latest reply yet",
    );
    const state = readFileSync(join(seededRecordDir(p.dir), "aidlc-state.md"), "utf-8");
    expect(state).toBe(stateBeforeRefusal);
    expect(state).toMatch(/^- \[-\] functional-design/m);
    expect(state).not.toMatch(/^- \[R\] functional-design/m);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("the recorded selection is the human's words, whitespace-normalized", () => {
    const p = project();
    const entries: TranscriptEntry[] = [transcript.human("Continue the AIDLC workflow")];
    const ask = routeToAsk(p, entries);
    const question = ask.question as string;
    const label = shown((ask.remedies as Array<Record<string, unknown>>)[0]);
    expect(p.humanPick(question, `  ${label.replace(/ /g, "  ")}  `, shownAll(ask)).code).toBe(0);
    const marker = p.marker();
    const expected = createHash("sha256")
      .update(label.replace(/\s+/g, " ").trim(), "utf-8")
      .digest("hex");
    // A pick in the question box that offered the remedies is recorded where it lands.
    expect(marker?.guard_recovery_response).toEqual({
      status: "awaiting-feedback",
      selection_sha256: expected,
      selected_op: (ask.remedies as Array<Record<string, unknown>>)[0].op,
      picked_by: "person",
    });
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});

// What `next` hands the agent for words typed at the recovery question: a
// print naming each of its choices' own commands and, unless the person has
// said the words are part of this work, the route for other work, with none of
// the person's words in it.
function expectRecoveryReading(run: Run, words?: string, otherWork = true): void {
  const reading = directive(run);
  expect(reading.kind, JSON.stringify(reading)).toBe("print");
  const message = String(reading.message);
  expect(message).toMatch(/--checkpoint guard-recovery --details '?reconfirm-summary'?/);
  expect(message).toMatch(/--checkpoint guard-recovery --details '?request-changes'?/);
  if (otherWork) expect(message).toMatch(/next --request [0-9a-f]{8}/);
  expect(message).not.toContain("--result resumed");
  if (words !== undefined) expect(message).not.toContain(words);
}

const revised = (p: Project): string => readFileSync(join(seededRecordDir(p.dir), "aidlc-state.md"), "utf-8");

describe("t329 a request typed at the open recovery question keeps the person's pick", () => {
  const feedback = "keep saved searches private until their owner shares them";
  const pick = `request changes: ${feedback}`;
  for (const policy of ["off", "relaxed", "strict"] as const) {
    test(`${policy}: "/aidlc <their pick>" is read against the recovery question, and the pick is carried out`, () => {
      const p = project(policy);
      expect(routeToAsk(p, []).ask_type).toBe("guard-recovery");
      expect(p.humanPrompt(`/aidlc ${pick}`).code).toBe(0);
      expectRecoveryReading(p.nextWith(pick.split(" ")), pick);
      // The print records nothing and asks nothing: the question still holds their reply.
      expect(p.marker()?.ask_type).toBe("guard-recovery");
      const recorded = p.record(`request-changes: ${feedback}`);
      expect(recorded.code, recorded.stdout + recorded.stderr).toBe(0);
      expect(JSON.parse(recorded.stdout).recorded).toBe("request-changes");
      const accepted = rejectedReport(p, "Request Changes", pick);
      expect(accepted.code, accepted.stdout + accepted.stderr).toBe(0);
      expect(revised(p)).toMatch(/^- \[R\] functional-design/m);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

    test(`${policy}: "/aidlc 2" is read the same way, and Request Changes asks what should change`, () => {
      const p = project(policy);
      expect(routeToAsk(p, []).ask_type).toBe("guard-recovery");
      expect(p.humanPrompt("/aidlc 2").code).toBe(0);
      expectRecoveryReading(p.nextWith(["2"]));
      const recorded = p.record("request-changes");
      expect(recorded.code, recorded.stdout + recorded.stderr).toBe(0);
      expect(JSON.parse(recorded.stdout).recorded).toBe("request-changes");
      expect(JSON.parse(recorded.stdout).message).toContain("What should change?");
      expect(p.humanPrompt(feedback).code).toBe(0);
      expect(p.record(`Request Changes: ${feedback}`).code).toBe(0);
      const accepted = rejectedReport(p, "Request Changes", feedback);
      expect(accepted.code, accepted.stdout + accepted.stderr).toBe(0);
      expect(revised(p)).toMatch(/^- \[R\] functional-design/m);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

    test(`${policy}: after Request Changes waits for what should change, their "/aidlc <words>" is read the same way`, () => {
      const p = project(policy);
      expect(routeToAsk(p, []).ask_type).toBe("guard-recovery");
      expect(p.humanPrompt("2").code).toBe(0);
      expect(p.record("request-changes").code).toBe(0);
      expect(p.humanPrompt(`/aidlc ${feedback}`).code).toBe(0);
      expectRecoveryReading(p.nextWith(feedback.split(" ")), feedback);
      const recorded = p.record(`Request Changes: ${feedback}`);
      expect(recorded.code, recorded.stdout + recorded.stderr).toBe(0);
      expect(JSON.parse(recorded.stdout).recorded).toBe("request-changes");
      const accepted = rejectedReport(p, "Request Changes", feedback);
      expect(accepted.code, accepted.stdout + accepted.stderr).toBe(0);
      expect(revised(p)).toMatch(/^- \[R\] functional-design/m);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

    test(`${policy}: words sent to the routing question and answered "part of that work" are the recovery reply`, () => {
      const p = project(policy);
      expect(routeToAsk(p, []).ask_type).toBe("guard-recovery");
      expect(p.humanPrompt(`/aidlc ${pick}`).code).toBe(0);
      const reading = String(directive(p.nextWith(pick.split(" "))).message);
      const request = /next (--request [0-9a-f]{8})/.exec(reading)?.[1];
      expect(request, reading).toBeDefined();
      // The agent read their words as other work: the routing question.
      const routing = directive(p.nextWith((request as string).split(" ")));
      expect(routing.ask_type, JSON.stringify(routing)).toBe("new-work-routing");
      const part = (routing.choices as Array<{ label: string; command: string }>)
        .find((choice) => choice.label === "Part of the active work");
      expect(part, JSON.stringify(routing.choices)).toBeDefined();
      expect(p.humanPrompt("1").code).toBe(0);
      const answer = (part as { command: string }).command.replace(/^.*aidlc-orchestrate\.ts\s+next\s+/, "");
      // Their words are the answer, with the question's own commands; the
      // question is not handed out afresh.
      expectRecoveryReading(p.nextWith(answer.split(/\s+/)), pick, false);
      const recorded = p.record(`request-changes: ${feedback}`);
      expect(recorded.code, recorded.stdout + recorded.stderr).toBe(0);
      expect(JSON.parse(recorded.stdout).recorded).toBe("request-changes");
      const accepted = rejectedReport(p, "Request Changes", pick);
      expect(accepted.code, accepted.stdout + accepted.stderr).toBe(0);
      expect(revised(p)).toMatch(/^- \[R\] functional-design/m);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

    test(`${policy}: once Confirm the summary again has asked its own question, words are not read as a recovery pick`, () => {
      const p = project(policy);
      expect(routeToAsk(p, []).ask_type).toBe("guard-recovery");
      expect(p.humanPrompt("1").code).toBe(0);
      expect(p.record("reconfirm-summary").code).toBe(0);
      // The remedy's own step: the summary, shown and logged as its question.
      const questions = join(seededRecordDir(p.dir), "construction", UNIT, "functional-design",
        "functional-design-questions.md");
      writeFileSync(questions, [
        "# Functional Design Questions", "", "## Q1", "Who can see a saved search?", "", "A) Its owner",
        "B) Everyone", "X) Other (please specify)", "", "[Answer]: A", "", "## Consolidated Summary Confirmation", "",
        "A saved search is private to its owner.", "", "- Looks correct", "- Request changes", "", "[Answer]:", "",
      ].join("\n"));
      const asked = p.log(["decision", "--checkpoint", "summary-confirmation", "--stage", "functional-design",
        "--unit", UNIT, "--questions-file", questions, "--decision", "Does this all look correct?",
        "--options", "Looks correct,Request changes"]);
      expect(asked.code, asked.stdout + asked.stderr).toBe(0);
      const words = "the summary looks right to me";
      expect(p.humanPrompt(`/aidlc ${words}`).code).toBe(0);
      const reading = directive(p.nextWith(words.split(" ")));
      expect(reading.kind, JSON.stringify(reading)).toBe("print");
      expect(String(reading.message)).not.toContain("--checkpoint guard-recovery");
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }
});
