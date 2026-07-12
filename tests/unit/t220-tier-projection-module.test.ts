// covers: file:tools/aidlc-tiers.ts (tier projection + cap module)
//
// t220 - the tier projection module (core/tools/aidlc-tiers.ts): table-driven
// projectTier coverage for every tier x every projection flavor, cap collapse behavior,
// the unknown-tier error path, the tier_cap precedence chain (env var beats
// space memory; project.md beats team.md beats org.md), and the Kiro collapse
// rule (tiers sharing a model -> the higher tier's effort wins the cli.json
// chat.modelDefaults entry).
//
// Mechanism: none. Pure functions plus a temp-dir fixture for the memory-layer
// reader. No process boundary, no LLM, zero tokens. The expected projection
// values are HARD-CODED here independently of TIER_PROJECTIONS, so this test
// pins the shipped policy (what each tier means on each harness) rather than
// echoing the table; a deliberate retune must edit both, which is the point.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";
import {
  capTier,
  isTier,
  kiroModelDefaults,
  KIRO_TIER_EFFORT,
  projectTier,
  readEnvCap,
  readMemoryCap,
  resolveTierCap,
  type Tier,
  TIER_PROJECTIONS,
  TIERS,
} from "../../core/tools/aidlc-tiers.ts";

// ---------------------------------------------------------------------------
// The policy pin: every tier x every projection flavor, expected values hard-coded.
// null = the harness-native key is OMITTED (the inherit-by-omission contract).
// ---------------------------------------------------------------------------
const EXPECTED: Record<
  Tier,
  {
    claude: { model: string; effort: "medium" | null };
    codex: { model: string | null; effort: "medium" | null };
    kiro: { model: string | null };
    opencode: { model: string | null; variant: "medium" | null };
  }
> = {
  judgment: {
    claude: { model: "inherit", effort: null },
    codex: { model: null, effort: null },
    kiro: { model: null },
    opencode: { model: null, variant: null },
  },
  balanced: {
    claude: { model: "sonnet", effort: null },
    codex: { model: "openai.gpt-5.4", effort: null },
    kiro: { model: "claude-sonnet-4.5" },
    opencode: { model: "amazon-bedrock/global.anthropic.claude-sonnet-4-6", variant: null },
  },
  templated: {
    claude: { model: "sonnet", effort: "medium" },
    codex: { model: "openai.gpt-5.4", effort: "medium" },
    kiro: { model: "claude-sonnet-4.5" },
    opencode: { model: "amazon-bedrock/global.anthropic.claude-sonnet-4-6", variant: "medium" },
  },
};

// A memory-layer fixture: a temp dir holding org/team/project files whose
// frontmatter carries the given tier_cap: values (null = no frontmatter).
function memoryFixture(caps: {
  org?: string | null;
  team?: string | null;
  project?: string | null;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "t220-memory-"));
  const entries: Array<[string, string | null | undefined]> = [
    ["org.md", caps.org],
    ["team.md", caps.team],
    ["project.md", caps.project],
  ];
  for (const [file, cap] of entries) {
    if (cap === undefined) continue; // file absent entirely
    const fm = cap === null ? "" : `---\ntier_cap: ${cap}\n---\n\n`;
    writeFileSync(join(dir, file), `${fm}# ${file}\n\nBody prose.\n`);
  }
  return dir;
}

