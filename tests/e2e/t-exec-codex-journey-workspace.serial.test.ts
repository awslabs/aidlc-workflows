// covers: subcommand:aidlc-utility:intent-birth, subcommand:aidlc-utility:space-create, subcommand:aidlc-utility:space, file:skills/aidlc/SKILL.md
//
// t-exec-codex-journey-workspace.serial.test.ts — the LIVE workspace journey,
// Codex-exec logic half (P10 / Stage E). Proves the SAME composed §0 promise the
// SDK + ACP legs prove (one feature spanning two repos · a 2nd intent alongside ·
// a non-default space, no collision), expressed in the Codex driver's NATIVE turn
// shape: a SEQUENCE of SEPARATE single-shot `codex exec` spawns against one
// shared on-disk workspace root.
//
// CODEX IS LOGIC-HALF ONLY, BY SURFACE LIMITATION — stated, not skipped. There is
// no Codex TUI driver (tui-drive.ts is tmux/Claude-shaped, zero codex awareness),
// so the render-half (statusline-orientation) journey matrix is Claude TUI ONLY —
// Kiro likewise ships no statusline surface (dist/kiro has no settings.json
// statusLine row; its AGENTS.md/SKILL.md state "there is no statusline"), so neither
// Codex nor Kiro contributes a render-half orientation leg; both are logic-half only.
// `codex exec` is a one-shot, non-interactive spawn
// (stdio:["ignore",…] — no stdin), so it CANNOT answer a mid-run question; each
// journey beat is therefore a separate single-shot spawn invoking one
// deterministic /aidlc verb whose result we read off disk.
//
// The journey beats mirror the SDK + ACP legs (repos captured by sibling
// auto-discovery on the auto-birth path — see the SDK leg's DRIFT NOTE):
//   1. `/aidlc "build auth across both repos"` → auto-birth A spanning both repos.
//   2. (cheaper variant) reverse-engineering writes per-repo codekb — no swarm.
//   3. `/aidlc intent-birth …` → a 2nd isolated intent; A untouched.
//   4. `/aidlc space-create teamB` → `/aidlc space teamB` → birth there; no leak.
//   5. `/aidlc space default` → A still resumable.
//
// LIVE GATE: requires AIDLC_CODEX_EXEC_LIVE=1 + a codex >= 0.139.0 binary
// (AIDLC_CODEX_BIN or PATH) + AWS creds for the Bedrock profile in
// AIDLC_CODEX_AWS_PROFILE (default "codex"). Skips cleanly otherwise. Serial.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  activeSpace,
  getField,
  listIntents,
  readIntentRegistry,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupWorkspaceJourney,
  REPO_ROOT,
  setupWorkspaceJourney,
  type WorkspaceJourney,
} from "../harness/fixtures.ts";

const CODEX_DIST = join(REPO_ROOT, "dist", "codex");
const CODEX_BIN = process.env.AIDLC_CODEX_BIN ?? "codex";
const AWS_PROFILE = process.env.AIDLC_CODEX_AWS_PROFILE ?? "codex";
const AWS_REGION = process.env.AIDLC_CODEX_AWS_REGION ?? "us-east-2";

// A multi-spawn live journey. codex exec is the slowest harness — even a "cheap"
// verb spawn can run several minutes when the model reasons before invoking the
// tool (a 240s cap turned that variance into a false red), and the per-repo
// reverse-engineering codekb spawn (9 artifacts × 2 repos) is the heaviest single
// beat in the suite. Budget the whole journey at 4200s, give each verb spawn a
// generous cap, and the codekb spawn the lion's share. Flaky-LLM-tier (watched).
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "4200", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 4200) * 1000;
const VERB_EXEC_MS = 420_000;
const CODEKB_EXEC_MS = Math.max(1_500_000, TEST_TIMEOUT_MS - 6 * VERB_EXEC_MS);

const UUIDV7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// The user types "teamB"; the engine slugifies it on disk (slugify lowercases —
// aidlc-lib.ts:463), so the SPACE DIR + cursor + registry key are "teamb".
const TEAM_B_SLUG = "teamb";

