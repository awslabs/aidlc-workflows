// covers: function:resolveDefaultScope, function:loadScopeMetadata
//
// resolveDefaultScope(preferred) is bundle-aware. It routes the core-era
// hardcoded defaults that leak through a plugin-only install (where the core
// feature/poc scopes are deselected by plugin selection):
//   - preferred is enabled                        -> preferred (stock: feature/poc)
//   - preferred NOT enabled + a scope declares
//     freeform_default: true                      -> that nominated scope
//   - preferred NOT enabled + a sole plugin owner -> its alphabetically-first scope
//   - preferred NOT enabled + no nomination and
//     no sole owner                               -> preferred (caller validates)
//
// The nomination is checked BEFORE the sole-plugin heuristic, so a plugin that
// ships several scopes can name its lean default rather than losing to the
// alphabetically-first one. Compilation rejects multiple enabled nominations
// instead of silently selecting the alphabetically-first claimant. Driven
// through the AIDLC_SCOPES_DIR seam (read at call time), the same fixture
// pattern as t225.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveDefaultScope,
  loadScopeMetadata,
  validScopes,
} from "../../core/tools/aidlc-lib.ts";
import { compileStageGraph } from "../../core/tools/aidlc-graph.ts";
import { withEnvAndFreshCaches } from "../harness/fixtures.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  withEnvAndFreshCaches({}, () => undefined);
});

// Build an isolated scopes tree from a set of *.md fixtures and return the env
// that points the loaders at it. The scope grid (the EXECUTE/SKIP source) is
// stubbed empty via AIDLC_SCOPE_GRID: the resolver only reads scope NAMES and
// their plugin/freeform-default frontmatter (all from the .md files), so an
// empty grid keeps validScopes() derivable without a compiled stage-graph.json.
function fixtureEnv(files: Record<string, string>): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "t257-"));
  tempDirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body, "utf-8");
  }
  const gridPath = join(dir, "scope-grid.json");
  writeFileSync(gridPath, "{}\n", "utf-8");
  return { AIDLC_SCOPES_DIR: dir, AIDLC_SCOPE_GRID: gridPath };
}

// A minimal scope .md. `plugin` and `freeform_default` are optional extras
// appended to the frontmatter (each already carrying its own trailing newline).
const scopeMd = (name: string, extra = "") =>
  `---\nname: ${name}\ndepth: Minimal\nkeywords:\n  - ${name}\ndescription: ${name} scope\n${extra}---\n\n# ${name}\n`;

describe("t257 resolveDefaultScope bundle-aware default", () => {
  test("returns preferred when it is an enabled scope (stock behaviour)", () => {
    const env = fixtureEnv({
      "aidlc-feature.md": scopeMd("feature"),
      "aidlc-lite.md": scopeMd("lite", "freeform_default: true\n"),
    });
    withEnvAndFreshCaches(env, () => {
      expect(resolveDefaultScope("feature")).toBe("feature");
    });
  });

  test("plugin-only install: the nominated freeform_default beats the alphabetically-first scope", () => {
    // Two scopes from the same sole plugin, core feature/poc deselected. The
    // sole-plugin heuristic alone would pick "bundle-all" (alphabetically
    // first); the nomination on "bundle-validate" wins because it is checked
    // first.
    const env = fixtureEnv({
      "bundle-all.md": scopeMd("bundle-all", "plugin: demo\n"),
      "bundle-validate.md": scopeMd("bundle-validate", "plugin: demo\nfreeform_default: true\n"),
    });
    withEnvAndFreshCaches(env, () => {
      expect(resolveDefaultScope("feature")).toBe("bundle-validate");
    });
  });

  test("plugin-only install: intent-birth's core 'poc' default resolves to an enabled scope, not a crash", () => {
    // Reproduces the bug: on a plugin-only install the core "poc" default is
    // absent, so handleIntentBirth's `validScopes().has(scope)` guard would die
    // with "Unknown scope". The resolver maps "poc" to the nominated default,
    // which IS a valid scope, so the guard passes.
    const env = fixtureEnv({
      "bundle-all.md": scopeMd("bundle-all", "plugin: demo\n"),
      "bundle-validate.md": scopeMd("bundle-validate", "plugin: demo\nfreeform_default: true\n"),
    });
    withEnvAndFreshCaches(env, () => {
      const resolved = resolveDefaultScope("poc");
      expect(resolved).toBe("bundle-validate");
      expect(validScopes().has(resolved)).toBe(true);
    });
  });

  test("parses freeform_default:true into ScopeMetadata", () => {
    const env = fixtureEnv({
      "bundle-validate.md": scopeMd("bundle-validate", "plugin: demo\nfreeform_default: true\n"),
    });
    withEnvAndFreshCaches(env, () => {
      expect(loadScopeMetadata()["bundle-validate"].freeformDefault).toBe(true);
    });
  });

  test("compile rejects multiple enabled freeform_default nominations", () => {
    const env = fixtureEnv({
      "bundle-all.md": scopeMd("bundle-all", "plugin: demo\nfreeform_default: true\n"),
      "bundle-validate.md": scopeMd("bundle-validate", "plugin: demo\nfreeform_default: true\n"),
    });
    expect(() =>
      withEnvAndFreshCaches(env, () => compileStageGraph())
    ).toThrow(
      "Multiple enabled scopes declare freeform_default: true (bundle-all, bundle-validate). " +
        "At most one enabled scope may nominate the freeform default.",
    );
  });

  test("returns preferred unchanged when nothing is nominated and no sole plugin owner", () => {
    // "bundle-all" carries no plugin field (core-bucketed) and no nomination, so
    // neither the nomination nor the sole-plugin heuristic fires; the caller-
    // supplied "feature" is returned for the caller's own validation to reject.
    const env = fixtureEnv({ "bundle-all.md": scopeMd("bundle-all") });
    withEnvAndFreshCaches(env, () => {
      expect(resolveDefaultScope("feature")).toBe("feature");
    });
  });
});
