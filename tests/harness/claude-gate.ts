import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  claudeDependenciesOf,
  type ClaudeDependency,
} from "../gen-coverage-registry.ts";

const __FILE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TESTS_DIR = join(__FILE_DIR, "..");

export const TEST_LEVELS = ["smoke", "unit", "integration", "e2e"] as const;
export type TestLevel = (typeof TEST_LEVELS)[number];
export const CLAUDE_GATED_LEVELS = ["integration", "e2e"] as const;

export interface ClaudeRequiredTest {
  file: string;
  dependencies: ClaudeDependency[];
}

export function discoverClaudeRequiredTests(
  testsDir = DEFAULT_TESTS_DIR,
  levels: readonly TestLevel[] = CLAUDE_GATED_LEVELS,
): ClaudeRequiredTest[] {
  const out: ClaudeRequiredTest[] = [];
  for (const level of levels) {
    const dir = join(testsDir, level);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir).sort()) {
      if (!entry.endsWith(".test.ts")) continue;
      // A sibling runner (smoke's t05) plants transient tZZ-*.test.ts files in
      // this shared dir and removes them when its case ends; a file listed by
      // readdir may legitimately be gone by the read. Skip it - a vanished
      // file cannot need the claude gate.
      let src: string;
      try {
        src = readFileSync(join(dir, entry), "utf-8");
      } catch {
        continue;
      }
      const dependencies = claudeDependenciesOf(entry, src);
      if (dependencies.length === 0) continue;
      out.push({
        file: `tests/${level}/${entry}`,
        dependencies,
      });
    }
  }
  return out;
}

if (import.meta.main) {
  const json = process.argv.includes("--json");
  const rows = discoverClaudeRequiredTests();
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.log(rows.map((r) => r.file).join("\n"));
  }
}