/** Prompt the conductor to run the deterministic intent-birth UTILITY directly
 *  (not route via `next`). A bare `/aidlc intent-birth …` is parsed as freeform
 *  and fed to `next`; with intent A active the engine advances/scope-changes A
 *  instead of birthing (a verified SDK failure rewrote A's Scope). Naming the
 *  exact .codex/tools command hits the mints-unconditionally handler. */
function birthToolPrompt(scope: string, args: string): string {
  return (
    `Run this exact command with the shell and then stop — do NOT run \`next\`, ` +
    `do NOT advance or scope-change the currently active intent: ` +
    `bun .codex/tools/aidlc-utility.ts intent-birth --scope ${scope} --arguments ${JSON.stringify(args)}`
  );
}

function codexVersionOk(): boolean {
  const r = spawnSync(CODEX_BIN, ["--version"], { encoding: "utf-8" });
  const m = (r.stdout ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (r.status !== 0 || !m) return false;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > 0 || min >= 139;
}

function skipReason(): string | null {
  if (process.env.AIDLC_CODEX_EXEC_LIVE !== "1") {
    return "set AIDLC_CODEX_EXEC_LIVE=1 to run the live codex-exec workspace journey (uses Bedrock)";
  }
  if (!codexVersionOk()) return `codex >= 0.139.0 not found (AIDLC_CODEX_BIN=${CODEX_BIN})`;
  if (!existsSync(CODEX_DIST)) return `distributable missing: ${CODEX_DIST}`;
  return null;
}
const SKIP_REASON = skipReason();

// The journey root with the codex shell, git-init'd + trusted + a CODEX_HOME
// config.toml (Bedrock provider + project trust). Mirrors setupCodexProject in
// t-exec-codex-status, but the project dir is the WORKSPACE ROOT carrying two
// sibling repos (setupWorkspaceJourney) — the engine runs against the root.
function setupCodexJourney(): WorkspaceJourney {
  const journey = setupWorkspaceJourney("codex");
  const { root, home } = journey;
  // The codex project must be a git repo (project hooks.json discovery — MR-3
  // D10). git-init the workspace ROOT; the sibling repos keep their own .git
  // (embedded; the `add -A` warns but does not fail).
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "install"],
  ]) {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  }
  const trust = spawnSync(
    "bun",
    [join(REPO_ROOT, "scripts", "package.ts"), "codex", "trust", "--project", root],
    { encoding: "utf-8", cwd: REPO_ROOT },
  );
  if (trust.status !== 0) throw new Error(`trust emit failed: ${trust.stderr}`);
  writeFileSync(
    join(home, "config.toml"),
    [
      `model = "openai.gpt-5.5"`,
      `model_provider = "amazon-bedrock"`,
      `model_context_window = 1000000`,
      `model_reasoning_effort = "low"`,
      ``,
      `[model_providers.amazon-bedrock.aws]`,
      `profile = "${AWS_PROFILE}"`,
      `region = "${AWS_REGION}"`,
      ``,
      `[shell_environment_policy]`,
      `set = { AIDLC_RULES_DIR = ".codex/aidlc-rules" }`,
      ``,
      `[projects."${root}"]`,
      `trust_level = "trusted"`,
      ``,
      trust.stdout,
    ].join("\n"),
    "utf-8",
  );
  return journey;
}

