// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:park
//
// The work is parked, and the person types a change to its plan: a different
// scope (`/aidlc --scope mvp`), a stage to leave out (`/aidlc --skip
// deployment-pipeline`), a stage to put back (`/aidlc --add ci-pipeline`), or a
// reshape (`/aidlc compose`). The only answer used to be "Workflow parked at
// "code-generation". Resume with /aidlc --resume.", and after the resume the
// plan was as before, so the person had to type the change again. Now the
// change is made while the work stays parked, the one line the person reads
// says so, and `/aidlc --resume` then picks the work up on the new plan.
//
// A real walk on the Claude tree under production guards: the person's turns
// go through the record-human-turn hook, and every command the agent runs goes
// through the Bash PreToolUse hooks first.

import { afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  cleanupTestProject,
  resetAidlcEnv,
  seededRecordDir,
  seededStateFile,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 4);

const BUN = process.execPath;
const SEP = String.fromCharCode(0x2014);
const SESSION = "01995000-7a11-7000-8000-000000000071";
const PRE_HOOKS = ["state-transition-guard", "reviewer-scope", "review-freeze", "plan-approval-guard"];

type Json = Record<string, unknown> & { kind?: string; message?: string; stage?: string };
interface Ran {
  code: number;
  out: string;
  json: Json | null;
}

function parseJson(text: string): Json | null {
  try {
    return JSON.parse(text.trim()) as Json;
  } catch {
    return null;
  }
}

function rows(phase: string, list: Array<[string, string, string]>): string {
  return [`### ${phase}`, ...list.map(([box, slug, mode]) => `- [${box}] ${slug} ${SEP} ${mode}`)].join("\n");
}
const skipped = (...slugs: string[]): Array<[string, string, string]> => slugs.map((slug) => [" ", slug, "SKIP"]);

// A bugfix at Code Generation: deployment-pipeline runs, ci-pipeline does not.
const STATE = `# AI-DLC State Tracking

## Project Information
- **Project**: formatPrice(0) returns an empty string instead of $0.00
- **Project Type**: Brownfield
- **Project Type Source**: workspace scan
- **Scope**: bugfix
- **State Version**: 8
- **Active Agent**: aidlc-developer-agent

## Scope Configuration
- **Stages to Execute**: 0.1, 0.2, 0.3, 2.1, 2.3, 3.5, 3.6, 4.1, 4.3
- **Stages to Skip**: 1.1 (intent-capture), 1.2 (market-research), 1.3 (feasibility), 1.4 (scope-definition), 1.5 (team-formation), 1.6 (rough-mockups), 1.7 (approval-handoff), 2.2 (practices-discovery), 2.4 (user-stories), 2.5 (refined-mockups), 2.6 (domain-design), 2.7 (units-generation), 2.8 (contract-design), 2.9 (delivery-planning), 3.1 (functional-design), 3.2 (nfr-requirements), 3.3 (nfr-design), 3.4 (infrastructure-design), 3.7 (ci-pipeline), 4.2 (environment-provisioning), 4.4 (observability-setup), 4.5 (incident-response), 4.6 (performance-validation), 4.7 (feedback-optimization)
- **Depth**: Minimal
- **Test Strategy**: Minimal
- **Guard Policy**: off (from scope bugfix)
- **Sensors**: on (from scope bugfix)
- **Learnings**: off (from scope bugfix)
- **Summary Confirmation**: off (from scope bugfix)
- **Plan Approval**: on (from scope bugfix)

## Workspace State
- **Project Root**: .
- **Languages**: JavaScript
- **Build System**: npm (package.json)

## Runtime State
- **Revision Count**: 0

## Phase Progress
- **Initialization**: Verified
- **Ideation**: Skipped
- **Inception**: Verified
- **Construction**: Active
- **Operation**: Pending

## Stage Progress

${rows("INITIALIZATION PHASE", [["x", "workspace-scaffold", "EXECUTE"], ["x", "workspace-detection", "EXECUTE"], ["x", "state-init", "EXECUTE"]])}

${rows("IDEATION PHASE", skipped("intent-capture", "market-research", "feasibility", "scope-definition", "team-formation", "rough-mockups", "approval-handoff"))}

${rows("INCEPTION PHASE", [["x", "reverse-engineering", "EXECUTE"], ...skipped("practices-discovery"), ["x", "requirements-analysis", "EXECUTE"], ...skipped("user-stories", "refined-mockups", "domain-design", "units-generation", "contract-design", "delivery-planning")])}

${rows("CONSTRUCTION PHASE", [...skipped("functional-design", "nfr-requirements", "nfr-design", "infrastructure-design"), ["-", "code-generation", "EXECUTE"], [" ", "build-and-test", "EXECUTE"], ...skipped("ci-pipeline")])}

${rows("OPERATION PHASE", [[" ", "deployment-pipeline", "EXECUTE"], ...skipped("environment-provisioning"), [" ", "deployment-execution", "EXECUTE"], ...skipped("observability-setup", "incident-response", "performance-validation", "feedback-optimization")])}

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: code-generation
- **Next Stage**: build-and-test
- **Status**: Running
`;

