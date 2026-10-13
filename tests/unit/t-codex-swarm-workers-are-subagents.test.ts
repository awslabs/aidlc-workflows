// A side-by-side build on Codex starts its workers as Codex subagents of the session, as every other harness
// does. A `codex exec` worker started from the agent's shell runs inside the workspace-write sandbox, where Codex's
// own home is read-only, so under approvals "never" it cannot start at all and under "on request" each one asks.
// A subagent inherits the session's sandbox and approval policy and runs without either.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const TREES = ["dist/codex", "dist-release/codex"];
const read = (tree: string, path: string) => readFileSync(join(REPO_ROOT, tree, path), "utf8");

describe("Codex side-by-side workers are subagents", () => {
  for (const tree of TREES) {
    test(`${tree}: the swarm fan-out spawns one developer subagent per Unit, in its own worktree`, () => {
      const swarm = read(tree, ".codex/aidlc-common/protocols/stage-protocol-swarm.md");
      const codex = swarm.slice(swarm.indexOf("### Codex CLI"));
      const fanOut = codex.slice(codex.indexOf("(2) **Fan out"), codex.indexOf("(3) "));
      expect(fanOut).toContain("`spawn_agent`");
      expect(fanOut).toContain("`aidlc-developer-agent`");
      expect(fanOut).toContain("worktree path");
      expect(codex).not.toContain("codex exec");
    });

    test(`${tree}: the skill, onboarding and config name no exec workers`, () => {
      const skill = read(tree, ".agents/skills/aidlc/SKILL.md");
      const swarmRow = skill.split("\n").find((line) => line.includes("**Swarm floor"));
      expect(swarmRow).toBeDefined();
      expect(swarmRow).toContain("`spawn_agent`");
      expect(swarmRow).not.toContain("codex exec");
      expect(skill).not.toContain("exec workers");
      expect(read(tree, ".codex/onboarding.md")).not.toContain("codex exec");
      expect(read(tree, ".codex/config.toml")).not.toContain("codex exec workers");
    });
  }
});
