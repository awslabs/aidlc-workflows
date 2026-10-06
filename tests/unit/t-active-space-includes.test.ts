// covers: function:repointHarnessIncludes, function:addRootBlocks
//
// t-active-space-includes — the harness-native rule includes FOLLOW the
// active-space cursor (gap #1, the (A) ambient channel).
//
// WHAT. `repointHarnessIncludes(projectDir, space)` surgically re-points each
// harness's native rule include at `aidlc/spaces/<space>/memory/` — Claude's
// @-import stub, Kiro's agents/*.json `resources` glob, Codex's config.toml
// AIDLC_RULES_DIR. The includes stay COMMITTED (each carries load-bearing engine
// wiring beyond the include); only the pointer SEGMENT is rewritten in place, so
// every other byte — hooks, prompt, model, sandbox, statusline — is preserved.
//
// MECHANISM. Copy the REAL generated dist surface for a harness into a temp tree
// (so we exercise the actual shipped shape, not a stub), set AIDLC_HARNESS_DIR to
// pick that harness's branch, call repointHarnessIncludes, and assert the pointer
// moved while the wiring survived. Zero LLM, fully deterministic.
//
// INVARIANTS asserted:
//   1. Each harness's pointer re-points to the requested space.
//   2. Engine wiring around the pointer is preserved byte-for-byte in spirit
//      (hooks/prompt/model for Kiro; model/sandbox/statusline for Codex; the
//      comment header + @-line count for Claude).
//   3. Re-pointing to the SAME space the file already points at is a NO-OP
//      (empty written[], byte-identical file) — the single-team zero-churn
//      guarantee (a default-cursor user never dirties the committed tree).
//   4. A cursorless call resolves `default` (activeSpace fallback).
//   5. Round-trip default → teamB → default restores the original bytes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { sha256Bytes, unionBlocks } from "../../core/tools/aidlc-distribution.ts";
import { addRootBlocks, repointHarnessIncludes } from "../../core/tools/aidlc-includes.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const distSurface = (h: string, ...parts: string[]): string =>
  join(REPO_ROOT, "dist", h, ...parts);
const portablePaths = (paths: string[]): string[] =>
  paths.map((path) => path.replaceAll("\\", "/"));

const scratch: string[] = [];
const savedHarness = process.env.AIDLC_HARNESS_DIR;
const savedHarnessName = process.env.AIDLC_HARNESS_NAME;

afterEach(() => {
  // AIDLC_HARNESS_DIR is read at call time + cached in lib via _harnessDir; but
  // the env read short-circuits the cache (harnessDir() returns the env value
  // before consulting the cache), so restoring the env is sufficient here.
  if (savedHarness === undefined) delete process.env.AIDLC_HARNESS_DIR;
  else process.env.AIDLC_HARNESS_DIR = savedHarness;
  if (savedHarnessName === undefined) delete process.env.AIDLC_HARNESS_NAME;
  else process.env.AIDLC_HARNESS_NAME = savedHarnessName;
  for (const d of scratch.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function freshRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "t-asi-"));
  scratch.push(d);
  return d;
}

// Lay down the committed default memory tree (so activeSpace + the resolver
// have a default to fall back to) and set the active-space cursor.
function seedSpaces(root: string, cursor?: string): void {
  for (const sp of ["default", "teamB"]) {
    mkdirSync(join(root, "aidlc", "spaces", sp, "memory", "phases"), { recursive: true });
    writeFileSync(join(root, "aidlc", "spaces", sp, "memory", "org.md"), `# org ${sp}\n`);
  }
  if (cursor !== undefined) {
    mkdirSync(join(root, "aidlc"), { recursive: true });
    writeFileSync(join(root, "aidlc", "active-space"), `${cursor}\n`);
  }
}