describe("t220 tier projection module", () => {
  // --- the vocabulary itself -------------------------------------------------
  test("TIERS is exactly the frozen vocabulary, ordered high to low", () => {
    expect([...TIERS]).toEqual(["judgment", "balanced", "templated"]);
  });

  test("isTier accepts the vocabulary and rejects everything else", () => {
    for (const t of TIERS) expect(isTier(t)).toBe(true);
    for (const bad of ["opus", "sonnet", "high", "", "Judgment"]) {
      expect(isTier(bad), `isTier(${JSON.stringify(bad)})`).toBe(false);
    }
  });

  // --- projectTier: every tier x every projection flavor ---------------------
  for (const tier of TIERS) {
    for (const flavor of ["claude", "codex", "kiro", "opencode"] as const) {
      test(`projectTier(${tier}, ${flavor}) matches the pinned policy`, () => {
        expect(projectTier(tier, flavor)).toEqual(EXPECTED[tier][flavor]);
      });
    }
  }

  test("projectTier throws loudly on an unknown tier", () => {
    expect(() => projectTier("opus", "claude")).toThrow(/unknown tier "opus"/);
    expect(() => projectTier("", "kiro")).toThrow(/unknown tier/);
  });

  // --- cap collapse ----------------------------------------------------------
  test("capTier clamps down, never up", () => {
    expect(capTier("judgment", "balanced")).toBe("balanced");
    expect(capTier("judgment", "templated")).toBe("templated");
    expect(capTier("balanced", "templated")).toBe("templated");
    // A cap ABOVE the tier is a no-op (caps are ceilings, not floors).
    expect(capTier("templated", "judgment")).toBe("templated");
    expect(capTier("balanced", "judgment")).toBe("balanced");
    // No cap = identity.
    expect(capTier("judgment", null)).toBe("judgment");
    expect(capTier("judgment", undefined)).toBe("judgment");
  });

  test("projectTier applies the cap before projecting", () => {
    expect(projectTier("judgment", "claude", "balanced")).toEqual(EXPECTED.balanced.claude);
    expect(projectTier("judgment", "codex", "templated")).toEqual(EXPECTED.templated.codex);
    expect(projectTier("balanced", "kiro", "templated")).toEqual(EXPECTED.templated.kiro);
  });

  // --- env cap ---------------------------------------------------------------
  test("readEnvCap: unset/empty -> null, valid -> tier, invalid -> loud error", () => {
    expect(readEnvCap({} as NodeJS.ProcessEnv)).toBeNull();
    expect(readEnvCap({ AIDLC_TIER_CAP: "" } as NodeJS.ProcessEnv)).toBeNull();
    expect(readEnvCap({ AIDLC_TIER_CAP: "balanced" } as NodeJS.ProcessEnv)).toBe("balanced");
    expect(() => readEnvCap({ AIDLC_TIER_CAP: "opus" } as NodeJS.ProcessEnv)).toThrow(
      /not a valid tier/,
    );
  });

  // --- memory cap: the layered last-writer-wins chain ------------------------
  test("readMemoryCap: absent dir/files/frontmatter -> null", () => {
    expect(readMemoryCap(join(tmpdir(), "t220-no-such-dir"))).toBeNull();
    const dir = memoryFixture({ org: null, team: null, project: null });
    try {
      expect(readMemoryCap(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readMemoryCap: org.md alone sets the cap", () => {
    const dir = memoryFixture({ org: "balanced" });
    try {
      expect(readMemoryCap(dir)).toBe("balanced");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readMemoryCap: project.md overrides org.md - lower OR raise", () => {
    // Lowering: org says balanced, project tightens to templated.
    const lower = memoryFixture({ org: "balanced", project: "templated" });
    // Raising: org says templated, project relaxes back to judgment.
    const raise = memoryFixture({ org: "templated", project: "judgment" });
    try {
      expect(readMemoryCap(lower)).toBe("templated");
      expect(readMemoryCap(raise)).toBe("judgment");
    } finally {
      rmSync(lower, { recursive: true, force: true });
      rmSync(raise, { recursive: true, force: true });
    }
  });

  test("readMemoryCap: team.md sits between org.md and project.md", () => {
    const dir = memoryFixture({ org: "judgment", team: "templated", project: null });
    try {
      expect(readMemoryCap(dir)).toBe("templated");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readMemoryCap: an invalid tier_cap value is a loud error naming the file", () => {
    const dir = memoryFixture({ org: "opus" });
    try {
      expect(() => readMemoryCap(dir)).toThrow(/org\.md.*not a valid tier/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readMemoryCap: tolerates quoted values and trailing comments; empty value throws", () => {
    // Common YAML scalar spellings a user will reasonably write.
    const quoted = memoryFixture({ org: '"balanced"' });
    const commented = memoryFixture({ org: "templated # workshop budget" });
    // A PRESENT key with an empty value means the user believes a cap is
    // active - silently ignoring it would ship uncapped without an error.
    const empty = memoryFixture({ org: "" });
    try {
      expect(readMemoryCap(quoted)).toBe("balanced");
      expect(readMemoryCap(commented)).toBe("templated");
      expect(() => readMemoryCap(empty)).toThrow(/org\.md.*not a valid tier/);
    } finally {
      for (const d of [quoted, commented, empty]) rmSync(d, { recursive: true, force: true });
    }
  });

  // --- full precedence: env beats memory --------------------------------------
  test("resolveTierCap: the env var beats the memory layers", () => {
    const dir = memoryFixture({ org: "balanced", project: "balanced" });
    try {
      expect(
        resolveTierCap(dir, { AIDLC_TIER_CAP: "templated" } as NodeJS.ProcessEnv),
      ).toBe("templated");
      // No env var -> the memory cap applies.
      expect(resolveTierCap(dir, {} as NodeJS.ProcessEnv)).toBe("balanced");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resolveTierCap: nothing set anywhere -> null (authored tiers ship)", () => {
    const dir = memoryFixture({});
    try {
      expect(resolveTierCap(dir, {} as NodeJS.ProcessEnv)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- the Kiro collapse rule -------------------------------------------------
  test("kiroModelDefaults: one entry per distinct pinned model, higher tier's effort wins", () => {
    // balanced and templated share claude-sonnet-4.5; balanced (higher) wins
    // with "high". judgment pins no model, so it contributes no entry.
    expect(kiroModelDefaults()).toEqual({ "claude-sonnet-4.5": "high" });
  });

  test("kiroModelDefaults: a templated cap collapses everything onto templated's effort", () => {
    // Under a templated cap every tier projects as templated, so the single
    // shared model entry carries templated's effort.
    expect(kiroModelDefaults("templated")).toEqual({ "claude-sonnet-4.5": "medium" });
  });

  test("KIRO_TIER_EFFORT deliberately omits judgment (no pinned model to ride on)", () => {
    expect(KIRO_TIER_EFFORT.judgment).toBeUndefined();
    expect(KIRO_TIER_EFFORT.balanced).toBe("high");
    expect(KIRO_TIER_EFFORT.templated).toBe("medium");
  });

  // --- structural invariant: the kiro slot can never carry an effort ----------
  test("TIER_PROJECTIONS kiro slots are model-only (no effort key can leak to agent JSON)", () => {
    for (const tier of TIERS) {
      expect(Object.keys(TIER_PROJECTIONS[tier].kiro)).toEqual(["model"]);
    }
  });
});

// ---------------------------------------------------------------------------
// SHIPPED-BYTES pins for the non-Claude projection writers. t216 pins the
// dist/claude .md output; package --check pins dist-vs-source parity but says
// nothing about whether the projection itself is RIGHT. These read the
// committed dist trees for one representative agent per tier and assert the
// projected keys - so a writer bug (e.g. the Codex TOML emitting an effort
// for a judgment agent) fails here even when the dist was faithfully
// regenerated from the broken writer.
// ---------------------------------------------------------------------------
describe("t220 shipped projection bytes (codex TOML, kiro JSON + md)", () => {
  const dist = (...p: string[]): string => join(REPO_ROOT, "dist", ...p);

  test("codex TOMLs: judgment omits model+effort, balanced pins model only, templated pins both", () => {
    const arch = readFileSync(dist("codex", ".codex", "agents", "aidlc-architect-agent.toml"), "utf-8");
    expect(/^model\s*=/m.test(arch), "judgment TOML must omit model").toBe(false);
    expect(/^model_reasoning_effort\s*=/m.test(arch), "judgment TOML must omit effort").toBe(false);
    const lead = readFileSync(dist("codex", ".codex", "agents", "aidlc-product-lead-agent.toml"), "utf-8");
    expect(lead).toContain('model = "openai.gpt-5.4"');
    expect(/^model_reasoning_effort\s*=/m.test(lead), "balanced TOML must omit effort").toBe(false);
    const delivery = readFileSync(dist("codex", ".codex", "agents", "aidlc-delivery-agent.toml"), "utf-8");
    expect(delivery).toContain('model = "openai.gpt-5.4"');
    expect(delivery).toContain('model_reasoning_effort = "medium"');
  });

  // The five delegation-target agents shipped as Kiro JSONs, per tier.
  const KIRO_JSON: Array<{ file: string; model: string | null }> = [
    { file: "aidlc-architect-agent.json", model: null }, // judgment
    { file: "aidlc-composer-agent.json", model: null }, // judgment
    { file: "aidlc-developer-agent.json", model: null }, // judgment
    { file: "aidlc-product-lead-agent.json", model: "claude-sonnet-4.5" }, // balanced
    { file: "aidlc-architecture-reviewer-agent.json", model: "claude-sonnet-4.5" }, // balanced
  ];

  const kiroHarnesses = HARNESS_MATRIX.filter(
    (harness) => harness.capabilities.kiroAgentJson,
  );
  test("matrix exposes at least one kiroAgentJson harness (floor guard)", () => {
    expect(kiroHarnesses.length).toBeGreaterThan(0);
  });
  for (const harness of kiroHarnesses) {
    test(`${harness.name} agent JSONs: judgment omits "model", balanced pins sonnet-4.5, NO effort-like keys anywhere`, () => {
      for (const { file, model } of KIRO_JSON) {
        const parsed = JSON.parse(
          readFileSync(join(harness.engineRoot, "agents", file), "utf-8"),
        ) as Record<string, unknown>;
        if (model === null) {
          expect("model" in parsed, `${harness.name}/${file}: judgment must omit "model"`).toBe(
            false,
          );
        } else {
          expect(parsed.model, `${harness.name}/${file}: model`).toBe(model);
        }
        // kiro-cli fail-closes on unknown agent-JSON fields: any effort-like
        // key would break agent validation at install.
        for (const key of Object.keys(parsed)) {
          expect(
            /effort|reasoning|thinking/i.test(key),
            `${harness.name}/${file}: forbidden inference key "${key}"`,
          ).toBe(false);
        }
      }
    });
  }

  test("Kiro-family agent .md frontmatter projects model and never effort", () => {
    const fmOf = (raw: string): string => {
      const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!m) throw new Error("no frontmatter");
      return m[1];
    };
    for (const harness of kiroHarnesses) {
      const arch = fmOf(
        readFileSync(join(harness.engineRoot, "agents", "aidlc-architect-agent.md"), "utf-8"),
      );
      expect(/^model:/m.test(arch), `${harness.name}: judgment must omit model:`).toBe(false);
      const delivery = fmOf(
        readFileSync(join(harness.engineRoot, "agents", "aidlc-delivery-agent.md"), "utf-8"),
      );
      expect(delivery).toMatch(/^model: claude-sonnet-4\.5$/m);
      for (const fm of [arch, delivery]) {
        expect(/^effort:/m.test(fm), `${harness.name}: .md must never carry effort:`).toBe(false);
      }
    }
  });

  test("kiro-ide cli.json carries the same tier-projected modelDefaults as kiro's (t148 pins kiro)", () => {
    const s = JSON.parse(
      readFileSync(dist("kiro-ide", ".kiro", "settings", "cli.json"), "utf-8"),
    ) as Record<string, Record<string, { output_config?: { effort?: string } }>>;
    const defaults = s["chat.modelDefaults"];
    expect(defaults?.["claude-opus-4.8"]?.output_config?.effort).toBe("xhigh");
    expect(defaults?.["claude-sonnet-4.5"]?.output_config?.effort).toBe("high");
  });

  // Full-roster completeness: raw `tier:` must never leak into ANY shipped
  // agent surface on ANY harness. t216 pins this for dist/claude only; a
  // tier-line-removal bug in the judgment path (where no replacement keys are
  // written) would surface on the kiro/codex .md copies first - e.g. a future
  // agent authored with tier: mid-frontmatter instead of last.
  for (const harness of HARNESS_MATRIX) {
    test(`${harness.name}: no shipped agent .md carries a raw tier: line (all 14)`, () => {
      const dir = join(harness.engineRoot, "agents");
      const mds = readdirSync(dir).filter((f) => f.endsWith("-agent.md"));
      expect(mds.length).toBe(14);
      for (const f of mds) {
        const raw = readFileSync(join(dir, f), "utf-8");
        expect(
          /^tier:/m.test(raw),
          `${harness.name}/${f}: raw tier: leaked into dist`,
        ).toBe(false);
      }
    });
  }

  test("opencode-shell: the emitted .opencode/agents subagent twins carry the projection too", () => {
    const dir = dist("opencode", ".opencode", "agents");
    const mds = readdirSync(dir).filter((f) => f.endsWith("-agent.md"));
    expect(mds.length).toBe(14);
    for (const f of mds) {
      const raw = readFileSync(join(dir, f), "utf-8");
      expect(/^tier:/m.test(raw), `opencode-shell/${f}: raw tier: leaked into dist`).toBe(false);
    }
  });

  test("codex: no shipped agent TOML carries a tier key (all 14)", () => {
    const dir = dist("codex", ".codex", "agents");
    const tomls = readdirSync(dir).filter((f) => f.endsWith(".toml"));
    expect(tomls.length).toBe(14);
    for (const f of tomls) {
      const raw = readFileSync(join(dir, f), "utf-8");
      expect(/^tier\s*=/m.test(raw), `codex/${f}: tier key leaked into TOML`).toBe(false);
    }
  });

  test("AIDLC_TIER_CAP is IGNORED under --check (drift guard is env-independent)", () => {
    // A stray env cap in a CI or test runner's environment must neither fail
    // nor mask drift: --check compares what the committed dist was built
    // from. The packager prints an ignore notice instead. (~10s: a real
    // single-harness check run - the pin is the exit code, not the notice.)
    const r = Bun.spawnSync(
      ["bun", join(REPO_ROOT, "scripts", "package.ts"), "claude", "--check"],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, AIDLC_TIER_CAP: "templated" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stderr = r.stderr.toString();
    expect(r.exitCode, `--check failed under env cap:\n${stderr}`).toBe(0);
    expect(stderr).toContain("IGNORED under --check");
  }, 60_000);
});
