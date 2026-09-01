// t331-devin-packaging.test.ts — the Devin distribution's shipped-shape contract.
//
// Every assertion here encodes a defect that was MEASURED during the port, not a
// stylistic preference. The comments name the failure each one prevents, because a
// guard whose reason is undocumented gets deleted by the next person who finds it
// inconvenient.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = join(REPO_ROOT, "dist", "devin");
const TREE = join(DIST, ".devin");

// Devin's documented matchable tool names (docs.devin.ai/cli/extensibility/hooks/
// lifecycle-hooks § "Tool names you can match").
const DEVIN_TOOLS = new Set([
  "read", "write", "edit", "apply_patch", "notebook_read", "notebook_edit",
  "grep", "glob", "exec", "get_output", "write_to_process", "kill_shell",
  "webfetch", "todo_write", "exit_plan_mode", "skill", "run_subagent",
  "read_subagent", "request_scope", "mcp_list_servers", "mcp_list_tools",
  "mcp_call_tool", "mcp_read_resource",
]);

// The eight events Devin supports. NOT present: SubagentStop, PreCompact,
// Notification (Claude Code has all three; Devin has none of them).
const DEVIN_EVENTS = new Set([
  "PreToolUse", "PostToolUse", "PermissionRequest", "UserPromptSubmit",
  "Stop", "PostCompaction", "SessionStart", "SessionEnd",
]);

const DEVIN_MODELS = new Set(["opus", "sonnet", "swe", "codex", "gemini"]);

function hooksConfig(): Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>> {
  return JSON.parse(readFileSync(join(TREE, "hooks.v1.json"), "utf-8"));
}

describe("devin distribution shape", () => {
  test("the tree exists with Devin's own harness identity", () => {
    // The projection attempt renamed .codex/ -> .devin/ but left harness.json
    // declaring {"name":"codex","harnessDir":".codex"}, so the engine looked for a
    // directory that no longer existed. Declaring identity is the whole reason this
    // is a harness rather than a copied dist.
    const hj = JSON.parse(readFileSync(join(TREE, "tools", "data", "harness.json"), "utf-8"));
    expect(hj.name).toBe("devin");
    expect(hj.harnessDir).toBe(".devin");
    expect(existsSync(join(DIST, hj.harnessDir))).toBe(true);
  });

  test("AGENTS.md is at the dist root and under Devin's 32 KiB always-on cap", () => {
    // Devin CLI caps an always-on rule file at 32 KiB and TRUNCATES the overflow
    // with a path hint rather than erroring (CLI changelog v2026.4.17-0). The V1
    // Windsurf package shipped a 135,044-byte AGENTS.md = 4.1x the cap, so ~3/4 of
    // the methodology silently never reached the model.
    const p = join(DIST, "AGENTS.md");
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p).byteLength).toBeLessThan(32768);
  });

  test("AGENTS.md orients the user, since Devin has no companyAnnouncements", () => {
    // Claude Code renders a start-of-session banner from its `companyAnnouncements`
    // setting. Devin has no equivalent, so the orientation has to be in AGENTS.md
    // or a first-time user sees no prompt to run anything.
    const md = readFileSync(join(DIST, "AGENTS.md"), "utf-8");
    expect(md).toContain("/aidlc");
    expect(md).not.toContain("$aidlc"); // Codex's prefix; Devin invokes with /
  });

  test("skills live in exactly one location", () => {
    // Devin stopped deduplicating same-named skills in CLI v3000.2.17: copies from
    // two locations surface with prefixes (/devin:aidlc vs /agents:aidlc) instead,
    // so a "belt and braces" mirror ships every skill twice.
    const roots = ["skills", ".agents/skills", ".github/skills", ".windsurf/skills"]
      .filter((r) => existsSync(join(r.startsWith(".") ? DIST : TREE, r)));
    expect(roots).toEqual(["skills"]);
    expect(readdirSync(join(TREE, "skills")).length).toBeGreaterThan(30);
  });

  test("no Cascade-only surfaces ship", () => {
    // Workflows are read only by Cascade — the legacy IDE agent, disabled by
    // default for enterprises since 2026-08-07 — and are explicitly excluded from
    // Devin's skill import. Shipping them aims at an agent the package cannot drive.
    for (const d of ["workflows", "memories"]) {
      expect(existsSync(join(TREE, d))).toBe(false);
    }
  });
});

  test("the method include lives in AGENTS.md, not .devin/rules/", () => {
    // MEASURED on CLI v3000.4.25: `devin rules paths` reports ONLY
    // `.windsurf/rules/*.md` as the always-on rule directory — not `.devin/rules/`,
    // despite the docs calling .devin/ preferred. A pointer placed there may never
    // load. AGENTS.md is documented AND observed as Devin's primary rules file on
    // all three surfaces, and it is the surface aidlc-includes.ts repoints on a
    // space switch (same rewriter Copilot uses).
    expect(existsSync(join(TREE, "rules"))).toBe(false);
    const md = readFileSync(join(DIST, "AGENTS.md"), "utf-8");
    const pointers = md.split("\n").filter((l) => l.startsWith("@aidlc/spaces/"));
    expect(pointers.length).toBe(7); // org, team, project + 4 phases
    expect(pointers).toContain("@aidlc/spaces/default/memory/org.md");
  });