describe("t-active-space-includes: Claude @-stub", () => {
  beforeEach(() => {
    process.env.AIDLC_HARNESS_DIR = ".claude";
  });

  function setup(): string {
    const root = freshRoot();
    seedSpaces(root);
    mkdirSync(join(root, ".claude", "rules"), { recursive: true });
    cpSync(distSurface("claude", ".claude", "rules", "aidlc.md"), join(root, ".claude", "rules", "aidlc.md"));
    return root;
  }

  test("re-points all @-lines to the requested space; preserves the comment header + line count", () => {
    const root = setup();
    const before = readFileSync(join(root, ".claude", "rules", "aidlc.md"), "utf-8");
    const written = portablePaths(repointHarnessIncludes(root, "teamB"));
    expect(written).toEqual([".claude/rules/aidlc.md"]);
    const after = readFileSync(join(root, ".claude", "rules", "aidlc.md"), "utf-8");
    const atLines = after.split("\n").filter((l) => l.startsWith("@"));
    // All 7 method @-lines re-pointed; none left on default.
    expect(atLines.length).toBe(7);
    expect(atLines.every((l) => l.includes("/teamB/memory/"))).toBe(true);
    expect(atLines.some((l) => l.includes("/default/memory/"))).toBe(false);
    expect(after).toContain("@../../aidlc/spaces/teamB/memory/org.md");
    expect(after).toContain("@../../aidlc/spaces/teamB/memory/phases/operation.md");
    // The comment header (non-@ lines) is preserved — same total line count.
    expect(after.split("\n").length).toBe(before.split("\n").length);
  });

  test("re-pointing to the SAME space already shipped (default) is a byte-identical NO-OP", () => {
    const root = setup();
    const before = readFileSync(join(root, ".claude", "rules", "aidlc.md"), "utf-8");
    const written = repointHarnessIncludes(root, "default");
    expect(written).toEqual([]);
    const after = readFileSync(join(root, ".claude", "rules", "aidlc.md"), "utf-8");
    expect(after).toBe(before);
  });

  test("cursorless call resolves default (no write when already default)", () => {
    const root = setup(); // no cursor seeded
    const written = repointHarnessIncludes(root); // space omitted → activeSpace → default
    expect(written).toEqual([]);
  });

  test("round-trip default → teamB → default restores the original bytes", () => {
    const root = setup();
    const before = readFileSync(join(root, ".claude", "rules", "aidlc.md"), "utf-8");
    repointHarnessIncludes(root, "teamB");
    repointHarnessIncludes(root, "default");
    const after = readFileSync(join(root, ".claude", "rules", "aidlc.md"), "utf-8");
    expect(after).toBe(before);
  });
});

describe("t-active-space-includes: Kiro agents/*.json resources glob", () => {
  beforeEach(() => {
    process.env.AIDLC_HARNESS_DIR = ".kiro";
  });

  function setup(): string {
    const root = freshRoot();
    seedSpaces(root);
    const agentsDst = join(root, ".kiro", "agents");
    mkdirSync(agentsDst, { recursive: true });
    // Copy ALL committed kiro agent JSONs (each carries a memory glob).
    for (const name of ["aidlc.json", "aidlc-developer-agent.json", "aidlc-architect-agent.json", "aidlc-product-lead-agent.json", "aidlc-architecture-reviewer-agent.json"]) {
      cpSync(distSurface("kiro", ".kiro", "agents", name), join(agentsDst, name));
    }
    return root;
  }

  test("re-points the resources glob in every agent JSON; preserves hooks/prompt + other resources", () => {
    const root = setup();
    const written = portablePaths(repointHarnessIncludes(root, "teamB"));
    // All 5 agent JSONs carry a memory glob → all 5 rewritten.
    expect(written.length).toBe(5);
    expect(written.every((p) => p.startsWith(".kiro/agents/") && p.endsWith(".json"))).toBe(true);
    const conductor = JSON.parse(readFileSync(join(root, ".kiro", "agents", "aidlc.json"), "utf-8"));
    expect(conductor.resources).toContain("file://aidlc/spaces/teamB/memory/**/*.md");
    expect(conductor.resources.some((r: string) => r.includes("/default/memory/"))).toBe(false);
    // Other resource entries preserved.
    expect(conductor.resources).toContain("file://AGENTS.md");
    expect(conductor.resources.some((r: string) => r.startsWith("skill://"))).toBe(true);
    // Engine wiring preserved (the load-bearing reason these files stay committed).
    expect(conductor.hooks?.agentSpawn).toBeDefined();
    expect(conductor.hooks?.postToolUse).toBeDefined();
    expect(typeof conductor.prompt).toBe("string");
    expect(conductor.prompt.length).toBeGreaterThan(50);
    // No model pin to preserve — and the rewrite must not resurrect one
    // (#601: Kiro agents inherit the session model).
    expect("model" in conductor).toBe(false);
    expect(conductor.tools).toBeDefined();
  });

  test("re-pointing to default (already shipped) is a NO-OP across all agent JSONs", () => {
    const root = setup();
    const written = repointHarnessIncludes(root, "default");
    expect(written).toEqual([]);
  });

  test("every trusted Kiro worker retains native memory preload when the active space changes", () => {
    const root = setup();
    const conductor = JSON.parse(readFileSync(distSurface("kiro", ".kiro", "agents", "aidlc.json"), "utf8"));
    const trusted = conductor.toolsSettings.subagent.trustedAgents as string[];
    expect(trusted.length).toBeGreaterThan(0);
    const originals = new Map<string, { resources: string[]; [key: string]: unknown }>();
    for (const name of trusted) {
      const source = distSurface("kiro", ".kiro", "agents", `${name}.json`);
      const raw = readFileSync(source, "utf8");
      const config = JSON.parse(raw);
      expect(config.resources.filter((entry: string) =>
        entry === "file://aidlc/spaces/default/memory/**/*.md")).toHaveLength(1);
      originals.set(name, config);
      writeFileSync(join(root, ".kiro", "agents", `${name}.json`), raw);
    }
    mkdirSync(join(root, "aidlc", "spaces", "team-b", "memory"), { recursive: true });
    writeFileSync(join(root, "aidlc", "active-space"), "team-b\n");
    repointHarnessIncludes(root);
    for (const [name, original] of originals) {
      const after = JSON.parse(readFileSync(join(root, ".kiro", "agents", `${name}.json`), "utf8"));
      expect(after).toEqual({
        ...original,
        resources: original.resources.map(entry => entry === "file://aidlc/spaces/default/memory/**/*.md"
          ? "file://aidlc/spaces/team-b/memory/**/*.md" : entry),
      });
      expect(after.resources).toContain("file://aidlc/spaces/team-b/memory/**/*.md");
      expect(after.resources).not.toContain("file://aidlc/spaces/default/memory/**/*.md");
    }
  });

  test("a malformed agent JSON is skipped, never corrupted", () => {
    const root = setup();
    const bad = join(root, ".kiro", "agents", "broken.json");
    writeFileSync(bad, "{ not valid json", "utf-8");
    // Should not throw; broken.json is left untouched; the valid ones still repoint.
    const written = portablePaths(repointHarnessIncludes(root, "teamB"));
    expect(written.some((p) => p.endsWith("broken.json"))).toBe(false);
    expect(readFileSync(bad, "utf-8")).toBe("{ not valid json");
  });
});

