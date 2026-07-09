// scripts/manifest-types.ts — the shared contract every harness/<name>/manifest.ts
// implements, consumed by scripts/package.ts.
//
// A manifest is DATA: how to project the harness-neutral core/ tree into one
// dist/<name>/<harnessDir>/ tree. The only CODE a harness may contribute is an
// optional emit() plugin (codex's config.toml / hooks.json / agent TOMLs /
// skills tree) — structural divergence that no declarative row can express.

import type { OnboardingFills } from "./onboarding.ts";

/** A single core dir projected from core/<src> into <harnessDir>/<dst>. */
export type DirMap = { src: string; dst: string };

/**
 * An authored harness file copied from harness/<name>/<src> into the dist tree.
 * By default <dst> is relative to <harnessDir>/ (e.g. .kiro/skills/aidlc/SKILL.md).
 * Set projectRoot:true to land it at the dist tree ROOT instead, beside the
 * harness dir (e.g. dist/kiro/AGENTS.md) — Kiro/Codex put AGENTS.md there.
 */
export type FileMap = { src: string; dst: string; projectRoot?: boolean };

/**
 * Context handed to a harness emit() plugin. Everything it needs to write
 * per-shell emissions (codex config.toml, hooks.json, agent TOMLs, the
 * .agents/skills tree) without reaching back into the packager internals.
 */
export type EmitContext = {
  /** Absolute path to the repo root. */
  repoRoot: string;
  /** Absolute path to core/ (the harness-neutral source). */
  coreRoot: string;
  /** Absolute path to harness/<name>/ (this harness's authored surfaces). */
  harnessRoot: string;
  /** Absolute path to the dist tree root for this harness (e.g. <repo>/dist/codex). */
  distRoot: string;
  /** The harness directory name (".claude" | ".kiro" | ".codex"). */
  harnessDir: string;
  /** Substitute {{HARNESS_DIR}} → this harness's dir in a prose string. */
  substituteToken: (s: string) => string;
  /**
   * The pack-time tier cap the packager resolved (AIDLC_TIER_CAP env var
   * over the core/memory tier_cap: layers), passed through so emit-owned
   * projections use the SAME cap as every declarative projection - the emit
   * plugin must not re-resolve it.
   */
  tierCap: "judgment" | "balanced" | "templated" | null;
  /** True for a --check run (verify only, write nothing). */
  check: boolean;
};

/** The result of an emit() run: the files it owns, for the orphan scan + --check. */
export type EmitResult = {
  /** Absolute paths the emit plugin wrote (or would write under --check). */
  written: string[];
  /** Problems found under --check (MISSING/DIFFERS/...), empty on a clean run. */
  problems: string[];
};

/**
 * How this harness's onboarding doc (CLAUDE.md / AGENTS.md) is generated from
 * the shared skeleton core/templates/onboarding.md. The packager renders the
 * skeleton with these fills (scripts/onboarding.ts), then applies the standard
 * {{HARNESS_DIR}} transform + rules-rename, and writes it to <dst>. Codex
 * generates its onboarding doc inside emit() instead (it merges a Codex-specific
 * header), so codex leaves this null. A harness that sets neither this nor a
 * harnessFiles CLAUDE.md/AGENTS.md ships no onboarding doc.
 */
export type OnboardingSpec = {
  /** Destination filename, e.g. "CLAUDE.md" or "AGENTS.md". */
  dst: string;
  /** Land at the dist tree root (beside the harness dir) instead of inside it. */
  projectRoot?: boolean;
  /** This harness's slot/invoke fills (imported by the manifest). */
  fills: OnboardingFills;
};

export type HarnessManifest = {
  /** Harness name; matches the dist/<name>/ and harness/<name>/ dir. */
  name: string;
  /** The harness directory the token substitutes to (".claude" | ".kiro" | ".codex"). */
  harnessDir: string;
  /**
   * Which tier-projection flavor this harness's agent surfaces use
   * (core/tools/aidlc-tiers.ts TIER_PROJECTIONS column). Declared here so a
   * new harness picks its projection shape in its manifest - the packager
   * never infers it from the harness name.
   */
  tierFlavor: "claude" | "codex" | "kiro";
  /** core/<src> → <harnessDir>/<dst> projections. */
  coreDirs: DirMap[];
  /** harness/<name>/<src> → <harnessDir>/<dst> authored-file copies. */
  harnessFiles: FileMap[];
  /**
   * Per-file YAML frontmatter lines appended (before the closing `---`) to
   * core-projected .md files - the seam for a harness-NATIVE frontmatter
   * field that must not ship to other harnesses, declared as manifest DATA
   * instead of forking the whole core file. `file` is the harness-relative
   * output path (e.g. "agents/aidlc-composer-agent.md"). The packager errors
   * on an unmatched file (typo guard), a missing frontmatter block, and a
   * key the core file already declares (so core later adding the key is a
   * loud conflict, never a silent double). Example: the Kiro IDE resolves a
   * delegated subagent's tool grants from the agent .md frontmatter
   * (`tools: ["read", "write", "shell"]`), not from the CLI's agent-v1
   * JSON - without the injected line an IDE delegate runs toolless.
   */
  frontmatterAdditions?: Array<{ file: string; lines: string[] }>;
  /**
   * How to render this harness's onboarding doc from core/templates/onboarding.md.
   * null when the harness generates it elsewhere (codex, via emit) or ships none.
   */
  onboarding?: OnboardingSpec | null;
  /** Rename core's rules/ dir to this (kiro: "steering", codex: "aidlc-rules", claude: null). */
  rulesRename: string | null;
  /** Authored files allowed inside generated/copied dirs (skip the orphan scan). */
  authoredExempt: RegExp[];
  /**
   * Skip the packager's standard runner-gen step (write + scopes into
   * <harnessDir>/skills/). Codex sets this: it ships NO skills inside
   * <harnessDir>/skills/ — the whole skill set (orchestrator, stage/scope
   * runners, session skills) is emitted into .agents/skills/ by emit.ts, which
   * composes runner-gen's render fns itself. Graph compile still runs (codex
   * needs the compiled .codex/tools/data/*.json). Claude/Kiro leave this false.
   */
  skipRunnerGen?: boolean;
  /** Optional per-shell emission plugin (codex only today). */
  emit: ((ctx: EmitContext) => EmitResult) | null;
  /**
   * How AIDLC plugins project into THIS harness (the hybrid delivery seam).
   * Optional: when omitted, the packager derives a sensible default from
   * `harnessDir` (manifestDir = "<harnessDir>-plugin", kind = "store"), so a
   * NEW harness added per the one-core-many-harnesses promise automatically
   * gets a plugin projection instead of being silently skipped. A harness with
   * no host plugin store (folder-drop + hook, like Kiro) sets kind "kiro".
   */
  plugin?: {
    /** Host plugin-manifest dir name (".claude-plugin", ".codex-plugin", ".kiro-plugin"). */
    manifestDir: string;
    /** "store" = host plugin store (Claude/Codex); "kiro" = folder-drop + .kiro.hook. */
    kind: "store" | "kiro";
  };
};
