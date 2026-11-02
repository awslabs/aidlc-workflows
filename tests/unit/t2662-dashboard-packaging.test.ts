// covers: script:package, coreDir:command-center
//
// Every harness tree ships the dashboard launcher, the Command Center server it
// imports, and the prebuilt UI bundle it serves, byte-for-byte from core/.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../..");
const HARNESS_DIRS: Record<string, string> = {
  claude: ".claude",
  codex: ".codex",
  copilot: ".aidlc",
  cursor: ".cursor",
  kiro: ".kiro",
  "kiro-ide": ".kiro",
  opencode: ".aidlc",
};

describe("command-center projection", () => {
  const coreUi = join(REPO, "core", "command-center", "ui");
  const assets = readdirSync(join(coreUi, "assets")).sort();

  test("the committed UI bundle exists in core", () => {
    expect(existsSync(join(coreUi, "index.html"))).toBe(true);
    expect(assets.some((name) => name.endsWith(".js"))).toBe(true);
  });

  for (const [harness, dir] of Object.entries(HARNESS_DIRS)) {
    test(`${harness} ships the launcher, the server and the UI bundle unchanged`, () => {
      const root = join(REPO, "dist", harness, dir);
      expect(existsSync(join(root, "tools", "aidlc-dashboard.ts"))).toBe(true);
      expect(existsSync(join(root, "command-center", "server", "index.ts"))).toBe(true);
      expect(readdirSync(join(root, "command-center", "ui", "assets")).sort()).toEqual(assets);
      for (const name of ["index.html", ...assets.map((a) => join("assets", a))]) {
        expect(readFileSync(join(root, "command-center", "ui", name)).equals(readFileSync(join(coreUi, name)))).toBe(true);
      }
    });
  }
});