describe("devin hooks.v1.json", () => {
  test("the hooks object is the whole file, with no wrapper key", () => {
    // hooks.v1.json is the one location where the hooks object IS the document;
    // every other location (config.json, .claude/settings.json) nests it under a
    // "hooks" key. Wrapping it here makes the file load and fire nothing.
    const cfg = hooksConfig();
    expect(cfg.hooks).toBeUndefined();
    expect(Object.keys(cfg).length).toBeGreaterThan(0);
  });

  test("every event is one Devin supports", () => {
    for (const ev of Object.keys(hooksConfig())) expect(DEVIN_EVENTS.has(ev)).toBe(true);
  });

  test("PreCompact and SubagentStop are absent — Devin has neither", () => {
    // Recorded as a shipped LIMITATION, not an oversight: PostCompaction fires
    // after a successful compaction (so state validation cannot veto one), and no
    // per-subagent completion event exists at all.
    const cfg = hooksConfig();
    expect(cfg.PreCompact).toBeUndefined();
    expect(cfg.SubagentStop).toBeUndefined();
    expect(cfg.PostCompaction).toBeDefined();
  });

  test("every matcher token is a documented Devin tool name", () => {
    // THE silent-failure guard. Devin's tool names are lowercase snake_case; a
    // matcher carrying Claude's names ("Bash", "Edit|Write", "Task") loads, never
    // matches, and reports nothing — enforcement that looks installed and is inert.
    for (const [ev, groups] of Object.entries(hooksConfig())) {
      for (const g of groups) {
        for (const tok of g.matcher?.match(/[a-z_]+/g) ?? []) {
          expect(DEVIN_TOOLS.has(tok), `${ev} matcher token "${tok}"`).toBe(true);
        }
      }
    }
  });

  test("hook commands are relative and carry no env var", () => {
    // dist/claude wires all 16 hook commands through "$CLAUDE_PROJECT_DIR", which
    // Devin never sets (it sets DEVIN_PROJECT_DIR), so each would resolve to
    // bun "/.claude/hooks/..." and fail. Relative paths sidestep the whole question.
    for (const groups of Object.values(hooksConfig())) {
      for (const g of groups) {
        for (const h of g.hooks) {
          expect(h.command).not.toMatch(/\$[A-Za-z_]/);
          expect(h.command.startsWith("bun .devin/hooks/")).toBe(true);
        }
      }
    }
  });

  test("every referenced adapter subcommand has a handler, and its core hook ships", () => {
    // A hook wired to a subcommand the adapter does not implement fires into a
    // no-op. Both halves are checked: the adapter's dispatch table and the core
    // hook file it delegates to.
    const adapter = readFileSync(join(TREE, "hooks", "aidlc-devin-adapter.ts"), "utf-8");
    for (const groups of Object.values(hooksConfig())) {
      for (const g of groups) {
        for (const h of g.hooks) {
          const sub = h.command.split(" ").pop()!;
          expect(adapter, `adapter handler for "${sub}"`).toContain(`"${sub}":`);
        }
      }
    }
    // Every file the CORE dispatch table names must ship in hooks/. Derived from
    // the table's own entries rather than a whole-file `aidlc-*.ts` regex: the
    // loose form also swept up the adapter's `../tools/aidlc-lib.ts` import and
    // demanded it in hooks/, which is the wrong directory and not a hook at all.
    for (const [, file] of adapter.matchAll(/^\s*"[a-z-]+":\s*\{\s*file:\s*"(aidlc-[a-z-]+\.ts)"/gm)) {
      expect(existsSync(join(TREE, "hooks", file)), `core hook ${file}`).toBe(true);
    }
    // Anything the adapter imports from ../tools/ must ship there. This is the
    // half the old regex was accidentally asserting in the wrong place.
    for (const [, file] of adapter.matchAll(/from "\.\.\/tools\/(aidlc-[a-z-]+\.ts)"/g)) {
      expect(existsSync(join(TREE, "tools", file)), `imported tool ${file}`).toBe(true);
    }
  });
});

describe("devin subagent profiles", () => {
  test("every persona names a Devin model explicitly", () => {
    // A Devin subagent profile whose model is absent or unrecognised runs on
    // Devin's DEFAULT SUBAGENT MODEL, not the session model — so judgment-tier work
    // silently downshifts. tierFlavor "claude" emits `model: inherit`, which is a
    // Claude sentinel and not a Devin model name, so emit() replaces it.
    const dir = join(TREE, "agents");
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const m = readFileSync(join(dir, f), "utf-8").match(/^model:\s*(\S+)\s*$/m);
      expect(m, `${f} has a model: line`).not.toBeNull();
      expect(DEVIN_MODELS.has(m![1]), `${f} model "${m![1]}"`).toBe(true);
    }
  });
});

