// covers: function:contextNote, function:bodyRuns, subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:continue
//
// The step that starts a stage the lead works in the chat carries the lead's
// persona itself, so there is no read for the agent to put in the right order.
// Before, the step listed the persona file first and said to read it before
// anything else; on Windows the agent read the stage file first in 2 of 6
// User Stories runs (the stage file's own Step 1 says to load the persona), and
// a stage could start its work before the lead's perspective was in place.
//
// On every shipped tree:
//   - an inline stage and a mob stage hand over the lead's persona text, the
//     same text as the file the step used to name, and no longer list that file;
//   - with collaborators on, the supports an inline stage adopts are still listed
//     to read from their files;
//   - a dispatched stage carries no persona (its agent loads its own), and a
//     gate shown again, whose body does not run, lists the file as before;
//   - a persona too large to ride beside its step is listed to read as before,
//     and the step is still delivered;
//   - every printed result stays within the host's limit for one result.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  createTestProject,
  FIXTURES_DIR,
  REPO_ROOT,
  runOrchestrateNext,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";

setDefaultTimeout(120_000);

const HARNESSES: ReadonlyArray<readonly [string, string]> = [
  ["claude", ".claude"],
  ["kiro", ".kiro"],
  ["kiro-ide", ".kiro"],
  ["codex", ".codex"],
  ["cursor", ".cursor"],
  ["opencode", ".aidlc"],
  ["copilot", ".aidlc"],
];
const STAGE_LINE = /^- \[[ x-]\] ([a-z0-9-]+) \u2014 EXECUTE$/gm;
const FIXTURE_STATE = readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8");
const FIXTURE_STAGES = [...FIXTURE_STATE.matchAll(STAGE_LINE)].map((match) => match[1] ?? "");
const HOST_ENV = [
  "AIDLC_PROJECT_DIR", "CLAUDE_PROJECT_DIR", "AIDLC_HARNESS_NAME", "AIDLC_HARNESS_DIR", "AIDLC_RUNTIME_ROOT",
  "AIDLC_RUNTIME_HARNESS_ROOT", "AIDLC_COMPILED_EXECUTABLE", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID",
  "CODEX_THREAD_ID", "CODEX_SESSION_ID", "KIRO_SESSION_ID", "OPENCODE", "AIDLC_SESSION_OVERRIDE",
  "AIDLC_SESSION_OVERRIDE_SOURCE", "AIDLC_STOP_HOOK_PROBE", "AWS_AIDLC_DEFAULT_SCOPE",
];

type Step = {
  kind: string;
  stage?: string;
  mode?: string;
  receipt?: string;
  lead_agent?: string;
  support_agents?: string[];
  lead_persona?: { path: string; text: string };
  inline_context_paths?: string[];
  context_note?: string;
  gate_only?: boolean;
  message?: string;
};

const projects: string[] = [];
afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
});

// The brownfield feature state with `stage` in progress: every earlier stage
// done, every later one still to run.
function stateAt(stage: string, collaborators: boolean): string {
  const at = FIXTURE_STAGES.indexOf(stage);
  const state = FIXTURE_STATE
    .replace(/^(- \*\*Current Stage\*\*: ).*$/m, `$1${stage}`)
    .replace(/^(- \*\*In Progress\*\*: ).*$/m, `$1${stage}`)
    .replace(STAGE_LINE, (line, slug: string) => {
      const index = FIXTURE_STAGES.indexOf(slug);
      const mark = index < at ? "x" : index === at ? "-" : " ";
      return line.replace(/^- \[[ x-]\]/, `- [${mark}]`);
    });
  return collaborators ? `${state}- **Collaborators**: on (set by you)\n` : state;
}

function limitOf(root: string, harnessDir: string): number {
  const data = JSON.parse(readFileSync(join(root, harnessDir, "tools", "data", "harness.json"), "utf-8")) as {
    directiveMaxBytes?: number;
  };
  return data.directiveMaxBytes ?? 28 * 1024;
}

// `next`, then `continue <receipt>` for every rules part, as the conductor runs them.
function deliver(
  harness: string,
  harnessDir: string,
  stage: string,
  collaborators = false,
  change: (proj: string) => void = () => {},
): {
  printed: string[];
  step: Step;
  proj: string;
} {
  const root = join(REPO_ROOT, "dist", harness);
  const proj = createTestProject();
  projects.push(proj);
  cpSync(join(root, harnessDir), join(proj, harnessDir), { recursive: true });
  cpSync(join(root, "aidlc"), join(proj, "aidlc"), { recursive: true });
  writeFileSync(seededStateFile(proj), stateAt(stage, collaborators), "utf-8");
  change(proj);
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of HOST_ENV) delete env[key];
  const printed: string[] = [];
  let args = ["next"];
  for (let hop = 0; hop < 20; hop++) {
    const run = Bun.spawnSync([process.execPath, join(proj, harnessDir, "tools", "aidlc-orchestrate.ts"), ...args], {
      cwd: proj,
      env,
    });
    const stdout = run.stdout.toString();
    expect(run.exitCode, `${harness} ${stage} ${args.join(" ")}: ${run.stderr.toString()}`).toBe(0);
    printed.push(stdout);
    const step = JSON.parse(stdout) as Step;
    if (step.kind !== "load-steering") return { printed, step, proj };
    args = ["continue", step.receipt ?? ""];
  }
  throw new Error(`${harness} ${stage}: the rules parts did not reach the stage's step in 20 hops`);
}

