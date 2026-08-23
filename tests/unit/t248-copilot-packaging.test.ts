// t248-copilot-packaging: dist/copilot parity + drift guard + shell shape.
//
// covers: file:tools/aidlc-lib.ts
//
// WHAT. Four contracts land here:
//   (1) The committed dist/copilot tree is byte-identical to what
//       `bun scripts/package.ts copilot --check` regenerates (drift guard,
//       same UX as codex's t150 test 1 / opencode's t240 test 1).
//   (2) Core parity: every .ts under dist/copilot/.aidlc/{tools,hooks}/
//       except the authored adapter is BYTE-IDENTICAL to its dist/claude
//       source (the architecture-B invariant: the packager may transform
//       prose/data paths, never code).
//   (3) The .github/ shell carries ONLY aidlc-named emissions — .github/ is
//       SHARED with real repo content in a user install, so every emitted
//       file must be collision-free (aidlc-prefixed dirs/files), and the
//       hook wiring must register PascalCase events with matcher-FREE
//       entries (VS Code parses but IGNORES matchers — a matcher would
//       silently broaden there; the adapter self-filters instead).
//   (4) The emitted persona twins carry NO model:/tier: keys (the two
//       Copilot surfaces disagree on model-value syntax — live-verified 400
//       on the CLI with an IDE display name — so agents must inherit the
//       session model) and project the core Task denial to a supported tools
//       allowlist that excludes Copilot's `agent` delegation tool.
//
// WHY SUBPROCESS for (1). Same idiom as t141/t150/t240: the packager is a
// CLI; we pin its observable behavior, not its internals.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
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

const PACKAGE_SCRIPT = join(REPO_ROOT, "scripts", "package.ts");
const CLAUDE_SRC = join(REPO_ROOT, "dist", "claude", ".claude");
const COPILOT_ROOT = join(REPO_ROOT, "dist", "copilot");
const ENGINE = join(COPILOT_ROOT, ".aidlc");
const SHELL = join(COPILOT_ROOT, ".github");
const WORKER_TOOLS_LINE = 'tools: ["read", "edit", "search", "execute", "web", "todo"]';

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

