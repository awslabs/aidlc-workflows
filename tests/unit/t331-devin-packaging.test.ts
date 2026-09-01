// t331-devin-packaging: dist/devin parity + drift guard + shell shape.
//
// covers: file:tools/aidlc-lib.ts
//
// WHAT. Ten contracts land here:
//   (1) The committed dist/devin tree is byte-identical to what
//       `bun scripts/package.ts devin --check` regenerates (drift guard,
//       same UX as codex's t150 / copilot's t248 / cursor's t275 test 1).
//   (2) Core parity: every .ts under dist/devin/.devin/{tools,hooks}/
//       except the authored adapter is BYTE-IDENTICAL to its dist/claude
//       source (the architecture-B invariant: the packager may transform
//       prose/data paths, never code).
//   (3) hooks.v1.json is the WHOLE hooks object (no "hooks" wrapper key),
//       carries the 7 Devin event keys, every command references the adapter
//       and $DEVIN_PROJECT_DIR, and the PreToolUse/PostToolUse blocks wire
//       the expected targets with the expected matchers.
//   (4) config.json shape: permissions allow/deny, read_config_from all false,
//       no model/env/effort/agent/statusLine/theme_mode top-level keys.
//   (5) mcp_config.json shape: 5 servers, context7 is HTTP (url+headers, no
//       command), the 4 AWS servers use uvx.
//   (6) rules/aidlc.md: no @-import, mentions the memory dir.
//   (7) AGENTS.md: no @-import directives, mentions /aidlc --status, no
//       companyAnnouncements/CLAUDE.md references.
//   (8) harness.json identity: name === "devin", harnessDir === ".devin".
//   (9) Doctor recognizes a pristine dist/devin install (devin-specific rows
//       present, Claude fallback absent).
//   (10) SKILL.md freshness: no leftover tokens, triggers in frontmatter,
//        "Harness notes (Devin CLI)" section present.
//
// WHY SUBPROCESS for (1). Same idiom as t141/t150/t240/t248/t275: the
// packager is a CLI; we pin its observable behavior, not its internals.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const PACKAGE_SCRIPT = join(REPO_ROOT, "scripts", "package.ts");
const CLAUDE_SRC = join(REPO_ROOT, "dist", "claude", ".claude");
const DEVIN_ROOT = join(REPO_ROOT, "dist", "devin");
const ENGINE = join(DEVIN_ROOT, ".devin");

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

