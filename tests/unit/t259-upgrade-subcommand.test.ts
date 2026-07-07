// covers: subcommand:aidlc-utility:upgrade
//
// Pins the wired `aidlc-utility upgrade` subcommand. One command, one optional
// --dry-run flag. Under the hood: fetch upstream tags, pick the newest tag in
// the installed major series, download tarball, diff, back up, apply (unless
// dry-run), preserve any file whose local bytes differ from the incoming
// upstream file. All network + tarball paths are injected via UpgradeOptions
// so tests never touch the network.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { upgrade } from "../../core/tools/aidlc-upgrade.ts";
import { AIDLC_SRC } from "../harness/fixtures.ts";

const BUN = process.execPath;
const UTILITY_TS = join(AIDLC_SRC, "tools", "aidlc-utility.ts");

function makeFakeUpstream(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, "dist", "claude", ".claude", rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
}

function makeFakeProject(root: string, installedVersion: string, files: Record<string, string>): void {
  // Write files ...
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, ".claude", rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  // ... and stamp the installed version into the harness's aidlc-version.ts.
  // upgrade() reads this file (not any imported constant) to know the
  // installed version.
  const vpath = join(root, ".claude", "tools", "aidlc-version.ts");
  mkdirSync(dirname(vpath), { recursive: true });
  writeFileSync(vpath, `export const AIDLC_VERSION = "${installedVersion}";\n`);
}

describe("t259 upgrade subcommand", () => {
  test("up-to-date short-circuits with no download", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "aidlc-upgrade-t-"));
    try {
      makeFakeProject(tmp, "2.1.0", { "any.md": "x" });
      let downloaded = false;
      const r = await upgrade(tmp, {
        fetchTagsFn: async () => ["v2.1.0", "v2.0.0"],
        downloadTarballFn: async () => {
          downloaded = true;
          return "";
        },
      });
      expect(r.reason).toBe("up-to-date");
      expect(r.installed).toBe("2.1.0");
      expect(r.latest).toBe("v2.1.0");
      expect(r.applied).toBe(false);
      expect(downloaded).toBe(false); // up-to-date must NOT download
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("installed newer than every upstream tag reports 'ahead'", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "aidlc-upgrade-t-"));
    try {
      makeFakeProject(tmp, "2.5.0", { "any.md": "x" });
      const r = await upgrade(tmp, { fetchTagsFn: async () => ["v2.1.0", "v2.0.0"] });
      expect(r.reason).toBe("ahead-of-upstream");
      expect(r.applied).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("cross-major upstream tags are ignored (2.x install never offered 3.x)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "aidlc-upgrade-t-"));
    try {
      makeFakeProject(tmp, "2.1.0", { "any.md": "x" });
      const r = await upgrade(tmp, { fetchTagsFn: async () => ["v3.0.0", "v2.1.0"] });
      expect(r.reason).toBe("up-to-date");
      expect(r.latest).toBe("v2.1.0");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("pre-release tags (e.g. v2.3.0-rc1) are ignored", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "aidlc-upgrade-t-"));
    try {
      makeFakeProject(tmp, "2.1.0", { "any.md": "x" });
      const r = await upgrade(tmp, { fetchTagsFn: async () => ["v2.3.0-rc1", "v2.1.0"] });
      expect(r.reason).toBe("up-to-date");
      expect(r.latest).toBe("v2.1.0");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("dry-run reports the diff and writes NOTHING", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "aidlc-upgrade-t-"));
    try {
      makeFakeProject(tmp, "2.0.0", {
        "shared.md": "same in both",
        "hooks/user-edit.ts": "// LOCAL EDIT",
      });
      const extractRoot = join(tmp, "upstream");
      mkdirSync(extractRoot, { recursive: true });
      makeFakeUpstream(extractRoot, {
        "shared.md": "same in both",
        "hooks/user-edit.ts": "// upstream would overwrite",
        "hooks/new-file.ts": "// added by upgrade",
      });
      const r = await upgrade(tmp, {
        dryRun: true,
        fetchTagsFn: async () => ["v2.1.0"],
        downloadTarballFn: async () => extractRoot,
      });
      expect(r.reason).toBe("dry-run");
      expect(r.applied).toBe(false);
      expect(r.diff?.added.sort()).toEqual(["hooks/new-file.ts"]);
      expect(r.diff?.unchanged.sort()).toEqual(["shared.md"]);
      expect(r.diff?.kept.sort()).toEqual(["hooks/user-edit.ts"]);
      // Files must NOT have been touched.
      expect(readFileSync(join(tmp, ".claude", "hooks", "user-edit.ts"), "utf-8")).toBe("// LOCAL EDIT");
      expect(existsSync(join(tmp, ".claude", "hooks", "new-file.ts"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("apply writes added + unchanged files, preserves user-modified, no backup dir created", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "aidlc-upgrade-t-"));
    try {
      makeFakeProject(tmp, "2.0.0", {
        "shared.md": "same in both",
        "hooks/user-edit.ts": "// LOCAL EDIT",
      });
      const extractRoot = join(tmp, "upstream");
      mkdirSync(extractRoot, { recursive: true });
      makeFakeUpstream(extractRoot, {
        "shared.md": "same in both",
        "hooks/user-edit.ts": "// upstream would overwrite",
        "hooks/new-file.ts": "// added by upgrade",
      });
      const r = await upgrade(tmp, {
        fetchTagsFn: async () => ["v2.1.0"],
        downloadTarballFn: async () => extractRoot,
      });
      expect(r.reason).toBe("applied");
      expect(r.applied).toBe(true);
      expect(r.installed).toBe("2.0.0");
      expect(r.latest).toBe("v2.1.0");
      // shared.md (unchanged) + new-file.ts (added) = 2 written; user-edit.ts kept.
      expect(r.filesWritten).toBe(2);
      expect(r.filesKept).toBe(1);
      // The user-modified file must be preserved BYTE-EXACT.
      expect(readFileSync(join(tmp, ".claude", "hooks", "user-edit.ts"), "utf-8")).toBe("// LOCAL EDIT");
      // The newly-added file must exist.
      expect(existsSync(join(tmp, ".claude", "hooks", "new-file.ts"))).toBe(true);
      // No backup dir must be created anywhere alongside the harness dir.
      const siblings = readdirSync(tmp);
      expect(siblings.filter((n) => n.startsWith(".claude.backup"))).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("errors clearly when no harness dir exists in project", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "aidlc-upgrade-t-"));
    try {
      // No .claude/.kiro/.codex under tmp — detection must fail explicitly.
      await expect(
        upgrade(tmp, { fetchTagsFn: async () => ["v2.1.0"] })
      ).rejects.toThrow(/No AI-DLC harness dir found/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("errors clearly when multiple harness dirs are present", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "aidlc-upgrade-t-"));
    try {
      mkdirSync(join(tmp, ".claude"), { recursive: true });
      mkdirSync(join(tmp, ".kiro"), { recursive: true });
      await expect(
        upgrade(tmp, { fetchTagsFn: async () => ["v2.1.0"] })
      ).rejects.toThrow(/Multiple harness dirs present/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("CLI dispatch: `upgrade` subcommand is wired and named in usage", () => {
    // We do NOT run the real upgrade here (would hit network); we hit the
    // default arm and assert the usage line names `upgrade`.
    const res = spawnSync(BUN, [UTILITY_TS, "definitely-not-a-real-subcommand"], {
      encoding: "utf-8",
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr ?? "").toContain("upgrade");
  }, 30000);
});
