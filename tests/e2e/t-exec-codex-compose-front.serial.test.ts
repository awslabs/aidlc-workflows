// covers: file:skills/aidlc/SKILL.md
//
// t-exec-codex-compose-front.serial.test.ts - the INTERACTIVE front-compose
// journey on Codex, expressed in the driver's native turn shape plus the one
// capability the older codex tests never used: `codex exec resume --last`
// continues the SAME recorded session (same session id, same rollout file,
// full context), so a gate that ends turn 1 can be answered by a scripted
// turn 2. Spike-proven 2026-07-02 (three-turn echo continuity + a full live
// beats-1-2 aidlc probe); artefacts under
// tmp/adaptive-workflows/spike-codex-resume/.
//
//   beat 1:  codex exec `/aidlc compose "<task>"` - the conductor dispatches
//            the composer, renders the proposal, and ends the turn AT the
//            approve/edit/reject gate as numbered prose (`request_user_input`
//            returns {} in exec mode, so the SKILL.md numbered-prose arm
//            fires). NOTHING is written: no scope data, no state file, no
//            intent record. JOURNEY TOLERANCE: the live codex conductor
//            sometimes drops the leading verb when forwarding (the known
//            conductor-forwarding variance on this harness), landing on the
//            engine's cold-start compose OFFER instead ("reply with
//            compose..."); when that happens the journey answers "compose"
//            in the same session and expects the gate on the next turn.
//            Either way: gate before write, nothing on disk.
//   beat 2:  codex exec resume --last "Approve" - same session (asserted via
//            the stderr session id), the conductor completes the write +
//            birth arc: intent record, aidlc-state.md, WORKFLOW_STARTED
//            audited.
//
// Deliberately JOURNEY-LEVEL: the composed scope's NAME is the model's
// choice, and the sanctioned `.codex/scopes/` write is sandbox-denied under
// plain codex exec (the conductor self-recovers via the scope-mapping env
// seam - spike section 5), so this test pins the observable contract (gate
// stop with no birth; same-session approve -> birth + audit) and leaves
// scope-file placement to the sandbox-grant design.
//
// `--last` filters recorded sessions by cwd, so beat 2 MUST run with the same
// cwd as beat 1 (both use the project dir).
//
// LIVE GATE: requires AIDLC_CODEX_EXEC_LIVE=1 + a codex >= 0.139.0 binary
// (AIDLC_CODEX_BIN or PATH) + AWS creds for the Bedrock profile in
// AIDLC_CODEX_AWS_PROFILE (default "codex"). Skips cleanly otherwise.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const CODEX_DIST = join(REPO_ROOT, "dist", "codex");
const CODEX_BIN = process.env.AIDLC_CODEX_BIN ?? "codex";
const AWS_PROFILE = process.env.AIDLC_CODEX_AWS_PROFILE ?? "codex";
const AWS_REGION = process.env.AIDLC_CODEX_AWS_REGION ?? "us-east-2";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "600", 10);
const PER_BEAT_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 600) * 1000;
// Up to three live turns back to back (the approve beat alone ran ~9 min in
// the spike; the offer-recovery arm adds one), so the envelope covers them
// all plus slack.
const TEST_TIMEOUT_MS = PER_BEAT_TIMEOUT_MS * 3 + 30_000;

function codexVersionOk(): boolean {
  const r = spawnSync(CODEX_BIN, ["--version"], { encoding: "utf-8" });
  const m = (r.stdout ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (r.status !== 0 || !m) return false;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > 0 || min >= 139;
}

function skipReason(): string | null {
  if (process.env.AIDLC_CODEX_EXEC_LIVE !== "1") {
    return "set AIDLC_CODEX_EXEC_LIVE=1 to run the live codex-exec journey (uses Bedrock)";
  }
  if (!codexVersionOk()) return `codex >= 0.139.0 not found (AIDLC_CODEX_BIN=${CODEX_BIN})`;
  if (!existsSync(CODEX_DIST)) return `distributable missing: ${CODEX_DIST}`;
  return null;
}
const SKIP_REASON = skipReason();

// Same scratch-install shape as t-exec-codex-status (dist/codex verbatim,
// git-initialized, Bedrock provider + project trust + hook trust pre-seed).
function setupCodexProject(): { proj: string; home: string; root: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-exec-")));
  const proj = join(root, "proj");
  const home = join(root, "codex-home");
  mkdirSync(home, { recursive: true });
  cpSync(join(CODEX_DIST, ".codex"), join(proj, ".codex"), { recursive: true });
  cpSync(join(CODEX_DIST, ".agents"), join(proj, ".agents"), { recursive: true });
  cpSync(join(CODEX_DIST, "AGENTS.md"), join(proj, "AGENTS.md"));
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "install"],
  ]) {
    const r = spawnSync("git", args, { cwd: proj, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  }
  const trust = spawnSync(
    "bun",
    [join(REPO_ROOT, "scripts", "package.ts"), "codex", "trust", "--project", proj],
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
      `[projects."${proj}"]`,
      `trust_level = "trusted"`,
      ``,
      trust.stdout,
    ].join("\n"),
    "utf-8",
  );
  return { proj, home, root };
}

