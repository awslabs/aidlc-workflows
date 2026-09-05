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

    // fold-usage is NOT registered on any event (S05: removed inert registrations).
    expect(raw).not.toContain("fold-usage");

    // PreToolUse has a reviewer-scope target.
    const pre = wiring.PreToolUse ?? [];
    expect(
      pre.some((g) =>
        g.hooks.some((h) => h.command.endsWith("reviewer-scope")),
      ),
    ).toBe(true);

    // PostToolUse has the expected targets. Matchers are regexes on tool_name;
    // assert behavior (compile + match/nonmatch) rather than one historical spelling.
    const post = wiring.PostToolUse ?? [];
    const findTarget = (target: string) =>
      post.find((g) => g.hooks.some((h) => h.command.endsWith(target)));
    const audit = findTarget("audit-and-sensors");
    expect(audit).toBeDefined();
    const sync = findTarget("sync-workflow-state");
    expect(sync).toBeDefined();
    const log = findTarget("log-subagent");
    expect(log).toBeDefined();
    const rebuild = findTarget("rebuild-stage-graph");
    expect(rebuild).toBeDefined();
    const humanTurn = findTarget("record-human-turn");
    expect(humanTurn).toBeDefined();

    // Compile each named matcher and verify intended matches and nonmatches.
    const re = (m?: string) => new RegExp(m ?? "");
    expect(re(audit?.matcher).test("edit")).toBe(true);
    expect(re(audit?.matcher).test("write")).toBe(true);
    expect(re(audit?.matcher).test("apply_patch")).toBe(true);
    expect(re(audit?.matcher).test("read")).toBe(false);
    expect(re(sync?.matcher).test("todo_write")).toBe(true);
    expect(re(sync?.matcher).test("exec")).toBe(false);
    expect(re(log?.matcher).test("run_subagent")).toBe(true);
    expect(re(log?.matcher).test("read_subagent")).toBe(false);
    expect(re(humanTurn?.matcher).test("ask_user_question")).toBe(true);
    expect(re(humanTurn?.matcher).test("exec")).toBe(false);
    expect(re(rebuild?.matcher).test("exec")).toBe(true);
    expect(re(rebuild?.matcher).test("get_output")).toBe(false);

    // PreToolUse deliver-stage-rules matcher is anchored to run_subagent only.
    const deliver = pre.find((g) =>
      g.hooks.some((h) => h.command.endsWith("deliver-stage-rules")),
    );
    expect(deliver).toBeDefined();
    expect(re(deliver?.matcher).test("run_subagent")).toBe(true);
    expect(re(deliver?.matcher).test("read_subagent")).toBe(false);
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

  test("6: rules/aidlc.md — no @-import, mentions the memory dir, has always_on trigger", () => {
    const stub = readFileSync(join(ENGINE, "rules", "aidlc.md"), "utf-8");
    expect(stub).not.toMatch(/^@/m);
    // S03: the pointer names the active-space memory dir AND the default seed.
    expect(stub).toContain("aidlc/spaces/<active-space>/memory/");
    expect(stub).toContain("aidlc/spaces/default/memory/");
    // S03: explicit always_on trigger frontmatter (Devin loads rules with this).
    expect(stub).toMatch(/^trigger:\s*always_on/m);
    // S03: the pointer is NOT an import — it names the dir but does not claim
    // to pull memory contents into ambient context.
    expect(stub).toContain("pointer");
    // S03: mentions the active-space cursor and default seed.
    expect(stub).toContain("aidlc/active-space");
    expect(stub).toContain("default");
    // S11: no overstated guarantees.
    expect(stub).not.toMatch(/identical on every harness/i);
  });

  test("7: AGENTS.md — no @-import directives, mentions /aidlc --status, no Claude references", () => {
    const agents = readFileSync(join(DEVIN_ROOT, "AGENTS.md"), "utf-8");
    expect(agents).not.toMatch(/^@/m);
    expect(agents).toContain("/aidlc --status");
    expect(agents).not.toContain("companyAnnouncements");
    expect(agents).not.toContain("CLAUDE.md");
  });

  // S11: onboarding reduction — Devin AGENTS.md must be <= 12KiB (12288 bytes)
  // UTF-8, with no duplicate DocumentKB prose and no overstated guarantees.
  test("7b: AGENTS.md onboarding size <= 12KiB (12288 bytes) UTF-8", () => {
    const agents = readFileSync(join(DEVIN_ROOT, "AGENTS.md"));
    expect(agents.length).toBeLessThanOrEqual(12288);
  });

  test("7c: AGENTS.md has no duplicate DocumentKB section", () => {
    const agents = readFileSync(join(DEVIN_ROOT, "AGENTS.md"), "utf-8");
    // The DocumentKB bullet should appear exactly once (was duplicated before S11).
    const count = (agents.match(/Document knowledge \(DocumentKB\)/g) ?? []).length;
    expect(count).toBe(1);
  });

  test("7d: AGENTS.md does not overstate guarantees (no 'identical on every harness' in onboarding)", () => {
    // The runbook flagged overstatement. The compressed onboarding should not
    // claim the method is "identical on every harness" (it is layered and
    // space-specific). This phrase was removed in S11.
    const agents = readFileSync(join(DEVIN_ROOT, "AGENTS.md"), "utf-8");
    expect(agents).not.toMatch(/identical on every harness/i);
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

  // S04: Devin persona frontmatter projection — strip display_name, examples,
  // disallowedTools, maxTurns from Devin agent .md files. Other harnesses keep
  // these fields. The authored core/agents/*.md files are unchanged.
  test("11: Devin agents strip unsupported frontmatter fields (display_name, examples, disallowedTools, maxTurns)", () => {
    const agentsDir = join(ENGINE, "agents");
    expect(existsSync(agentsDir)).toBe(true);
    const agentFiles = readdirSync(agentsDir).filter(
      (f) => f.endsWith("-agent.md") && f !== "aidlc.md",
    );
    expect(agentFiles.length).toBeGreaterThanOrEqual(14);
    for (const f of agentFiles) {
      const body = readFileSync(join(agentsDir, f), "utf-8");
      const m = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      expect(m, `${f}: no frontmatter block`).not.toBeNull();
      const fm = m![1];
      // Stripped fields must be absent from the frontmatter block.
      expect(fm, `${f}: display_name still in Devin frontmatter`).not.toMatch(/^display_name:/m);
      expect(fm, `${f}: examples still in Devin frontmatter`).not.toMatch(/^examples:/m);
      expect(fm, `${f}: disallowedTools still in Devin frontmatter`).not.toMatch(/^disallowedTools:/m);
      expect(fm, `${f}: maxTurns still in Devin frontmatter`).not.toMatch(/^maxTurns:/m);
      // Preserved fields must remain.
      expect(fm, `${f}: name stripped`).toMatch(/^name:\s*aidlc-/m);
      expect(fm, `${f}: description stripped`).toMatch(/^description:/m);
      // Body must still carry the persona content (not just frontmatter).
      expect(body.length).toBeGreaterThan(200);
    }
  });

  test("12: Claude agents retain unsupported-by-Devin fields (no projection leakage)", () => {
    const claudeAgents = join(CLAUDE_SRC, "agents");
    expect(existsSync(claudeAgents)).toBe(true);
    const productAgent = readFileSync(join(claudeAgents, "aidlc-product-agent.md"), "utf-8");
    const fm = productAgent.match(/^---\r?\n([\s\S]*?)\r?\n---/)![1];
    expect(fm).toMatch(/^display_name:\s*Product Agent/m);
    expect(fm).toMatch(/^examples:/m);
    expect(fm).toMatch(/^disallowedTools:\s*Task/m);
    // The architecture-reviewer has maxTurns in core; Claude keeps it.
    const reviewer = readFileSync(join(claudeAgents, "aidlc-architecture-reviewer-agent.md"), "utf-8");
    const reviewerFm = reviewer.match(/^---\r?\n([\s\S]*?)\r?\n---/)![1];
    expect(reviewerFm).toMatch(/^maxTurns:\s*60/m);
  });

  test("13: Devin agent body content unchanged by projection (examples text in body survives)", () => {
    // The developer agent body mentions "error-handling" (an examples entry)
    // in prose — the strip only removes the frontmatter examples: block, not
    // body prose. Verify body content is intact.
    const dev = readFileSync(join(ENGINE, "agents", "aidlc-developer-agent.md"), "utf-8");
    // The body should still contain the persona heading and core responsibilities.
    expect(dev).toContain("# Developer Agent");
    // The frontmatter examples list (db-conventions.md, error-handling.md) is
    // stripped from frontmatter but those words may appear in body prose.
    // The key invariant: no examples: KEY in frontmatter.
    const fm = dev.match(/^---\r?\n([\s\S]*?)\r?\n---/)![1];
    expect(fm).not.toMatch(/^examples:/m);
  });

  // S03: invocation and rule activation — generated runners carry triggers: [user],
  // standalone skills (knowledge, outcomes-pack) carry triggers: [user], and the
  // rules stub has trigger: always_on. Read-only skills (replay, session-cost)
  // are NOT modified — they keep their existing user-invocable: true field.
  test("14: generated stage runners carry triggers: [user] (Devin invocation metadata)", () => {
    const skillsDir = join(ENGINE, "skills");
    expect(existsSync(skillsDir)).toBe(true);
    // Sample a few generated runners.
    const runners = ["aidlc-domain-design", "aidlc-code-generation", "aidlc-init", "aidlc-feature"];
    for (const r of runners) {
      const path = join(skillsDir, r, "SKILL.md");
      expect(existsSync(path), `${r}/SKILL.md missing`).toBe(true);
      const body = readFileSync(path, "utf-8");
      const fm = body.match(/^---\r?\n([\s\S]*?)\r?\n---/)![1];
      expect(fm, `${r}: no triggers: [user] in frontmatter`).toMatch(/^triggers:\s*\[user\]/m);
    }
  });

  test("15: standalone skills (knowledge, outcomes-pack) carry triggers: [user]", () => {
    for (const skill of ["aidlc-knowledge", "aidlc-outcomes-pack"]) {
      const path = join(ENGINE, "skills", skill, "SKILL.md");
      const body = readFileSync(path, "utf-8");
      const fm = body.match(/^---\r?\n([\s\S]*?)\r?\n---/)![1];
      expect(fm, `${skill}: no triggers: [user]`).toMatch(/^triggers:\s*\[user\]/m);
    }
  });

  test("16: read-only skills (replay, session-cost) do NOT carry triggers: (preserved as-is)", () => {
    // Row 5: preserve current triggers for read-only aidlc-replay and
    // aidlc-session-cost. They use user-invocable: true, not triggers:.
    for (const skill of ["aidlc-replay", "aidlc-session-cost"]) {
      const path = join(ENGINE, "skills", skill, "SKILL.md");
      const body = readFileSync(path, "utf-8");
      const fm = body.match(/^---\r?\n([\s\S]*?)\r?\n---/)![1];
      expect(fm, `${skill}: should NOT have triggers: (row 5 preserves existing)`).not.toMatch(/^triggers:/m);
      expect(fm, `${skill}: user-invocable: true should be present`).toMatch(/^user-invocable:\s*true/m);
    }
  });

  test("17: harness.json carries runnerFrontmatterAdditions with triggers: [user]", () => {
    const harnessJson = JSON.parse(
      readFileSync(join(ENGINE, "tools", "data", "harness.json"), "utf-8"),
    ) as Record<string, unknown>;
    const additions = harnessJson.runnerFrontmatterAdditions;
    expect(Array.isArray(additions)).toBe(true);
    expect((additions as string[]).some((l) => l.includes("triggers"))).toBe(true);
  });

  test("18: rules/aidlc.md is a pointer, not an import (no memory file contents inlined)", () => {
    const stub = readFileSync(join(ENGINE, "rules", "aidlc.md"), "utf-8");
    // The pointer names the directory but does not inline org.md/team.md content.
    // It should NOT contain the actual memory file headings (those live in the
    // memory files themselves, loaded by the engine at runtime).
    expect(stub).not.toContain("# Organization");
    expect(stub).not.toContain("# Team Practices");
    // It SHOULD explain that the engine resolves memory at runtime.
    expect(stub).toContain("engine");
    expect(stub.toLowerCase()).toContain("resolver");
  });
});
