// covers: function:isReadOnlyEngineProbe, function:isStopHookProbe, function:isRouteCheckProbe, function:evaluateCodeGenerationApproval, function:recordPlanApprovalReceipt, function:beginCodeGeneration
//
// CAN A HUMAN'S PLAN APPROVAL SURVIVE ITS OWN TURN?
//
// Every scenario here is a sequence a person actually performs, driven through
// the real engine and the real hooks in a scratch project. They were all reported
// as the same experience: the human answers "Approve Plan", and the framework
// says the approval does not exist.
//
// The cause was that the approval was stored as a derived property of mutable
// bytes. It was keyed to the identity of the directive that happened to be issued
// when the question was asked, that directive was bound to a hash of the whole
// state file (cache fields included), and the store was deleted whenever a
// directive was published, refreshed, cleared, advanced, or invalidated by
// compaction. Since asking the engine "what now?" republishes, the Stop hook's own
// consultation at the end of the turn destroyed the challenge minted during it.
//
// So the sequences below assert the property rather than the mechanism: after each
// legitimate action, is the recorded decision still the recorded decision? And the
// converse, which matters just as much: when the human's answer should NOT carry
// over (the plan changed, the attempt restarted, they asked for changes), is it
// refused, and with an instruction they can act on?

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  artifactFilename,
  hookChildEnv,
  sessionsDir,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupTestProject,
  resetAidlcEnv,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

resetAidlcEnv();

const BUN = process.execPath;
const SESSION = "01995000-0995-7000-8000-000000000995";
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

// A sha256 of every file in the project, so "this invocation changed nothing" is
// an observation rather than an inference from the absence of a symptom.
function snapshot(root: string, rel = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(join(root, rel)).sort()) {
    if (rel === "" && name === ".git") continue;
    const path = rel ? `${rel}/${name}` : name;
    const stat = statSync(join(root, path), { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isDirectory()) {
      out[`${path}/`] = "<dir>";
      Object.assign(out, snapshot(root, path));
    } else if (stat.isFile()) {
      out[path] = createHash("sha256")
        .update(readFileSync(join(root, path)))
        .digest("hex");
    } else {
      out[path] = "<other>";
    }
  }
  return out;
}

// The hook's own bookkeeping (health stamps, its no-progress counter, usage
// pointers, turn-shape markers) is machine-local runtime state, not workflow
// authority, so it is excluded when asking whether project bytes moved.
const RUNTIME_NOISE =
  /\.aidlc-hooks-health|\.aidlc-stop-hook|\.aidlc-sessions\/(?:usage|current)|\.transcript$|\.aidlc-human-turn|\.aidlc-engine-touch|\.aidlc-clone-id/;

function bytesMoved(
  before: Record<string, string>,
  after: Record<string, string>,
): { created: string[]; modified: string[]; deleted: string[] } {
  const relevant = (path: string) => !RUNTIME_NOISE.test(path);
  return {
    created: Object.keys(after).filter((k) => !(k in before)).filter(relevant),
    modified: Object.keys(after)
      .filter((k) => k in before && before[k] !== after[k])
      .filter(relevant),
    deleted: Object.keys(before).filter((k) => !(k in after)).filter(relevant),
  };
}

interface Project {
  dir: string;
  lib: Record<string, (...args: never[]) => unknown>;
  posture: Record<string, (...args: never[]) => unknown>;
  env: Record<string, string>;
  probeEnv: Record<string, string>;
  statePath: string;
  markerPath: string;
  tool: (name: string) => string;
  hook: (name: string) => string;
  marker: () => Record<string, unknown> | null;
  runtimeFiles: () => string[];
  receipts: () => string[];
  next: (extra?: Record<string, string>, args?: string[]) => Run;
  continueWith: (token: string) => Run;
  stopHook: () => Run;
  humanTurn: (prompt: string) => Run;
}

