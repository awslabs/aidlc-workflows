// covers: file:aidlc-common/protocols/stage-protocol-reviewer.md, file:aidlc-common/protocols/stage-protocol-swarm.md
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const TREES = [
  ["dist/codex", ".codex"],
  ["dist-release/codex", ".codex"],
] as const;

const TOOLS = ["Claude Code", "Kiro CLI", "Kiro IDE", "Codex CLI", "Cursor", "opencode", "GitHub Copilot"];

function section(text: string, own: string): string {
  const from = text.indexOf(`### ${own}\n`);
  if (from === -1) return "";
  const rest = text.slice(from + 1).search(/\n#{2,3} /);
  return (rest === -1 ? text.slice(from) : text.slice(from, from + 1 + rest)).trimEnd();
}

describe("Codex role spawns pass fork_turns", () => {
  for (const [tree, dir] of TREES) {
    const read = (module: string) =>
      readFileSync(join(REPO_ROOT, tree, dir, "aidlc-common", "protocols", module), "utf8");

    test(`${tree}: the reviewer dispatch names the role with a fresh spawn, not a full-history fork`, () => {
      const reviewer = section(read("stage-protocol-reviewer.md"), "Codex CLI");
      expect(reviewer).toContain("`spawn_agent`");
      expect(reviewer).toContain("`agent_type`");
      expect(reviewer).toContain('`fork_turns: "none"`');
      expect(reviewer).toContain("Full-history forked agents inherit the parent agent type");
      expect(reviewer).not.toContain('`fork_turns: "all"`');
    });

    test(`${tree}: the reviewer stays a fresh, independent role`, () => {
      const reviewer = section(read("stage-protocol-reviewer.md"), "Codex CLI");
      expect(reviewer).toContain("`directive.reviewer`");
      expect(reviewer).toContain(".codex/agents/aidlc-<role>-agent.toml");
      expect(reviewer).toContain("`developer_instructions`");
      expect(reviewer).toContain("the brief carries paths and never the parent's conversation");
    });

    test(`${tree}: the swarm fan-out spawns each worker with a fresh spawn too`, () => {
      const swarm = section(read("stage-protocol-swarm.md"), "Codex CLI");
      const fanOut = swarm.slice(swarm.indexOf("**Fan out via `spawn_agent`**"), swarm.indexOf("(3) "));
      expect(fanOut).toContain("`aidlc-developer-agent`");
      expect(fanOut).toContain("`agent_type`");
      expect(fanOut).toContain('`fork_turns: "none"`');
      expect(fanOut).not.toContain('`fork_turns: "all"`');
    });
  }

  test("fork_turns is a Codex parameter, so no other binding names it", () => {
    for (const module of ["stage-protocol-reviewer.md", "stage-protocol-swarm.md"]) {
      const core = readFileSync(
        join(REPO_ROOT, "core", "aidlc-common", "protocols", module),
        "utf8",
      );
      for (const tool of TOOLS.filter((name) => name !== "Codex CLI")) {
        expect(section(core, tool), `${module}: ${tool}`).not.toContain("fork_turns");
      }
      expect(section(core, "Codex CLI")).toContain("fork_turns");
    }
  });
});