describe("t-active-space-includes: Kiro IDE steering follows the active space", () => {
  beforeEach(() => {
    process.env.AIDLC_HARNESS_DIR = ".kiro";
  });

  test("re-points all live memory references in the always-included IDE steering file", () => {
    const root = freshRoot();
    seedSpaces(root);
    const steeringDir = join(root, ".kiro", "steering");
    mkdirSync(steeringDir, { recursive: true });
    const steeringPath = join(steeringDir, "aidlc-active-memory.md");
    cpSync(
      distSurface(
        "kiro-ide",
        ".kiro",
        "steering",
        "aidlc-active-memory.md",
      ),
      steeringPath,
    );
    const written = portablePaths(repointHarnessIncludes(root, "teamB"));
    expect(written).toEqual([".kiro/steering/aidlc-active-memory.md"]);

    const after = readFileSync(steeringPath, "utf-8");
    expect(after).toContain("inclusion: always");
    expect(after).toContain(
      "#[[file:aidlc/spaces/teamB/memory/org.md]]",
    );
    expect(after).toContain(
      "#[[file:aidlc/spaces/teamB/memory/phases/operation.md]]",
    );
    expect(after).not.toContain("aidlc/spaces/default/memory/");
  });

  test("re-pointing the IDE steering file to default is a no-op", () => {
    const root = freshRoot();
    seedSpaces(root);
    const steeringDir = join(root, ".kiro", "steering");
    mkdirSync(steeringDir, { recursive: true });
    const steeringPath = join(steeringDir, "aidlc-active-memory.md");
    cpSync(
      distSurface(
        "kiro-ide",
        ".kiro",
        "steering",
        "aidlc-active-memory.md",
      ),
      steeringPath,
    );
    const before = readFileSync(steeringPath, "utf-8");
    expect(repointHarnessIncludes(root, "default")).toEqual([]);
    expect(readFileSync(steeringPath, "utf-8")).toBe(before);
  });
});

