// t-issue-report-core-parity: the aidlc-issue-report skill keeps three of AI-DLC's lists by hand (the audit events it
// reports as problems, the harness rows it names, the folders it looks for an install in), because it must run before
// it can import anything from an install and on installs older or newer than this tree. This file holds those copies
// to AI-DLC's own sources, so a new guard refusal, a renamed event or a new harness fails here instead of a report
// quietly saying nothing went wrong.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessManifest } from "../../scripts/manifest-types.ts";
import { PROBLEM_EVENTS } from "../../core/skills/aidlc-issue-report/scripts/lib-audit.ts";
import { ENGINE_DIRS } from "../../core/skills/aidlc-issue-report/scripts/lib-project.ts";
import { HARNESS_ROWS } from "../../core/skills/aidlc-issue-report/scripts/lib-shape.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

// The quoted names in one declaration of an authored source, from its opening text to the first `end` after it. A
// declaration that is not found fails the test: an empty list would make every comparison below pass.
function declaredNames(file: string, opening: string, end: string): Set<string> {
  const src = readFileSync(join(REPO_ROOT, file), "utf8");
  const start = src.indexOf(opening);
  if (start < 0) throw new Error(`${opening} not found in ${file}`);
  const stop = src.indexOf(end, start + opening.length);
  if (stop < 0) throw new Error(`end of ${opening} not found in ${file}`);
  const names = new Set([...src.slice(start, stop).matchAll(/"([A-Z][A-Z_]+)"/g)].map((m) => m[1]));
  if (names.size === 0) throw new Error(`${opening} in ${file} names nothing`);
  return names;
}

const AUDIT_EVENTS = declaredNames("core/tools/aidlc-audit.ts", "const VALID_EVENT_TYPES = new Set([", "]);");
const GUARD_REFUSALS = declaredNames("core/tools/aidlc-lib.ts", "export type GuardRefusalEvent =", ";");

const HARNESS_NAMES = readdirSync(join(REPO_ROOT, "harness"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(REPO_ROOT, "harness", entry.name, "manifest.ts")))
  .map((entry) => entry.name);
const manifests: HarnessManifest[] = [];
for (const name of HARNESS_NAMES) {
  manifests.push((await import(join(REPO_ROOT, "harness", name, "manifest.ts"))).default as HarnessManifest);
}

describe("the issue report's hand-kept lists match AI-DLC", () => {
  test("every problem event is an audit event AI-DLC writes", () => {
    expect([...PROBLEM_EVENTS].filter((event) => !AUDIT_EVENTS.has(event))).toEqual([]);
  });

  test("every guard refusal AI-DLC records is a problem", () => {
    expect(GUARD_REFUSALS.size).toBeGreaterThan(3);
    expect([...GUARD_REFUSALS].filter((event) => !PROBLEM_EVENTS.has(event))).toEqual([]);
  });

  test("a check that could not run is a problem", () => {
    expect(AUDIT_EVENTS.has("SENSOR_COULD_NOT_RUN")).toBe(true);
    expect(PROBLEM_EVENTS.has("SENSOR_COULD_NOT_RUN")).toBe(true);
  });

  test("the harness rows are the shipped harnesses' names", () => {
    expect([...HARNESS_ROWS].sort()).toEqual(manifests.map((m) => m.name).sort());
  });

  test("the install folders are the shipped harnesses' folders", () => {
    expect([...ENGINE_DIRS].map(String).sort()).toEqual([...new Set(manifests.map((m) => m.harnessDir))].sort());
  });
});
