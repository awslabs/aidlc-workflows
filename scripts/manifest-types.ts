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
  /** The harness directory the token substitutes to (".claude" | ".kiro" | ".codex" | ".aidlc"). */
  harnessDir: string;
  /**
   * Which tier-projection flavor this harness's agent surfaces use
   * (core/tools/aidlc-tiers.ts TIER_PROJECTIONS column). Declared here so a
   * new harness picks its projection shape in its manifest - the packager
   * never infers it from the harness name.
   */
  tierFlavor: "claude" | "codex" | "kiro" | "opencode";
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
   *
   * A block spanning multiple YAML lines is supported: the FIRST line names
   * the key (validated + collision-checked), and any following indented
   * continuation lines (leading whitespace) ride along untouched. This lets a
   * nested mapping/sequence ship as one addition, e.g. the Kiro IDE 1.0
   * `permissions.rules` block:
   *   lines: ["permissions:", "  rules:", "    - capability: shell", ...].
   */
  frontmatterAdditions?: Array<{ file: string; lines: string[] }>;
  /**
   * Per-file YAML frontmatter KEYS removed from a core-projected .md's
   * frontmatter - the inverse seam of frontmatterAdditions, for expressing the
   * ABSENCE of a harness-neutral field in one harness without forking the core
   * file. `file` is the harness-relative output path; `keys` are top-level
   * frontmatter keys to drop (with their indented continuation lines). Example:
   * the Kiro IDE ignores the CLI's `disallowedTools` field, so its distributions
   * remove it rather than shipping dead frontmatter. The packager errors on an
   * unmatched file (typo guard), a missing frontmatter block, and a key the core
   * file does not declare (so a stale removal that no longer matches core is a
   * loud no-op, never a silent miss).
   */
  frontmatterRemovals?: Array<{ file: string; keys: string[] }>;
  /**
   * How to render this harness's onboarding doc from core/templates/onboarding.md.
   * null when the harness generates it elsewhere (codex, via emit) or ships none.
   */
  onboarding?: OnboardingSpec | null;
  /** Rename core's rules/ dir to this (kiro: "steering", codex: "aidlc-rules", claude: null). */
  rulesRename: string | null;
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
   * into ctx.distRoot; under --check the packager supplies a temporary root and
   * compares the complete generated tree with the committed distribution.
   */
  emit: ((ctx: EmitContext) => void) | null;
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

// --- The frontmatter transformation seam -------------------------------
//
// These two pure functions implement the frontmatterAdditions /
// frontmatterRemovals rows declared above. They live here, beside the contract
// they serve, so the transformation is unit-testable: scripts/package.ts runs
// its build at import time, so a test cannot reach into it for a function.
// Both are string-in/string-out and throw rather than emit questionable YAML.
// Append manifest-declared frontmatter lines to a projected .md, just before
// the closing `---` of its YAML block (manifest-types.ts frontmatterAdditions).
// Hard errors, never silent: the file must open with a frontmatter block, and
// no added line's key may already exist in it - if core later grows the same
// key, the build fails loudly instead of shipping a double. A multi-line block is
// supported: a line with NO leading whitespace opens a new key (validated +
// collision-checked); an indented continuation line (a nested mapping/sequence
// entry) rides along unchecked.
export function applyFrontmatterAdditions(
  content: string,
  lines: string[],
  file: string,
): string {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n(---\r?\n)/);
  if (!m) {
    throw new Error(
      `frontmatterAdditions: ${file} has no leading frontmatter block to extend.`,
    );
  }
  const fm = m[1];
  // Keys this addition block itself declares — a duplicate WITHIN the block is
  // as invalid as one colliding with core, and silently ships a YAML mapping
  // with a repeated key (last writer wins, or a parser error).
  const added = new Set<string>();
  for (const line of lines) {
    // Indented lines continue the preceding key's block (nested mapping /
    // sequence); only top-level lines name a key to validate.
    if (/^\s/.test(line)) continue;
    const key = line.split(":")[0]?.trim();
    if (!key || !/^[A-Za-z_][\w-]*$/.test(key)) {
      throw new Error(
        `frontmatterAdditions: line "${line}" for ${file} does not start with a YAML key.`,
      );
    }
    if (added.has(key)) {
      throw new Error(
        `frontmatterAdditions: ${file} declares "${key}:" twice in the same addition block - ` +
          `emit one mapping per key.`,
      );
    }
    added.add(key);
    if (new RegExp(`^${key}:`, "m").test(fm)) {
      throw new Error(
        `frontmatterAdditions: ${file} already declares "${key}:" in core - ` +
          `resolve the collision instead of shipping a duplicate key.`,
      );
    }
  }
  const insertAt = m[0].length - m[2].length;
  return `${content.slice(0, insertAt)}${lines.join("\n")}\n${content.slice(insertAt)}`;
}

