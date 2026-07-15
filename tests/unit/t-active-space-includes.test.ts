// covers: function:repointHarnessIncludes
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
// MECHANISM. Copy the REAL committed dist surface for a harness into a temp tree
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
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repointHarnessIncludes } from "../../core/tools/aidlc-includes.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const distSurface = (h: string, ...parts: string[]): string =>
  join(REPO_ROOT, "dist", h, ...parts);

const scratch: string[] = [];
const savedHarness = process.env.AIDLC_HARNESS_DIR;

afterEach(() => {
  // AIDLC_HARNESS_DIR is read at call time + cached in lib via _harnessDir; but
  // the env read short-circuits the cache (harnessDir() returns the env value
  // before consulting the cache), so restoring the env is sufficient here.
  if (savedHarness === undefined) delete process.env.AIDLC_HARNESS_DIR;
  else process.env.AIDLC_HARNESS_DIR = savedHarness;
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
    const written = repointHarnessIncludes(root, "teamB");
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

  test("re-points the resources glob in every agent JSON; preserves hooks/prompt/model + other resources", () => {
    const root = setup();
    const written = repointHarnessIncludes(root, "teamB");
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
    expect(conductor.model).toBeDefined();
    expect(conductor.tools).toBeDefined();
  });

  test("re-pointing to default (already shipped) is a NO-OP across all agent JSONs", () => {
    const root = setup();
    const written = repointHarnessIncludes(root, "default");
    expect(written).toEqual([]);
  });

  test("a malformed agent JSON is skipped, never corrupted", () => {
    const root = setup();
    const bad = join(root, ".kiro", "agents", "broken.json");
    writeFileSync(bad, "{ not valid json", "utf-8");
    // Should not throw; broken.json is left untouched; the valid ones still repoint.
    const written = repointHarnessIncludes(root, "teamB");
    expect(written.some((p) => p.endsWith("broken.json"))).toBe(false);
    expect(readFileSync(bad, "utf-8")).toBe("{ not valid json");
  });
});

describe("t-active-space-includes: Kiro IDE resources follow the active space", () => {
  beforeEach(() => {
    process.env.AIDLC_HARNESS_DIR = ".kiro";
  });

  test("re-points every IDE agent JSON memory glob while preserving the remaining config", () => {
    const root = freshRoot();
    seedSpaces(root);
    const agentsSrc = distSurface("kiro-ide", ".kiro", "agents");
    const agentsDst = join(root, ".kiro", "agents");
    mkdirSync(agentsDst, { recursive: true });
    const agentFiles = readdirSync(agentsSrc).filter((name) => name.endsWith(".json")).sort();
    for (const name of agentFiles) cpSync(join(agentsSrc, name), join(agentsDst, name));

    const conductorPath = join(agentsDst, "aidlc.json");
    const before = JSON.parse(readFileSync(conductorPath, "utf-8")) as {
      resources: string[];
      [key: string]: unknown;
    };
    const written = repointHarnessIncludes(root, "teamB");
    expect(written).toHaveLength(agentFiles.length);

    const after = JSON.parse(readFileSync(conductorPath, "utf-8")) as {
      resources: string[];
      [key: string]: unknown;
    };
    expect(after.resources).toContain("file://aidlc/spaces/teamB/memory/**/*.md");
    expect(after.resources.some((resource) => resource.includes("/default/memory/"))).toBe(false);
    expect({ ...after, resources: before.resources }).toEqual(before);
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

  test("re-points AIDLC_RULES_DIR to the requested space; preserves model/sandbox/statusline", () => {
    const root = setup();
    const written = repointHarnessIncludes(root, "teamB");
    expect(written).toEqual([".codex/config.toml"]);
    const cfg = readFileSync(join(root, ".codex", "config.toml"), "utf-8");
    expect(cfg).toContain('AIDLC_RULES_DIR = "aidlc/spaces/teamB/memory"');
    expect(cfg).not.toContain('AIDLC_RULES_DIR = "aidlc/spaces/default/memory"');
    // Engine config preserved (the load-bearing reason config.toml stays committed).
    expect(cfg).toContain("model_provider");
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
    const written = repointHarnessIncludes(root, "teamB");
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

    const written = repointHarnessIncludes(root, "teamB");
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

    const written = repointHarnessIncludes(root, "teamB");
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
    for (const base of [".aidlc", ".opencode"]) {
      const dir = join(root, base, "agents");
      mkdirSync(dir, { recursive: true });
      const agent = join(dir, "aidlc-architect-agent.md");
      cpSync(
        distSurface("opencode", base, "agents", "aidlc-architect-agent.md"),
        agent,
      );
      agents.push(agent);
    }

    const written = repointHarnessIncludes(root, "teamB");
    expect(written).toEqual([
      "opencode.json",
      ".aidlc/agents/aidlc-architect-agent.md",
      ".opencode/agents/aidlc-architect-agent.md",
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
    const written = repointHarnessIncludes(root, "teamB");
    expect(written).toEqual([]);
    expect(readFileSync(join(root, "opencode.json"), "utf-8")).toBe("{ not json");
  });
});
