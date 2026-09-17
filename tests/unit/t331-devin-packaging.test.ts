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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { trustedCommand } from "../../core/tools/aidlc-command.ts";
import { HARNESS_HONESTY } from "../../core/tools/aidlc-model-policy.ts";
import manifest from "../../harness/devin/manifest.ts";

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
    expect(r.stdout + r.stderr).toContain(
      "deterministic across two independent build(s) for devin",
    );
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
        // Normalize the {{INVOKE}} token substitution: devin gets
        // `bun .devin/tools/aidlc.ts`, claude gets `bun .claude/tools/aidlc.ts`.
        let devin = readFileSync(file, "utf-8");
        devin = devin.replaceAll("bun .devin/tools/", "bun .claude/tools/");
        devin = devin.replaceAll('.replaceAll(".devin", harnessDir)', '.replaceAll(".claude", harnessDir)');
        expect(devin).toBe(readFileSync(claudeTwin, "utf-8"));
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

  test("4: config.json has allow-only framework permissions in copy and native projections", () => {
    const allow = [
      "Read(**)", "edit", "write", "grep", "glob",
      "Exec(bun .devin/tools/*)", "Exec(bun run .devin/tools/*)",
      "Exec(date -u)", "run_subagent", "ask_user_question", "web_search", "webfetch",
    ];
    const nativeAllow = [
      ...allow.filter((entry) => !entry.startsWith("Exec(bun ")),
      `Exec(${trustedCommand()})`,
    ];
    for (const [path, expectedAllow] of [
      [join(REPO_ROOT, "harness", "devin", "config.json"), allow],
      [join(ENGINE, "config.json"), allow],
      [join(REPO_ROOT, "dist-release", "devin", ".devin", "config.json"), nativeAllow],
    ] as const) {
      const config = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
      expect(config.permissions, path).toEqual({ allow: expectedAllow });
      expect(config.read_config_from, path).toEqual({ cursor: false, windsurf: false, claude: false });
      // No inference/config keys at the top level.
      for (const key of ["model", "env", "effort", "agent", "statusLine", "theme_mode"]) {
        expect(key in config, `${path}: config.json must not carry top-level "${key}"`).toBe(false);
      }
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
    const ctx = mcp.mcpServers.context7!;
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
    for (const [name, server] of Object.entries(mcp.mcpServers)) {
      expect(server.disabled, `${name} disabled`).toBe(true);
      expect(Object.keys(server).at(-1), `${name} key order`).toBe("disabled");
    }
  });

  test("5b: MCP defaults survive copy and release packaging and match Kiro", () => {
    type McpConfig = { mcpServers: Record<string, Record<string, unknown>> };
    const paths = [
      join(REPO_ROOT, "harness", "devin", "mcp_config.json"),
      join(ENGINE, "mcp_config.json"),
      join(REPO_ROOT, "dist-release", "devin", ".devin", "mcp_config.json"),
    ];
    const configs = paths.map((path) => {
      expect(existsSync(path), path).toBe(true);
      const config = JSON.parse(readFileSync(path, "utf-8")) as McpConfig;
      expect(Object.keys(config.mcpServers).sort(), path).toEqual(
        ["aws-iac", "aws-mcp", "aws-pricing", "aws-serverless", "context7"],
      );
      for (const [name, server] of Object.entries(config.mcpServers)) {
        expect(server.disabled, `${path}: ${name} disabled`).toBe(true);
        expect(Object.keys(server).at(-1), `${path}: ${name} key order`).toBe("disabled");
      }
      return config;
    });
    const [authored, copy, release] = configs;
    expect(copy).toEqual(authored);
    expect(release).toEqual(authored);
    const kiro = JSON.parse(readFileSync(
      join(REPO_ROOT, "harness", "kiro", "settings", "mcp.json"), "utf-8",
    )) as McpConfig;
    for (const name of ["aws-mcp", "aws-pricing", "aws-iac", "aws-serverless"]) {
      const server = authored.mcpServers[name];
      expect(server, name).toEqual(kiro.mcpServers[name]);
      expect((server.args as string[])[0], `${name} launcher`).toEndWith("@latest");
    }
    const context7 = authored.mcpServers.context7;
    expect(context7.url).toBe(kiro.mcpServers.context7.url);
    expect(context7.disabled).toBe(kiro.mcpServers.context7.disabled);
    expect(context7.headers).toEqual({ CONTEXT7_API_KEY: `\${CONTEXT7_API_KEY}` });
    expect("type" in context7).toBe(false);
    expect("command" in context7).toBe(false);
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

  // S11: onboarding reduction — Devin AGENTS.md must be <= 16KiB (16384 bytes)
  // UTF-8, with no duplicate DocumentKB prose and no overstated guarantees.
  // (Limit raised from 12KiB to 16KiB after upstream 2.8.x grew the shared
  // onboarding template's Structure section; Devin-specific fills are still
  // trimmed — no bun prereq, no AI-DLC Method resumption section.)
  test("7b: AGENTS.md onboarding size <= 16KiB (16384 bytes) UTF-8", () => {
    const agents = readFileSync(join(DEVIN_ROOT, "AGENTS.md"));
    expect(agents.length).toBeLessThanOrEqual(16384);
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

  test("7e: MCP onboarding explains default-off and per-server activation", () => {
    for (const root of [DEVIN_ROOT, join(REPO_ROOT, "dist-release", "devin")]) {
      const agents = readFileSync(join(root, "AGENTS.md"), "utf-8");
      expect(agents).toContain("All five MCP servers are disabled by default.");
      expect(agents).toContain("enable selected entries with `disabled: false`");
    }
  });

  test("7f: Devin onboarding describes scoped permissions without blanket MCP approval", () => {
    for (const root of [DEVIN_ROOT, join(REPO_ROOT, "dist-release", "devin")]) {
      const agents = readFileSync(join(root, "AGENTS.md"), "utf-8");
      expect(agents).toContain("MCP tool calls are not blanket-pre-approved");
      expect(agents).toContain("not a general destructive-command security boundary");
      expect(agents).not.toContain("all MCP tools");
      expect(agents).not.toContain("Review the broad `mcp__*` permission grant");
      expect(agents).toContain(root === DEVIN_ROOT
        ? "`bun .devin/tools/*`"
        : `\`${trustedCommand()}\``);
    }
  });

  test("8: harness.json identity — name === devin, harnessDir === .devin", () => {
    const harness = JSON.parse(
      readFileSync(join(ENGINE, "tools", "data", "harness.json"), "utf-8"),
    ) as { name: string; harnessDir: string };
    expect(harness.name).toBe("devin");
    expect(harness.harnessDir).toBe(".devin");
  });

  test("9: doctor gates on Devin hook execution evidence (absent marker fails; adapter run passes; invalid marker fails)", () => {
    const root = mkdtempSync(join(tmpdir(), "t331-devin-doctor-"));
    try {
      const project = join(root, "project");
      cpSync(DEVIN_ROOT, project, { recursive: true });
      const markerPath = join(project, ".devin", ".aidlc-session-start.local.json");
      const runDoctor = () => {
        const r = spawnSync(
          "bun",
          [join(project, ".devin", "tools", "aidlc-utility.ts"), "doctor", "--verbose", "--project-dir", project],
          {
            cwd: project,
            encoding: "utf-8",
            env: { ...process.env, AIDLC_HARNESS_DIR: ".devin" },
          },
        );
        return { status: r.status, output: `${r.stdout}${r.stderr}` };
      };
      let { status, output } = runDoctor();
      expect(status, output).toBe(1);
      expect(output).toContain("Devin hook execution evidence: no valid SessionStart marker");
      expect(output).toContain("/hooks");
      expect(output).toContain("fully restart Devin CLI");
      expect(existsSync(markerPath)).toBe(false);
      // Devin-specific rows.
      expect(output).toContain("aidlc-devin-adapter.ts present");
      expect(output).toContain("hooks.v1.json present");
      expect(output).toContain("config.json present");
      expect(output).toContain("mcp_config.json present");
      expect(output).toContain("rules/aidlc.md present");
      expect(output).toContain("devin CLI version");
      // The Claude settings.json fallback must NOT appear.
      expect(output).not.toContain("settings.json present");

      const a = spawnSync(
        "bun",
        [join(project, ".devin", "hooks", "aidlc-devin-adapter.ts"), "session-start"],
        {
          cwd: project,
          input: JSON.stringify({ hook_event_name: "SessionStart", cwd: project }),
          encoding: "utf-8",
          env: { ...process.env, DEVIN_PROJECT_DIR: project, CLAUDE_PROJECT_DIR: undefined },
        },
      );
      expect(a.status, `${a.stdout}${a.stderr}`).toBe(0);
      expect(existsSync(markerPath)).toBe(true);
      const marker = JSON.parse(readFileSync(markerPath, "utf-8")) as { lastRun?: unknown };
      expect(typeof marker.lastRun).toBe("string");
      expect(new Date(marker.lastRun as string).toISOString()).toBe(marker.lastRun as string);

      ({ status, output } = runDoctor());
      expect(status, output).toBe(0);
      expect(output).toContain("Devin hook execution evidence: SessionStart last ran");
      expect(output).toContain("current hook approval is not verified");
      expect(output).toContain("Devin subagent model:");
      expect(output).toContain("Default subagent model");
      expect(output).toContain("SWE-1.6");
      expect(output).toContain("effective organization setting/model not inspected");
      expect(output).toContain("None disables subagents");

      const jsonRun = spawnSync(
        "bun",
        [join(project, ".devin", "tools", "aidlc-doctor.ts"), "--json", "--offline", "--project-dir", project],
        {
          cwd: project,
          encoding: "utf-8",
          env: { ...process.env, AIDLC_HARNESS_DIR: ".devin" },
        },
      );
      expect(jsonRun.status, `${jsonRun.stdout}${jsonRun.stderr}`).toBe(0);
      const envelope = JSON.parse(jsonRun.stdout) as {
        data: {
          checks: Array<{ pass: boolean; severity?: string; label: string }>;
          warnings: number;
          failed: number;
        };
      };
      const advisory = envelope.data.checks.filter((check) =>
        check.label.startsWith("Devin subagent model:"),
      );
      expect(advisory.length).toBe(1);
      expect(advisory[0]!.pass).toBe(false);
      expect(advisory[0]!.severity).toBe("warn");
      expect(envelope.data.warnings).toBeGreaterThanOrEqual(1);
      expect(envelope.data.failed).toBe(0);

      for (const bad of ["", "not-json", "null", "{}", '{"lastRun":123}', '{"lastRun":"not-a-date"}']) {
        writeFileSync(markerPath, bad, "utf-8");
        ({ status, output } = runDoctor());
        expect(status, `marker=${JSON.stringify(bad)}\n${output}`).toBe(1);
        expect(output).toContain("Devin hook execution evidence: no valid SessionStart marker");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("9b: shipped devin trees carry no marker and ignore it via the shipped .gitignore", () => {
    for (const root of [DEVIN_ROOT, join(REPO_ROOT, "dist-release", "devin")]) {
      expect(existsSync(join(root, ".devin", ".aidlc-session-start.local.json")), root).toBe(false);
      const gitignore = readFileSync(join(root, ".gitignore"), "utf-8");
      expect(gitignore.split(/\r?\n/), root).toContain(".devin/.aidlc-session-start.local.json");
    }
    const proj = mkdtempSync(join(tmpdir(), "t331-devin-gitignore-"));
    try {
      const init = spawnSync("git", ["init"], { cwd: proj, encoding: "utf-8" });
      expect(init.status, `${init.stdout}${init.stderr}`).toBe(0);
      cpSync(join(DEVIN_ROOT, ".gitignore"), join(proj, ".gitignore"));
      const r = spawnSync(
        "git",
        ["check-ignore", "--no-index", ".devin/.aidlc-session-start.local.json"],
        { cwd: proj, encoding: "utf-8" },
      );
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    } finally {
      rmSync(proj, { recursive: true, force: true });
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

  // Devin retains the authored persona frontmatter fields, matching core and
  // Claude modulo tier/model projection. Native CFG005 warnings are expected.
  test("11: Devin agents retain authored frontmatter fields (display_name, examples, disallowedTools, maxTurns)", () => {
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
      const core = readFileSync(join(REPO_ROOT, "core", "agents", f), "utf-8");
      const coreFm = core.match(/^---\r?\n([\s\S]*?)\r?\n---/)![1];
      const claude = readFileSync(join(CLAUDE_SRC, "agents", f), "utf-8");
      const claudeFm = claude.match(/^---\r?\n([\s\S]*?)\r?\n---/)![1];
      const withoutTierProjection = (frontmatter: string) => frontmatter
        .split(/\r?\n/)
        .filter((line) => !/^(?:tier|model|effort|variant|allowed-tools):/.test(line))
        .join("\n");
      for (const field of ["display_name", "examples", "disallowedTools", "maxTurns"]) {
        const key = new RegExp(`^${field}:`, "m");
        expect(key.test(fm), `${f}: ${field} differs from core`).toBe(key.test(coreFm));
      }
      expect(withoutTierProjection(fm), `${f}: frontmatter differs from core`).toBe(withoutTierProjection(coreFm));
      expect(withoutTierProjection(fm), `${f}: frontmatter differs from Claude`).toBe(withoutTierProjection(claudeFm));
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
    expect(fm).not.toMatch(/^allowed-tools:/m);
    // The architecture-reviewer has maxTurns in core; Claude keeps it.
    const reviewer = readFileSync(join(claudeAgents, "aidlc-architecture-reviewer-agent.md"), "utf-8");
    const reviewerFm = reviewer.match(/^---\r?\n([\s\S]*?)\r?\n---/)![1];
    expect(reviewerFm).toMatch(/^maxTurns:\s*60/m);
  });

  test("13: Devin developer agent retains frontmatter examples and body content", () => {
    // Both the frontmatter examples list and persona body remain intact.
    const dev = readFileSync(join(ENGINE, "agents", "aidlc-developer-agent.md"), "utf-8");
    // The body should still contain the persona heading and core responsibilities.
    expect(dev).toContain("# Developer Agent");
    const fm = dev.match(/^---\r?\n([\s\S]*?)\r?\n---/)![1];
    expect(fm).toMatch(/^examples:/m);
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

  test("9c: a Claude install gets no Devin subagent-model advisory", () => {
    const root = mkdtempSync(join(tmpdir(), "t331-claude-doctor-"));
    try {
      const project = join(root, "project");
      cpSync(join(REPO_ROOT, "dist", "claude"), project, { recursive: true });
      const r = spawnSync(
        "bun",
        [join(project, ".claude", "tools", "aidlc-doctor.ts"), "--json", "--offline", "--project-dir", project],
        {
          cwd: project,
          encoding: "utf-8",
          env: { ...process.env, AIDLC_HARNESS_DIR: ".claude" },
        },
      );
      const envelope = JSON.parse(r.stdout) as {
        data: { checks: Array<{ label: string }> };
      };
      expect(
        envelope.data.checks.filter((check) =>
          check.label.startsWith("Devin subagent model:"),
        ).length,
      ).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("19: all 14 core Devin profiles carry the native allowed-tools allowlist", () => {
    const expectedTools = ["read", "write", "edit", "apply_patch", "notebook_read", "notebook_edit", "grep", "glob", "exec", "get_output", "write_to_process", "kill_shell", "web_search", "webfetch", "todo_write", "request_scope", "mcp_list_servers", "mcp_list_tools", "mcp_call_tool", "mcp_read_resource"];
    const coreDir = join(REPO_ROOT, "core", "agents");
    const coreFiles = readdirSync(coreDir).filter((file) => file.endsWith("-agent.md")).sort();
    expect(coreFiles.length).toBe(14);
    expect(manifest.frontmatterAdditions!.filter(({ file }) => file.startsWith("agents/")).map(({ file }) => file.slice("agents/".length)).sort()).toEqual(coreFiles);
    for (const root of [ENGINE, join(REPO_ROOT, "dist-release", "devin", ".devin")]) {
      const invoke = root === ENGINE ? "bun .devin/tools/aidlc.ts" : "aidlc";
      for (const file of coreFiles) {
        const raw = readFileSync(join(root, "agents", file), "utf-8");
        const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)!;
        const fm = Bun.YAML.parse(match[1]) as Record<string, unknown>;
        expect(fm["allowed-tools"], `${root}/${file}`).toEqual(expectedTools);
        expect([...match[1].matchAll(/^allowed-tools:/gm)].length).toBe(1);
        for (const key of ["tools", "model", "max-nesting"]) expect(key in fm).toBe(false);
        const core = readFileSync(join(coreDir, file), "utf-8");
        const coreMatch = core.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)!;
        const coreFm = Bun.YAML.parse(coreMatch[1]) as Record<string, unknown>;
        const withoutProjection = (fields: Record<string, unknown>) => Object.fromEntries(
          Object.entries(fields).filter(([key]) => !["tier", "model", "effort", "variant", "allowed-tools"].includes(key)),
        );
        expect(withoutProjection(fm), `${root}/${file}: authored metadata`).toEqual(withoutProjection(coreFm));
        const body = raw
          .slice(match[0].length)
          .replace(/^<!-- aidlc-delegated-knowledge-preflight -->\r?\n[^\n]*\r?\n\r?\n/, "")
          .split("\n---\n\n<!-- Absorbed at build time")[0]!;
        const coreBody = core
          .slice(coreMatch[0].length)
          .replaceAll("{{HARNESS_DIR}}", ".devin")
          .replaceAll("{{INVOKE}}", invoke);
        expect(body.trimEnd()).toBe(coreBody.trimEnd());
      }
    }
  });

  test("20: no other harness's agent tree carries the Devin allowlist", () => {
    const allowlistLine = "allowed-tools: [read, write, edit, apply_patch, notebook_read, notebook_edit, grep, glob, exec, get_output, write_to_process, kill_shell, web_search, webfetch, todo_write, request_scope, mcp_list_servers, mcp_list_tools, mcp_call_tool, mcp_read_resource]";
    const harnessDirs = [".claude", ".kiro", ".codex", ".aidlc", ".cursor", ".github"];
    const offenders: string[] = [];
    for (const distRoot of ["dist", "dist-release"]) {
      for (const harness of readdirSync(join(REPO_ROOT, distRoot))) {
        if (harness === "devin" || harness === "plugins") continue;
        const harnessRoot = join(REPO_ROOT, distRoot, harness);
        for (const dirName of harnessDirs) {
          const agentsDir = join(harnessRoot, dirName, "agents");
          if (!existsSync(agentsDir)) continue;
          for (const file of walk(agentsDir)) {
            if (readFileSync(file, "utf-8").includes(allowlistLine)) {
              offenders.push(file);
            }
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("21: Devin onboarding explains the subagent model policy and native allowlist", () => {
    for (const root of [DEVIN_ROOT, join(REPO_ROOT, "dist-release", "devin")]) {
      const agents = readFileSync(join(root, "AGENTS.md"), "utf-8");
      expect(agents).toContain("Default subagent model");
      expect(agents).toContain("SWE-1.6");
      expect(agents).toContain("not automatic parent-model inheritance");
      expect(agents).toContain("does not inspect the effective organization setting/model");
      expect(agents).toContain("**None** disables subagents");
      expect(agents).toContain("a Devin-native `allowed-tools` list without `run_subagent`, `read_subagent`, or `skill`");
      expect(agents).toContain("the parent conductor owns delegation");
      expect(agents).toContain("subject to their `allowed-tools` lists and host permissions");
      expect(agents).not.toContain("subject to their `tools:` allowlists");
    }
  });

  test("22: model-policy honesty names the default subagent model, not session inheritance", () => {
    const message = HARNESS_HONESTY.devin.message;
    expect(message).toContain("default subagent model");
    expect(message).not.toContain("Devin CLI inherits the session model");
  });
});