async function project(
  scope: "express" | "feature",
  shape: (dir: string, statePath: string) => void = () => {},
): Promise<Project> {
  const dir: string = setupIntegrationProject({
    withState: "state-brownfield-feature.md",
  });
  projects.push(dir);
  const importFrom = (path: string) => import(pathToFileURL(path).href);
  const tool = (name: string) => join(dir, ".claude", "tools", `aidlc-${name}.ts`);
  const hook = (name: string) => join(dir, ".claude", "hooks", `aidlc-${name}.ts`);
  const lib = await importFrom(tool("lib"));
  const posture = await importFrom(tool("testing-posture"));
  const statePath = seededStateFile(dir);
  let state = readFileSync(statePath, "utf-8")
    .replace(/^- \*\*Depth\*\*:.*$/m, "- **Depth**: Minimal")
    .replace(/^- \*\*Test Strategy\*\*:.*$/m, "- **Test Strategy**: Minimal")
    .replace(/^- \*\*In Progress\*\*:.*$/m, "- **In Progress**: code-generation")
    .replace(/^- \*\*Inception\*\*:.*$/m, "- **Inception**: Verified")
    .replace(/^- \*\*Construction\*\*:.*$/m, "- **Construction**: Active")
    .replace(/^- \*\*Lifecycle Phase\*\*:.*$/m, "- **Lifecycle Phase**: CONSTRUCTION")
    .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation");
  state = state.replace(
    /^- \[[ xSR?-]\] code-generation(\s+\S\s+)EXECUTE$/m,
    "- [-] code-generation$1EXECUTE",
  );
  if (scope === "express") {
    state = state.replace(/^- \*\*Scope\*\*:.*$/m, "- **Scope**: express");
  }
  writeFileSync(statePath, state, "utf-8");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "base.ts"), "export const base = 1;\n");
  shape(dir, statePath);
  const env = { ...process.env, CLAUDE_PROJECT_DIR: dir } as Record<string, string>;
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
  appendAuditEntry(
    "SESSION_STARTED",
    { Source: "startup", Session: SESSION },
    dir,
  );
  const markerPath = join(seededRecordDir(dir), ".aidlc-active-directive.json");
  const runtimeDir = join(sessionsDir(dir), "plan-approval");
  const runtimeFiles = () =>
    existsSync(runtimeDir) ? readdirSync(runtimeDir).sort() : [];
  return {
    dir,
    lib,
    posture,
    env,
    // Exactly the environment the Stop hook gives its own consultation.
    probeEnv: {
      ...(hookChildEnv(dir, SESSION, { AIDLC_STOP_HOOK_PROBE: "1" }) as Record<
        string,
        string
      >),
      CLAUDE_PROJECT_DIR: dir,
    },
    statePath,
    markerPath,
    tool,
    hook,
    marker: () =>
      existsSync(markerPath)
        ? (JSON.parse(readFileSync(markerPath, "utf-8")) as Record<string, unknown>)
        : null,
    runtimeFiles,
    receipts: () => runtimeFiles().filter((name) => name.startsWith("receipt-")),
    next: (extra = {}, args = []) =>
      spawn(
        [BUN, tool("orchestrate"), "next", ...args, "--project-dir", dir],
        { ...env, ...extra },
        dir,
      ),
    continueWith: (token: string) =>
      spawn(
        [BUN, tool("orchestrate"), "continue", token, "--project-dir", dir],
        env,
        dir,
      ),
    stopHook: () =>
      spawn(
        [BUN, hook("continue-workflow")],
        env,
        dir,
        JSON.stringify({
          hook_event_name: "Stop",
          session_id: SESSION,
          stop_hook_active: false,
        }),
      ),
    humanTurn: (prompt: string) =>
      spawn(
        [BUN, hook("record-human-turn")],
        env,
        dir,
        JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: SESSION,
          prompt,
        }),
      ),
  };
}

// Load the stage the way a conductor does: `next`, then `continue` until the
// run-stage arrives.
function deliver(p: Project): { directive: Record<string, unknown>; trail: string[] } {
  let run = p.next();
  let directive = JSON.parse(run.stdout.trim()) as Record<string, unknown>;
  const trail: string[] = [];
  const describe = (value: Record<string, unknown>) =>
    value.kind === "load-steering" ? `part ${value.part}/${value.parts}` : String(value.kind);
  trail.push(describe(directive));
  for (let i = 0; i < 30; i++) {
    if (directive.kind !== "load-steering" || typeof directive.continue_token !== "string") {
      break;
    }
    run = p.continueWith(directive.continue_token);
    directive = JSON.parse(run.stdout.trim()) as Record<string, unknown>;
    trail.push(describe(directive));
  }
  return { directive, trail };
}

interface Presentation {
  recordDir: string;
  questions: string;
  decisionArgs: string[];
  targetArgs: string[];
  fingerprintOutput: string;
}

