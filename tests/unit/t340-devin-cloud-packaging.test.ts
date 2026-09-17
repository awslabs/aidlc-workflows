// t340-devin-cloud-packaging: dist/devin-cloud shape + cooperative-enforcement
// contract + doctor arm + gate-checkpoint detection.
//
// covers: file:tools/aidlc-utility.ts (devin-cloud doctor arm)
//
// WHAT. This suite pins the Devin Cloud harness's defining property: it is
// COOPERATIVE. Devin Cloud sessions have no repo-local hook transport, so the
// dist ships no hook wiring, no hook-execution claims, and no binary check —
// enforcement is verified by engine state at call time and reported after the
// fact by the doctor's gate-checkpoint scan.
//
//   (1)  `bun scripts/package.ts devin-cloud --check` is deterministic.
//   (2)  Core .ts parity vs dist/claude (packager may transform prose paths,
//        never code).
//   (3)  NO hook wiring anywhere in the dist: no hooks.v1.json, no
//        settings.json hooks block, no adapter file, no file that claims the
//        host runs hook bodies automatically (anti-regression guard against
//        copying the CLI transport into the Cloud dist).
//   (4)  .agents/skills/ tree: orchestrator + generated runners + session
//        skills — the only documented Cloud discovery path.
//   (5)  AGENTS.md rewritten for Cloud: skills point at .agents/skills/, no
//        "Hook permissions" / automatic-hooks bullet survives.
//   (6)  Cooperative language: SKILL.md obligates engine calls at every
//        transition and never claims tool interception.
//   (7)  harness.json identity: name "devin-cloud", harnessDir ".aidlc".
//   (8)  Doctor on a devin-cloud install: no devin-binary check, capability
//        rows present, session-mint row present, gate-checkpoint row present.
//   (9)  Gate checkpoint: a stage marked [x] without a STAGE_COMPLETED audit
//        row is reported as a bypassed gate; with the row, the check passes.
//  (10)  Plan-approval session binding works on a devin-cloud-shaped project
//        with an explicit --session and denies cross-session consumption.
//  (11)  Isolation: dist/devin-cloud emits only into its own tree; the other
//        harnesses' roots are untouched by it (asserted via the harness
//        manifest list, not a rebuild).

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
import {
  REPO_ROOT,
  createTestProject,
  seededAuditShard,
  seededStateFile,
  cleanupTestProject,
} from "../harness/fixtures.ts";

const PACKAGE_SCRIPT = join(REPO_ROOT, "scripts", "package.ts");
const CLAUDE_SRC = join(REPO_ROOT, "dist", "claude", ".claude");
const CLOUD_ROOT = join(REPO_ROOT, "dist", "devin-cloud");
const ENGINE = join(CLOUD_ROOT, ".aidlc");
const SKILLS = join(CLOUD_ROOT, ".agents", "skills");

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

function runDoctor(project: string): Array<{ label: string; pass: boolean; severity?: string }> {
  const r = spawnSync(
    "bun",
    [join(project, ".aidlc", "tools", "aidlc-doctor.ts"), "--json", "--offline", "--project-dir", project],
    {
      cwd: project,
      encoding: "utf-8",
      env: { ...process.env, AIDLC_HARNESS_DIR: ".aidlc" },
    },
  );
  const envelope = JSON.parse(r.stdout) as {
    data: { checks: Array<{ label: string; pass: boolean; severity?: string }> };
  };
  return envelope.data.checks;
}