describe("t248 dist/copilot packaging parity + shell shape", () => {
  test("1: committed dist/copilot matches the packaging script (drift guard)", () => {
    const r = spawnSync("bun", [PACKAGE_SCRIPT, "copilot", "--check"], {
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
        // The authored shim is copilot-only; everything else is shared core.
        if (rel === join("hooks", "aidlc-copilot-adapter.ts")) continue;
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

  test("3: .github shell is aidlc-prefixed only, hooks PascalCase + matcher-free", () => {
    // Every emitted path is collision-free for a merge into a user's .github/.
    for (const file of walk(SHELL)) {
      const rel = relative(SHELL, file);
      const top = rel.split(sep)[0];
      expect(["hooks", "agents", "skills"]).toContain(top);
      const name = rel.split(sep)[1] ?? "";
      expect(name.startsWith("aidlc")).toBe(true);
    }
    const wiring = JSON.parse(readFileSync(join(SHELL, "hooks", "aidlc.json"), "utf-8")) as {
      version: number;
      hooks: Record<string, Array<Record<string, unknown>>>;
    };
    expect(wiring.version).toBe(1);
    const events = Object.keys(wiring.hooks);
    // PascalCase registration is the shared-payload recipe: both surfaces
    // then deliver snake_case payloads to the one adapter.
    for (const event of events) {
      expect(event[0]).toBe(event[0].toUpperCase());
      for (const entry of wiring.hooks[event]) {
        expect(entry.matcher).toBeUndefined();
        expect(String(entry.bash)).toContain("aidlc-copilot-adapter.ts");
      }
    }
    for (const required of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStart", "SubagentStop", "PreCompact"]) {
      expect(events).toContain(required);
    }
    expect(wiring.hooks.PreToolUse).toHaveLength(1);
    expect(String(wiring.hooks.PreToolUse[0]?.bash)).toContain(
      "aidlc-copilot-adapter.ts guard-tool-call",
    );
    expect(events).not.toContain("SessionEnd");
  });

  test("4: persona twins carry no model/tier keys and exclude the agent delegation tool", () => {
    for (const agentsDir of [join(ENGINE, "agents"), join(SHELL, "agents")]) {
      for (const f of readdirSync(agentsDir).filter((x) => x.endsWith(".md"))) {
        const raw = readFileSync(join(agentsDir, f), "utf-8");
        expect(raw, `${f}: concrete default memory pointer`).not.toContain(
          "aidlc/spaces/<active-space>/memory/",
        );
      }
    }

    const agentsDir = join(SHELL, "agents");
    const files = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
    expect(files.length).toBe(14);
    for (const f of files) {
      const raw = readFileSync(join(agentsDir, f), "utf-8");
      const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)?.[1] ?? "";
      expect(fm).not.toMatch(/^model:/m);
      expect(fm).not.toMatch(/^tier:/m);
      expect(fm).not.toMatch(/^disallowedTools:/m);
      expect(fm).not.toMatch(/^agents:/m);
      // The core source declares the Task denial on every current persona;
      // its projected form is Copilot's supported built-in tool allowlist.
      const coreSrc = readFileSync(join(REPO_ROOT, "core", "agents", f), "utf-8");
      if (/^disallowedTools:/m.test(coreSrc)) {
        expect(fm.split("\n")).toContain(WORKER_TOOLS_LINE);
      }
      // Body prose points at the engine dir, never an unsubstituted token.
      expect(raw).not.toContain("{{HARNESS_DIR}}");
    }
  });

  test("5: skills tree keeps questions on the human-presence-safe prose path", () => {
    const skills = readdirSync(join(SHELL, "skills"));
    expect(skills).toContain("aidlc");
    expect(skills).toContain("aidlc-init");
    expect(skills).toContain("aidlc-compose");
    expect(skills.length).toBeGreaterThan(30);
    const orchestrator = readFileSync(join(SHELL, "skills", "aidlc", "SKILL.md"), "utf-8");
    expect(orchestrator).toContain("Copilot harness");
    expect(orchestrator).toContain("bun .aidlc/tools/aidlc-orchestrate.ts next");
    expect(orchestrator).not.toContain("{{HARNESS_DIR}}");
    expect(orchestrator).toContain("numbered prose");
    expect(orchestrator).toContain("picker results do not fire");
    expect(orchestrator).toContain("| `load-steering` |");
    expect(orchestrator).toContain("directive.continue_token");
    expect(orchestrator).toContain("The orchestration engine emits eight kinds today");
    expect(orchestrator).toContain("stage-protocol-ensemble.md");
    const ensembleProtocol = readFileSync(
      join(
        ENGINE,
        "aidlc-common",
        "protocols",
        "stage-protocol-ensemble.md",
      ),
      "utf-8",
    );
    expect(ensembleProtocol).toContain(
      "rules as the accumulated `load-steering` bundle",
    );
    expect(existsSync(join(ENGINE, "hooks", "aidlc-deliver-stage-rules.ts"))).toBe(true);
    const questionRendering = readFileSync(
      join(SHELL, "skills", "aidlc", "question-rendering.md"),
      "utf-8",
    );
    expect(questionRendering).toContain("numbered prose options in chat");
    expect(questionRendering).toContain("does not fire the trusted `UserPromptSubmit`");
    expect(questionRendering).toContain("Calling either picker would therefore deadlock");
    expect(questionRendering).toContain("start every question at `1`");
    expect(questionRendering).toMatch(/Use unordered\s+bullets/);
    expect(questionRendering).toMatch(/Visible `1`\s+maps/);
    const harnessData = JSON.parse(
      readFileSync(join(ENGINE, "tools", "data", "harness.json"), "utf-8"),
    ) as { name?: string };
    expect(harnessData.name).toBe("copilot");
  });

  test("6: doctor catches missing Copilot hook dependencies and root AGENTS.md", () => {
    const project = mkdtempSync(join(tmpdir(), "t248-copilot-doctor-"));
    try {
      cpSync(COPILOT_ROOT, project, { recursive: true });
      rmSync(join(project, ".aidlc", "hooks", "aidlc-state-transition-guard.ts"));
      rmSync(join(project, ".aidlc", "hooks", "aidlc-deliver-stage-rules.ts"));
      rmSync(join(project, ".aidlc", "hooks", "aidlc-plan-approval-guard.ts"));
      rmSync(join(project, ".aidlc", "hooks", "aidlc-review-freeze.ts"));
      rmSync(join(project, "AGENTS.md"));
      const result = spawnSync(
        process.execPath,
        [
          join(project, ".aidlc", "tools", "aidlc-utility.ts"),
          "doctor",
          "--project-dir",
          project,
        ],
        {
          cwd: project,
          encoding: "utf-8",
          env: {
            ...process.env,
            AIDLC_HARNESS_DIR: ".aidlc",
            AIDLC_HARNESS_NAME: "copilot",
            COPILOT_HOME: join(project, ".copilot-home"),
          },
        },
      );
      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).not.toBe(0);
      expect(output).toContain("✗  aidlc-state-transition-guard.ts present");
      expect(output).toContain("✗  aidlc-deliver-stage-rules.ts present");
      expect(output).toContain("✗  aidlc-plan-approval-guard.ts present");
      expect(output).toContain("✗  aidlc-review-freeze.ts present");
      expect(output).toContain("✗  AGENTS.md present (onboarding + method imports)");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("7: doctor parses real JSONC trust config and fails malformed existing config", () => {
    const project = mkdtempSync(join(tmpdir(), "t248-copilot-jsonc-"));
    try {
      cpSync(COPILOT_ROOT, project, { recursive: true });
      const copilotHome = join(project, ".copilot-home");
      mkdirSync(copilotHome, { recursive: true });
      const configPath = join(copilotHome, "config.json");
      const runDoctor = () =>
        spawnSync(
          process.execPath,
          [
            join(project, ".aidlc", "tools", "aidlc-utility.ts"),
            "doctor",
            "--project-dir",
            project,
          ],
          {
            cwd: project,
            encoding: "utf-8",
            env: {
              ...process.env,
              AIDLC_HARNESS_DIR: ".aidlc",
              AIDLC_HARNESS_NAME: "copilot",
              COPILOT_HOME: copilotHome,
            },
          },
        );

      writeFileSync(
        configPath,
        `{
  // Copilot writes JSONC, not strict JSON.
  "trustedFolders": [
    ${JSON.stringify(project)}, // inline comments are valid
  ],
}
`,
      );
      const valid = runDoctor();
      expect(valid.status).toBe(0);
      expect(`${valid.stdout}${valid.stderr}`).toContain(
        "✓  project folder in ~/.copilot/config.json trustedFolders",
      );

      writeFileSync(configPath, '{ "trustedFolders": [\n');
      const malformed = runDoctor();
      expect(malformed.status).not.toBe(0);
      expect(`${malformed.stdout}${malformed.stderr}`).toContain(
        "✗  could not parse ~/.copilot/config.json",
      );
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