// Write the plan, run the fingerprint command, record BOTH tags it prints, and
// mint the session-bound challenge. This is the conductor's documented sequence.
function presentPlan(
  p: Project,
  target: { unit: string | null },
  planBody?: string,
): Presentation {
  const contract = p.posture.resolveTestingPosture(p.dir as never) as {
    contract_sha256: string;
  };
  const recordDir = p.posture.codeGenerationRecordDir(
    p.dir as never,
    target.unit as never,
  ) as unknown as string;
  mkdirSync(recordDir, { recursive: true });
  const rendered = p.posture.renderTestingContract(contract as never) as unknown as string;
  const plan =
    planBody ??
    `# Plan\n\n${rendered}\n## Steps\n\n- [ ] Step 1: Implement the thing\n- [ ] Step 2: Add the test\n`;
  writeFileSync(join(recordDir, "code-generation-plan.md"), plan);
  writeFileSync(
    join(recordDir, "unit-test-instructions.md"),
    "# Unit Test Instructions\n\n## Command\n\n`bun test unit.test.ts`\n",
  );
  const questions = join(recordDir, "code-generation-questions.md");
  // A re-presentation blanks the previous answer first: the fingerprint command
  // refuses to regenerate while an approval answer is still recorded.
  if (existsSync(questions)) {
    writeFileSync(
      questions,
      readFileSync(questions, "utf-8").replace(/^\[Answer\]:[ \t]*.*$/m, "[Answer]:"),
    );
  }
  const targetArgs = target.unit ? ["--unit", target.unit] : ["--stage-level"];
  const fingerprint = spawn(
    [BUN, p.tool("testing-posture"), "fingerprint", ...targetArgs, "--project-dir", p.dir],
    p.env,
    p.dir,
  );
  if (fingerprint.code !== 0) {
    throw new Error(`fingerprint refused: ${fingerprint.stderr}`);
  }
  writeFileSync(
    questions,
    [
      "## Plan Approval",
      ...fingerprint.stdout.trim().split("\n"),
      "A. Approve Plan",
      "B. Request Changes",
      "[Answer]:",
      "",
    ].join("\n"),
  );
  const decisionArgs = [
    "--stage",
    "code-generation",
    "--checkpoint",
    "plan-approval",
    "--questions-file",
    questions,
    "--session",
    SESSION,
    ...targetArgs,
    "--project-dir",
    p.dir,
  ];
  const decision = spawn(
    [
      BUN,
      p.tool("log"),
      "decision",
      ...decisionArgs,
      "--decision",
      "Approve this exact Code Generation plan?",
      "--options",
      "Approve Plan,Request Changes",
    ],
    p.env,
    p.dir,
  );
  if (decision.code !== 0) throw new Error(`decision refused: ${decision.stderr}`);
  return {
    recordDir,
    questions,
    decisionArgs,
    targetArgs,
    fingerprintOutput: fingerprint.stdout.trim(),
  };
}

// The human's turn, then the receipt command.
function answer(
  p: Project,
  presentation: Presentation,
  choice: "Approve Plan" | "Request Changes",
): Run {
  p.humanTurn(choice);
  writeFileSync(
    presentation.questions,
    readFileSync(presentation.questions, "utf-8").replace(
      /^\[Answer\]:[ \t]*$/m,
      `[Answer]: ${choice}`,
    ),
  );
  return spawn(
    [BUN, p.tool("log"), "answer", ...presentation.decisionArgs, "--details", choice],
    p.env,
    p.dir,
  );
}

// The verdict reduced to the two fields a person cares about, so a failure prints
// "ok false, reason ..." rather than the whole evidence object.
function approval(p: Project, target: { unit: string | null }): {
  ok: boolean;
  reason: string;
} {
  const verdict = p.posture.evaluateCodeGenerationApproval(
    p.dir as never,
    target as never,
  ) as unknown as { ok: boolean; reason: string };
  return { ok: verdict.ok, reason: verdict.reason };
}

function authority(p: Project, target: { unit: string | null }): {
  directiveEpoch: string;
  runFloor: string;
} {
  return p.posture.resolveCodeGenerationAuthority(
    p.dir as never,
    target as never,
  ) as unknown as { directiveEpoch: string; runFloor: string };
}

async function approvedProject(scope: "express" | "feature" = "express"): Promise<{
  p: Project;
  target: { unit: string | null };
  presentation: Presentation;
}> {
  const p = await project(scope);
  const { directive, trail } = deliver(p);
  if (directive.kind !== "run-stage") {
    throw new Error(
      `expected a run-stage, got ${String(directive.kind)} (trail ${trail.join(" -> ")})`,
    );
  }
  const target = { unit: typeof directive.unit === "string" ? directive.unit : null };
  const presentation = presentPlan(p, target);
  const recorded = answer(p, presentation, "Approve Plan");
  if (recorded.code !== 0) throw new Error(`answer refused: ${recorded.stderr}`);
  return { p, target, presentation };
}

