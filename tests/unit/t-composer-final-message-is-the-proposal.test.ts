// covers: core/agents/aidlc-composer-agent.md
//
// On every harness the lead reads the composer helper's FINAL message as its
// result. A composer that ends on a status line ("done, see above") makes the
// lead ask again, and on Codex that re-ask is printed for the person. The
// persona says it once, and every harness copy follows from core.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const LINE = /Your final message IS the proposal[^.]*never a status line/;

describe("the composer's final message is the proposal", () => {
  test("the authored persona says so", () => {
    expect(readFileSync(join(REPO_ROOT, "core", "agents", "aidlc-composer-agent.md"), "utf-8")).toMatch(LINE);
  });

  test("every shipped copy carries the line", () => {
    const copies = [
      join("dist", "claude", ".claude", "agents", "aidlc-composer-agent.md"),
      join("dist", "codex", ".codex", "agents", "aidlc-composer-agent.toml"),
      join("dist", "kiro", ".kiro", "agents", "aidlc-composer-agent.md"),
      join("dist", "kiro-ide", ".kiro", "agents", "aidlc-composer-agent.md"),
      join("dist", "cursor", ".cursor", "agents", "aidlc-composer-agent.md"),
      join("dist", "opencode", ".opencode", "agents", "aidlc-composer-agent.md"),
      join("dist", "copilot", ".github", "agents", "aidlc-composer-agent.agent.md"),
    ].filter((rel) => existsSync(join(REPO_ROOT, rel)));
    expect(copies.length).toBeGreaterThan(3);
    for (const rel of copies) {
      expect(readFileSync(join(REPO_ROOT, rel), "utf-8"), rel).toMatch(LINE);
    }
  });
});
