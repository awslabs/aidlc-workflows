// covers: file:config.json
//
// t-exec-devin-config-imports.serial.test.ts — live, credential-free proof
// that the shipped `.devin/config.json` `read_config_from` block isolates
// every documented compatibility-import source, and that a vendor-default
// config really does import them (positive control). Devin-side proof of the
// DEVIN-04 "Coexisting harnesses" row.
//
// No inference: `devin skills list` and `devin mcp list` read the merged
// config and print what would load — they never connect to an MCP server.
// Live-verified 2026-09-21 on Devin CLI 3000.6.14 / 3000.10.21 / 3000.10.31
// / 3000.11.1. Copilot *agents* (.github/agents/*.md) were not observed to
// import on those builds and are deliberately not asserted. Observed
// read_config_from precedence (user > project > project-local, contrary to
// Devin's docs) is also deliberately not asserted — pinning undocumented
// behavior would make a vendor fix a red test. The child env points
// XDG_CONFIG_HOME (and APPDATA) at an empty scratch dir so the contributor's
// own user config cannot participate.
//
// The proof is the shipped bytes, not a projection — the test copies
// harness/devin/config.json into the scratch project, so it does NOT need
// dist/devin.
//
// LIVE GATE: requires AIDLC_DEVIN_EXEC_LIVE=1 + a devin binary >=
// DEVIN_MIN_VERSION (AIDLC_DEVIN_BIN or PATH). Skips cleanly otherwise.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDevinCli } from "../harness/exec-drive.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import {
  compareTriples,
  DEVIN_MIN_VERSION,
  DEVIN_MIN_VERSION_STRING,
  parseVersionTriple,
} from "../../core/tools/aidlc-devin-version.ts";

const DEVIN_BIN = process.env.AIDLC_DEVIN_BIN ?? "devin";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "600", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 600) * 1000;
const AUTHORED_CONFIG = join(REPO_ROOT, "harness", "devin", "config.json");

function devinVersionOk(): boolean {
  const r = spawnSync(DEVIN_BIN, ["--version"], { encoding: "utf-8" });
  const version = parseVersionTriple(r.stdout ?? "");
  // Compare against the shared Devin CLI support floor.
  return r.status === 0 && version !== null &&
    compareTriples(version, DEVIN_MIN_VERSION) >= 0;
}

function skipReason(): string | null {
  if (process.env.AIDLC_DEVIN_EXEC_LIVE !== "1") {
    return "set AIDLC_DEVIN_EXEC_LIVE=1 to run the live Devin import-isolation proof";
  }
  if (!devinVersionOk()) return `devin >= ${DEVIN_MIN_VERSION_STRING} not found (AIDLC_DEVIN_BIN=${DEVIN_BIN})`;
  return null;
}
const SKIP_REASON = skipReason();

const SKILL_MD = "---\nname: probe\ndescription: import probe\n---\n\nprobe\n";

// One probe of every documented import source. MCP URLs point at
// 127.0.0.1:1 — nothing listens; `mcp list` does not connect.
function plantImportProbes(workspace: string): void {
  const write = (rel: string, content: string) => {
    const path = join(workspace, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content, "utf-8");
  };
  write(".devin/skills/aidlc/SKILL.md", SKILL_MD);
  write(".github/skills/aidlc/SKILL.md", SKILL_MD);
  write(".github/skills/probe-copilot-skill/SKILL.md", SKILL_MD);
  write(".claude/skills/probe-claude-skill/SKILL.md", SKILL_MD);
  write(".windsurf/skills/probe-windsurf-skill/SKILL.md", SKILL_MD);
  write("AGENTS.md", "# probe project\n");
  write(".mcp.json", `${JSON.stringify({
    mcpServers: {
      "probe-claude-mcp": { url: "http://127.0.0.1:1/claude" },
    },
  }, null, 2)}\n`);
  write(".cursor/mcp.json", `${JSON.stringify({
    mcpServers: {
      "probe-cursor-mcp": { url: "http://127.0.0.1:1/cursor" },
    },
  }, null, 2)}\n`);
  write("opencode.json", `${JSON.stringify({
    mcp: {
      "probe-opencode-mcp": {
        type: "remote",
        url: "http://127.0.0.1:1/opencode",
        enabled: true,
      },
    },
  }, null, 2)}\n`);
  write(".zed/settings.json", `${JSON.stringify({
    context_servers: {
      "probe-zed-mcp": {
        source: "custom",
        command: "true",
        args: [],
      },
    },
  }, null, 2)}\n`);
  write(".devin/mcp_config.json", `${JSON.stringify({
    mcpServers: {
      "probe-devin-own": {
        url: "http://127.0.0.1:1/devin",
        disabled: true,
      },
    },
  }, null, 2)}\n`);
}