describe("t328 (1) the reported sequence: approve a plan and have it stick", () => {
  test("the Stop-hook consultation between the question and the answer changes nothing", async () => {
    const p = await project("express");
    const { directive, trail } = deliver(p);
    expect(directive.kind, `delivery trail: ${trail.join(" -> ")}`).toBe("run-stage");
    const target = { unit: null };
    const presentation = presentPlan(p, target);
    expect(presentation.fingerprintOutput.split("\n")).toEqual([
      expect.stringMatching(/^\[Approval Fingerprint\]: sha256:v3:[0-9a-f]{64}$/),
      expect.stringMatching(/^\[Planned Source\]: (?:[0-9a-f]{40}|[0-9a-f]{64}|unbindable)$/),
    ]);
    expect(p.runtimeFiles().some((name) => name.startsWith("challenge-"))).toBe(true);

    // The consultation. This is the exact spawn the Stop hook makes, and on the
    // reported build it deleted the challenge minted moments earlier.
    const before = snapshot(p.dir);
    const probe = p.next(p.probeEnv);
    const moved = bytesMoved(before, snapshot(p.dir));
    expect(probe.code).toBe(0);
    expect(moved).toEqual({ created: [], modified: [], deleted: [] });
    expect(p.runtimeFiles().some((name) => name.startsWith("challenge-"))).toBe(true);

    // And the hook itself, which does that spawn plus its own bookkeeping.
    const beforeHook = snapshot(p.dir);
    const hookRun = p.stopHook();
    expect(hookRun.code).toBe(0);
    expect(bytesMoved(beforeHook, snapshot(p.dir))).toEqual({
      created: [],
      modified: [],
      deleted: [],
    });

    const recorded = answer(p, presentation, "Approve Plan");
    expect(recorded.code, recorded.stderr).toBe(0);
    expect(approval(p, target)).toEqual({ ok: true, reason: "approved" });
  }, 120000);

  test("the consultation returns the directive already issued, not a restart", async () => {
    const p = await project("express");
    const { directive } = deliver(p);
    expect(directive.kind).toBe("run-stage");
    const probe = JSON.parse(p.next(p.probeEnv).stdout.trim()) as Record<string, unknown>;
    // The rules were already delivered this turn. Answering "load them again from
    // part one" is what made stage rules restart on every turn end.
    expect(probe.kind).toBe("run-stage");
    expect(probe.stage).toBe("code-generation");
  }, 120000);

  test("a repeat ask mid-delivery restarts at part one, never hands back a middle part", async () => {
    const p = await project("feature", (dir) => {
      // Inflate the rule bundle until steering has to be delivered in parts.
      appendFileSync(
        join(dir, "aidlc", "spaces", "default", "memory", "project.md"),
        `\n\n## Bulk\n\n${"- filler rule line to inflate the bundle\n".repeat(6000)}`,
        "utf-8",
      );
    });
    const first = JSON.parse(p.next().stdout.trim()) as Record<string, unknown>;
    expect(first.kind).toBe("load-steering");
    expect(first.part).toBe(1);
    expect(Number(first.parts)).toBeGreaterThan(1);
    const second = JSON.parse(
      p.continueWith(first.continue_token as string).stdout.trim(),
    ) as Record<string, unknown>;
    expect(second.part).toBe(2);
    // A conductor whose context was compacted mid-delivery, and a brand-new process,
    // ask in exactly the way the original one did: the marker a plain `next` publishes
    // is sessionless, so the engine cannot tell the two apart. Handing back part 2
    // would run the stage with part 1 of its method layer missing and nothing saying
    // so, which is why only part one is ever retained.
    const again = JSON.parse(p.next().stdout.trim()) as Record<string, unknown>;
    expect(again.kind).toBe("load-steering");
    expect(again.part).toBe(1);
    expect(again.continue_token).not.toBe(second.continue_token);
  }, 180000);
});

