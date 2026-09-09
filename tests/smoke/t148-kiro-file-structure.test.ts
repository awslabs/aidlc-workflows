// t148-kiro-file-structure: structural smoke for the dist/kiro harness tree.
//
// covers: file:settings/cli.json, file:settings/mcp.json, file:agents/aidlc.md
//
// Mirrors t01's pattern for the Kiro shell: the SHIPPED dist/kiro tree has the
// right shape - core dirs present and populated, authored shell files present,
// the conductor's Markdown frontmatter carrying the load-bearing fields (a
// match-scoped shell grant rather than blanket trust; delegation trust; the
// resources a custom agent does not get for free), the engine pin and default
// agent in settings/cli.json, and hook registration living in manifests that all
// route through this row's adapter. Pure fs reads except the one doctor case.
//
// This file used to assert the agent-v1 JSON shape: an agents/aidlc.json
// conductor, persona JSONs, and hooks registered inside them. That row merged
// into this one, which is Markdown with standalone hook manifests, so the cases
// were rewritten rather than dropped - the properties they pinned (no blanket
// shell trust, no nested delegation, every registration reaching the adapter, no
// model pin) all still matter, just on a different surface.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HARNESS_MATRIX,
  manifestGrantsIdeAgentTools,
} from "../harness/harness-matrix.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const KIRO = join(REPO_ROOT, "dist", "kiro");
const K = join(KIRO, ".kiro");

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
}

function frontmatter(p: string): string {
  const raw = readFileSync(p, "utf-8");
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) throw new Error(`${p}: no frontmatter`);
  return m[1];
}

/** Agent files a routed stage delegates to (everything but the conductor). */
function personaAgents(): string[] {
  return readdirSync(join(K, "agents"))
    .filter((f) => f.endsWith("-agent.md"))
    .sort();
}

