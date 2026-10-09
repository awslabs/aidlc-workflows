// covers: function:workspaceSourceState
//
// Composer installs a PHP project's dependencies into `vendor/` beside its
// `composer.json`. The source-boundary walk read and hashed every file there,
// so on a PHP monorepo with over a gigabyte of vendored packages `aidlc doctor`
// and every Plan Approval freshness check ran for minutes (#1879), and past the
// walk's entry budget the boundary failed to bind at all. The directory a
// package manager fills beside its manifest is now conditional, like `bin/` and
// `obj/` beside a .NET project file: outside the boundary unless a path under it
// is registered in `.aidlc-source-paths.json`. One row per manifest (see
// MANIFEST_ROWS below, which mirrors the table in aidlc-lib.ts). Elsewhere the
// same names stay bound: C projects keep hand-maintained code and submodules
// under `vendor/` (t314 keeps its fixture submodule at vendor/sub). These tests
// pin every row OUT of the fingerprint, pin a Composer install inside a
// sub-project OUT while the sub-project's own source stays IN, pin a `vendor/`
// with no manifest beside it IN, and pin the registration escape back IN.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspaceSourceState } from "../../core/tools/aidlc-lib.ts";
import { cleanupTestProject, createTestProject } from "../harness/fixtures.ts";

const created: string[] = [];
afterEach(() => {
  while (created.length) cleanupTestProject(created.pop());
});

// Manifest file -> the directories the package manager fills beside it.
const MANIFEST_ROWS: ReadonlyArray<readonly [manifest: string, dir: string]> = [
  ["composer.json", "vendor"],
  ["go.mod", "vendor"],
  ["Podfile", "Pods"],
  ["mix.exs", "deps"],
  ["mix.exs", "_build"],
  ["pubspec.yaml", ".dart_tool"],
  ["bower.json", "bower_components"],
  ["Gemfile", ".bundle"],
  ["stack.yaml", ".stack-work"],
];

function sourceProject(): string {
  const project = createTestProject();
  created.push(project);
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "app.php"), "<?php\n$app = 1;\n");
  mkdirSync(join(project, "lib-a", "src"), { recursive: true });
  writeFileSync(join(project, "lib-a", "src", "lib.php"), "<?php\n$lib = 1;\n");
  return project;
}

function composerProject(): string {
  const project = sourceProject();
  writeFileSync(join(project, "composer.json"), '{"name":"app/root","require":{}}\n');
  writeFileSync(join(project, "lib-a", "composer.json"), '{"name":"app/lib-a","require":{}}\n');
  return project;
}

function fingerprint(project: string): string {
  const state = workspaceSourceState(project);
  expect(state).not.toBeNull();
  return state!.fingerprint;
}

/** What a dependency install leaves behind: package source and a generated index. */
function installDependencies(dir: string, version: string): void {
  const pkg = join(dir, "acme", "widgets", "src");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "Widget.php"), `<?php\nclass Widget { const VERSION = '${version}'; }\n`);
  writeFileSync(join(pkg, "widget.go"), `package widgets // ${version}\n`);
  writeFileSync(join(dir, "autoload.php"), `<?php\n// ${version}\n`);
}

describe("t-vendor-outside-source-boundary: the directory a package manager fills beside its manifest is outside the source boundary", () => {
  test.each(MANIFEST_ROWS)("%s: an install into %s/ leaves the fingerprint unchanged", (manifest, dir) => {
    const project = sourceProject();
    writeFileSync(join(project, manifest), `# ${manifest}\n`);
    const before = fingerprint(project);
    installDependencies(join(project, dir), "1.0.0");
    expect(fingerprint(project)).toBe(before);
    // A later update rewrites the packages; still not a source change.
    installDependencies(join(project, dir), "1.1.0");
    expect(fingerprint(project)).toBe(before);
  });

  test("a sub-project's vendor/ beside its own composer.json is outside too, while its source stays bound", () => {
    const project = composerProject();
    const before = fingerprint(project);
    installDependencies(join(project, "lib-a", "vendor"), "2.0.0");
    expect(fingerprint(project)).toBe(before);
    writeFileSync(join(project, "lib-a", "src", "lib.php"), "<?php\n$lib = 2;\n");
    expect(fingerprint(project)).not.toBe(before);
  });

  test("a vendor/ with no manifest beside it stays bound", () => {
    const project = sourceProject();
    const before = fingerprint(project);
    mkdirSync(join(project, "vendor", "libfoo"), { recursive: true });
    writeFileSync(join(project, "vendor", "libfoo", "foo.c"), "int foo(void) { return 1; }\n");
    const withVendored = fingerprint(project);
    expect(withVendored).not.toBe(before);
    writeFileSync(join(project, "vendor", "libfoo", "foo.c"), "int foo(void) { return 2; }\n");
    expect(fingerprint(project)).not.toBe(withVendored);
  });

  test("a vendor/ beside a Gemfile stays bound (Rails keeps source in vendor/assets)", () => {
    const project = sourceProject();
    writeFileSync(join(project, "Gemfile"), "source 'https://rubygems.org'\n");
    const before = fingerprint(project);
    mkdirSync(join(project, "vendor", "assets", "javascripts"), { recursive: true });
    writeFileSync(join(project, "vendor", "assets", "javascripts", "widget.js"), "export const widget = 1;\n");
    expect(fingerprint(project)).not.toBe(before);
  });

  test("a path registered in .aidlc-source-paths.json under vendor/ is bound again", () => {
    const project = composerProject();
    writeFileSync(
      join(project, ".aidlc-source-paths.json"),
      JSON.stringify({ version: 1, paths: ["vendor/acme/widgets/src"] }),
    );
    const before = fingerprint(project);
    installDependencies(join(project, "vendor"), "1.0.0");
    const installed = fingerprint(project);
    expect(installed).not.toBe(before);
    // The registered package changes: bound. The rest of vendor/ changes: not bound.
    writeFileSync(join(project, "vendor", "acme", "widgets", "src", "Widget.php"), "<?php\nclass Widget { const VERSION = 'edited'; }\n");
    const edited = fingerprint(project);
    expect(edited).not.toBe(installed);
    writeFileSync(join(project, "vendor", "autoload.php"), "<?php\n// regenerated\n");
    expect(fingerprint(project)).toBe(edited);
  });
});
