import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

const scanner = new Bun.Transpiler({ loader: "ts" });

/** Check actual copied bytes, including OS-gated literal dynamic imports, without
 * loading another platform's native code. External packages are not fixture files. */
export function assertRunnerFixtureImports(root: string): void {
  const harness = resolve(root, "tests/harness");
  const lib = resolve(root, "tests/lib");
  const pending = [resolve(harness, "tui-record-file.ts")];
  const backend = resolve(harness, "tui-bun-backend.ts");
  if (existsSync(backend)) pending.push(backend);
  const visited = new Set<string>();
  for (const file of pending) {
    if (visited.has(file)) continue;
    visited.add(file);
    for (const entry of scanner.scanImports(readFileSync(file, "utf8"))) {
      if (!entry.path.startsWith(".")) continue;
      const dependency = resolve(dirname(file), entry.path);
      if (![harness, lib].some((directory) => dependency.startsWith(`${directory}${sep}`))) continue;
      if (!existsSync(dependency)) throw new Error(`incomplete runner fixture: ${file} imports missing ${dependency}`);
      pending.push(dependency);
    }
  }
}