describe("t148 dist/kiro file structure", () => {
  test("core dirs exist and are populated", () => {
    for (const [dir, min] of [
      ["tools", 20],
      ["aidlc-common/stages", 5],
      ["knowledge", 5],
      ["sensors", 4],
      ["scopes", 9],
      ["agents", 11],
      ["hooks", 10],
    ] as Array<[string, number]>) {
      const p = join(K, dir);
      expect(existsSync(p)).toBe(true);
      expect(readdirSync(p).length).toBeGreaterThanOrEqual(min);
    }
  });

  test("ships the method ('memory') tree at the workspace root aidlc/spaces/default/memory/", () => {
    // The AIDLC method relocated OUT of the harness dir to the workspace root
    // under aidlc/spaces/default/memory/ - one hand-editable source of truth,
    // identical on every harness. Kiro reads it two ways and needs both, because
    // a custom agent inherits neither: the conductor's `resources` globs and the
    // always-included steering file. It sits beside .kiro/, so resolve from KIRO.
    const mem = (...parts: string[]) =>
      join(KIRO, "aidlc", "spaces", "default", "memory", ...parts);
    for (const f of ["org.md", "team.md", "project.md"]) {
      expect(existsSync(mem(f))).toBe(true);
    }
    for (const p of ["ideation", "inception", "construction", "operation"]) {
      expect(existsSync(mem("phases", `${p}.md`))).toBe(true);
    }
    // steering/ ships, because it carries the active-memory pointer - but it must
    // hold ONLY that pointer, not the retired in-harness rule layers.
    expect(readdirSync(join(K, "steering")).sort()).toEqual([
      "aidlc-active-memory.md",
    ]);
  });

  test("authored shell files present", () => {
    for (const f of [
      "skills/aidlc/SKILL.md",
      "skills/aidlc/question-rendering.md",
      "hooks/aidlc-kiro-adapter.ts",
      "agents/aidlc.md",
      "agents/aidlc-developer-agent.md",
      "agents/aidlc-architect-agent.md",
      "steering/aidlc-active-memory.md",
      "settings/cli.json",
      "settings/mcp.json",
    ]) {
      expect(existsSync(join(K, f))).toBe(true);
    }
    expect(existsSync(join(KIRO, "AGENTS.md"))).toBe(true);
    // Neither half of the agent-v1 generation may come back alongside this one.
    expect(readdirSync(join(K, "agents")).filter((f) => f.endsWith(".json")))
      .toEqual([]);
    // The pre-1.0 wiring generation is retired except for one file: it is the only
    // channel an unsupported Kiro IDE 0.x reads, and it does not fire on a
    // supported one, so it carries the "please upgrade" notice and nothing else.
    expect(readdirSync(join(K, "hooks")).filter((f) => f.endsWith(".kiro.hook")).sort())
      .toEqual(["aidlc-legacy-ide-notice.kiro.hook"]);
  });

  test("ships always-included active-memory steering", () => {
    const path = join(K, "steering", "aidlc-active-memory.md");
    const steering = readFileSync(path, "utf-8");
    expect(steering).toMatch(/^---\ninclusion: always\n---/);
    for (const file of [
      "org.md",
      "team.md",
      "project.md",
      "phases/ideation.md",
      "phases/inception.md",
      "phases/construction.md",
      "phases/operation.md",
    ]) {
      expect(steering).toContain(
        `#[[file:aidlc/spaces/default/memory/${file}]]`,
      );
    }
  });

  test("conductor: match-scoped shell grant, never blanket trust (findings 0.9b)", () => {
    const fm = frontmatter(join(K, "agents", "aidlc.md"));
    expect(fm).toContain("capability: shell");
    expect(fm).toContain("bun .kiro/tools/aidlc-*");
    // The tool glob cannot cover the dispatcher: `aidlc-*` needs a literal `-`,
    // and `aidlc.ts` is the only command the orchestrator skill issues.
    expect(fm).toContain("bun .kiro/tools/aidlc.ts engine *");
    expect(fm).toContain("date -u *");
    // And the denials that bound it.
    expect(fm).toContain("rm -rf *");
    expect(fm).toContain("git push *");
    // A rule with an effect but no match list would be blanket trust.
    for (const rule of fm.split(/^ {4}- capability:/m).slice(1)) {
      expect(rule, `rule needs an effect: ${rule}`).toMatch(/effect: (allow|deny|ask)/);
      expect(rule, `rule needs a match list: ${rule}`).toContain("match:");
    }
  });

  test("conductor carries the layers a custom agent does not auto-load", () => {
    const fm = frontmatter(join(K, "agents", "aidlc.md"));
    for (const resource of [
      "file://.kiro/steering/**/*.md",
      "skill://.kiro/skills/*/SKILL.md",
      "file://aidlc/spaces/default/memory/**/*.md",
      "file://AGENTS.md",
    ]) {
      expect(fm, `conductor resources must name ${resource}`).toContain(resource);
    }
    // Delegation trust: every persona a routed stage can dispatch to. An unlisted
    // one stalls the workflow on an approval prompt the conductor cannot answer.
    expect(fm).toContain("trustedAgents:");
    for (const agent of personaAgents().map((f) => f.replace(/\.md$/, ""))) {
      expect(fm, `trustedAgents must name ${agent}`).toContain(`"${agent}"`);
    }
  });

  test("delegation targets cannot nest (no subagent tool)", () => {
    // The conductor delegates; a persona must not. Nested delegation would let a
    // stage spawn work the engine never routed.
    expect(frontmatter(join(K, "agents", "aidlc.md"))).toContain("subagent");
    for (const f of personaAgents()) {
      expect(
        frontmatter(join(K, "agents", f)),
        `${f} must not grant the subagent tool`,
      ).not.toContain("subagent");
    }
  });

  test("IDE-agent capability ignores unrelated frontmatter additions", () => {
    expect(
      manifestGrantsIdeAgentTools({
        harnessFiles: [],
        frontmatterAdditions: [
          { file: "agents/aidlc-example-agent.md", lines: ["badge: example"] },
          { file: "skills/aidlc/SKILL.md", lines: [`tools: ["read"]`] },
        ],
      }),
    ).toBe(false);
    expect(
      manifestGrantsIdeAgentTools({
        harnessFiles: [],
        frontmatterAdditions: [
          { file: "agents/aidlc-example-agent.md", lines: [`tools: ["read"]`] },
        ],
      }),
    ).toBe(true);
  });

  test("no shipped Kiro agent surface pins a model (#601: agents inherit the session model)", () => {
    for (const f of readdirSync(join(K, "agents")).filter((n) => n.endsWith(".md"))) {
      const fm = frontmatter(join(K, "agents", f));
      expect(/^model:/m.test(fm), `${f}: model pin leaked (#601)`).toBe(false);
      expect(/^effort:/m.test(fm), `${f}: effort key leaked`).toBe(false);
    }
  });

  test("the Kiro agent Markdown omits the Claude-only disallowedTools key", () => {
    // Kiro fails closed on an unknown agent field, so a key only Claude
    // understands must not reach this projection.
    for (const f of readdirSync(join(K, "agents")).filter((n) => n.endsWith(".md"))) {
      expect(
        frontmatter(join(K, "agents", f)),
        `${f}: disallowedTools is Claude-only`,
      ).not.toContain("disallowedTools");
    }
  });

  test("every hook registration routes through this row's adapter", () => {
    const hooksDir = join(K, "hooks");
    const manifests = readdirSync(hooksDir).filter((f) => f.endsWith(".json"));
    expect(manifests.length).toBeGreaterThan(0);
    let registrations = 0;
    for (const name of manifests) {
      const parsed = readJson(join(hooksDir, name)) as unknown as {
        version?: string;
        hooks?: Array<{ trigger?: string; action?: { type?: string; command?: string } }>;
      };
      expect(parsed.version, name).toBe("v1");
      expect(Array.isArray(parsed.hooks), name).toBe(true);
      for (const hook of parsed.hooks ?? []) {
        registrations++;
        expect(hook.action?.type, name).toBe("command");
        const command = hook.action?.command ?? "";
        // Always THIS row's name: a stranger harness name dispatches into an
        // adapter with no handler, and a PreToolUse gate then fails OPEN.
        expect(command, `${name}: ${command}`).toContain("engine adapter kiro ");
        expect(command, `${name}: no other harness name`).not.toMatch(
          /engine adapter (?!kiro )/,
        );
      }
    }
    expect(registrations).toBeGreaterThanOrEqual(manifests.length);
  });

  test("workspace activation ships the engine pin and the default agent", () => {
    const settings = readJson(join(K, "settings", "cli.json"));
    // The engine pin is what lets a plain `kiro-cli` reach the agent runtime this
    // row targets, with no flag at the call site.
    expect(settings["chat.agentEngine"]).toBe("v3");
    expect(settings["chat.defaultAgent"]).toBe("aidlc");
  });

  test("workspace pins per-model efforts via chat.modelDefaults (authored conditional entries only)", () => {
    // The shipped cli.json carries ONLY the authored orchestrator entry
    // (claude-opus-4.8 -> xhigh): a CONDITIONAL per-model effort default that
    // applies only when the session actually runs that model. No agent surface
    // pins a model (#601), and no tier pins a Kiro model, so no tier-derived
    // entry ships. Pin the whole map so neither the authored default nor a
    // resurrected projection pin can regress.
    const settings = readJson(join(K, "settings", "cli.json"));
    const defaults = settings["chat.modelDefaults"] as Record<
      string,
      { output_config?: { effort?: string } }
    >;
    expect(defaults?.["claude-opus-4.8"]?.output_config?.effort).toBe("xhigh");
    expect(Object.keys(defaults ?? {}).sort()).toEqual(["claude-opus-4.8"]);
  });

  test("doctor accepts the shipped shape", () => {
    const r = spawnSync(
      "bun",
      [join(K, "tools", "aidlc.ts"), "doctor", "--project-dir", KIRO, "--verbose"],
      { cwd: KIRO, encoding: "utf-8" },
    );
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    expect(out, out.slice(-400)).toContain("agents/aidlc.md present (conductor wiring)");
    expect(out).toContain(
      "settings/cli.json present (engine pin + default-agent activation)",
    );
    expect(out).toMatch(/\b0 problems\b/);
  });

  test("kiro skills carry the kiro tool prefix, never the claude one", () => {
    const skill = readFileSync(join(K, "skills", "aidlc", "SKILL.md"), "utf-8");
    expect(skill).toContain("bun .kiro/tools/");
    expect(skill).not.toContain("bun .claude/tools/");
    expect(skill).not.toContain("AskUserQuestion");
  });

  test("the matrix agrees this row's agents are capability-bearing Markdown", () => {
    const kiro = HARNESS_MATRIX.find((harness) => harness.name === "kiro");
    expect(kiro).toBeDefined();
    expect(kiro?.capabilities.ideAgentTools).toBe(true);
    expect(kiro?.capabilities.reviewerScopeRegistration).toBe("kiro-manifest");
  });
});