describe("t-active-space-includes: Codex config.toml AIDLC_RULES_DIR", () => {
  beforeEach(() => {
    process.env.AIDLC_HARNESS_DIR = ".codex";
  });

  function setup(): string {
    const root = freshRoot();
    seedSpaces(root);
    mkdirSync(join(root, ".codex"), { recursive: true });
    cpSync(distSurface("codex", ".codex", "config.toml"), join(root, ".codex", "config.toml"));
    return root;
  }

  test("re-points AIDLC_RULES_DIR to the requested space; preserves provider neutrality, sandbox, and statusline", () => {
    const root = setup();
    const before = readFileSync(join(root, ".codex", "config.toml"), "utf-8");
    const written = portablePaths(repointHarnessIncludes(root, "teamB"));
    expect(written).toEqual([".codex/config.toml"]);
    const cfg = readFileSync(join(root, ".codex", "config.toml"), "utf-8");
    expect(cfg).toContain('AIDLC_RULES_DIR = "aidlc/spaces/teamB/memory"');
    expect(cfg).not.toContain('AIDLC_RULES_DIR = "aidlc/spaces/default/memory"');
    expect(cfg).toBe(before.replace(
      'AIDLC_RULES_DIR = "aidlc/spaces/default/memory"',
      'AIDLC_RULES_DIR = "aidlc/spaces/teamB/memory"',
    ));
    // The parser's object return type omits these shipped Codex config fields.
    const parsed = Bun.TOML.parse(cfg) as {
      developer_instructions?: string;
      shell_environment_policy?: { set?: Record<string, string> };
    };
    expect(parsed.shell_environment_policy).toMatchObject({
      set: { AIDLC_RULES_DIR: "aidlc/spaces/teamB/memory" },
    });
    const parsedBefore = Bun.TOML.parse(before) as typeof parsed;
    expect(parsed.developer_instructions).toBe(parsedBefore.developer_instructions);
    // Engine config preserved (the load-bearing reason config.toml stays committed).
    expect(cfg).toContain("Model/provider: intentionally omitted");
    expect(cfg).not.toMatch(/^(?:model|model_provider)\s*=/m);
    expect(cfg).toContain("sandbox_mode");
    expect(cfg).toContain("status_line");
  });

  test("re-pointing to default (already shipped) is a byte-identical NO-OP", () => {
    const root = setup();
    const before = readFileSync(join(root, ".codex", "config.toml"), "utf-8");
    const written = repointHarnessIncludes(root, "default");
    expect(written).toEqual([]);
    expect(readFileSync(join(root, ".codex", "config.toml"), "utf-8")).toBe(before);
  });
});


describe("t-active-space-includes: opencode opencode.json instructions glob", () => {
  beforeEach(() => {
    process.env.AIDLC_HARNESS_DIR = ".aidlc";
    process.env.AIDLC_HARNESS_NAME = "opencode";
  });

  function setup(): string {
    const root = freshRoot();
    seedSpaces(root);
    // The include lives at the PROJECT ROOT (opencode.json), not inside the
    // engine dir - opencode reads it from the workspace root.
    cpSync(distSurface("opencode", "opencode.json"), join(root, "opencode.json"));
    return root;
  }

  test("re-points the instructions glob to the requested space; preserves skills.paths + permissions", () => {
    const root = setup();
    const written = portablePaths(repointHarnessIncludes(root, "teamB"));
    expect(written).toEqual(["opencode.json"]);
    const cfg = JSON.parse(readFileSync(join(root, "opencode.json"), "utf-8")) as {
      instructions: string[];
      skills: { paths: string[] };
      permission: { bash: Record<string, string> };
    };
    expect(cfg.instructions).toContain("aidlc/spaces/teamB/memory/**/*.md");
    expect(cfg.instructions).not.toContain("aidlc/spaces/default/memory/**/*.md");
    // The load-bearing wiring beyond the pointer survives the rewrite.
    expect(cfg.skills.paths).toContain(".aidlc/skills");
    expect(cfg.permission.bash["bun .aidlc/tools/*"]).toBe("allow");
  });

  test("re-pointing to default (already shipped) is a byte-identical NO-OP", () => {
    const root = setup();
    const before = readFileSync(join(root, "opencode.json"), "utf-8");
    const written = repointHarnessIncludes(root, "default");
    expect(written).toEqual([]);
    expect(readFileSync(join(root, "opencode.json"), "utf-8")).toBe(before);
  });

  test("falls back to opencode.jsonc and preserves comments plus trailing commas", () => {
    const root = setup();
    rmSync(join(root, "opencode.json"));
    const before = `{
  // Keep this project note.
  // "instructions": ["aidlc/spaces/default/memory/**/*.md"],
  "instructions": [
    "docs/project.md",
    "aidlc/spaces/default/memory/**/*.md",
  ],
  /* Keep this block comment too. */
  "permission": {
    "bash": {
      "*": "ask",
    },
  },
}
`;
    writeFileSync(join(root, "opencode.jsonc"), before, "utf-8");

    const written = portablePaths(repointHarnessIncludes(root, "teamB"));
    expect(written).toEqual(["opencode.jsonc"]);
    const after = readFileSync(join(root, "opencode.jsonc"), "utf-8");
    expect(after).toBe(
      before.replaceAll(
        "aidlc/spaces/default/memory/**/*.md",
        "aidlc/spaces/teamB/memory/**/*.md",
      ),
    );
  });

  test("re-points both config filenames when both are present", () => {
    const root = setup();
    const jsonc = `{
  "instructions": ["aidlc/spaces/default/memory/**/*.md"],
}
`;
    writeFileSync(join(root, "opencode.jsonc"), jsonc, "utf-8");

    const written = portablePaths(repointHarnessIncludes(root, "teamB"));
    expect(written).toEqual(["opencode.json", "opencode.jsonc"]);
    for (const name of ["opencode.json", "opencode.jsonc"]) {
      const body = readFileSync(join(root, name), "utf-8");
      expect(body).toContain("aidlc/spaces/teamB/memory/**/*.md");
      expect(body).not.toContain("aidlc/spaces/default/memory/**/*.md");
    }
  });

  test("re-points explicit inline and native agent memory references with the config", () => {
    const root = setup();
    const agents: string[] = [];
    const shippedAgents = new Map<string, string>();
    for (const base of [".aidlc", ".opencode"]) {
      const dir = join(root, base, "agents");
      mkdirSync(dir, { recursive: true });
      const agent = join(dir, "aidlc-architect-agent.md");
      cpSync(
        distSurface("opencode", base, "agents", "aidlc-architect-agent.md"),
        agent,
      );
      agents.push(agent);
      shippedAgents.set(agent, readFileSync(agent, "utf-8"));
      const pluginAgent = join(dir, "test-pro-metrics-agent.md");
      writeFileSync(
        pluginAgent,
        "---\nname: test-pro-metrics-agent\nplugin: test-pro\n---\nRead aidlc/spaces/default/memory/org.md\n",
        "utf-8",
      );
      agents.push(pluginAgent);
    }

    expect(repointHarnessIncludes(root, "default")).toEqual([]);
    for (const [agent, before] of shippedAgents) {
      expect(readFileSync(agent, "utf-8")).toBe(before);
    }

    const written = portablePaths(repointHarnessIncludes(root, "teamB"));
    expect(written).toEqual([
      "opencode.json",
      ".aidlc/agents/aidlc-architect-agent.md",
      ".aidlc/agents/test-pro-metrics-agent.md",
      ".opencode/agents/aidlc-architect-agent.md",
      ".opencode/agents/test-pro-metrics-agent.md",
    ]);
    for (const agent of agents) {
      const body = readFileSync(agent, "utf-8");
      expect(body).toContain("aidlc/spaces/teamB/memory/");
      expect(body).not.toContain("aidlc/spaces/default/memory/");
    }
  });

  test("a malformed opencode.json is skipped, never corrupted", () => {
    const root = setup();
    writeFileSync(join(root, "opencode.json"), "{ not json");
    const written = portablePaths(repointHarnessIncludes(root, "teamB"));
    expect(written).toEqual([]);
    expect(readFileSync(join(root, "opencode.json"), "utf-8")).toBe("{ not json");
  });
});