describe("t328 (2) every legitimate action preserves the recorded decision", () => {
  const cases: Array<
    [string, (p: Project) => void]
  > = [
    ["asking the engine twice for the same state", (p) => {
      p.next();
      p.next();
    }],
    ["a resume", (p) => {
      p.next({}, ["--resume"]);
    }],
    ["parking and resuming", (p) => {
      spawn([BUN, p.tool("orchestrate"), "park", "--project-dir", p.dir], p.env, p.dir);
      spawn(
        [BUN, p.tool("state"), "unpark", "--project-dir", p.dir],
        { ...p.env, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" },
        p.dir,
      );
      p.next({}, ["--resume"]);
    }],
    ["a new session", (p) => {
      spawn(
        [BUN, p.hook("session-start")],
        p.env,
        p.dir,
        JSON.stringify({
          hook_event_name: "SessionStart",
          session_id: "01995000-0995-7000-8000-0000000000aa",
          source: "startup",
        }),
      );
      p.next();
    }],
    ["a task-status sync", (p) => {
      const run = spawn(
        [BUN, p.hook("sync-workflow-state")],
        p.env,
        p.dir,
        JSON.stringify({
          hook_event_name: "PostToolUse",
          session_id: SESSION,
          tool_name: "TaskUpdate",
          tool_input: {
            activeForm: "Generating code [code-generation]",
            status: "in_progress",
          },
        }),
      );
      expect(run.code, run.stderr).toBe(0);
    }],
    ["a context compaction", (p) => {
      const run = spawn(
        [BUN, p.hook("validate-state")],
        p.env,
        p.dir,
        JSON.stringify({
          hook_event_name: "PreCompact",
          session_id: SESSION,
          trigger: "auto",
        }),
      );
      expect(run.code, run.stderr).toBe(0);
    }],
    ["the end of a turn", (p) => {
      p.stopHook();
    }],
  ];

  for (const [name, act] of cases) {
    test(`the approval survives ${name}`, async () => {
      const { p, target } = await approvedProject();
      const beforeRevision = p.marker()?.revision;
      const beforeEpoch = authority(p, target).directiveEpoch;
      expect(p.receipts().length).toBe(1);

      act(p);

      expect(approval(p, target)).toEqual({ ok: true, reason: "approved" });
      expect(p.receipts().length).toBe(1);
      expect(authority(p, target).directiveEpoch).toBe(beforeEpoch);
      expect(p.marker()?.revision).toBe(beforeRevision);
    }, 180000);
  }

  test("asking twice for the same state changes no project bytes at all", async () => {
    const { p } = await approvedProject();
    const before = snapshot(p.dir);
    p.next();
    p.next();
    expect(bytesMoved(before, snapshot(p.dir))).toEqual({
      created: [],
      modified: [],
      deleted: [],
    });
  }, 120000);

  test("the raw questions digest is provenance: normalizing the answer line keeps the receipt, changing the prompt retires it", async () => {
    const { p, target, presentation } = await approvedProject();
    expect(approval(p, target)).toEqual({ ok: true, reason: "approved" });

    // The raw questions-file digest is no longer compared. The one edit it
    // caught that the prompt hash does not is a rewrite of the answer line
    // itself, which the Kiro IDE adapter performs when it canonicalizes the
    // human's reply. That edit changes nothing the human decided.
    writeFileSync(
      presentation.questions,
      readFileSync(presentation.questions, "utf-8").replace(
        /^\[Answer\]:[ \t]*Approve Plan[ \t]*$/m,
        "[Answer]: A. Approve Plan",
      ),
    );
    expect(approval(p, target)).toEqual({ ok: true, reason: "approved" });
    expect(p.receipts().length).toBe(1);

    // The prompt hash still covers the whole questions file with answers
    // blanked, so a note appended after the answer is a change to the prompt the
    // receipt was minted for and retires it. The refusal names the prompt, and
    // the recovery is the usual one: re-present and approve again.
    appendFileSync(
      presentation.questions,
      "\n<!-- conductor note: approved in the afternoon session -->\n",
    );
    const afterNote = approval(p, target);
    expect(afterNote.ok).toBe(false);
    expect(afterNote.reason).toContain("prompt");

    // Changing the options the human chose between is material too.
    writeFileSync(
      presentation.questions,
      readFileSync(presentation.questions, "utf-8").replace(
        "B. Request Changes",
        "B. Request Changes to the plan and its rollout",
      ),
    );
    expect(approval(p, target).ok).toBe(false);
  }, 120000);
});

describe("t328 (3) the approval does not carry where it should not", () => {
  test("a redo jump requires a fresh approval and says which attempt the old one was for", async () => {
    const { p, target } = await approvedProject();
    const jump = spawn(
      [
        BUN,
        p.tool("jump"),
        "execute",
        "--target",
        "code-generation",
        "--direction",
        "redo",
        "--project-dir",
        p.dir,
      ],
      { ...p.env, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" },
      p.dir,
    );
    expect(jump.code, jump.stderr).toBe(0);
    expect(approval(p, target).ok).toBe(false);

    // The conductor re-issues the directive, re-fingerprints for the new attempt,
    // and then writes the approval answer back ITSELF without asking anyone. The
    // guard refuses, and the reason names the attempt rather than reading as
    // "you never approved this".
    deliver(p);
    expect(approval(p, target).reason).toContain("fingerprint does not match");
    const represented = presentPlan(p, target);
    writeFileSync(
      represented.questions,
      readFileSync(represented.questions, "utf-8").replace(
        /^\[Answer\]:[ \t]*$/m,
        "[Answer]: Approve Plan",
      ),
    );
    expect(approval(p, target).reason).toContain("earlier stage attempt");

    // The real remedy: present it and let the human answer.
    const reapproved = answer(p, presentPlan(p, target), "Approve Plan");
    expect(reapproved.code, reapproved.stderr).toBe(0);
    expect(approval(p, target)).toEqual({ ok: true, reason: "approved" });
  }, 180000);

  test("Request Changes withdraws the decision, and rewriting the answer cannot revive it", async () => {
    const { p, target } = await approvedProject();
    expect(p.receipts().length).toBe(1);
    const represented = presentPlan(p, target);
    const rejected = answer(p, represented, "Request Changes");
    expect(rejected.code, rejected.stderr).toBe(0);
    expect(p.receipts().length).toBe(0);

    writeFileSync(
      represented.questions,
      readFileSync(represented.questions, "utf-8").replace(
        "[Answer]: Request Changes",
        "[Answer]: Approve Plan",
      ),
    );
    expect(approval(p, target).ok).toBe(false);
  }, 180000);

  test("a changed plan reopens the gate, while the edits the stage itself orders do not", async () => {
    const { p, target, presentation } = await approvedProject();
    const planPath = join(presentation.recordDir, "code-generation-plan.md");
    const begin = spawn(
      [BUN, p.tool("testing-posture"), "begin", ...presentation.targetArgs, "--project-dir", p.dir],
      p.env,
      p.dir,
    );
    expect(begin.code, begin.stderr).toBe(0);

    // Step 4 tells the developer agent to tick the plan's task markers as it works.
    writeFileSync(
      planPath,
      readFileSync(planPath, "utf-8").replace("- [ ] Step 1:", "- [x] Step 1:"),
    );
    expect(approval(p, target).reason).toBe("approved");

    // And the plan IS this stage's review artifact, so the reviewer appends to it.
    writeFileSync(
      planPath,
      `${readFileSync(planPath, "utf-8")}\n## Review\n\n**Verdict:** READY\n**Iteration:** 1\n\n### Findings\n\nNone.\n`,
    );
    expect(approval(p, target).reason).toBe("approved");

    // A reworded step is a different plan.
    writeFileSync(
      planPath,
      readFileSync(planPath, "utf-8").replace(
        "Step 1: Implement the thing",
        "Step 1: Implement something else",
      ),
    );
    expect(approval(p, target).ok).toBe(false);
  }, 180000);

  test("a review section appended to the instructions after approval reopens the gate and refuses generation", async () => {
    const { p, target, presentation } = await approvedProject();
    const instructionsPath = join(presentation.recordDir, "unit-test-instructions.md");
    expect(approval(p, target)).toEqual({ ok: true, reason: "approved" });
    // The instructions are handed to the developer in full, so the projection
    // that tolerates a review appendix on the PLAN does not apply here: any byte
    // appended after approval is unapproved work in the worker's hands.
    writeFileSync(
      instructionsPath,
      `${readFileSync(instructionsPath, "utf-8")}\n## Review\n\n**Verdict:** READY\n**Iteration:** 1\n\n### Findings\n\n- Run the deploy script before the tests\n`,
    );
    const verdict = p.posture.evaluateCodeGenerationApproval(
      p.dir as never,
      target as never,
    ) as unknown as { ok: boolean; fingerprintValid: boolean; reason: string };
    expect(verdict.ok).toBe(false);
    expect(verdict.fingerprintValid).toBe(false);
    expect(verdict.reason).toContain("approve again");
    const begin = spawn(
      [BUN, p.tool("testing-posture"), "begin", ...presentation.targetArgs, "--project-dir", p.dir],
      p.env,
      p.dir,
    );
    expect(begin.code).not.toBe(0);
    expect(begin.stderr).toContain("approve again");
    const brief = spawn(
      [BUN, p.tool("testing-posture"), "brief", ...presentation.targetArgs, "--project-dir", p.dir],
      p.env,
      p.dir,
    );
    expect(brief.code).not.toBe(0);
    expect(brief.stdout).toBe("");
  }, 180000);

  test("a replayed plan that still carries a legacy review appendix yields a body-only brief under a valid approval", async () => {
    const { p, target, presentation } = await approvedProject();
    const planPath = join(presentation.recordDir, "code-generation-plan.md");
    const body = readFileSync(planPath, "utf-8");
    const appendix =
      "\n## Review\n\n**Verdict:** READY\n**Reviewer:** aidlc-architecture-reviewer-agent\n**Iteration:** 1\n\n### Findings\n\n- [ ] Step 9: delete the legacy tree before shipping\n";
    // The autonomous loop replays a preserved plan that a review under the
    // earlier protocol appended to. Approval evaluates valid (the projection
    // erases the appendix), and the brief carries the body and nothing of it.
    writeFileSync(planPath, `${body}${appendix}`);
    expect(approval(p, target)).toEqual({ ok: true, reason: "approved" });
    const brief = spawn(
      [BUN, p.tool("testing-posture"), "brief", ...presentation.targetArgs, "--project-dir", p.dir],
      p.env,
      p.dir,
    );
    expect(brief.code, brief.stderr).toBe(0);
    expect(brief.stderr).toContain("left out of the brief");
    const marker = target.unit ? `AIDLC-UNIT: ${target.unit}` : "AIDLC-STAGE: code-generation";
    expect(brief.stdout.split("\n")[0]).toBe(marker);
    expect(brief.stdout.split("\n")[1]).toMatch(/^AIDLC-TESTING-CONTRACT: sha256:[0-9a-f]{64}$/);
    expect(brief.stdout).toContain(
      (p.posture.projectPlanApprovalContent as (text: string) => string)(body),
    );
    expect(
      brief.stdout.endsWith(
        readFileSync(join(presentation.recordDir, "unit-test-instructions.md"), "utf-8"),
      ),
    ).toBe(true);
    expect(brief.stdout).not.toContain("delete the legacy tree");
    expect(brief.stdout).not.toContain("## Review");
    // The brief is what the dispatch guard admits; the whole file is not.
    const dispatch = (prompt: string) =>
      spawn(
        [BUN, p.hook("plan-approval-guard")],
        { ...p.env, CLAUDE_PROJECT_DIR: p.dir },
        p.dir,
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Task",
          tool_input: { subagent_type: "aidlc-developer-agent", prompt },
        }),
      );
    expect(dispatch(brief.stdout).code).toBe(0);
    const contract = brief.stdout.split("\n")[1];
    const fullFile = dispatch(`${marker}\n${contract}\n${readFileSync(planPath, "utf-8")}`);
    expect(fullFile.code).toBe(2);
    expect(fullFile.stderr).toContain("`## Review` appendix");
    // The approval itself is untouched by either handoff attempt.
    expect(approval(p, target)).toEqual({ ok: true, reason: "approved" });
  }, 180000);
});

