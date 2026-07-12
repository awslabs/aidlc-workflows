// Rule frontmatter schema — machine-checkable realisation of the rule-file
// frontmatter spec in docs/reference/08-rule-system.md. Sibling of
// aidlc-stage-schema.ts. Consumed by aidlc-graph compile (loadRules) and
// the future doctor rule-drift check (which imports loadRules from
// aidlc-graph.ts, not this file directly — single walking surface, no
// parser duplication).
//
// Hand-rolled, zero-dep — reuses scalarField from aidlc-lib.ts as a
// zero-dep YAML primitive. Pure functions; no I/O.
//
// Schema (strict-additive runtime + pull authoring):
//   - pairing: string   — sensor cross-reference; "feedforward-only" or
//                          a sensor id matching ^aidlc-
//
// Deleted from the schema:
//   - enforcement: enforced (no two-mode keyword; all rules are guardrails)
//   - overrides: { rule, reason, approved_by } (no governance attestation
//     keyword; conflicts rejected at admission gates instead)
//   - paths: string[] (push-side scoping; pull authoring puts the
//     phase→rule import on the stage's existing phase: field, so phase
//     rules attach to every stage in their phase — no glob filter needed)

import { scalarField } from "./aidlc-lib.ts";

export interface RuleFrontmatter {
  // pairing: "feedforward-only" or a sensor-id starting with "aidlc-".
  // Compile-time check is shape-only; sensor cross-validation happens
  // at doctor time (separate concern, separate code path).
  pairing?: string;
}

// parseRuleFrontmatter — extract YAML frontmatter from a rule-file body.
// Returns {} when no `---...---` block is present. Differs from
// parseStageFrontmatter (which throws on missing frontmatter) because rule
// files routinely ship with no frontmatter (aidlc-org.md, aidlc-team.md,
// aidlc-project.md, all 4 phase rules carry zero frontmatter; only the
// optional pairing: case introduces it).
//
// Tolerates unknown keys (forward-compat per 08-rule-system.md "additive
// extension"). Validation runs separately via validateRuleFrontmatter.
//
// Strips a UTF-8 BOM (U+FEFF) before matching. macOS and Windows editors
// occasionally save markdown files with a leading BOM; without this, the
// `^---\r?\n` regex anchor wouldn't match and the file would parse as
// frontmatter-less, silently dropping `pairing:`.
export function parseRuleFrontmatter(raw: string): RuleFrontmatter {
  const cleaned = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
  const m = cleaned.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm = m[1];

  const obj: RuleFrontmatter = {};

  const pairing = scalarField(fm, "pairing");
  if (pairing !== "") obj.pairing = pairing;

  return obj;
}

// validateRuleFrontmatter — schema check on a parsed rule frontmatter.
// Throws "<file>: <message>" on the first violation, mirroring
// compileStageGraph's error pattern. Compile fails loud and names the file.
export function validateRuleFrontmatter(
  obj: RuleFrontmatter,
  file: string,
): void {
  if (obj.pairing !== undefined) {
    if (typeof obj.pairing !== "string" || obj.pairing.length === 0) {
      throw new Error(`${file}: pairing must be a non-empty string`);
    }
    if (obj.pairing !== "feedforward-only" && !obj.pairing.startsWith("aidlc-")) {
      throw new Error(
        `${file}: pairing must be "feedforward-only" or start with "aidlc-" ` +
          `(sensor id shape); got "${obj.pairing}"`,
      );
    }
  }
}
