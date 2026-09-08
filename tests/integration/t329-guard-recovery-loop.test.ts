// covers: directive:guard-recovery, function:consumeSharedDirectiveAsk,
// function:guardRecoveryFeedbackStatus, function:currentGuardRecoveryAskMarker,
// function:isRequestChangesChoice, function:recordGuardRefusal
//
// A GUARD-RECOVERY ASK IS A HUMAN WAIT, AND THE HUMAN'S SELECTION SURVIVES.
//
// The scenario is the one a spike measured on the earlier branch: per-Unit
// Construction routes functional-design for a Unit whose design artifacts exist
// but whose summary was never confirmed. `next` refuses at routing time and emits
// a guard-recovery ask. The human picks the action-only remedy ("ask what should
// change and end the turn"), the conductor asks and ends the turn.
//
// On that branch the Stop hook then re-probed, found the same ask, blocked with
// "render the ask", and the conductor's obedient `next` rewrote the marker and
// discarded the selection: the byte-identical question was asked again on every
// cycle until the no-progress cap released the turn. Here the Stop hook releases
// on the ask, and a repeated `next` for the same state returns the same ask
// without touching the marker, so the consumed selection is still there when the
// human's feedback arrives and the Request Changes report binds to it.

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { hookChildEnv } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupTestProject,
  resetAidlcEnv,
  seededRecordDir,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

resetAidlcEnv();

const BUN = process.execPath;
const SESSION = "01995000-0995-7000-8000-000000000329";
const UNIT = "saved-search";
const projects: string[] = [];
afterAll(() => {
  for (const project of projects) cleanupTestProject(project);
});

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
  continueWith: (token: string) => Run;
  probeNext: () => Run;
  report: (args: string[]) => Run;
  stopHook: (entries: TranscriptEntry[], stopHookActive: boolean) => Run;
  humanPick: (question: string, label: string) => Run;
  humanPrompt: (text: string) => Run;
}

const RUNNER_GUARD_SKIPS = [
  "AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD",
  "AIDLC_SKIP_HUMAN_PRESENCE_GUARD",
] as const;

