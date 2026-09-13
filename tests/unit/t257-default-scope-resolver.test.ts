// covers: function:selectionAwareDefaultScope
//
// Selection-aware resolution rescues a caller's explicit preferred scope when
// that scope is absent from the enabled install:
//   - preferred is enabled                        -> preferred (stock: feature/poc)
//   - preferred NOT enabled + a scope declares
//     freeform_default: true                      -> that nominated scope
//   - preferred NOT enabled + a sole plugin owner -> its alphabetically-first scope
//   - preferred NOT enabled + no nomination and
//     no sole owner                               -> preferred + selection error
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
  selectionAwareDefaultScope,
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
function fixtureEnv(files: Record<string, string>): Record<string, string | undefined> {
  const dir = mkdtempSync(join(tmpdir(), "t257-"));
  tempDirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body, "utf-8");
  }
  const gridPath = join(dir, "scope-grid.json");
  writeFileSync(gridPath, "{}\n", "utf-8");
  return {
    AIDLC_SCOPES_DIR: dir,
    AIDLC_SCOPE_GRID: gridPath,
    AIDLC_SCOPE_MAPPING: undefined,
    AIDLC_RUNTIME_HARNESS_ROOT: undefined,
    AIDLC_RUNTIME_ROOT: undefined,
  };
}

// A minimal scope .md. `plugin` and `freeform_default` are optional extras
// appended to the frontmatter (each already carrying its own trailing newline).
const scopeMd = (name: string, extra = "") =>
  `---\nname: ${name}\ndepth: Minimal\nkeywords:\n  - ${name}\ndescription: ${name} scope\n${extra}---\n\n# ${name}\n`;

describe("t257 selection-aware scope rescue", () => {
  test("returns preferred when it is an enabled scope (stock behaviour)", () => {
    const env = fixtureEnv({
      "aidlc-feature.md": scopeMd("feature"),
      "aidlc-lite.md": scopeMd("lite", "freeform_default: true\n"),
    });
    withEnvAndFreshCaches(env, () => {
      expect(selectionAwareDefaultScope("feature").scope).toBe("feature");
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
      expect(selectionAwareDefaultScope("feature").scope).toBe("bundle-validate");
    });
  });

  test("an unavailable explicit poc preference resolves to the sole plugin's first scope", () => {
    const env = fixtureEnv({
      "bundle-all.md": scopeMd("bundle-all", "plugin: demo\n"),
      "bundle-validate.md": scopeMd("bundle-validate", "plugin: demo\n"),
    });
    withEnvAndFreshCaches(env, () => {
      const resolved = selectionAwareDefaultScope("poc");
      expect(resolved.scope).toBe("bundle-all");
      expect(resolved.error).toBeUndefined();
    });
  });

  test("compile rejects multiple enabled freeform_default nominations", () => {
    const env = fixtureEnv({
      "bundle-all.md": scopeMd("bundle-all", "plugin: demo\nfreeform_default: true\n"),
      "bundle-validate.md": scopeMd("bundle-validate", "plugin: demo\nfreeform_default: true\n"),
    });
    expect(() =>
      withEnvAndFreshCaches(env, () => compileStageGraph())
    ).toThrow();
  });

  test("an unavailable preference without nomination or a sole plugin owner requires an explicit scope", () => {
    // A core-owned scope cannot nominate a substitute through the sole-plugin
    // heuristic; preserve the preference and report that selection is required.
    const env = fixtureEnv({ "bundle-all.md": scopeMd("bundle-all") });
    withEnvAndFreshCaches(env, () => {
      const resolved = selectionAwareDefaultScope("feature");
      expect(resolved.scope).toBe("feature");
      expect(resolved.error).toContain("Pass --scope explicitly");
    });
  });
});
