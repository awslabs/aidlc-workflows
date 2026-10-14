// covers: file:skills/aidlc/SKILL.md
//
// The orchestrator skills and the generated scope runners must not tell the
// agent to default to carrying on the open work ("Default to CONTINUATION ...
// when in doubt, continue"). The engine's reading step already says what to do
// when the agent cannot tell (ask the person where the work belongs). Neither
// sentence may appear: not in an authored skill, not in the runner
// generator, not in any skill the packager ships (the scope runners are
// generated into dist).
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const STALE = [/Default to CONTINUATION/i, /when in doubt,? continue/i];

function skillFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) skillFiles(path, out);
    else if (name === "SKILL.md") out.push(path);
  }
  return out;
}

function carriers(paths: string[]): string[] {
  return paths.filter((path) => STALE.some((pattern) => pattern.test(readFileSync(path, "utf-8"))))
    .map((path) => relative(ROOT, path));
}

describe("no skill tells the agent to default to carrying on", () => {
  test("the authored skills and the runner generator carry neither sentence", () => {
    const authored = skillFiles(join(ROOT, "harness"));
    expect(authored.length).toBeGreaterThanOrEqual(7);
    expect(carriers([...authored, join(ROOT, "core", "tools", "aidlc-runner-gen.ts")])).toEqual([]);
  });

  test("no packaged skill, generated scope runners included, carries either sentence", () => {
    const shipped = skillFiles(join(ROOT, "dist"));
    // The runner packages dist before tests; a scope runner must be among them.
    expect(shipped.some((path) => /skills[\\/]aidlc-bugfix[\\/]SKILL\.md$/.test(path))).toBe(true);
    expect(carriers(shipped)).toEqual([]);
  });
});