function project(): Project {
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
  writeFileSync(statePath, state, "utf-8");
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
  const markerPath = join(record, ".aidlc-active-directive.json");
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
    continueWith: (token) =>
      spawn([BUN, tool("orchestrate"), "continue", token, "--project-dir", dir], env, dir),
    probeNext: () => {
      let run = spawn([BUN, tool("orchestrate"), "next", "--project-dir", dir], probeEnv, dir);
      let d = directive(run);
      while (d.kind === "load-steering") {
        run = spawn(
          [BUN, tool("orchestrate"), "continue", d.continue_token as string, "--project-dir", dir],
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
    humanPick: (question, label) =>
      spawn(
        [BUN, hook("record-human-turn")],
        env,
        dir,
        JSON.stringify({
          hook_event_name: "PostToolUse",
          session_id: SESSION,
          tool_name: "AskUserQuestion",
          tool_input: { questions: [{ question, options: [{ label }] }] },
          tool_response: {
            questions: [{ question, options: [{ label }] }],
            answers: { [question]: label },
          },
        }),
      ),
    humanPrompt: (text) =>
      spawn(
        [BUN, hook("record-human-turn")],
        env,
        dir,
        JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: SESSION,
          prompt: text,
        }),
      ),
  };
}

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
      run = p.continueWith(d.continue_token as string);
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
    expect(marker?.remedies).toEqual(
      remedies.map(({ op, action }) => ({ op, action })),
    );

    // The observer sees the same ask and publishes nothing.
    const before = readFileSync(p.markerPath, "utf-8");
    const probed = directive(p.probeNext());
    expect(probed.kind).toBe("ask");
    expect(probed.ask_type).toBe("guard-recovery");
    expect(readFileSync(p.markerPath, "utf-8")).toBe(before);
  }, 180000);

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
    const label = actionOnly?.action as string;

    // The human picks through the same-turn question widget; the conductor asks
    // "What should change?" and ends the turn.
    expect(p.humanPick(question, label).code).toBe(0);
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
    expect(prematureDirective.kind).toBe("error");
    expect(String(prematureDirective.message)).toContain("not revision feedback");

    // The human answers; the marker binds the feedback text.
    const feedback = "Split the save-search workflow into two steps";
    expect(p.humanPrompt(feedback).code).toBe(0);
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
  }, 240000);

  test("a Request Changes choice cannot stand in for a separate nonblank rejection reason", () => {
    const p = project();
    const entries: TranscriptEntry[] = [transcript.human("Continue the AIDLC workflow")];
    const ask = routeToAsk(p, entries);
    const requestChanges = (ask.remedies as Array<Record<string, unknown>>).find(
      (remedy) => remedy.op === "request-changes",
    );
    expect(requestChanges).toBeDefined();
    expect(
      p.humanPick(ask.question as string, requestChanges?.action as string).code,
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
    expect(rejection.kind).toBe("error");
    expect(String(rejection.message)).toContain("guard-recovery choice is not revision feedback");
    expect(String(rejection.message)).toContain("What should change?");
    expect(String(rejection.message)).toContain("separate response");
    expect(readFileSync(statePath, "utf-8")).toBe(stateBeforeReport);
  }, 240000);

  test("a tolerant Request Changes selection binds later exact feedback", () => {
    const p = project();
    const entries: TranscriptEntry[] = [transcript.human("Continue the AIDLC workflow")];
    const ask = routeToAsk(p, entries);
    expect(
      (ask.remedies as Array<Record<string, unknown>>).some(
        (remedy) => remedy.op === "request-changes",
      ),
    ).toBe(true);

    expect(p.humanPick(ask.question as string, "B.  Request   Changes").code).toBe(0);
    expect(p.marker()?.guard_recovery_response).toMatchObject({
      status: "awaiting-feedback",
      selected_op: "request-changes",
    });
    const feedback = "Keep saved searches private until their owner shares them";
    expect(p.humanPrompt(feedback).code).toBe(0);
    const accepted = rejectedReport(p, "Request Changes", feedback);
    expect(accepted.code, accepted.stderr).toBe(0);
    const state = readFileSync(join(seededRecordDir(p.dir), "aidlc-state.md"), "utf-8");
    expect(state).toMatch(/^- \[R\] functional-design/m);
  }, 240000);

  test("a different recovery choice cannot authorize a later rejection", () => {
    const p = project();
    const entries: TranscriptEntry[] = [transcript.human("Continue the AIDLC workflow")];
    const ask = routeToAsk(p, entries);
    const reconfirm = (ask.remedies as Array<Record<string, unknown>>).find(
      (remedy) => remedy.op === "reconfirm-summary",
    );
    expect(reconfirm).toBeDefined();
    expect(p.humanPick(ask.question as string, reconfirm?.action as string).code).toBe(0);
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
    expect(refusal.kind).toBe("error");
    expect(String(refusal.message)).toContain(
      "recovery-question choice was not Request Changes",
    );
    expect(String(refusal.message)).toContain(reconfirm?.action as string);
    const state = readFileSync(join(seededRecordDir(p.dir), "aidlc-state.md"), "utf-8");
    expect(state).toBe(stateBeforeRefusal);
    expect(state).toMatch(/^- \[-\] functional-design/m);
    expect(state).not.toMatch(/^- \[R\] functional-design/m);
  }, 240000);

  test("a legacy consumed selection without its selected remedy cannot authorize rejection", () => {
    const p = project();
    const entries: TranscriptEntry[] = [transcript.human("Continue the AIDLC workflow")];
    const ask = routeToAsk(p, entries);
    const requestChanges = (ask.remedies as Array<Record<string, unknown>>).find(
      (remedy) => remedy.op === "request-changes",
    );
    expect(requestChanges).toBeDefined();
    expect(p.humanPick(ask.question as string, requestChanges?.action as string).code).toBe(0);
    const feedback = "Separate query validation from persistence";
    expect(p.humanPrompt(feedback).code).toBe(0);

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
    expect(refusal.kind).toBe("error");
    expect(String(refusal.message)).toContain(
      "recovery-question choice was not Request Changes",
    );
    const state = readFileSync(join(seededRecordDir(p.dir), "aidlc-state.md"), "utf-8");
    expect(state).toBe(stateBeforeRefusal);
    expect(state).toMatch(/^- \[-\] functional-design/m);
    expect(state).not.toMatch(/^- \[R\] functional-design/m);
  }, 240000);

  test("the recorded selection is the human's words, whitespace-normalized", () => {
    const p = project();
    const entries: TranscriptEntry[] = [transcript.human("Continue the AIDLC workflow")];
    const ask = routeToAsk(p, entries);
    const question = ask.question as string;
    const label = (ask.remedies as Array<Record<string, unknown>>)[0].action as string;
    expect(p.humanPick(question, `  ${label.replace(/ /g, "  ")}  `).code).toBe(0);
    const marker = p.marker();
    const expected = createHash("sha256")
      .update(label.replace(/\s+/g, " ").trim(), "utf-8")
      .digest("hex");
    expect(marker?.guard_recovery_response).toEqual({
      status: "awaiting-feedback",
      selection_sha256: expected,
      selected_op: (ask.remedies as Array<Record<string, unknown>>)[0].op,
    });
  }, 180000);
});