describe("t331 dist/devin packaging parity + shell shape", () => {
  test("1: committed dist/devin matches the packaging script (drift guard)", () => {
    const r = spawnSync("bun", [PACKAGE_SCRIPT, "devin", "--check"], {
      encoding: "utf-8",
      cwd: REPO_ROOT,
      timeout: 180_000,
    });
    expect(r.stdout + r.stderr).toContain("--check: OK");
    expect(r.status).toBe(0);
  });

  test("2: engine .ts files are byte-identical to the dist/claude sources", () => {
    expect(existsSync(ENGINE)).toBe(true);
    let compared = 0;
    for (const sub of ["tools", "hooks"]) {
      for (const file of walk(join(ENGINE, sub))) {
        if (!file.endsWith(".ts")) continue;
        const rel = relative(ENGINE, file);
        // The authored shim is devin-only; everything else is shared core.
        if (rel === join("hooks", "aidlc-devin-adapter.ts")) continue;
        // Compiled data (tools/data/) is per-tree by design; only code is pinned.
        if (rel.split(sep).includes("data")) continue;
        const claudeTwin = join(CLAUDE_SRC, rel);
        expect(existsSync(claudeTwin)).toBe(true);
        expect(readFileSync(file, "utf-8")).toBe(readFileSync(claudeTwin, "utf-8"));
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(20);
  });

  test("3: hooks.v1.json is the whole hooks object with the 7 Devin events and expected targets", () => {
    const raw = readFileSync(join(ENGINE, "hooks.v1.json"), "utf-8");
    const wiring = JSON.parse(raw) as Record<
      string,
      Array<{ matcher?: string; hooks: Array<{ type?: string; command: string }> }>
    >;
    // The whole file IS the hooks object — top-level keys are event names,
    // NOT a "hooks" wrapper key.
    expect("hooks" in wiring).toBe(false);
    const events = Object.keys(wiring).sort();
    expect(events).toEqual(
      [
        "PostCompaction",
        "PostToolUse",
        "PreToolUse",
        "SessionEnd",
        "SessionStart",
        "Stop",
        "UserPromptSubmit",
      ].sort(),
    );
    // Every command references the adapter and $DEVIN_PROJECT_DIR.
    for (const event of events) {
      for (const group of wiring[event]) {
        for (const h of group.hooks) {
          expect(h.command).toContain("aidlc-devin-adapter.ts");
          expect(h.command).toContain("$DEVIN_PROJECT_DIR");
        }
      }
    }
    // aidlc-statusline is NOT referenced (Devin has no statusline config).
    expect(raw).not.toContain("aidlc-statusline");

    // PreToolUse has a reviewer-scope target.
    const pre = wiring.PreToolUse ?? [];
    expect(
      pre.some((g) =>
        g.hooks.some((h) => h.command.endsWith("reviewer-scope")),
      ),
    ).toBe(true);

    // PostToolUse has the expected targets with the expected matchers.
    const post = wiring.PostToolUse ?? [];
    const findTarget = (target: string) =>
      post.find((g) => g.hooks.some((h) => h.command.endsWith(target)));
    const audit = findTarget("audit-and-sensors");
    expect(audit?.matcher).toBe("edit|write|apply_patch");
    const sync = findTarget("sync-workflow-state");
    expect(sync?.matcher).toBe("todo_write");
    const log = findTarget("log-subagent");
    expect(log?.matcher).toBe("run_subagent");
    const rebuild = findTarget("rebuild-stage-graph");
    expect(rebuild?.matcher).toBe("exec");
  });

  test("4: config.json shape — permissions, read_config_from, no inference keys", () => {
    const config = JSON.parse(readFileSync(join(ENGINE, "config.json"), "utf-8")) as Record<
      string,
      unknown
    >;
    const permissions = config.permissions as {
      allow: string[];
      deny: string[];
    };
    expect(permissions.allow).toContain("Read(**)");
    expect(permissions.allow).toContain("Exec(bun)");
    expect(permissions.allow).toContain("run_subagent");
    expect(permissions.allow).toContain("ask_user_question");
    expect(permissions.allow).toContain("mcp__*");
    expect(permissions.deny).toContain("Exec(sudo)");
    const readConfigFrom = config.read_config_from as Record<string, boolean>;
    expect(readConfigFrom.cursor).toBe(false);
    expect(readConfigFrom.windsurf).toBe(false);
    expect(readConfigFrom.claude).toBe(false);
    // No inference/config keys at the top level.
    for (const key of ["model", "env", "effort", "agent", "statusLine", "theme_mode"]) {
      expect(key in config, `config.json must not carry top-level "${key}"`).toBe(false);
    }
  });

  test("5: mcp_config.json shape — 5 servers, context7 HTTP, 4 AWS via uvx", () => {
    const mcp = JSON.parse(readFileSync(join(ENGINE, "mcp_config.json"), "utf-8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    const servers = Object.keys(mcp.mcpServers).sort();
    expect(servers).toEqual(
      ["aws-iac", "aws-mcp", "aws-pricing", "aws-serverless", "context7"].sort(),
    );
    // context7 is an HTTP server: url + headers, no type/command.
    const ctx = mcp.mcpServers["context7"]!;
    expect("url" in ctx).toBe(true);
    expect("headers" in ctx).toBe(true);
    expect("type" in ctx).toBe(false);
    expect("command" in ctx).toBe(false);
    // The 4 AWS servers use uvx (command + args).
    for (const name of ["aws-mcp", "aws-pricing", "aws-iac", "aws-serverless"]) {
      const srv = mcp.mcpServers[name]!;
      expect(srv.command).toBe("uvx");
      expect(Array.isArray(srv.args)).toBe(true);
    }
  });

  test("6: rules/aidlc.md — no @-import, mentions the memory dir", () => {
    const stub = readFileSync(join(ENGINE, "rules", "aidlc.md"), "utf-8");
    expect(stub).not.toMatch(/^@/m);
    expect(stub).toContain("aidlc/spaces/default/memory/");
  });

  test("7: AGENTS.md — no @-import directives, mentions /aidlc --status, no Claude references", () => {
    const agents = readFileSync(join(DEVIN_ROOT, "AGENTS.md"), "utf-8");
    expect(agents).not.toMatch(/^@/m);
    expect(agents).toContain("/aidlc --status");
    expect(agents).not.toContain("companyAnnouncements");
    expect(agents).not.toContain("CLAUDE.md");
  });

  test("8: harness.json identity — name === devin, harnessDir === .devin", () => {
    const harness = JSON.parse(
      readFileSync(join(ENGINE, "tools", "data", "harness.json"), "utf-8"),
    ) as { name: string; harnessDir: string };
    expect(harness.name).toBe("devin");
    expect(harness.harnessDir).toBe(".devin");
  });

  test("9: doctor recognizes a pristine dist/devin install (devin rows present, Claude fallback absent)", () => {
    const root = mkdtempSync(join(tmpdir(), "t331-devin-doctor-"));
    try {
      const project = join(root, "project");
      cpSync(DEVIN_ROOT, project, { recursive: true });
      const r = spawnSync(
        "bun",
        [join(project, ".devin", "tools", "aidlc-utility.ts"), "doctor", "--project-dir", project],
        {
          cwd: project,
          encoding: "utf-8",
          env: { ...process.env, AIDLC_HARNESS_DIR: ".devin" },
        },
      );
      const output = `${r.stdout}${r.stderr}`;
      expect(r.status, output).toBe(0);
      // Devin-specific rows.
      expect(output).toContain("aidlc-devin-adapter.ts present");
      expect(output).toContain("hooks.v1.json present");
      expect(output).toContain("config.json present");
      expect(output).toContain("mcp_config.json present");
      expect(output).toContain("rules/aidlc.md present");
      expect(output).toContain("devin CLI version");
      expect(output).toContain("hook approval");
      // The Claude settings.json fallback must NOT appear.
      expect(output).not.toContain("settings.json present");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("10: SKILL.md freshness — no leftover tokens, triggers, Harness notes section", () => {
    const skill = readFileSync(join(ENGINE, "skills", "aidlc", "SKILL.md"), "utf-8");
    expect(skill).not.toContain("{{HARNESS_DIR}}");
    expect(skill).not.toContain("companyAnnouncements");
    expect(skill).not.toContain("CLAUDE.md");
    expect(skill).not.toContain(".claude");
    expect(skill).toMatch(/^triggers:/m);
    expect(skill).toContain("Harness notes (Devin CLI)");
  });
});