class Walk {
  readonly env: NodeJS.ProcessEnv;
  constructor(readonly proj: string) {
    const env = testGuardEnvironment({ ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj }, "production");
    delete env.AWS_AIDLC_DEFAULT_SCOPE;
    env.AIDLC_UNATTENDED = "0";
    env.CLAUDECODE = "1";
    env.PATH = `${dirname(BUN)}:${env.PATH ?? ""}`;
    this.env = env;
  }

  private spawn(argv: string[], input = ""): { code: number; stdout: string; stderr: string } {
    const r = spawnSync(argv[0], argv.slice(1), {
      cwd: this.proj,
      env: this.env,
      encoding: "utf-8",
      input,
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  hook(name: string, payload: Record<string, unknown>): { code: number; stdout: string; stderr: string } {
    return this.spawn(
      [BUN, join(this.proj, ".claude", "tools", "aidlc.ts"), "engine", "hook", name],
      JSON.stringify({ session_id: SESSION, cwd: this.proj, ...payload }),
    );
  }

  /** The person types a message. */
  say(prompt: string): void {
    this.hook("record-human-turn", { hook_event_name: "UserPromptSubmit", prompt });
  }

  /** The PreToolUse hooks Claude Code fires for a tool call: what blocked it, if any. */
  private pre(tool: string, input: Record<string, unknown>): string | null {
    for (const name of PRE_HOOKS) {
      const pre = this.hook(name, { hook_event_name: "PreToolUse", tool_name: tool, tool_input: input });
      const json = parseJson(pre.stdout) as { hookSpecificOutput?: { permissionDecision?: string } } | null;
      if (pre.code === 2 || json?.hookSpecificOutput?.permissionDecision === "deny") {
        return `BLOCKED by ${name}: ${pre.stderr}${pre.stdout}`;
      }
    }
    return null;
  }

  /** The agent's Write tool: the PreToolUse hooks, the write, the audit hook. */
  write(rel: string, content: string): void {
    const abs = join(this.proj, rel);
    const blocked = this.pre("Write", { file_path: abs, content });
    expect(blocked).toBeNull();
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    this.hook("write-audit-log", {
      hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: abs, content },
      tool_response: { type: "create", filePath: abs },
    });
  }

  /** The agent's Bash tool: the PreToolUse hooks, then the command. */
  bash(line: string): Ran {
    const blocked = this.pre("Bash", { command: line });
    if (blocked !== null) return { code: 2, out: blocked, json: null };
    const r = this.spawn(["bash", "-c", line]);
    this.hook("rebuild-stage-graph", {
      hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: line },
      tool_response: { stdout: r.stdout, stderr: r.stderr },
    });
    return { code: r.code, out: `${r.stdout}${r.stderr}`, json: parseJson(r.stdout) };
  }

  /** `next` as the skill runs it, following load-steering parts. */
  next(args: string[]): Ran {
    let r = this.bash(["bun", ".claude/tools/aidlc.ts", "engine", "orchestrate", "next", ...args].join(" "));
    for (let i = 0; i < 20 && r.json?.kind === "load-steering" && typeof r.json.next === "string"; i++) {
      r = this.bash(String(r.json.next));
    }
    return r;
  }

  /** Every engine command a print names, run as printed and in order. */
  runNamed(message: string): Ran[] {
    const commands = [...message.matchAll(/`(bun \.claude\/tools\/[^`]+)`/g)].map((m) => m[1]);
    return commands.map((command) => this.bash(command));
  }

  state(): string {
    return readFileSync(seededStateFile(this.proj), "utf-8");
  }

  row(slug: string): string {
    return this.state().split("\n").find((line) => line.includes(` ${slug} ${SEP} `)) ?? `(no ${slug} row)`;
  }

  parked(): boolean {
    return /^- \*\*Parked\*\*: \S/m.test(this.state());
  }
}

async function parkedProject(at: "stage" | "plan question" = "stage"): Promise<Walk> {
  const proj = setupIntegrationProject({ stripEnvScope: true });
  created.push(proj);
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "package.json"), `${JSON.stringify({ name: "price-format", type: "module" }, null, 2)}\n`);
  writeFileSync(join(proj, "src", "price.js"), "export function formatPrice(cents) {\n  if (!cents) return \"\";\n  return `$${(cents / 100).toFixed(2)}`;\n}\n");
  writeFileSync(seededStateFile(proj), STATE);
  const requirements = join(seededRecordDir(proj), "inception", "requirements-analysis");
  mkdirSync(requirements, { recursive: true });
  writeFileSync(join(requirements, "requirements.md"), "# Requirements\n\n`formatPrice(0)` must return `$0.00`.\n");
  const { appendAuditEntry } = await import("../../dist/claude/.claude/tools/aidlc-audit.ts");
  const { compileRuntime } = await import("../../dist/claude/.claude/tools/aidlc-runtime.ts");
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "bugfix", Request: "Fix formatPrice(0)" }, proj);
  for (const slug of ["workspace-scaffold", "workspace-detection", "state-init", "reverse-engineering", "requirements-analysis"]) {
    appendAuditEntry("STAGE_STARTED", { Stage: slug }, proj);
    appendAuditEntry("STAGE_COMPLETED", { Stage: slug }, proj);
  }
  appendAuditEntry("STAGE_STARTED", { Stage: "code-generation", Agent: "aidlc-developer-agent" }, proj);
  const compiled = compileRuntime(proj);
  if (compiled.skipped) throw new Error(`runtime compilation skipped: ${compiled.skipped}`);

  const walk = new Walk(proj);
  walk.hook("session-start", { hook_event_name: "SessionStart", source: "startup" });
  // The work is at Code Generation.
  walk.say("/aidlc");
  const first = walk.next([]);
  expect(first.json?.kind, first.out).toBe("run-stage");
  expect(first.json?.stage).toBe("code-generation");
  if (at === "plan question") {
    // The developer writes the code plan, and the engine asks the person to approve it.
    const produces = (first.json?.produces as string[] | undefined) ?? [];
    const plan = produces.find((path) => path.endsWith("code-generation-plan.md"));
    const instructions = produces.find((path) => path.endsWith("unit-test-instructions.md"));
    expect(plan && instructions, first.out).toBeTruthy();
    const contract = walk.bash("bun .claude/tools/aidlc-testing-posture.ts render");
    expect(contract.code, contract.out).toBe(0);
    walk.write(plan!, "# Code Generation Plan\n\n## Summary\n\n" +
      "- Builds: `formatPrice(0)` returns `$0.00`\n- Touches: `src/price.js`, new `src/price.test.js`\n" +
      "- Tests: 2 unit tests\n\n## Steps\n\n- [ ] Step 1: Fix the check in `src/price.js`\n" +
      `- [ ] Step 2: Write \`src/price.test.js\`\n- [ ] Step 3: Run \`node --test src/price.test.js\`\n\n${contract.out.trim()}\n`);
    walk.write(instructions!, "# Unit Test Instructions\n\n- Run: `node --test src/price.test.js`\n");
    const ask = walk.next([]);
    expect(ask.json?.ask_type, ask.out).toBe("plan-approval");
  }
  // The person stops for the day, and the agent parks the work.
  walk.say("let's stop here for today");
  const park = walk.bash("bun .claude/tools/aidlc.ts engine orchestrate park");
  expect(park.json?.kind, park.out).toBe("parked");
  expect(walk.parked()).toBe(true);
  // They come back in a new chat.
  walk.hook("session-start", { hook_event_name: "SessionStart", source: "startup" });
  return walk;
}

