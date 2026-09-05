// core/tools/aidlc-devin-profile.ts — Devin persona frontmatter projection.
//
// Internal projection helper (NOT a CLI command). Strips frontmatter fields
// Devin's native agent loader ignores (display_name, examples, disallowedTools,
// maxTurns) from agent .md files during Devin packaging, after the shared tier
// projection in scripts/package.ts has run. The authored core/agents/*.md files
// keep these fields for other harnesses (Claude, Kiro, Codex, etc.); only the
// Devin dist copy is trimmed.
//
// Why: `devin doctor --json` warns CFG005 for ignored keys. The fields carry
// no enforcement on Devin (disallowedTools is a Claude/Kiro concept; maxTurns
// is not a Devin agent field; display_name and examples are display-only).
// Removing them from the Devin projection produces clean doctor output without
// weakening the authored personas (the no-nesting default is Devin-native, not
// a disallowedTools: Task projection).
//
// Used by:
//   - scripts/package.ts (Devin agent projection, after projectTierFrontmatter)
//   - core/tools/aidlc-plugin-emit.ts (Devin plugin agent emission)
//   - scripts/plugin-hooks-template/compose.ts (Devin plugin compose, via
//     dynamic import of the installed helper)
//
// Idempotent: applying twice produces identical output (the stripped fields are
// already absent on the second pass).

/** The complete set of frontmatter field names stripped from Devin agent .md
 *  projection outputs. Each is ignored by Devin's native agent loader and
 *  triggers a CFG005 doctor warning if left in. */
const DEVIN_UNSUPPORTED_FIELDS: ReadonlySet<string> = new Set([
  "display_name",
  "examples",
  "disallowedTools",
  "maxTurns",
]);

/** Strip Devin-unsupported frontmatter fields from an agent .md source string.
 *
 *  Reads only the leading closed YAML block (between the first two `---`
 *  fences). Removes a field block = its top-level key line plus any following
 *  indented continuation lines (e.g. the `examples:` list items), up to the
 *  next top-level key or the closing fence. Preserves the body exactly. Blank
 *  lines and comments between retained fields are kept where possible.
 *
 *  Rejects unsupported/ambiguous frontmatter syntax (no closing fence) with a
 *  useful error naming the source path. Pure: no I/O, no external deps.
 *
 *  @param source - the full .md file content (frontmatter + body)
 *  @param sourcePath - path for error messages only
 *  @returns the .md with unsupported fields removed from the frontmatter */
export function stripDevinUnsupportedProfileFields(
  source: string,
  sourcePath: string,
): string {
  // Strip a UTF-8 BOM before anchoring (same tolerance as agentTierFromMd).
  const bom = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const hasBom = bom !== source;
  // Match the leading closed YAML block. Require a closing `---` fence so a
  // truncated file produces a useful error rather than silently passing through.
  const m = bom.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) {
    throw new Error(
      `${sourcePath}: agent .md has no closed YAML frontmatter block for Devin projection.`,
    );
  }
  const fmBlock = m[0]; // includes fences and trailing newline
  const fmContent = m[1]; // between fences
  const newFm = stripFields(fmContent, sourcePath);
  if (newFm === fmContent) {
    // No fields stripped — return unchanged (idempotent fast path).
    return source;
  }
  const newBlock = `---\n${newFm}\n---\n`;
  const replaced = bom.replace(fmBlock, () => newBlock);
  return hasBom ? `\uFEFF${replaced}` : replaced;
}

/** Remove the unsupported top-level field blocks from frontmatter content.
 *  A field block = the `key:` line plus all following indented lines (those
 *  starting with whitespace) up to the next top-level key or end of block. */
function stripFields(fm: string, sourcePath: string): string {
  const lines = fm.split(/\r?\n/);
  const result: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    // A top-level key line: starts at column 0 with a YAML key.
    const keyMatch = line.match(/^(\w[\w-]*):/);
    if (keyMatch && DEVIN_UNSUPPORTED_FIELDS.has(keyMatch[1])) {
      // Skip this key line and all following indented continuation lines.
      i++;
      while (i < lines.length && /^\s/.test(lines[i]!)) {
        i++;
      }
      continue;
    }
    result.push(line);
    i++;
  }
  // Clean up: remove trailing blank lines that the strip may have left at the
  // end of the block (cosmetic; the closing fence follows immediately).
  while (result.length > 0 && result[result.length - 1]!.trim() === "") {
    result.pop();
  }
  // Detect a potential ambiguity: if a stripped field name appears as a
  // non-top-level key (e.g. nested under another field), do not flag it —
  // we only strip top-level blocks. This is the correct behavior; nested
  // unsupported keys are not produced by the authored personas.
  return result.join("\n");
}

/** Check whether a frontmatter field name is in the Devin-unsupported set.
 *  Exposed for tests that want to verify the set without hard-coding it. */
export function isDevinUnsupportedField(key: string): boolean {
  return DEVIN_UNSUPPORTED_FIELDS.has(key);
}
