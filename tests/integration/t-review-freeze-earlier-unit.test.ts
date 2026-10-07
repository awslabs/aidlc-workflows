// covers: hook:aidlc-review-freeze, function:reviewFreezeRecoveryGuidance, function:recoveryGuidance
//
// No model (tests/harness/scope-run.ts). A classic run with two Units built
// one at a time, under a team's strict Guard Policy (project.md "Mode:
// strict"). While Unit 2 ("extra") writes its code, the person asks for a
// note in Unit 1's ("core") approved code plan. The review freeze refuses the
// agent's write, and the step it names is core's: doing it again redoes only
// core's Code Generation, the note lands, and extra keeps its work, set aside.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import {
  type AgentStandIn,
  auditEvents,
  cleanupScopeProjects,
  field,
  runScope,
  SCOPE_RUN_TIMEOUT_MS,
} from "../harness/scope-run.ts";

afterAll(cleanupScopeProjects);

const SKIP = [
  "practices-discovery", "user-stories", "refined-mockups", "domain-design", "contract-design",
  "delivery-planning", "infrastructure-design",
];

function lockStrict(proj: string): void {
  const dir = join(proj, "aidlc", "spaces", "default", "memory");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "project.md");
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "# Project\n";
  writeFileSync(path, existing.includes("## Guard Policy\n")
    ? existing.replace("## Guard Policy\n", "## Guard Policy\n\nMode: strict\n")
    : `${existing.trimEnd()}\n\n## Guard Policy\n\nMode: strict\n`, "utf-8");
}

interface Seen {
  refusal: string;
  named: string;
  retried: number | null;
  after: Record<string, unknown> | null;
}

// The person's ask, the agent's write through the real hook, then the step the
// refusal names, run the way the agent runs it once the person says yes.
function editCorePlan(agent: AgentStandIn, seen: Seen): void {
  const host = agent.host;
  const rel = agent.plans.get("core") ?? "";
  expect(rel, "core's code plan").not.toBe("");
  const abs = join(host.proj, rel);
  const content = `${readFileSync(abs, "utf-8")}- [x] Step 3: Note that extra reuses core's parser\n`;
  const write = () =>
    host.hook("review-freeze", { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: abs, content } });
  agent.person.say("Also note in core's code plan that extra reuses core's parser.");
  const refused = write();
  expect(refused.status).toBe(2);
  seen.refusal = refused.stderr;
  const step = /run (\/aidlc --stage (\S+) --unit ([\w-]+))/.exec(refused.stderr);
  seen.named = step?.[1] ?? "";
  if (!step) return;
  agent.person.say("ok, do what you suggested");
  const printed = host.bash(`bun .claude/tools/aidlc-orchestrate.ts next --stage ${step[2]} --unit ${step[3]}`);
  const message = String((JSON.parse(printed.stdout.trim()) as { message?: string }).message ?? "");
  for (const [, command] of message.split("then tell the person")[0].matchAll(/`(bun \.claude\/tools\/[^`]+)`/g)) {
    host.bash(command);
  }
  const retried = write();
  seen.retried = retried.status;
  if (retried.status !== 0) return;
  host.write(rel, content);
  seen.after = JSON.parse(host.bash("bun .claude/tools/aidlc-orchestrate.ts next").stdout.trim()) as Record<string, unknown>;
}

test("a refused edit of an earlier Unit's approved plan names that Unit's redo, and the redo lets it through", () => {
  const seen: Seen = { refusal: "", named: "", retried: null, after: null };
  let done = false;
  let proj = "";
  try {
    proj = runScope("classic", {
      flags: ["--skip", SKIP.join(","), "--guard-policy", "strict", "--review", "adversarial", "--plan-approval", "on"],
      units: ["core", "extra"],
      followRefusals: true,
      afterApproval: (stage, agent) => {
        if (stage === "requirements-analysis") lockStrict(agent.host.proj);
        return undefined;
      },
      onCode: (unit, agent) => {
        proj = agent.host.proj;
        if (unit === "extra" && !done) {
          done = true;
          editCorePlan(agent, seen);
        }
        return [];
      },
    }).proj;
  } catch {
    // The stand-in carries on with extra's build after the probe; the run past
    // this point is not what this case checks.
  }
  expect(done).toBe(true);
  // The step names core, the Unit whose plan was asked for, never extra.
  expect(seen.named, seen.refusal).toBe("/aidlc --stage code-generation --unit core");
  expect(seen.refusal).not.toContain('unit "extra"');
  expect(seen.retried, seen.refusal).toBe(0);
  // The walk goes on with core's redo, and extra's own Code Generation was
  // never sent back: it is set aside, to pick up again by name.
  expect(seen.after, JSON.stringify(seen.after)).toMatchObject({ stage: "code-generation", unit: "core" });
  const rejected = auditEvents(proj).filter((e) => e.event === "GATE_REJECTED" && field(e.block, "Unit") === "extra");
  expect(rejected.map((e) => e.block)).toEqual([]);
}, SCOPE_RUN_TIMEOUT_MS);
