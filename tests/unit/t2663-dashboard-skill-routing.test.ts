// covers: skill:aidlc, utility:dashboard
//
// Every harness orchestrator skill routes `/aidlc dashboard` straight to the
// launcher, before (and instead of) the first `next`, so opening the Command
// Center never touches the workflow.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const HARNESSES = ["claude", "codex", "copilot", "cursor", "kiro", "kiro-ide", "opencode"];
const HEADING = "**Opening the Command Center (`/aidlc dashboard`).**";
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), "utf8");

describe("/aidlc dashboard skill routing", () => {
  for (const h of HARNESSES) {
    test(`${h}: SKILL.md routes dashboard to the launcher before next`, () => {
      const skill = read("harness", h, "skills", "aidlc", "SKILL.md");
      const at = skill.indexOf(HEADING);
      expect(at).toBeGreaterThan(-1);
      expect(skill.indexOf(HEADING, at + 1)).toBe(-1);
      const paragraph = skill.slice(at, skill.indexOf("\n\n", at));
      expect(paragraph).toContain("{{INVOKE}} dashboard");
      expect(paragraph).toContain("do not run `next`");
      expect(paragraph).toContain("in the background");
      expect(at).toBeLessThan(skill.indexOf("Each `next` returns"));
    });
  }

  test("claude's argument hint lists dashboard", () => {
    expect(read("harness", "claude", "skills", "aidlc", "SKILL.md")).toMatch(/argument-hint: "[^"]*\| dashboard \|/);
  });

  test("opencode's command lists dashboard among its utilities", () => {
    expect(read("harness", "opencode", "command", "aidlc.md")).toContain("Utilities: --status, --doctor, dashboard,");
  });
});