/** The person types the change; the agent runs `next` and the commands it names. */
function typeChange(walk: Walk, flags: string[]): Json {
  walk.say(`/aidlc ${flags.join(" ")}`);
  const said = walk.next(flags);
  expect(said.json, said.out).not.toBeNull();
  // Before: the request was answered with the park, and nothing was made.
  expect(said.json?.kind, said.out).toBe("print");
  for (const ran of walk.runNamed(String(said.json?.message ?? ""))) {
    expect(ran.code, ran.out).toBe(0);
    expect(ran.json?.kind, ran.out).not.toBe("error");
  }
  return said.json!;
}

/** The person resumes: the agent unparks as `next --resume` names, then runs `next --resume`. */
function resume(walk: Walk): Json {
  walk.say("/aidlc --resume");
  let r = walk.next(["--resume"]);
  if (/aidlc-state\.ts unpark/.test(String(r.json?.message ?? ""))) {
    for (const ran of walk.runNamed(String(r.json?.message ?? ""))) expect(ran.code, ran.out).toBe(0);
    r = walk.next(["--resume"]);
  }
  expect(r.json, r.out).not.toBeNull();
  expect(["run-stage", "ask"], r.out).toContain(String(r.json?.kind));
  expect(walk.parked()).toBe(false);
  return r.json!;
}