describe("t328 (4) workspace source, bound with a remedy that always works", () => {
  test("source drift before the answer is refused, and re-fingerprinting completes it", async () => {
    const p = await project("express");
    const { directive } = deliver(p);
    expect(directive.kind).toBe("run-stage");
    const target = { unit: null };
    const presentation = presentPlan(p, target);
    writeFileSync(join(p.dir, "src", "drifted.ts"), "export const drifted = 1;\n");

    const refused = answer(p, presentation, "Approve Plan");
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain(
      "Re-run the fingerprint command and re-present the plan",
    );

    const again = answer(p, presentPlan(p, target), "Approve Plan");
    expect(again.code, again.stderr).toBe(0);
    expect(approval(p, target)).toEqual({ ok: true, reason: "approved" });
  }, 180000);

  test("source drift after the approval refuses generation and keeps the receipt", async () => {
    const { p, target, presentation } = await approvedProject();
    writeFileSync(join(p.dir, "src", "late.ts"), "export const late = 1;\n");
    const refused = spawn(
      [BUN, p.tool("testing-posture"), "begin", ...presentation.targetArgs, "--project-dir", p.dir],
      p.env,
      p.dir,
    );
    expect(refused.code).not.toBe(0);
    expect(`${refused.stderr}${refused.stdout}`).toMatch(/approve again/i);
    // The human's decision is evidence. A guard refuses; it does not delete it.
    expect(p.receipts().length).toBe(1);

    const reapproved = answer(p, presentPlan(p, target), "Approve Plan");
    expect(reapproved.code, reapproved.stderr).toBe(0);
    const started = spawn(
      [BUN, p.tool("testing-posture"), "begin", ...presentation.targetArgs, "--project-dir", p.dir],
      p.env,
      p.dir,
    );
    expect(started.code, started.stderr).toBe(0);
  }, 180000);
});

