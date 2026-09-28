import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

const scanner = new Bun.Transpiler({ loader: "ts" });

/** Check actual copied bytes, including OS-gated literal dynamic imports, without
 * loading another platform's native code. External packages are not fixture files. */
export function assertRunnerFixtureImports(root: string, entries?: readonly string[]): void {
  const harness = resolve(root, "tests/harness");
  const lib = resolve(root, "tests/lib");
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
      if (![harness, lib].some((directory) => dependency.startsWith(`${directory}${sep}`))) continue;
      if (!existsSync(dependency)) throw new Error(`incomplete runner fixture: ${file} imports missing ${dependency}`);
      pending.push(dependency);
    }
  }
}