function probeTokens(text: string): string[] {
  return (text.match(/probe-[A-Za-z0-9-]+/g) ?? []).sort();
}

describe(`t-exec-devin read_config_from import isolation via devin skills/mcp list`, () => {
  test.skipIf(SKIP_REASON !== null)(
    `shipped config: no sibling skill or MCP imports; /aidlc stays unprefixed${SKIP_REASON ? ` [SKIP: ${SKIP_REASON}]` : ""}`,
    () => {
      const workspace = mkdtempSync(join(tmpdir(), "aidlc-devin-imports-"));
      const xdg = mkdtempSync(join(tmpdir(), "aidlc-devin-xdg-"));
      try {
        expect(
          spawnSync("git", ["init"], { cwd: workspace, encoding: "utf-8" }).status,
        ).toBe(0);
        plantImportProbes(workspace);
        // The shipped authored file, verbatim — this is what is under test.
        cpSync(AUTHORED_CONFIG, join(workspace, ".devin", "config.json"));

        const env = { XDG_CONFIG_HOME: xdg, APPDATA: xdg };
        const skills = runDevinCli(workspace, ["skills", "list"], env);
        const mcp = runDevinCli(workspace, ["mcp", "list"], env);
        const skillsOut = `${skills.stdout}\n${skills.stderr}`;
        const mcpOut = `${mcp.stdout}\n${mcp.stderr}`;
        expect(skills.rc).toBe(0);
        expect(mcp.rc).toBe(0);

        // /aidlc resolves unprefixed to Devin's own skills dir — no
        // collision renaming because no imported twin is loaded.
        expect(skillsOut).toMatch(/\/aidlc .*\(\.\/\.devin\/skills\/aidlc\)/);
        expect(skillsOut).not.toContain("/github:aidlc");
        expect(skillsOut).not.toContain("/devin:aidlc");
        expect(skillsOut).not.toContain("probe-");
        // Devin's own (disabled) registry entry must list — it proves
        // `mcp list` read the scratch project's .devin/mcp_config.json;
        // no imported probe may appear alongside it.
        expect(mcpOut).toContain("probe-devin-own");
        for (const token of probeTokens(mcpOut)) {
          expect(token).toBe("probe-devin-own");
        }
      } finally {
        rmSync(workspace, { recursive: true, force: true });
        rmSync(xdg, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test.skipIf(SKIP_REASON !== null)(
    `positive control: vendor defaults import Copilot skills and OpenCode/Zed MCP — if this fails, Devin changed its import defaults (revisit D1)${SKIP_REASON ? ` [SKIP: ${SKIP_REASON}]` : ""}`,
    () => {
      const workspace = mkdtempSync(join(tmpdir(), "aidlc-devin-imports-"));
      const xdg = mkdtempSync(join(tmpdir(), "aidlc-devin-xdg-"));
      try {
        expect(
          spawnSync("git", ["init"], { cwd: workspace, encoding: "utf-8" }).status,
        ).toBe(0);
        plantImportProbes(workspace);
        // No read_config_from: the vendor default imports everything.
        writeFileSync(
          join(workspace, ".devin", "config.json"),
          `${JSON.stringify({ permissions: { allow: [] } }, null, 2)}\n`,
          "utf-8",
        );

        const env = { XDG_CONFIG_HOME: xdg, APPDATA: xdg };
        const skills = runDevinCli(workspace, ["skills", "list"], env);
        const mcp = runDevinCli(workspace, ["mcp", "list"], env);
        const skillsOut = `${skills.stdout}\n${skills.stderr}`;
        const mcpOut = `${mcp.stdout}\n${mcp.stderr}`;
        expect(skills.rc).toBe(0);
        expect(mcp.rc).toBe(0);

        // The imported twin collides with Devin's own aidlc skill: BOTH are
        // renamed with a provider prefix and bare /aidlc disappears.
        expect(skillsOut).toContain("probe-copilot-skill");
        expect(skillsOut).toContain("/devin:aidlc");
        expect(skillsOut).toContain("/github:aidlc");
        expect(mcpOut).toContain("probe-opencode-mcp");
        expect(mcpOut).toContain("probe-zed-mcp");
      } finally {
        rmSync(workspace, { recursive: true, force: true });
        rmSync(xdg, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