function personaFile(harnessDir: string, agent: string, proj: string): string {
  const copy = `${harnessDir}/aidlc-common/personas/${agent}.md`;
  try {
    readFileSync(join(proj, copy));
    return copy;
  } catch {
    return `${harnessDir}/agents/${agent}.md`;
  }
}

describe("t-lead-persona-in-step: the step carries the lead's persona", () => {
  for (const [harness, harnessDir] of HARNESSES) {
    for (const stage of ["user-stories", "requirements-analysis"]) {
      test(`${harness}: ${stage} hands over the lead's persona and lists no persona file to read`, () => {
        const { printed, step, proj } = deliver(harness, harnessDir, stage);
        expect(step.kind, step.message).toBe("run-stage");
        expect(step.mode).toBe(stage === "user-stories" ? "mob" : "inline");
        const file = personaFile(harnessDir, step.lead_agent ?? "", proj);
        expect(step.lead_persona?.path).toBe(file);
        expect(step.lead_persona?.text).toBe(readFileSync(join(proj, file), "utf-8"));
        expect(step.context_note).toStartWith("Work this stage as the lead whose persona this step carries. ");
        for (const path of step.inline_context_paths ?? []) {
          expect(path, "a persona file is still listed to read").not.toMatch(/(?:agents|personas)\/aidlc-[a-z-]+-agent\.md$/);
        }
        const limit = limitOf(join(REPO_ROOT, "dist", harness), harnessDir);
        for (const out of printed) expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(limit);
      });
    }

    test(`${harness}: with collaborators on, an inline stage hands over the lead and still lists the supports' personas`, () => {
      const { printed, step, proj } = deliver(harness, harnessDir, "nfr-requirements", true);
      expect(step.kind, step.message).toBe("run-stage");
      expect(step.mode).toBe("inline");
      expect((step.support_agents ?? []).length).toBeGreaterThan(0);
      const file = personaFile(harnessDir, step.lead_agent ?? "", proj);
      expect(step.lead_persona?.text).toBe(readFileSync(join(proj, file), "utf-8"));
      expect(step.inline_context_paths).not.toContain(file);
      for (const support of step.support_agents ?? []) {
        expect(step.inline_context_paths).toContain(personaFile(harnessDir, support, proj));
      }
      const limit = limitOf(join(REPO_ROOT, "dist", harness), harnessDir);
      for (const out of printed) expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(limit);
    });

    test(`${harness}: a dispatched stage carries no persona`, () => {
      const { step } = deliver(harness, harnessDir, "practices-discovery");
      expect(step.kind, step.message).toBe("run-stage");
      expect(step.mode).toBe("subagent");
      expect(step.lead_persona).toBeUndefined();
    });
  }
});

describe("t-lead-persona-in-step: where the step lists the persona as before", () => {
  for (const [harness, harnessDir] of [["claude", ".claude"], ["copilot", ".aidlc"]] as const) {
    test(`${harness}: a persona too large to ride beside its step is listed first to read, and the step still comes`, () => {
      const limit = limitOf(join(REPO_ROOT, "dist", harness), harnessDir);
      let file = "";
      const { printed, step } = deliver(harness, harnessDir, "user-stories", false, (proj) => {
        file = personaFile(harnessDir, "aidlc-product-agent", proj);
        appendFileSync(join(proj, file), `\n## Team practice\n${"Write the story first. ".repeat(Math.ceil(limit / 23))}\n`);
      });
      expect(step.kind, step.message).toBe("run-stage");
      expect(step.lead_persona).toBeUndefined();
      expect(step.inline_context_paths?.[0]).toBe(file);
      expect(step.context_note).toStartWith("Before anything else, read the persona and knowledge files this step lists");
      for (const out of printed) expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(limit);
    });
  }

  test("a gate shown again, whose body does not run, carries no persona and lists the file as before", () => {
    const stage = "requirements-analysis";
    const proj = createOrchestrationTestProject();
    projects.push(proj);
    writeFileSync(seededStateFile(proj), readFileSync(join(FIXTURES_DIR, "state-mid-inception.md"), "utf-8"), "utf-8");
    const dir = join(seededRecordDir(proj), "inception", stage);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "requirements.md"), "# Requirements\n", "utf-8");
    appendAuditEntry("STAGE_STARTED", { Stage: stage }, proj);
    const env = { ...process.env, AIDLC_SKIP_REVIEWER_GATE_GUARD: "1", AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1" };
    const orch = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
    const reported = spawnSync(process.execPath, [orch, "report", "--stage", stage, "--result", "awaiting-approval", "--project-dir", proj], {
      encoding: "utf-8",
      env,
    });
    expect(reported.status, `${reported.stdout}${reported.stderr}`).toBe(0);
    const again = runOrchestrateNext(orch, proj, [], { env }).directive as Step | null;
    expect(again?.kind, JSON.stringify(again)).toBe("run-stage");
    expect(again?.gate_only).toBe(true);
    expect(again?.lead_persona).toBeUndefined();
    expect(again?.inline_context_paths?.[0]).toBe(".claude/agents/aidlc-product-agent.md");
  });
});