describe("devin harness re-identification", () => {
  test("the shipped .gitignore names Devin's local files, not another harness's", () => {
    // harness/devin/dot-gitignore was seeded from harness/claude/ and carried
    // `.claude/settings.local.json` — a file Devin does not have. Devin's
    // gitignorable local surfaces are config.local.json / mcp_config.local.json
    // (docs.devin.ai/cli/reference/configuration/global-vs-local).
    const gi = readFileSync(join(DIST, ".gitignore"), "utf-8");
    expect(gi).not.toMatch(/\.claude|\.codex|\.kiro|\.cursor|\.opencode/);
    expect(gi).toContain(".devin/config.local.json");
  });

  test("no Codex identity leaks into Devin's OWN surfaces", () => {
    // The projection approach renamed the directory and left 506 `.codex/` path
    // references across 119 files, 61 `$aidlc` (Codex's invoke prefix), and an
    // AGENTS.md titled "AI-DLC on Codex CLI". Generating from core/ means none of
    // that can occur — this test is what keeps it that way.
    //
    // SCOPED DELIBERATELY to the harness-identity surfaces. The shared ENGINE
    // legitimately names other harnesses, and must not be swept:
    //   aidlc-runner-gen.ts  `activeHarnessDir === ".codex" ? "$aidlc" : "/aidlc"`
    //   aidlc-lib.ts         the ".codex": "aidlc-rules" subdir map
    //   aidlc-tiers.ts       the CodexEffort projection type
    //   workspace-detection  the list of harness dirs the scanner excludes
    // Those branches are why `.devin` needs no per-harness special-casing at all
    // (it falls to the `/aidlc` default). A blanket sweep would have renamed a
    // TYPE and broken compilation — which is exactly what the substitution pass
    // did when it produced `DevinEffort`.
    const surfaces = [
      join(DIST, "AGENTS.md"),
      join(TREE, "hooks.v1.json"),
      join(TREE, "rules"),
      join(TREE, "skills"),
      join(TREE, "agents"),
    ];
    const offenders: string[] = [];
    const check = (p: string) => {
      const t = readFileSync(p, "utf-8");
      if (t.includes(".codex/") || t.includes("$aidlc") || /Codex CLI/.test(t)) offenders.push(p);
    };
    const scan = (p: string) => {
      if (!existsSync(p)) return;
      if (!statSync(p).isDirectory()) {
        if (/\.(md|json)$/.test(p)) check(p);
        return;
      }
      for (const e of readdirSync(p, { withFileTypes: true })) {
        scan(join(p, e.name));
      }
    };
    for (const s of surfaces) scan(s);
    expect(offenders).toEqual([]);
  });
});