describe("t-active-space-includes: Copilot AGENTS.md and persona rosters", () => {
  beforeEach(() => {
    process.env.AIDLC_HARNESS_DIR = ".aidlc";
    process.env.AIDLC_HARNESS_NAME = "copilot";
  });

  test("re-points core and plugin personas without touching user .github agents", () => {
    const root = freshRoot();
    seedSpaces(root);
    cpSync(distSurface("copilot", "AGENTS.md"), join(root, "AGENTS.md"));

    const shippedAgents = new Map<string, string>();
    for (const base of [".aidlc", ".github"]) {
      const dir = join(root, base, "agents");
      mkdirSync(dir, { recursive: true });
      const agent = join(dir, "aidlc-architect-agent.md");
      cpSync(
        distSurface("copilot", base, "agents", "aidlc-architect-agent.md"),
        agent,
      );
      shippedAgents.set(agent, readFileSync(agent, "utf-8"));
      writeFileSync(
        join(dir, "test-pro-metrics-agent.md"),
        "---\nname: test-pro-metrics-agent\nplugin: test-pro\n---\nRead aidlc/spaces/default/memory/org.md\n",
        "utf-8",
      );
    }
    const userAgent = join(root, ".github", "agents", "release-manager.md");
    writeFileSync(
      userAgent,
      "---\nname: release-manager\n---\nRead aidlc/spaces/default/memory/org.md\n",
      "utf-8",
    );

    expect(repointHarnessIncludes(root, "default")).toEqual([]);
    for (const [agent, before] of shippedAgents) {
      expect(readFileSync(agent, "utf-8")).toBe(before);
    }

    const written = portablePaths(repointHarnessIncludes(root, "teamB"));
    expect(written).toEqual([
      "AGENTS.md",
      ".aidlc/agents/aidlc-architect-agent.md",
      ".aidlc/agents/test-pro-metrics-agent.md",
      ".github/agents/aidlc-architect-agent.md",
      ".github/agents/test-pro-metrics-agent.md",
    ]);
    for (const rel of written) {
      expect(readFileSync(join(root, rel), "utf-8")).toContain("aidlc/spaces/teamB/memory/");
    }
    expect(readFileSync(userAgent, "utf-8")).toContain("aidlc/spaces/default/memory/");
  });
});