// Remove manifest-declared frontmatter keys from a projected .md's YAML block
// (manifest-types.ts frontmatterRemovals) - the inverse of the additions seam,
// for a harness-neutral field a given harness must ship WITHOUT. A removed key
// drops its line plus any indented continuation lines (nested block). Hard
// errors, never silent: the file must open with a frontmatter block, and each
// named key must currently exist - a stale removal that no longer matches core
// fails loudly instead of silently no-opping.
export function applyFrontmatterRemovals(
  content: string,
  keys: string[],
  file: string,
): string {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n(---\r?\n)/);
  if (!m) {
    throw new Error(
      `frontmatterRemovals: ${file} has no leading frontmatter block to trim.`,
    );
  }
  const fmLines = m[1].split(/\r?\n/);
  const keySet = new Set(keys);
  const seen = new Set<string>();
  const kept: string[] = [];
  let dropping = false;
  // Only a real top-level MAPPING KEY ends the block being dropped. A blank line
  // or a full-line `#` comment is neither: treating those as terminators leaves
  // the rest of the removed key's block behind as orphaned indented lines, which
  // is invalid YAML (a mapping value with no key).
  const TOP_LEVEL_KEY = /^([A-Za-z_][\w.-]*)\s*:/;
  for (const line of fmLines) {
    const indented = /^\s/.test(line);
    const blankOrComment = line.trim() === "" || line.trimStart().startsWith("#");
    const keyMatch = indented ? null : TOP_LEVEL_KEY.exec(line);
    if (keyMatch) {
      // A top-level key ends any block being dropped and decides this line.
      dropping = keySet.has(keyMatch[1]);
      if (dropping) {
        seen.add(keyMatch[1]);
        continue;
      }
    } else if (dropping && (indented || blankOrComment)) {
      // Still inside the removed key's block: its indented values, and the blank
      // lines / comments interleaved among them, all go with it.
      continue;
    } else if (!indented && !blankOrComment) {
      // A non-indented line that is not a mapping key (e.g. a list item at
      // column 0, or a stray scalar). Fail closed rather than guess whether it
      // belongs to the block being dropped.
      throw new Error(
        `frontmatterRemovals: ${file} frontmatter line is neither a top-level key ` +
          `nor an indented continuation: ${JSON.stringify(line)}`,
      );
    }
    kept.push(line);
  }
  const missed = keys.filter((k) => !seen.has(k));
  if (missed.length > 0) {
    throw new Error(
      `frontmatterRemovals: ${file} does not declare key(s) [${missed.join(", ")}] in core - ` +
        `remove the stale entry from the manifest.`,
    );
  }
  // Fail closed on a trailing orphan: if the last kept line is still an indented
  // continuation of a removed key, the output would be invalid YAML.
  const orphan = kept.findIndex((line, i) => {
    if (!/^\s/.test(line)) return false;
    for (let j = i - 1; j >= 0; j--) {
      const prev = kept[j];
      if (prev.trim() === "" || prev.trimStart().startsWith("#")) continue;
      return !TOP_LEVEL_KEY.test(prev) && !/^\s/.test(prev);
    }
    return true; // an indented line with no preceding key at all
  });
  if (orphan >= 0) {
    throw new Error(
      `frontmatterRemovals: ${file} would emit an orphaned continuation line ` +
        `(${JSON.stringify(kept[orphan])}) with no owning key.`,
    );
  }
  return `${content.slice(0, m.index ?? 0)}---\n${kept.join("\n")}\n${m[2]}${content.slice((m.index ?? 0) + m[0].length)}`;
}
