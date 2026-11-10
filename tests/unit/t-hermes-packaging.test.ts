// t-hermes-packaging: dist/hermes determinism + shell shape.
//
// covers: file:tools/aidlc-runtime-paths.ts
//
// WHAT. Five contracts land here:
//   (1) `bun scripts/package.ts hermes --check` produces byte-identical clean
//       builds (the same UX as t240/t275 test 1).
//   (2) Core parity: every .ts under dist/hermes/.hermes/{tools,hooks}/ is
//       BYTE-IDENTICAL to its dist/claude source (the architecture-B
//       invariant: the packager may transform prose/data paths, never code).
//   (3) The tree Hermes reads natively is shaped for it: the orchestrator is
//       the project skill `.hermes/skills/aidlc/SKILL.md`, the 14 personas are
//       inline .md files under `.hermes/agents/`, `.hermes.md` is the
//       project-root always-on context file, and no text still carries a
//       packager token.
//   (4) No host wiring is claimed: Hermes keeps shell hooks in the person's
//       own ~/.hermes/config.yaml, so the tree ships no settings.json, no
//       hooks.json, and the projection descriptor names no hook surface - while
//       the engine's own hooks/ code still ships (the engine invokes it).
//   (5) `aidlc doctor` passes on a pristine copy inside a git repository,
//       names the harness, and warns (never fails) outside one: Hermes loads
//       project skills only from a trusted repository.
//
// WHY SUBPROCESS for (1) and (5). Same idiom as t240/t275: the packager and
// doctor are CLIs; we pin their observable behavior, not their internals.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { describe, expect, test, setDefaultTimeout } from "bun:test";
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
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const PACKAGE_SCRIPT = join(REPO_ROOT, "scripts", "package.ts");
const CLAUDE_SRC = join(REPO_ROOT, "dist", "claude", ".claude");
const HERMES_ROOT = join(REPO_ROOT, "dist", "hermes");
const HERMES_ENGINE = join(HERMES_ROOT, ".hermes");

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

describe("dist/hermes packaging parity + shell shape", () => {
  test("1: hermes package generation is deterministic", () => {
    const r = spawnSync("bun", [PACKAGE_SCRIPT, "hermes", "--check"], {
      timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS),
      encoding: "utf-8",
      cwd: REPO_ROOT,
    });
    if (r.status !== 0) console.error(r.stderr);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("deterministic across two independent build(s) for hermes");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("2: packaged .ts files differ only at the declared projection token", () => {
    const divergent: string[] = [];
    // The one sanctioned in-code transform: the copy channel's engine command
    // names its own tree (`bun .hermes/tools/aidlc.ts`). Nothing else in a
    // packaged .ts may differ from its dist/claude twin.
    const comparable = (file: string) =>
      readFileSync(file, "utf-8").replaceAll("bun .hermes/tools/", "bun .claude/tools/");
    for (const dir of ["tools", "hooks"]) {
      const source = join(HERMES_ENGINE, dir);
      if (!existsSync(source)) continue;
      for (const file of walk(source)) {
        if (!file.endsWith(".ts")) continue;
        const twin = join(CLAUDE_SRC, dir, file.slice(source.length + 1));
        if (!existsSync(twin)) continue;
        if (comparable(file) !== readFileSync(twin, "utf-8")) divergent.push(file);
      }
    }
    expect(divergent).toEqual([]);
  });

  test("3: the surfaces Hermes reads natively are shaped for it", () => {
    // The orchestrator is a project skill Hermes discovers from .hermes/skills.
    const skill = join(HERMES_ENGINE, "skills", "aidlc", "SKILL.md");
    expect(existsSync(skill)).toBe(true);
    const skillText = readFileSync(skill, "utf-8");
    expect(skillText).toContain("name: aidlc");
    expect(skillText).toContain("# AI-DLC (hermes harness)");
    expect(skillText).toContain("Harness notes (hermes)");
    expect(skillText).not.toContain("# AI-DLC (cursor harness)");
    // Exactly the 14 shipped personas, as inline .md files.
    const personas = readdirSync(join(HERMES_ENGINE, "agents")).filter((name) => name.endsWith("-agent.md"));
    expect(personas).toHaveLength(14);
    // .hermes.md is the project-root always-on context file.
    const onboarding = join(HERMES_ROOT, ".hermes.md");
    expect(existsSync(onboarding)).toBe(true);
    expect(readFileSync(onboarding, "utf-8")).toContain("# AI-DLC on Hermes Agent");
    // No packager token survives in a Markdown file the agent reads.
    const leftovers: string[] = [];
    for (const file of walk(HERMES_ROOT)) {
      if (!file.endsWith(".md")) continue;
      const text = readFileSync(file, "utf-8");
      if (/\{\{(?:HARNESS_DIR|INVOKE|OPTION_LETTERS|SKILL_INVOKE)\}\}/.test(text)) leftovers.push(file);
    }
    expect(leftovers).toEqual([]);
  });

  test("4: no host wiring is claimed, and the engine's own hooks still ship", () => {
    for (const file of ["settings.json", "hooks.json", "cli.json"]) {
      expect(existsSync(join(HERMES_ENGINE, file))).toBe(false);
    }
    const harnessData = JSON.parse(
      readFileSync(join(HERMES_ENGINE, "tools", "data", "harness.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(harnessData.distribution).toBe("hermes");
    expect(harnessData.harnessDir).toBe(".hermes");
    expect(harnessData.productName).toBe("Hermes Agent");
    expect(harnessData.hostShell).toEqual({ env: ["AI_AGENT=hermes-agent"] });
    expect(harnessData.hookActivation).toBeUndefined();
    const descriptor = JSON.parse(
      readFileSync(join(HERMES_ENGINE, "tools", "data", "aidlc-projection.json"), "utf-8"),
    ) as { rootIntegrations?: Array<{ path?: string }> };
    const roots = (descriptor.rootIntegrations ?? []).map((entry) => entry.path).sort();
    expect(roots).toEqual([".gitignore", ".hermes.md"]);
    // The guard hooks are engine code the conductor runs; they stay on disk.
    expect(existsSync(join(HERMES_ENGINE, "hooks", "aidlc-plan-approval-guard.ts"))).toBe(true);
  });

  test("5: doctor passes on a pristine copy in a git repository and names the harness", () => {
    const root = mkdtempSync(join(tmpdir(), "t-hermes-doctor-"));
    try {
      const project = join(root, "project");
      cpSync(HERMES_ROOT, project, { recursive: true });
      const doctor = () =>
        spawnSync(
          "bun",
          [join(project, ".hermes", "tools", "aidlc-utility.ts"), "doctor", "--verbose", "--project-dir", project],
          {
            timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
            cwd: project,
            encoding: "utf-8",
            env: { ...process.env, HOME: join(root, "home"), USERPROFILE: join(root, "home") },
          },
        );

      // Outside a git repository Hermes loads no project skill, so doctor
      // reports it as a problem: the install cannot be used from that folder.
      const ungitted = doctor();
      expect(ungitted.status).toBe(1);
      expect(ungitted.stdout).toContain("project is in a git repository");

      const git = spawnSync("git", ["init", "-q"], { cwd: project, encoding: "utf-8" });
      expect(git.status).toBe(0);
      const gitted = doctor();
      expect(gitted.status).toBe(0);
      expect(gitted.stdout).toContain("(.hermes, Hermes Agent)");
      expect(gitted.stdout).toContain("0 problems");
      expect(gitted.stdout).toContain("skills/aidlc/SKILL.md present");
      expect(gitted.stdout).toContain(".hermes.md present");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
