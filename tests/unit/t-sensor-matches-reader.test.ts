// covers: function:sensorMatchesPath
//
// A check's `matches` glob has one reader, sensorMatchesPath, and the gate's
// pre-filter, the dispatcher's own re-check and the write hook all call it.
// When the dispatcher read the glob its own way, `**/` needed a folder there
// and none at the gate, so a team check on code-generation/code-summary.md was
// fired by the gate, refused by the dispatcher and recorded as could not run.
// The table pins what the glob takes, the shipped manifests' patterns
// included; the last test keeps the three callers on the one reader.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sensorMatchesPath } from "../../core/tools/aidlc-sensor-record.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

const RECORD = "/p/aidlc/spaces/default/intents/i";
const CODE_SUMMARY = "**/code-generation/**/code-summary.md";

const TABLE: [pattern: string, path: string, expected: boolean][] = [
  // `**/` takes zero, one and many folders.
  [CODE_SUMMARY, `${RECORD}/construction/code-generation/code-summary.md`, true],
  [CODE_SUMMARY, `${RECORD}/construction/code-generation/unit-a/code-summary.md`, true],
  [CODE_SUMMARY, `${RECORD}/construction/code-generation/unit-a/notes/code-summary.md`, true],
  [CODE_SUMMARY, `${RECORD}/construction/code-generation/unit-a/code-summary.txt`, false],
  [CODE_SUMMARY, `${RECORD}/construction/functional-design/code-summary.md`, false],
  // Brace sets: one, two, nested.
  ["**/*.{ts,js}", "/p/src/a.js", true],
  ["**/*.{ts,js}", "/p/src/a.tsx", false],
  ["**/{src,lib}/*.{ts,js}", "/p/lib/a.js", true],
  ["**/{src,lib}/*.{ts,js}", "/p/test/a.js", false],
  ["**/*.{ts,{mjs,cjs}}", "/p/a.cjs", true],
  // `?` is one character, never a separator.
  ["**/unit-?.md", "/p/unit-a.md", true],
  ["**/unit-?.md", "/p/unit-ab.md", false],
  // A leading `./` is literal on both sides.
  ["./src/*.ts", "./src/a.ts", true],
  ["./src/*.ts", "src/a.ts", false],
  ["./src/*.ts", "/p/src/a.ts", false],
  ["**/one.md", "./p/one.md", true],
  // Windows paths, backslashes or not, any drive-letter case.
  ["**/{aidlc-docs,intents,codekb}/**", "C:\\p\\aidlc\\spaces\\default\\intents\\i\\inception\\requirements.md", true],
  [CODE_SUMMARY, "C:\\p\\code-generation\\code-summary.md", true],
  ["**/*.{ts,tsx}", "c:/p/src/a.tsx", true],
  // The shipped manifests' patterns on the outputs they are bound to.
  ["**/{aidlc-docs,intents}/**", `${RECORD}/inception/requirements-analysis/requirements.md`, true],
  ["**/{aidlc-docs,intents}/**", "/p/aidlc/spaces/default/codekb/repo-a/architecture.md", false],
  ["**/{aidlc-docs,intents,codekb}/**", "/p/aidlc/spaces/default/codekb/repo-a/architecture.md", true],
  ["**/{aidlc-docs,intents,codekb}/**", "/p/aidlc-docs/inception/requirements.md", true],
  ["**/traceability.json", `${RECORD}/construction/unit-a/traceability.json`, true],
  ["**/traceability.json", "/p/traceability.json.bak", false],
  ["**/*.{ts,js}", "/p/README.md", false],
  ["**/*.{ts,tsx}", "/p/src/a.ts", true],
];

describe("t-sensor-matches-reader", () => {
  for (const [pattern, path, expected] of TABLE) {
    test(`${pattern} ${expected ? "takes" : "refuses"} ${path}`, () => {
      expect(sensorMatchesPath(pattern, path)).toBe(expected);
    });
  }

  test("the gate, the dispatcher and the write hook read matches through the one reader", () => {
    for (const rel of ["core/tools/aidlc-state.ts", "core/tools/aidlc-sensor.ts", "core/hooks/aidlc-run-sensors.ts"]) {
      const source = readFileSync(join(REPO_ROOT, rel), "utf-8");
      expect(source, rel).toContain("sensorMatchesPath(");
      expect(source, rel).not.toContain("new Bun.Glob(");
      expect(source, rel).not.toContain("globToRegex");
    }
  });
});