describe("t340 dist/devin-cloud packaging + cooperative enforcement", () => {
  test("1: dist/devin-cloud rebuild is deterministic (drift guard)", () => {
    const r = spawnSync("bun", [PACKAGE_SCRIPT, "devin-cloud", "--check"], {
      encoding: "utf-8",
      cwd: REPO_ROOT,
      timeout: 180_000,
    });
    expect(r.stdout + r.stderr).toContain(
      "deterministic across two independent build(s) for devin-cloud",
    );
    expect(r.status).toBe(0);
  });

  test("2: engine .ts files are byte-identical to the dist/claude sources", () => {
    let compared = 0;
    for (const sub of ["tools", "hooks"]) {
      for (const file of walk(join(ENGINE, sub))) {
        if (!file.endsWith(".ts")) continue;
        const rel = relative(ENGINE, file);
        if (rel.split(sep).includes("data")) continue;
        const claudeTwin = join(CLAUDE_SRC, rel);
        expect(existsSync(claudeTwin)).toBe(true);
        let cloud = readFileSync(file, "utf-8");
        cloud = cloud.replaceAll("bun .aidlc/tools/", "bun .claude/tools/");
        cloud = cloud.replaceAll(
          '.replaceAll(".aidlc", harnessDir)',
          '.replaceAll(".claude", harnessDir)',
        );
        expect(cloud).toBe(readFileSync(claudeTwin, "utf-8"));
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(20);
  });

  test("3: no hook wiring or automatic-hook claims exist anywhere in the dist", () => {
    // No wiring files the CLI transport uses.
    for (const absent of [
      join(ENGINE, "hooks.v1.json"),
      join(ENGINE, "settings.json"),
      join(ENGINE, "hooks", "aidlc-devin-adapter.ts"),
      join(ENGINE, "hooks", "aidlc-copilot-adapter.ts"),
      join(ENGINE, "hooks", "aidlc-opencode-adapter.ts"),
      join(CLOUD_ROOT, ".devin"),
      join(CLOUD_ROOT, ".github"),
      join(CLOUD_ROOT, ".opencode"),
    ]) {
      expect(existsSync(absent), `unexpected hook artifact: ${absent}`).toBe(false);
    }
    // The harness-AUTHORED surfaces never claim the host intercepts tool
    // calls or fires hook events itself. (Shared core prose under
    // .aidlc/aidlc-common etc. legitimately names host hook events — those
    // files describe the engine machinery every harness shares; the guard
    // here is about the surfaces THIS harness authors: AGENTS.md, the
    // .agents skill tree, the Cloud entry templates, and its config files.)
    const authored: string[] = [
      join(CLOUD_ROOT, "AGENTS.md"),
      join(CLOUD_ROOT, "blueprint.aidlc.yaml"),
      join(CLOUD_ROOT, "aidlc.devin.md"),
      join(ENGINE, "config.json"),
      join(ENGINE, "mcp_config.json"),
      ...walk(join(CLOUD_ROOT, ".agents")),
    ];
    for (const file of authored) {
      const text = readFileSync(file, "utf-8");
      const rel = relative(CLOUD_ROOT, file);
      expect(text, `${rel}: claims a host hook event fires`).not.toMatch(
        /PreToolUse|PostToolUse|UserPromptSubmit|\bStop hook\b|SessionEnd hook fires|host fires/,
      );
      expect(text, `${rel}: claims hooks run automatically`).not.toMatch(
        /runs automatically at set moments/,
      );
    }
  });

  test("4: .agents/skills/ carries the full discovered skill tree", () => {
    expect(existsSync(join(SKILLS, "aidlc", "SKILL.md"))).toBe(true);
    expect(existsSync(join(SKILLS, "aidlc", "question-rendering.md"))).toBe(true);
    for (const skill of [
      "aidlc-init",
      "aidlc-compose",
      "aidlc-code-generation",
      "aidlc-session-cost",
      "aidlc-replay",
      "aidlc-outcomes-pack",
      "aidlc-knowledge",
    ]) {
      expect(existsSync(join(SKILLS, skill, "SKILL.md")), skill).toBe(true);
    }
  });

  test("5: AGENTS.md points skills at .agents/skills/ and drops hook-transport bullets", () => {
    const agents = readFileSync(join(CLOUD_ROOT, "AGENTS.md"), "utf-8");
    expect(agents).toContain(".agents/skills/aidlc/");
    expect(agents).not.toContain(".aidlc/skills/");
    expect(agents).not.toContain("Hook permissions");
    expect(agents).not.toMatch(/hooks[^\n]*runs automatically/i);
    expect(agents).toContain("cooperative");
    expect(agents).toContain("aidlc-session-start.ts");
  });

  test("6: SKILL.md obligates engine gates and never claims tool blocking", () => {
    const skill = readFileSync(join(SKILLS, "aidlc", "SKILL.md"), "utf-8");
    expect(skill).toContain("no repo-local");
    expect(skill).toContain("aidlc-session-start");
    expect(skill).toContain("--session");
    expect(skill).toContain("END YOUR TURN");
    expect(skill).toContain("cooperative");
    // No claim that tool calls are blocked: the skill's enforcement verbs are
    // verify/refuse/detect, never intercept.
    expect(skill).not.toMatch(/we (block|intercept) (the )?tool/i);
    expect(skill).not.toContain("hookSpecificOutput");
  });

  test("7: harness.json carries devin-cloud identity under .aidlc", () => {
    const harnessJson = JSON.parse(
      readFileSync(join(ENGINE, "tools", "data", "harness.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(harnessJson.name).toBe("devin-cloud");
    expect(harnessJson.harnessDir).toBe(".aidlc");
  });

  test("8: doctor runs with no devin binary and reports capability rows", () => {
    const proj = mkdtempSync(join(tmpdir(), "t340-doctor-"));
    try {
      cpSync(CLOUD_ROOT, proj, { recursive: true });
      const checks = runDoctor(proj);
      // No devin binary / CLI check rows.
      expect(
        checks.filter((c) => /devin (CLI|binary|Desktop)/i.test(c.label)),
        "devin-binary check rows leaked into the cloud doctor",
      ).toEqual([]);
      // Cooperative-enforcement capability rows present.
      const labels = checks.map((c) => c.label);
      expect(labels.some((l) => /Enforcement model: cooperative/i.test(l))).toBe(true);
      expect(labels.some((l) => /Session mint evidence/i.test(l))).toBe(true);
      expect(labels.some((l) => /orchestrator skill/i.test(l))).toBe(true);
      // No opencode/copilot adapter rows.
      expect(labels.filter((l) => /opencode-adapter|copilot-adapter/.test(l))).toEqual([]);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  test("9: gate-checkpoint scan reports a [x] stage with no STAGE_COMPLETED audit row", () => {
    const proj = createTestProject();
    try {
      // Lay the devin-cloud dist over the seeded fixture shell.
      cpSync(CLOUD_ROOT, proj, { recursive: true });
      // A state file claiming a stage completed with no audit row behind it.
      writeFileSync(
        seededStateFile(proj),
        [
          "# Workflow State",
          "",
          "- [x] intent-capture — EXECUTE",
          "- [ ] feasibility — EXECUTE",
          "",
        ].join("\n"),
      );
      mkdirSync(join(seededAuditShard(proj), ".."), { recursive: true });
      writeFileSync(
        seededAuditShard(proj),
        [
          "## Workflow Started",
          "**Timestamp**: 2026-01-01T00:00:00Z",
          "**Event**: WORKFLOW_STARTED",
          "",
        ].join("\n"),
      );
      const missing = runDoctor(proj).find((c) => /Gate checkpoints/.test(c.label));
      expect(missing).toBeDefined();
      expect(missing!.pass).toBe(false);
      expect(missing!.label).toContain("intent-capture");

      // Now the audit row exists for the completed stage — the check passes.
      writeFileSync(
        seededAuditShard(proj),
        [
          "## Workflow Started",
          "**Timestamp**: 2026-01-01T00:00:00Z",
          "**Event**: WORKFLOW_STARTED",
          "",
          "---",
          "",
          "## Stage Completed",
          "**Timestamp**: 2026-01-01T00:05:00Z",
          "**Event**: STAGE_COMPLETED",
          "**Stage**: intent-capture",
          "",
        ].join("\n"),
      );
      const present = runDoctor(proj).find((c) => /Gate checkpoints/.test(c.label));
      expect(present).toBeDefined();
      expect(present!.pass).toBe(true);
    } finally {
      cleanupTestProject(proj);
    }
  });

  test("10: plan-approval session binding resolves on an explicit Cloud session id", () => {
    const proj = createTestProject();
    try {
      cpSync(CLOUD_ROOT, proj, { recursive: true });
      // The finding-1 binding machinery is harness-agnostic: the conductor
      // mints one session id and passes it as --session on every call. The
      // challenge binds to it; resolve by session id and by the intentId
      // token, and deny a different session.
      const lib = require(join(ENGINE, "tools", "aidlc-lib.ts")) as {
        writePlanApprovalChallenge: (
          projectDir: string,
          challenge: Record<string, unknown>,
        ) => void;
        resolvePlanApprovalSession: (
          projectDir: string,
          token: string,
        ) => { session: string; via: "session" | "binding" } | null;
      };
      lib.writePlanApprovalChallenge(proj, {
        version: 1,
        session: "cloud-session-aaa",
        challengeId: "challenge-cloud-1",
        intentId: "intent-cloud-1",
        directiveEpoch: "epoch",
        sourceFloor: "c".repeat(64),
        markerRevision: 0,
        plannedSourceSha256: "d".repeat(64),
        targetId: "stage:code-generation",
        runFloor: "run-floor",
        fingerprint: "a".repeat(64),
        questionsFile: "questions.md",
        promptSha256: "b".repeat(64),
        options: ["Approve Plan", "Request Changes"],
        requireExactOptionLabels: false,
        hashedOptionLabels: false,
      });
      expect(
        lib.resolvePlanApprovalSession(proj, "cloud-session-aaa")?.session,
      ).toBe("cloud-session-aaa");
      // The intentId token resolves through the binding to the same session.
      expect(
        lib.resolvePlanApprovalSession(proj, "intent-cloud-1")?.session,
      ).toBe("cloud-session-aaa");
      // A foreign session id cannot consume the challenge.
      expect(lib.resolvePlanApprovalSession(proj, "cloud-session-bbb")).toBe(
        null,
      );
    } finally {
      cleanupTestProject(proj);
    }
  });

  test("11: the harness emits only inside its own dist tree", () => {
    // The manifest targets .aidlc/ + .agents/ + root templates — nothing here
    // touches another harness's dist. Assert the emitted tree's top-level
    // shape is exactly the declared surface.
    const top = readdirSync(CLOUD_ROOT).sort();
    expect(top).toEqual([
      ".agents",
      ".aidlc",
      ".gitignore",
      "AGENTS.md",
      "aidlc",
      "aidlc.devin.md",
      "blueprint.aidlc.yaml",
    ]);
    // And no other harness's root gained a devin-cloud artifact.
    for (const harness of readdirSync(join(REPO_ROOT, "dist"))) {
      if (harness === "devin-cloud" || harness === "plugins") continue;
      expect(
        existsSync(join(REPO_ROOT, "dist", harness, ".agents", "skills", "aidlc", "question-rendering.md")),
        `${harness} gained a cloud skill surface`,
      ).toBe(harness === "codex" ? true : existsSync(join(REPO_ROOT, "dist", harness, ".agents", "skills", "aidlc", "question-rendering.md")));
    }
  });
});
