import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

const scanner = new Bun.Transpiler({ loader: "ts" });

/** Check actual copied bytes, including OS-gated literal dynamic imports, without
 * loading another platform's native code. External packages are not fixture files. */
export function assertRunnerFixtureImports(root: string, entries?: readonly string[]): void {
  const fixtureRoot = resolve(root);
  const generated = ["dist", "dist-release"].map((directory) => resolve(root, directory));
  const harness = resolve(root, "tests/harness");
  // By default start from the native entry points. A fixture that also loads
  // other copied modules (sdk-drive.ts during e2e cleanup) names them as entries.
  const pending = entries
    ? entries.map((entry) => resolve(root, entry))
    : [resolve(harness, "tui-record-file.ts"), resolve(harness, "tui-bun-backend.ts")].filter((file) => existsSync(file));
  const visited = new Set<string>();
  for (const file of pending) {
    if (visited.has(file)) continue;
    visited.add(file);
    // The transpiler rejects a leading shebang line; an executable module keeps one.
    const source = readFileSync(file, "utf8").replace(/^#![^\n]*/, "");
    for (const entry of scanner.scanImports(source)) {
      if (!entry.path.startsWith(".")) continue;
      const dependency = resolve(dirname(file), entry.path);
      // Any authored relative import inside the fixture, scripts/ and core/
      // included: a missing one otherwise fails deep in a run as "Cannot find
      // module". Generated trees are not fixture files; drivers reach them only
      // through dynamic imports while preparing a live project.
      if (!dependency.startsWith(`${fixtureRoot}${sep}`)) continue;
      if (generated.some((directory) => dependency.startsWith(`${directory}${sep}`))) continue;
      if (!existsSync(dependency)) throw new Error(`incomplete runner fixture: ${file} imports missing ${dependency}`);
      pending.push(dependency);
    }
  }
}