const created: string[] = [];
beforeAll(() => resetAidlcEnv());
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

describe("t-parked-work-takes-plan-changes: a change typed over parked work is made, not dropped", () => {
  test("/aidlc --scope mvp: the scope changes, the work stays parked, and --resume carries on in mvp", async () => {
    const walk = await parkedProject();
    const said = typeChange(walk, ["--scope", "mvp"]);
    expect(said.message).toContain("scope change --scope mvp");
    expect(said.message).toContain("--resume");
    expect(walk.state()).toMatch(/^- \*\*Scope\*\*: mvp$/m);
    expect(walk.parked()).toBe(true);
    resume(walk);
    expect(walk.state()).toMatch(/^- \*\*Scope\*\*: mvp$/m);
  });

  test("/aidlc --skip deployment-execution: the stage leaves the plan, the work stays parked, --resume keeps it off", async () => {
    const walk = await parkedProject();
    const said = typeChange(walk, ["--skip", "deployment-execution"]);
    expect(said.message).toContain("recompose --skip deployment-execution");
    expect(said.message).toContain("--resume");
    expect(walk.row("deployment-execution")).toContain("SKIP");
    expect(walk.parked()).toBe(true);
    const back = resume(walk);
    expect(back.stage).toBe("code-generation");
    expect(walk.row("deployment-execution")).toContain("SKIP");
  });

  test("/aidlc --add ci-pipeline: the stage joins the plan, the work stays parked, --resume keeps it on", async () => {
    const walk = await parkedProject();
    const said = typeChange(walk, ["--add", "ci-pipeline"]);
    expect(said.message).toContain("recompose --add ci-pipeline");
    expect(said.message).toContain("--resume");
    expect(walk.row("ci-pipeline")).toContain("EXECUTE");
    expect(walk.parked()).toBe(true);
    const back = resume(walk);
    expect(back.stage).toBe("code-generation");
    expect(walk.row("ci-pipeline")).toContain("EXECUTE");
  });

  test("parked at the plan question: --skip deployment-execution is made, and --resume asks the plan question again", async () => {
    const walk = await parkedProject("plan question");
    const said = typeChange(walk, ["--skip", "deployment-execution"]);
    expect(said.message).toContain("recompose --skip deployment-execution");
    expect(said.message).toContain("--resume");
    expect(walk.row("deployment-execution")).toContain("SKIP");
    expect(walk.parked()).toBe(true);
    const back = resume(walk);
    expect(back.kind).toBe("ask");
    expect(back.ask_type).toBe("plan-approval");
    expect(walk.row("deployment-execution")).toContain("SKIP");
  });

  test("/aidlc compose: the reshape is taken up, not answered with the park", async () => {
    const walk = await parkedProject();
    walk.say("/aidlc compose");
    const said = walk.next(["compose"]);
    expect(said.json?.kind, said.out).toBe("print");
    expect(String(said.json?.message)).toMatch(/composer/i);
    expect(walk.parked()).toBe(true);
  });
});