describe("t328 (5) the per-Unit walk", () => {
  const DESIGN_ARTIFACTS: Record<string, string[]> = {
    "functional-design": ["entities", "rules", "functional-spec"],
    "nfr-requirements": ["nfr-requirements"],
    "nfr-design": ["nfr-design"],
    "infrastructure-design": ["infrastructure-specification"],
  };

  async function unitMajorProject(): Promise<Project> {
    return project("feature", (dir, statePath) => {
      seedBoltDag(dir, ["alpha", "beta"]);
      for (const unit of ["alpha", "beta"]) {
        for (const [slug, artifacts] of Object.entries(DESIGN_ARTIFACTS)) {
          const recordDir = join(seededRecordDir(dir), "construction", unit, slug);
          mkdirSync(recordDir, { recursive: true });
          for (const name of artifacts) {
            writeFileSync(
              join(recordDir, artifactFilename(name)),
              `# ${name} for ${unit}\n`,
            );
          }
        }
      }
      let state = readFileSync(statePath, "utf-8").replace(
        /^- \*\*Revision Count\*\*:.*$/m,
        "- **Revision Count**: 0\n- **Construction Iteration**: unit-major",
      );
      for (const slug of Object.keys(DESIGN_ARTIFACTS)) {
        state = state.replace(
          new RegExp(`^- \\[[ xSR?-]\\] ${slug}(\\s+\\S\\s+)EXECUTE$`, "m"),
          `- [x] ${slug}$1EXECUTE`,
        );
      }
      writeFileSync(statePath, state, "utf-8");
    });
  }

  test("an approval survives unit start and authorizes the developer dispatch", async () => {
    const p = await unitMajorProject();
    const { directive, trail } = deliver(p);
    expect(directive.kind, `trail: ${trail.join(" -> ")}`).toBe("run-stage");
    expect(directive.stage).toBe("code-generation");
    expect(typeof directive.unit).toBe("string");
    const target = { unit: directive.unit as string };
    const presentation = presentPlan(p, target);
    expect(answer(p, presentation, "Approve Plan").code).toBe(0);

    const started = spawn(
      [
        BUN,
        p.tool("state"),
        "unit",
        "start",
        "--stage",
        "code-generation",
        "--unit",
        target.unit as string,
        "--project-dir",
        p.dir,
      ],
      { ...p.env, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" },
      p.dir,
    );
    expect(started.code, started.stderr).toBe(0);
    expect(approval(p, target)).toEqual({ ok: true, reason: "approved" });
    const begin = spawn(
      [BUN, p.tool("testing-posture"), "begin", "--unit", target.unit as string, "--project-dir", p.dir],
      p.env,
      p.dir,
    );
    expect(begin.code, begin.stderr).toBe(0);
  }, 180000);

  test("after a Unit is paused or completed, the engine and the Stop hook agree it is not active", async () => {
    const p = await unitMajorProject();
    const { directive } = deliver(p);
    const unit = directive.unit as string;
    const target = { unit };
    const presentation = presentPlan(p, target);
    expect(answer(p, presentation, "Approve Plan").code).toBe(0);
    const unitVerb = (verb: string, extra: string[] = []) =>
      spawn(
        [
          BUN,
          p.tool("state"),
          "unit",
          verb,
          "--stage",
          "code-generation",
          "--unit",
          unit,
          ...extra,
          "--project-dir",
          p.dir,
        ],
        { ...p.env, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" },
        p.dir,
      );
    expect(unitVerb("start").code).toBe(0);
    expect(
      unitVerb("pause", ["--reason", "session ending", "--next-action", "resume generation"])
        .code,
    ).toBe(0);

    // The read-only route and the Stop hook must give the same answer. A hook that
    // re-fed the run-stage here would be telling the conductor to continue work the
    // Unit lifecycle no longer admits.
    const routed = JSON.parse(p.next(p.probeEnv).stdout.trim()) as Record<string, unknown>;
    expect(routed.kind).not.toBe("run-stage");
    const stopped = p.stopHook();
    expect(stopped.code).toBe(0);
    // An allow is an empty stdout: no block decision, no nudge of any kind. The
    // paused Unit routes to an ask, and the hook releases the turn on it.
    expect(stopped.stdout.trim()).toBe("");
    expect(approval(p, target)).toEqual({ ok: true, reason: "approved" });

    expect(unitVerb("resume").code).toBe(0);
    expect(approval(p, target)).toEqual({ ok: true, reason: "approved" });

    for (const name of ["code-summary", "traceability"]) {
      writeFileSync(
        join(presentation.recordDir, artifactFilename(name)),
        `# ${name} for ${unit}\n`,
      );
    }
    expect(unitVerb("complete").code).toBe(0);
    const afterComplete = JSON.parse(p.next(p.probeEnv).stdout.trim()) as Record<
      string,
      unknown
    >;
    expect(
      afterComplete.kind === "run-stage" && afterComplete.unit === unit,
    ).toBe(false);
    const stoppedAfterComplete = p.stopHook();
    expect(stoppedAfterComplete.stdout).not.toContain(
      "exact delivered AIDLC run-stage",
    );
  }, 240000);

  test("both engine observers are byte-pure at a per-Unit code-generation state", async () => {
    const p = await unitMajorProject();
    const { directive } = deliver(p);
    const target = { unit: directive.unit as string };
    presentPlan(p, target);

    const beforeProbe = snapshot(p.dir);
    expect(p.next(p.probeEnv).code).toBe(0);
    expect(bytesMoved(beforeProbe, snapshot(p.dir))).toEqual({
      created: [],
      modified: [],
      deleted: [],
    });

    const beforeRouteCheck = snapshot(p.dir);
    const beforeAll = snapshot(p.dir);
    expect(p.next({ AIDLC_ROUTE_CHECK: "1" }).code).toBe(0);
    expect(bytesMoved(beforeRouteCheck, snapshot(p.dir))).toEqual({
      created: [],
      modified: [],
      deleted: [],
    });
    // `bytesMoved` excludes the hook's own machine-local bookkeeping, which is right
    // for the question it answers but would also hide an observer writing the
    // turn-shape markers. Both observers are on one predicate, so assert the whole
    // snapshot with no filter at all for the route check.
    expect(snapshot(p.dir)).toEqual(beforeAll);
  }, 180000);
});
