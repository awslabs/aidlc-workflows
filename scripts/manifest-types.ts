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
  /** Manifest harness name used by native adapter routes. */
  harnessName: string;
  /** Absolute path to the dist tree root for this harness (e.g. <repo>/dist/codex). */
  distRoot: string;
  /** The harness directory name (".claude" | ".kiro" | ".codex"). */
  harnessDir: string;
  /** Route-table-derived namespace trusted by native host permission surfaces. */
  trustedRouteNamespace: string;
  /** Substitute {{HARNESS_DIR}} → this harness's dir in a prose string. */
  substituteToken: (s: string) => string;
  /**
   * The pack-time tier cap the packager resolved (AIDLC_TIER_CAP env var
   * over the core/memory tier_cap: layers), passed through so emit-owned
   * projections use the SAME cap as every declarative projection - the emit
   * plugin must not re-resolve it.
   */
  tierCap: "judgment" | "balanced" | "templated" | null;
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

export type RootIntegration = {
  /** Project-root path emitted by this distribution. */
  path: string;
  /** Merge policy used by `aidlc config`; never inferred from the filename. */
  policy: "managed-block" | "json-map" | "json-array" | "whole-file";
  /** Stable marker identity for managed-block integrations. */
  marker?: string;
  /** Top-level object key merged for json-map integrations. */
  jsonKey?: string;
  /** Optional integrations may be omitted by an init mode such as --mcp none. */
  optional?: boolean;
  /**
   * Exact historical signatures that `aidlc config` may adopt as framework-owned.
   * Unknown or locally modified legacy content remains project-owned or conflicts.
   */
  legacySignatures?: {
    /** SHA-256 hashes of exact unmarked files safe to wrap or replace. */
    wholeFileHashes?: string[];
    /** Canonical JSON value hashes, keyed by entry below jsonKey. */
    jsonEntryHashes?: Record<string, string[]>;
  };
};

export type NativeRootIntegration = RootIntegration & (
  | {
      /** Authored file below harness/<name>/ copied into each native projection. */
      src: string;
      content?: never;
    }
  | {
      /** Harness-formatted generated content supplied directly to the native projection. */
      content: string;
      src?: never;
    }
);

export type HarnessManifest = {
  /** Harness name; matches the dist/<name>/ and harness/<name>/ dir. */
  name: string;
  /** User-facing product name used by lifecycle output. */
  productName: string;
  /** Exact host action printed after `aidlc config` completes. */
  configNextStep: string;
  /** The harness directory the token substitutes to (".claude" | ".kiro" | ".codex" | ".aidlc" | ".cursor"). */
  harnessDir: string;
  /** Explicit project-root reconciliation policies consumed by `aidlc config`. */
  rootIntegrations: RootIntegration[];
  /** Native-invocation-only project-root integrations such as host trust seeds. */
  nativeRootIntegrations?: NativeRootIntegration[];
  /**
   * Project-root-relative path to the emitted orchestrator SKILL.md. Defaults
   * to <harnessDir>/skills/aidlc/SKILL.md; emit-owned harnesses that place
   * skills elsewhere declare their emitted location explicitly (for example
   * Codex under .agents/skills/).
   */
  orchestratorSkillPath?: string;
  /**
   * Which tier-projection flavor this harness's agent surfaces use
   * (core/tools/aidlc-tiers.ts TIER_PROJECTIONS column). Declared here so a
   * new harness picks its projection shape in its manifest - the packager
   * never infers it from the harness name.
   */
  tierFlavor: "claude" | "codex" | "kiro" | "opencode" | "copilot" | "cursor";
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
   * Harness-native YAML fields appended to every generated stage/scope runner
   * skill. The packager persists these in tools/data/harness.json so runner
   * regeneration during plugin composition applies the same host contract.
   */
  runnerFrontmatterAdditions?: string[];
  /**
   * How to render this harness's onboarding doc from core/templates/onboarding.md.
   * null when the harness generates it elsewhere (codex, via emit) or ships none.
   */
  onboarding?: OnboardingSpec | null;
  /** Rename core's rules/ dir to this (kiro: "steering", codex: "aidlc-rules", claude: null). */
  rulesRename: string | null;
  /**
   * DocumentKB text extractors, keyed by MIME type, emitted into
   * <harnessDir>/tools/data/harness.json. ABSENT by default in every harness —
   * with no entry the tool probes `pdftotext` on PATH and degrades to
   * `extractor_unavailable`, so this is an override, never a requirement.
   *
   * It has to be PACKAGER-owned rather than hand-edited: writeHarnessData()
   * builds a FRESH object, so a hand-added field is erased on the next build.
   * A team needs its extractor choice authored in the repository so it reaches
   * every generated release, which rules out the runtime-written path too —
   * that one targets a different, install-local file.
   *
   * `argv` is an array, never a shell string: the value becomes a process
   * invocation, and `$IN` is the only substitution.
   */
  documentExtractors?: Record<string, { argv: string[]; timeoutMs?: number }> | null;
  /**
   * Skip the packager's standard runner-gen step (write + scopes into
   * <harnessDir>/skills/). Codex sets this: it ships NO skills inside
   * <harnessDir>/skills/ — the whole skill set (orchestrator, stage/scope
   * runners, session skills) is emitted into .agents/skills/ by emit.ts, which
   * composes runner-gen's render fns itself. Graph compile still runs (codex
   * needs the compiled .codex/tools/data/*.json). Claude/Kiro leave this false.
   */
  skipRunnerGen?: boolean;
  /**
   * Optional per-shell emission plugin (codex only today). It always writes
   * into ctx.distRoot; under --check the packager invokes it in two independent
   * temporary roots and compares the complete generated trees.
   */
  emit: ((ctx: EmitContext) => void) | null;
  /**
   * How AIDLC plugins project into THIS harness (the hybrid delivery seam).
   * Optional: when omitted, the packager derives a sensible default from
   * `harnessDir` (manifestDir = "<harnessDir>-plugin", kind = "store"), so a
   * NEW harness added per the one-core-many-harnesses promise automatically
   * gets a plugin projection instead of being silently skipped. A harness with
   * no host plugin store uses a folder-drop projection: Kiro CLI sets kind
   * "kiro" and relies on the explicit composer, while Kiro IDE sets kind
   * "kiro-ide" for its v2 SessionStart registration. Cursor sets kind "cursor"
   * for its flat camelCase hook schema.
   */
  plugin?: {
    /** Host plugin-manifest dir name (for example ".claude-plugin" or ".cursor-plugin"). */
    manifestDir: string;
    /** Host-specific plugin hook projection shape. */
    kind: "store" | "kiro" | "kiro-ide" | "cursor";
    /**
     * Additional project-root surfaces emitted outside harnessDir that compose
     * must copy into a disposable plugin-test candidate.
     */
    installRoots?: string[];
  };
};