describe("t-active-space-includes: Cursor rules + persona bodies", () => {
  beforeEach(() => {
    process.env.AIDLC_HARNESS_DIR = ".cursor";
  });

  function setup(): string {
    const root = freshRoot();
    seedSpaces(root);
    const rulesSrc = distSurface("cursor", ".cursor", "rules");
    const rulesDst = join(root, ".cursor", "rules");
    mkdirSync(rulesDst, { recursive: true });
    for (const name of readdirSync(rulesSrc).filter((file) => file.endsWith(".mdc")).sort()) {
      cpSync(join(rulesSrc, name), join(rulesDst, name));
    }
    mkdirSync(join(root, ".cursor", "agents"), { recursive: true });
    cpSync(
      distSurface("cursor", ".cursor", "agents", "aidlc-architect-agent.md"),
      join(root, ".cursor", "agents", "aidlc-architect-agent.md"),
    );
    return root;
  }

  test("re-points every standing/phase rule and the persona bodies; idempotent at default", () => {
    const root = setup();
    const written = portablePaths(repointHarnessIncludes(root, "teamB"));
    expect(written).toEqual([
      ".cursor/rules/aidlc-phase-construction.mdc",
      ".cursor/rules/aidlc-phase-ideation.mdc",
      ".cursor/rules/aidlc-phase-inception.mdc",
      ".cursor/rules/aidlc-phase-operation.mdc",
      ".cursor/rules/aidlc.mdc",
      ".cursor/agents/aidlc-architect-agent.md",
    ]);
    const ruleNames = readdirSync(join(root, ".cursor", "rules"))
      .filter((file) => file.endsWith(".mdc"))
      .sort();
    expect(ruleNames).toContain("aidlc-onboarding.mdc");
    expect(written).not.toContain(".cursor/rules/aidlc-onboarding.mdc");
    expect(readFileSync(join(root, ".cursor", "rules", "aidlc-onboarding.mdc"), "utf-8"))
      .toContain("aidlc/spaces/<space>/memory/");
    for (const name of ruleNames.filter((file) => file !== "aidlc-onboarding.mdc")) {
      const rule = readFileSync(join(root, ".cursor", "rules", name), "utf-8");
      expect(rule, name).toContain("aidlc/spaces/teamB/memory/");
      expect(rule, name).not.toContain("aidlc/spaces/default/memory/");
    }
    const standing = readFileSync(join(root, ".cursor", "rules", "aidlc.mdc"), "utf-8");
    expect(standing).toContain("aidlc/spaces/teamB/memory/org.md");
    // The rule frontmatter (alwaysApply) survives the re-point untouched.
    expect(standing).toMatch(/^alwaysApply: true$/m);
    const operation = readFileSync(
      join(root, ".cursor", "rules", "aidlc-phase-operation.mdc"),
      "utf-8",
    );
    expect(operation).toContain("aidlc/spaces/teamB/memory/phases/operation.md");
    expect(operation).toMatch(/^alwaysApply: false$/m);
    const agent = readFileSync(join(root, ".cursor", "agents", "aidlc-architect-agent.md"), "utf-8");
    expect(agent).toContain("aidlc/spaces/teamB/memory/");
    expect(agent).not.toContain("aidlc/spaces/default/memory/");
    // Re-pointing back to default restores the committed bytes; a second
    // default re-point is a clean no-op (nothing written).
    repointHarnessIncludes(root, "default");
    expect(repointHarnessIncludes(root, "default")).toEqual([]);
    for (const name of ruleNames) {
      expect(readFileSync(join(root, ".cursor", "rules", name), "utf-8")).toBe(
        readFileSync(distSurface("cursor", ".cursor", "rules", name), "utf-8"),
      );
    }
  });

  test("a missing rules directory is skipped; personas alone still re-point", () => {
    const root = setup();
    rmSync(join(root, ".cursor", "rules"), { recursive: true });
    const written = portablePaths(repointHarnessIncludes(root, "teamB"));
    expect(written).toEqual([".cursor/agents/aidlc-architect-agent.md"]);
  });
});

