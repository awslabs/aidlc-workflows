// covers: function:composeDispatchDirective
//
// Row 142 of the live-run audit: on Kiro CLI the composer's first helper call
// failed on screen, "The tool input does not match the tool schema: missing
// field `stages`", then the agent retried and the plan came. Seen in five runs
// (live-ux k-lx10, k-lx12, k-lx12b, k-lx45, harness-proof J0). The person reads
// a tool error for something they did not do.
//
// The engine's own dispatch print said only "Dispatch the composer agent ... as
// a subagent", so the step now names the call on the Kiro CLI install, where
// the refusal was seen. Every other install, the shared kiro-ide one included,
// is told no tool: Kiro IDE and Kiro CLI v3 both run that tree and take
// different tools, and their skill already says to use the one the agent's own
// tool list has.
//
// Mechanism = the real `next` on a packaged tree, no model.

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestProject, createTestProject, REPO_ROOT } from "../harness/fixtures.ts";

const HARNESS_DIR: Record<string, string> = {
  kiro: ".kiro",
  "kiro-ide": ".kiro",
  claude: ".claude",
};

const projects: string[] = [];
afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
});

/** A packaged install of one harness, as a configured project leaves it. */
function copiedProject(harness: string): string {
  const root = join(REPO_ROOT, "dist", harness);
  const proj = createTestProject();
  projects.push(proj);
  cpSync(join(root, HARNESS_DIR[harness]), join(proj, HARNESS_DIR[harness]), { recursive: true });
  cpSync(join(root, "aidlc"), join(proj, "aidlc"), { recursive: true });
  return proj;
}

/** The composer-dispatch print for a request no ready-made plan fits. */
async function composeDispatch(harness: string): Promise<string> {
  const proj = copiedProject(harness);
  const engine = join(proj, HARNESS_DIR[harness], "tools", "aidlc-orchestrate.ts");
  const run = async (argv: string[]): Promise<string> => {
    const child = Bun.spawn([process.execPath, engine, ...argv], {
      cwd: proj,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, `${argv.join(" ")}: ${stderr}`).toBe(0);
    return stdout;
  };
  const offer = JSON.parse(
    await run(["next", "Build a tiny tool for counting late invoices by region"]),
  ) as { ask_type?: string; compose_command?: string };
  expect(offer.ask_type).toBe("compose-offer");
  const request = (offer.compose_command ?? "").split("--request ")[1]?.trim() ?? "";
  expect(request).toMatch(/^[0-9a-f]{8}$/);
  const print = JSON.parse(await run(["next", "compose", "--request", request])) as {
    kind?: string;
    message?: string;
  };
  expect(print.kind).toBe("print");
  return print.message ?? "";
}

describe("the composer dispatch names the call this install takes", () => {
  // Live on Kiro CLI 2.23.1, two runs of the compose offer: one was clean and one
  // still failed its first call on screen, now "missing field `task`" (the agent
  // sent mode and stages and left task out). And Kiro names the tool `subagent`
  // there, not `orchestrate_subagent`. So the step names the tool as Kiro names
  // it and says both fields are needed, not just the one that was missing first.
  test("Kiro CLI gets the subagent call, and both required fields", async () => {
    const message = await composeDispatch("kiro");
    expect(message).toContain("the subagent tool is `subagent`");
    expect(message).not.toContain("`orchestrate_subagent`");
    expect(message).toContain(
      '{mode:"blocking", task:"<this message>", stages:[{name:"compose", role:"aidlc-composer-agent", prompt_template:"<this message>"}]}',
    );
    expect(message).toContain("needs both `task` and `stages`, each filled");
    expect(message).toContain("a call missing either one is refused by the tool");
  });

  // Kiro IDE and Kiro CLI v3 share the kiro-ide install and take different
  // tools (`invoke_sub_agent` there, `orchestrate_subagent` with a stages array
  // on v3, captured in t218 on kiro-cli 2.24.0), so naming either one would
  // tell the other the wrong tool at its first composer call.
  test("the shared Kiro IDE install is told no tool, as before", async () => {
    const message = await composeDispatch("kiro-ide");
    expect(message).toContain("Dispatch the composer agent");
    expect(message).not.toContain("subagent tool is");
    expect(message).not.toContain("invoke_sub_agent");
    expect(message).not.toContain("orchestrate_subagent");
    expect(message).not.toContain("stages:[");
  });

  test("a harness that dispatches a named agent is unchanged", async () => {
    const message = await composeDispatch("claude");
    expect(message).toContain("Dispatch the composer agent");
    expect(message).not.toContain("subagent tool is");
    expect(message).not.toContain("stages:[");
  });
});
