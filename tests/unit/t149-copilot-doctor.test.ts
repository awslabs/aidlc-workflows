// covers: subcommand:aidlc-utility:doctor
//
// t149 - the GitHub Copilot doctor arm (FR-007, data-flows Flow 2.2). handleDoctor
// (aidlc-utility.ts) gained a `.github`-gated branch that validates the four
// components a Copilot install must ship:
//   A. .github/agents/ exists AND carries at least one *.agent.md
//   B. .github/skills/aidlc/SKILL.md exists (the /aidlc entry point)
//   C. .github/hooks/hooks.json exists (the hook registry)
//   D. .github/hooks/aidlc-copilot-adapter.ts exists (the stdin adapter)
// On a complete install doctor exits 0 with a success line; removing any one of
// the four produces the corresponding SPECIFIC failure message and a non-zero
// exit, so CI and the user get an actionable signal naming the missing piece.
//
// The Copilot install is ADDITIVE: the branch is gated on the detected `.github`
// harness dir, so it never runs for the other four harnesses (which own their
// own wiring checks). It also had to make two pre-existing agent-frontmatter
// checks Copilot-aware (Copilot's transposed .agent.md files carry only `name`,
// no display_name), or a healthy Copilot install would spuriously fail Schema
// validation / render 14 phantom naming advisories.
//
// Mechanism = cli: doctor terminates with process.exit and writes its report to
// stdout, so we copy the shipped dist/copilot/ tree into a temp project and
// spawn the REAL tool through the bun runtime with AIDLC_HARNESS_DIR=.github
// (the same seam runtimeHarnessDir honours), then assert on the rendered report
// and exit code - exactly as the sibling doctor twins (t83/t204) do. Copying the
// shipped tree (not hand-authoring a fixture) means the test cannot drift from
// what the packager actually emits.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const BUN = process.execPath;
const COPILOT_DIST = join(REPO_ROOT, "dist", "copilot");

const created: string[] = [];
afterEach(() => {
  while (created.length) {
    const p = created.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

/** Copy the shipped dist/copilot/ tree into a fresh temp project. */
function copilotProject(): string {
  let proj = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "aidlc-copilot-"));
  try {
    proj = realpathSync(proj);
  } catch {
    /* keep the raw path */
  }
  cpSync(COPILOT_DIST, proj, { recursive: true });
  created.push(proj);
  return proj;
}

interface DoctorResult {
  status: number;
  out: string; // combined stdout+stderr
}

function runDoctor(proj: string): DoctorResult {
  const util = join(proj, ".github", "tools", "aidlc-utility.ts");
  const res = spawnSync(BUN, [util, "doctor", "--project-dir", proj], {
    encoding: "utf-8",
    env: { ...process.env, AIDLC_HARNESS_DIR: ".github" },
  });
  return {
    status: res.status ?? -1,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

describe("t149 copilot doctor arm", () => {
  test("a complete Copilot install passes all four checks and exits 0", () => {
    const proj = copilotProject();
    const { status, out } = runDoctor(proj);
    expect(out).toMatch(/✓\s+\.github\/agents\/ present \(\d+ \*\.agent\.md\)/);
    expect(out).toContain("✓  .github/skills/aidlc/SKILL.md present");
    expect(out).toContain("✓  .github/hooks/hooks.json present");
    expect(out).toContain("✓  .github/hooks/aidlc-copilot-adapter.ts present");
    // No Copilot component is reported missing, and the run exits clean.
    expect(out).not.toContain("Missing");
    expect(out).toContain("0 failed");
    expect(status).toBe(0);
  });

  test("missing .github/agents/ fails with the specific message and non-0 exit", () => {
    const proj = copilotProject();
    rmSync(join(proj, ".github", "agents"), { recursive: true, force: true });
    const { status, out } = runDoctor(proj);
    expect(out).toContain("✗  Missing .github/agents/ directory");
    expect(status).not.toBe(0);
  });

  test("missing /aidlc SKILL.md fails with the specific message and non-0 exit", () => {
    const proj = copilotProject();
    rmSync(join(proj, ".github", "skills", "aidlc", "SKILL.md"), { force: true });
    const { status, out } = runDoctor(proj);
    expect(out).toContain(
      "✗  Missing /aidlc skill at .github/skills/aidlc/SKILL.md",
    );
    expect(status).not.toBe(0);
  });

  test("missing hooks.json fails with the specific message and non-0 exit", () => {
    const proj = copilotProject();
    rmSync(join(proj, ".github", "hooks", "hooks.json"), { force: true });
    const { status, out } = runDoctor(proj);
    expect(out).toContain("✗  Missing .github/hooks/hooks.json");
    expect(status).not.toBe(0);
  });

  test("missing hook adapter fails with the specific message and non-0 exit", () => {
    const proj = copilotProject();
    rmSync(join(proj, ".github", "hooks", "aidlc-copilot-adapter.ts"), {
      force: true,
    });
    const { status, out } = runDoctor(proj);
    expect(out).toContain(
      "✗  Missing hook adapter at .github/hooks/aidlc-copilot-adapter.ts",
    );
    expect(status).not.toBe(0);
  });

  test("an agents dir with no *.agent.md fails with the specific message", () => {
    const proj = copilotProject();
    const agentsDir = join(proj, ".github", "agents");
    rmSync(agentsDir, { recursive: true, force: true });
    // Recreate the dir empty (present, but carries zero agent files).
    mkdirSync(agentsDir, { recursive: true });
    const { status, out } = runDoctor(proj);
    expect(out).toContain("✗  No *.agent.md files in .github/agents/");
    expect(status).not.toBe(0);
  });
});