function execCodex(
  proj: string,
  home: string,
  prompt: string,
  timeoutMs: number = VERB_EXEC_MS,
): { rc: number; out: string } {
  const r = spawnSync(CODEX_BIN, ["exec", prompt], {
    cwd: proj,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CODEX_HOME: home },
    timeout: timeoutMs,
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

// The engine resolves the per-repo codekb store to the SPACE-LEVEL sibling of
// intents (aidlc/spaces/<space>/codekb/<repo>/ - the dir codekb-path prints, the
// codekb-determinism placement fix), but the live RE subagent occasionally still
// writes the bare workspace-root form aidlc/codekb/<repo>/. Either is a valid
// per-repo store for this beat's promise; accept BOTH, only absence is a fail
// (matching the SDK t-journey-workspace.sdk sibling helper verbatim, and the ACP
// t-acp-kiro-journey-workspace sibling modulo candidate order).
function codekbFiles(root: string, repo: string): string[] {
  const candidates = [
    join(root, "aidlc", "spaces", activeSpace(root), "codekb", repo),
    join(root, "aidlc", "codekb", repo),
  ];
  for (const dir of candidates) {
    try {
      const md = readdirSync(dir).filter((f) => f.endsWith(".md"));
      if (md.length > 0) return md;
    } catch {
      /* try the next candidate */
    }
  }
  return [];
}

function activeRecordDir(root: string): string | undefined {
  return listIntents(root, activeSpace(root)).find((i) => i.active)?.dirName ?? undefined;
}

/** The RE codekb beat has TWO valid outcomes, and both keep the multi-repo journey
 *  intact. Brownfield: reverse-engineering EXECUTEs and writes a per-repo codekb
 *  store, so the codekbFiles asserts below hold. Greenfield: the engine stamps
 *  reverse-engineering SKIP at intent birth (aidlc-utility.ts records it in the
 *  Stages to Skip row), so no codekb is written and the asserts must not run (the
 *  skip is the correct behaviour, not a flake). This reads the born intent's
 *  aidlc-state.md and returns true only for that greenfield RE-skip: Project Type is
 *  Greenfield AND the Stages to Skip row names the reverse-engineering slug. We match
 *  the bare slug, never the row's human annotation (the engine writes it with an
 *  em-dash phrase we deliberately avoid touching). A genuine brownfield RE failure
 *  still falls through to the asserts and reds, as it should. */
function greenfieldReSkip(recordDir: string): boolean {
  let content: string;
  try {
    content = readFileSync(join(recordDir, "aidlc-state.md"), "utf-8");
  } catch {
    return false;
  }
  const projectType = (getField(content, "Project Type") ?? "").toLowerCase();
  const stagesToSkip = getField(content, "Stages to Skip") ?? "";
  return projectType === "greenfield" && stagesToSkip.includes("reverse-engineering");
}

/** Count WORKFLOW_STARTED events in a record's audit shards — exactly one for an
 *  intent's own birth; a SECOND means a foreign birth bled in. Per-session
 *  SessionStart/End hooks append SESSION_* events to the active intent, so raw
 *  shard bytes are not stable across spawns; this count is the stable collision
 *  signal (see the SDK leg's note). */
function workflowStartedCount(recordDir: string): number {
  let n = 0;
  try {
    for (const f of readdirSync(join(recordDir, "audit"))) {
      if (!f.endsWith(".md")) continue;
      const body = readFileSync(join(recordDir, "audit", f), "utf-8");
      n += (body.match(/^\*\*Event\*\*:\s*WORKFLOW_STARTED\s*$/gm) ?? []).length;
    }
  } catch {
    /* no audit dir → 0 */
  }
  return n;
}

describe("t-exec-codex-journey-workspace (live codex-exec multi-repo·intent·space journey)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `one feature spanning two repos, a 2nd intent, a non-default space — composed live over codex exec${SKIP_REASON ? ` [SKIP: ${SKIP_REASON}]` : ""}`,
    () => {
      const journey = setupCodexJourney();
      const { root, home } = journey;
      try {
        // --- Step 1: auto-birth A spanning both siblings ---------------------
        // Name the scope explicitly: a bare prose `/aidlc "<desc>"` emits an `ask`
        // scope-confirm (orchestrate Branch 8 :1148) that the ONE-SHOT codex exec
        // spawn cannot answer (no stdin), so the run would end before birth.
        // `--scope feature` births via Branch 9a with no gate; the repo span is
        // still captured by sibling auto-discovery.
        const r1 = execCodex(
          root,
          home,
          `Use the $aidlc skill to run: /aidlc --scope feature "build auth across both repos"`,
        );
        expect(r1.rc).toBe(0);
        const reg1 = readIntentRegistry(root);
        expect(reg1.length).toBe(1);
        expect(reg1[0].repos).toEqual(["repo-a", "repo-b"]);
        expect(reg1[0].uuid).toMatch(UUIDV7_RE);
        expect(reg1[0].status).toBe("in-flight");
        const recordA = activeRecordDir(root);
        expect(recordA).toBeDefined();

        // --- Step 2: per-repo codekb for both siblings (cheaper variant) ------
        const r2 = execCodex(
          root,
          home,
          `Use the $aidlc skill to run: /aidlc --stage reverse-engineering --single`,
          CODEKB_EXEC_MS,
        );
        expect(r2.rc).toBe(0);
        // Resolve A's record dir up front (hoisted above the codekb asserts) so we can
        // read its state-file and tell which of the two valid RE outcomes applies.
        const recordADir = join(root, "aidlc", "spaces", "default", "intents", recordA as string);
        if (greenfieldReSkip(recordADir)) {
          // Greenfield: reverse-engineering was stamped SKIP at birth, so no per-repo
          // codekb is expected. The recorded skip is the correct outcome; accept it and
          // do NOT run the codekb asserts (permissive by design).
          expect(greenfieldReSkip(recordADir)).toBe(true);
        } else {
          // Brownfield: reverse-engineering ran, so both repos got a codekb store.
          expect(codekbFiles(root, "repo-a").length).toBeGreaterThan(0);
          expect(codekbFiles(root, "repo-b").length).toBeGreaterThan(0);
        }

        const stateABefore = readFileSync(join(recordADir, "aidlc-state.md"), "utf-8");
        expect(workflowStartedCount(recordADir)).toBe(1);

        // --- Step 3: a SECOND isolated intent alongside A --------------------
        // Name the intent-birth tool directly (mints unconditionally) so the
        // conductor does not route via `next` and advance/scope-change A.
        const r3 = execCodex(root, home, birthToolPrompt("poc", "build a standalone metrics dashboard"));
        expect(r3.rc).toBe(0);
        const reg3 = readIntentRegistry(root);
        expect(reg3.length).toBe(2);
        expect(new Set(reg3.map((e) => e.uuid)).size).toBe(2);
        for (const e of reg3) expect(e.uuid).toMatch(UUIDV7_RE);
        // A's workflow state untouched + B's birth did not bleed into A's shard.
        expect(readFileSync(join(recordADir, "aidlc-state.md"), "utf-8")).toBe(stateABefore);
        expect(workflowStartedCount(recordADir)).toBe(1);

        // --- Step 4: non-default space, no learnings leak --------------------
        const r4 = execCodex(root, home, `Use the $aidlc skill to run: /aidlc space-create teamB`);
        expect(r4.rc).toBe(0);
        const teamBMemory = join(root, "aidlc", "spaces", TEAM_B_SLUG, "memory");
        const defaultOrg = readFileSync(
          join(root, "aidlc", "spaces", "default", "memory", "org.md"),
          "utf-8",
        );
        expect(readFileSync(join(teamBMemory, "org.md"), "utf-8")).toBe(defaultOrg);
        expect(readFileSync(join(teamBMemory, "team.md"), "utf-8")).toBe("# Team practices\n");
        expect(readFileSync(join(teamBMemory, "project.md"), "utf-8")).toBe("# Project overrides\n");
        // space-create (#5) provisions the full space shape incl. the codekb/ +
        // knowledge/ siblings (with .gitkeep floors), matching default.
        expect(existsSync(join(root, "aidlc", "spaces", TEAM_B_SLUG, "knowledge"))).toBe(true);
        expect(existsSync(join(root, "aidlc", "spaces", TEAM_B_SLUG, "codekb"))).toBe(true);

        const r4b = execCodex(root, home, `Use the $aidlc skill to run: /aidlc space teamB`);
        expect(r4b.rc).toBe(0);
        expect(activeSpace(root)).toBe(TEAM_B_SLUG);

        const r4c = execCodex(root, home, birthToolPrompt("poc", "teamB onboarding flow"));
        expect(r4c.rc).toBe(0);
        expect(readIntentRegistry(root, TEAM_B_SLUG).length).toBe(1);
        expect(readIntentRegistry(root, "default").length).toBe(2);
        expect(existsSync(join(root, "aidlc", "spaces", TEAM_B_SLUG, "knowledge"))).toBe(true);

        // --- Step 5: back to default; A still resumable ----------------------
        const r5 = execCodex(root, home, `Use the $aidlc skill to run: /aidlc space default`);
        expect(r5.rc).toBe(0);
        expect(activeSpace(root)).toBe("default");
        // A's workflow state survived the round trip; no foreign birth bled in.
        expect(readFileSync(join(recordADir, "aidlc-state.md"), "utf-8")).toBe(stateABefore);
        expect(workflowStartedCount(recordADir)).toBe(1);
        expect(readIntentRegistry(root, "default").length).toBe(2);
      } finally {
        cleanupWorkspaceJourney(journey);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