// One codex turn. `resume: true` continues the newest recorded session for
// this cwd (`codex exec resume --last "<prompt>"`) instead of starting fresh.
// stderr is kept separate: the `session id:` line lives there and is the
// deterministic same-session proof.
function codexTurn(
  proj: string,
  home: string,
  prompt: string,
  opts: { resume?: boolean } = {},
): { rc: number; stdout: string; stderr: string } {
  const argv = opts.resume ? ["exec", "resume", "--last", prompt] : ["exec", prompt];
  const r = spawnSync(CODEX_BIN, argv, {
    cwd: proj,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CODEX_HOME: home },
    timeout: PER_BEAT_TIMEOUT_MS,
  });
  return { rc: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const sessionIdOf = (stderr: string): string | undefined =>
  /session id:\s*([0-9a-f-]{36})/i.exec(stderr)?.[1];

function intentRecords(proj: string): string[] {
  const dir = join(proj, "aidlc", "spaces", "default", "intents");
  if (!existsSync(dir)) return [];
  // Dot-dirs are hook plumbing (the Stop hook's .aidlc-hooks-health
  // heartbeat lands here on every turn), not intent records.
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name);
}

describe("t-exec-codex-compose-front - interactive compose over exec + exec resume", () => {
  test.skipIf(SKIP_REASON !== null)(
    `beat 1 stops at the gate with nothing written; beat 2 resume-approves into birth${SKIP_REASON ? ` [SKIP: ${SKIP_REASON}]` : ""}`,
    () => {
      const { proj, home, root } = setupCodexProject();
      try {
        // Beat 1: the compose front. The turn must END at a human question
        // (the proposal gate, or - conductor-forwarding variance - the
        // engine's cold-start compose offer) with NOTHING written.
        const b1 = codexTurn(
          proj,
          home,
          'Use the $aidlc skill to run: /aidlc compose "add a rate limiter middleware to an existing Express API"',
        );
        expect(b1.rc).toBe(0);
        const b1Session = sessionIdOf(b1.stderr);
        expect(b1Session).toBeDefined();
        expect(intentRecords(proj)).toEqual([]);

        // If the verb was dropped and the engine asked the compose OFFER
        // instead of the proposal gate, answer "compose" in-session; the
        // next turn must land on the gate. Still: nothing written yet.
        let gateOut = b1.stdout;
        if (!/approve/i.test(gateOut)) {
          expect(gateOut).toMatch(/compose/i);
          const offerTurn = codexTurn(proj, home, "compose", { resume: true });
          expect(offerTurn.rc).toBe(0);
          expect(sessionIdOf(offerTurn.stderr)).toBe(b1Session);
          gateOut = offerTurn.stdout;
        }
        // The approve/edit/reject gate reached the final message.
        expect(gateOut).toMatch(/approve/i);
        expect(gateOut).toMatch(/reject/i);
        // Nothing written before approval: no state file, no intent record.
        expect(intentRecords(proj)).toEqual([]);
        expect(
          existsSync(join(proj, "aidlc", "spaces", "default", "intents", "active-intent")),
        ).toBe(false);

        // Beat 2: answer the gate in the SAME session.
        const b2 = codexTurn(proj, home, "Approve", { resume: true });
        expect(b2.rc).toBe(0);
        // Same-session proof: resume continued beat 1's conversation.
        expect(sessionIdOf(b2.stderr)).toBe(b1Session);

        // The approve completed the write + birth arc on disk.
        const records = intentRecords(proj);
        expect(records.length).toBe(1);
        const rec = join(proj, "aidlc", "spaces", "default", "intents", records[0]);
        const state = readFileSync(join(rec, "aidlc-state.md"), "utf-8");
        expect(state).toContain("# AI-DLC State Tracking");
        const auditDir = join(rec, "audit");
        const audit = readdirSync(auditDir)
          .filter((f) => f.endsWith(".md"))
          .map((f) => readFileSync(join(auditDir, f), "utf-8"))
          .join("\n");
        expect(audit).toContain("**Event**: WORKFLOW_STARTED");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