// A copy runtime leaves the team's .gitignore and AGENTS.md out and ships
// AI-DLC's part of each in the harness folder (root-blocks). Where config never
// ran, the engine adds that part after the team's content, once.
describe("t-active-space-includes: AI-DLC's part of the team's root files", () => {
  const blocks = join(distSurface("copilot", ".aidlc"), "tools", "data", "root-blocks");
  const gitignorePart = (): string =>
    `# BEGIN AI-DLC:gitignore\n${readFileSync(join(blocks, "gitignore"), "utf-8").trim()}\n# END AI-DLC:gitignore\n`;
  const agentsPart = (): string =>
    `<!-- BEGIN AI-DLC:agents -->\n${readFileSync(join(blocks, "agents"), "utf-8").trim()}\n<!-- END AI-DLC:agents -->\n`;
  function copiedProject(): string {
    const root = freshRoot();
    cpSync(distSurface("copilot", ".aidlc"), join(root, ".aidlc"), { recursive: true });
    return root;
  }

  test("keeps the team's .gitignore and AGENTS.md byte for byte and adds AI-DLC's part once", () => {
    const root = copiedProject();
    writeFileSync(join(root, ".gitignore"), "node_modules\n.env.local\n");
    writeFileSync(join(root, "AGENTS.md"), "# Shop\n\nOur own notes for agents.\n");
    expect(addRootBlocks(root).sort()).toEqual([".gitignore", "AGENTS.md"]);
    expect(readFileSync(join(root, ".gitignore"), "utf-8")).toBe(`node_modules\n.env.local\n\n${gitignorePart()}`);
    expect(readFileSync(join(root, "AGENTS.md"), "utf-8")).toBe(`# Shop\n\nOur own notes for agents.\n\n${agentsPart()}`);
    // A second session changes nothing.
    expect(addRootBlocks(root)).toEqual([]);
    expect(readFileSync(join(root, ".gitignore"), "utf-8")).toBe(`node_modules\n.env.local\n\n${gitignorePart()}`);
  });

  test("a project without the files gets only AI-DLC's part", () => {
    const root = copiedProject();
    addRootBlocks(root);
    expect(readFileSync(join(root, ".gitignore"), "utf-8")).toBe(gitignorePart());
    expect(readFileSync(join(root, "AGENTS.md"), "utf-8")).toBe(agentsPart());
  });

  test("an earlier release's unchanged copy keeps its template lines as the team's own", () => {
    const root = copiedProject();
    const template = [
      "# Logs", "logs", "*.log", "npm-debug.log*", "yarn-debug.log*", "yarn-error.log*",
      "pnpm-debug.log*", "lerna-debug.log*", "", "node_modules", "dist", "dist-ssr", "*.local", "",
      "# Editor directories and files", ".vscode/*", "!.vscode/extensions.json", ".idea", ".DS_Store",
      "*.suo", "*.ntvs*", "*.njsproj", "*.sln", "*.sw?",
    ].join("\n");
    const earlier = `${template}\n\n${readFileSync(join(blocks, "gitignore"), "utf-8")}`;
    // The release that shipped it lists it among the files it recognises.
    const descriptorPath = join(root, ".aidlc", "tools", "data", "aidlc-projection.json");
    const descriptor = JSON.parse(readFileSync(descriptorPath, "utf-8"));
    descriptor.rootIntegrations.find((integration: { path: string }) => integration.path === ".gitignore")
      .legacySignatures.wholeFileHashes.push(sha256Bytes(earlier));
    writeFileSync(descriptorPath, `${JSON.stringify(descriptor)}\n`);
    writeFileSync(join(root, ".gitignore"), earlier);
    expect(addRootBlocks(root)).toContain(".gitignore");
    expect(readFileSync(join(root, ".gitignore"), "utf-8")).toBe(`${template}\n\n${gitignorePart()}`);
  });

  // Earlier parts had notes above each group of entries, and two harnesses'
  // parts were combined under a heading per harness. A part with exactly the
  // shipped entries is AI-DLC's own whatever its notes, so it becomes the
  // plain part: one comment line, then every harness's entries.
  test("an earlier part with notes, alone or combined, becomes the plain part", () => {
    const root = copiedProject();
    cpSync(distSurface("kiro", ".kiro"), join(root, ".kiro"), { recursive: true });
    const kiroBlock = readFileSync(join(distSurface("kiro", ".kiro"), "tools", "data", "root-blocks", "gitignore"), "utf-8");
    const plain = unionBlocks([
      { distribution: "copilot", text: readFileSync(join(blocks, "gitignore"), "utf-8") },
      { distribution: "kiro", text: kiroBlock },
    ]);
    const entries = plain.split("\n").filter((line) => !line.startsWith("#"));
    const earlier = [
      "# AI-DLC, the committed and ignored split.",
      "# Per-user cursors are ignored.",
      ...entries.slice(0, 3),
      "#",
      "# Machine-local runtime is ignored.",
      ...entries.slice(3, -2),
      "",
      "# kiro harness",
      ...entries.slice(-2),
    ].join("\n");
    writeFileSync(join(root, ".gitignore"), `node_modules\n\n# BEGIN AI-DLC:gitignore\n${earlier}\n# END AI-DLC:gitignore\n`);
    expect(addRootBlocks(root)).toContain(".gitignore");
    const written = readFileSync(join(root, ".gitignore"), "utf-8");
    expect(written).toBe(`node_modules\n\n# BEGIN AI-DLC:gitignore\n${plain}\n# END AI-DLC:gitignore\n`);
    expect(written).toContain("aidlc/.aidlc-turn-counter");
    expect(written.split("\n").filter((line) => line.startsWith("#") && !/^# (BEGIN|END) AI-DLC:/.test(line)))
      .toEqual(["# AI-DLC: local working files"]);
  });

  test("a part the team changed, and a project config manages, are left as they are", () => {
    const changed = copiedProject();
    const edited = gitignorePart().replace("# END AI-DLC:gitignore", "our-own-line\n# END AI-DLC:gitignore");
    writeFileSync(join(changed, ".gitignore"), edited);
    writeFileSync(join(changed, "AGENTS.md"), "# Shop\n");
    expect(addRootBlocks(changed)).toEqual(["AGENTS.md"]);
    expect(readFileSync(join(changed, ".gitignore"), "utf-8")).toBe(edited);

    const configured = copiedProject();
    writeFileSync(join(configured, ".aidlc", "tools", "data", "aidlc-manifest.json"), "{}\n");
    writeFileSync(join(configured, ".gitignore"), "node_modules\n");
    expect(addRootBlocks(configured)).toEqual([]);
    expect(readFileSync(join(configured, ".gitignore"), "utf-8")).toBe("node_modules\n");
    expect(readdirSync(configured)).not.toContain("AGENTS.md");
  });

  test("files the Cursor installer manages are left to it", () => {
    const root = copiedProject();
    const installed = "node_modules\n\n# BEGIN AIDLC CURSOR\naidlc/active-space\n# END AIDLC CURSOR\n";
    writeFileSync(join(root, ".gitignore"), installed);
    writeFileSync(join(root, "AGENTS.md"), "<!-- BEGIN AIDLC CURSOR -->\n# AI-DLC\n<!-- END AIDLC CURSOR -->\n");
    expect(addRootBlocks(root)).toEqual([]);
    expect(readFileSync(join(root, ".gitignore"), "utf-8")).toBe(installed);
  });

  test("nothing outside the project is read or written, whatever the harness folder declares", () => {
    const root = copiedProject();
    const outside = freshRoot();
    const descriptorPath = join(root, ".aidlc", "tools", "data", "aidlc-projection.json");
    const descriptor = JSON.parse(readFileSync(descriptorPath, "utf-8"));
    const escaping = `../${basename(outside)}/escaped`;
    descriptor.rootIntegrations.push(
      { path: escaping, policy: "managed-block", marker: "escape" },
      { path: "linked/AGENTS.md", policy: "managed-block", marker: "linked" },
      { path: "notes.md", policy: "managed-block", marker: "../../../outside" },
    );
    writeFileSync(descriptorPath, `${JSON.stringify(descriptor)}\n`);
    for (const marker of ["escape", "linked"]) {
      writeFileSync(join(root, ".aidlc", "tools", "data", "root-blocks", marker), "export EVIL=1\n");
    }
    symlinkSync(outside, join(root, "linked"), "dir");
    // The team's AGENTS.md is a link to a file outside: it is not written through.
    writeFileSync(join(outside, "AGENTS.md"), "# elsewhere\n");
    symlinkSync(join(outside, "AGENTS.md"), join(root, "AGENTS.md"));
    expect(addRootBlocks(root)).toEqual([".gitignore"]);
    expect(existsSync(join(outside, "escaped"))).toBe(false);
    expect(readdirSync(outside).sort()).toEqual(["AGENTS.md"]);
    expect(readFileSync(join(outside, "AGENTS.md"), "utf-8")).toBe("# elsewhere\n");
    expect(existsSync(join(root, "notes.md"))).toBe(false);
  });

  test("a part written at session start names the person's active space", () => {
    const root = copiedProject();
    mkdirSync(join(root, "aidlc", "spaces", "team-b", "memory", "phases"), { recursive: true });
    writeFileSync(join(root, "aidlc", "spaces", "team-b", "memory", "org.md"), "# org team-b\n");
    writeFileSync(join(root, "aidlc", "active-space"), "team-b\n");
    const started = spawnSync(process.execPath, [join(root, ".aidlc", "hooks", "aidlc-session-start.ts")], {
      cwd: root,
      input: "{}",
      encoding: "utf-8",
      env: { ...process.env, AIDLC_HARNESS_DIR: ".aidlc", AIDLC_HARNESS_NAME: "copilot" },
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(started.status, `${started.stdout}${started.stderr}`).toBe(0);
    const agents = readFileSync(join(root, "AGENTS.md"), "utf-8");
    expect(agents).toContain("<!-- BEGIN AI-DLC:agents -->");
    expect(agents).toContain("@aidlc/spaces/team-b/memory/org.md");
    expect(agents).not.toContain("@aidlc/spaces/default/memory/");
  });
});
