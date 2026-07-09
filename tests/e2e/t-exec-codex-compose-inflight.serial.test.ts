// covers: file:skills/aidlc/SKILL.md
//
// t-exec-codex-compose-inflight.serial.test.ts - the P4 in-flight recompose
// journey on Codex, the Codex logic-half twin of the SDK test
// t196-compose-inflight. t196 proves the CONDUCTOR arc over the Claude SDK; this
// proves the SAME arc runs on the shipped dist/codex conductor, expressed in the
// driver's native turn shape plus `codex exec resume --last` (continues the SAME
// recorded session - same session id, same rollout file, full context - so a
// gate that ends beat 1 is answered by a scripted beat 2, the same capability
// the front-compose twin uses).
//
//   seed:   a BORN-shape feature workflow (the state-initialization-done
//           fixture: cursor at intent-capture, market-research + team-formation
//           pending grid-EXECUTE ahead of it). Seeded from a fixture rather than
//           a subprocess intent-birth so the deterministic tier stays
//           fixture-driven, the same posture the front + reviewer twins take.
//   beat 1: codex exec `/aidlc compose "drop market research and team formation
//           ..."` - the conductor dispatches the composer, proposes SKIP flips,
//           writes the pending marker `aidlc/.aidlc-compose-pending`, and ends
//           the turn AT the approve/edit/reject gate (numbered prose:
//           request_user_input returns {} in exec mode). NOTHING is applied:
//           the state file is byte-unchanged, no RECOMPOSED. JOURNEY TOLERANCE:
//           the live codex conductor sometimes drops the leading verb when
//           forwarding, landing on the engine's cold-start compose OFFER
//           ("reply with compose...") instead; when that happens the journey
//           answers "compose" in the same session and expects the gate next.
//   beat 2: codex exec resume --last "Approve" - same session (asserted via the
//           stderr session id), the conductor runs the recompose verb and
//           deletes the marker.
//   disk:   market-research now carries the SKIP suffix, the cursor and every
//           checkbox marker are byte-unchanged, Total Stages shrank, Stages to
//           Skip names market-research, RECOMPOSED audited, the marker gone.
//
// JOURNEY-LEVEL tolerance (mirrors t196): the live composer exercises judgment
// over WHICH of the two named stages to flip (a run keeping team-formation was
// observed), so the deterministic contract is that at least the unambiguous
// market-research flip landed AS A SUFFIX EDIT, the plan shrank, and the cursor
// never moved. t194 pins the exact multi-flip mechanics. The marker is asserted
// absent only AFTER beat 2 completes (resume returns when the turn is done),
// avoiding the write-then-delete race t196 documents.
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
  copyFileSync,
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
import {
  DEFAULT_INTENT_UUID,
  DEFAULT_RECORD_DIR,
  FIXTURE_CLONE_ID,
  FIXTURES_DIR,
  REPO_ROOT,
  seededRecordDir,
} from "../harness/fixtures.ts";

const CODEX_DIST = join(REPO_ROOT, "dist", "codex");
const CODEX_BIN = process.env.AIDLC_CODEX_BIN ?? "codex";
const AWS_PROFILE = process.env.AIDLC_CODEX_AWS_PROFILE ?? "codex";
const AWS_REGION = process.env.AIDLC_CODEX_AWS_REGION ?? "us-east-2";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "600", 10);
const PER_BEAT_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 600) * 1000;
// Up to three live turns back to back (compose front, the offer-recovery arm,
// then the resume-approve), so the envelope covers them all plus slack.
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

// Same scratch-install shape as the front-compose twin (dist/codex verbatim,
// git-initialized, Bedrock provider + project trust + hook trust pre-seed), plus
// the sibling aidlc/ workspace shell and a fixture-seeded BORN feature record
// (the running workflow this journey re-shapes). Seeding from a fixture keeps
// the deterministic tier fixture-driven - no subprocess intent-birth.
function setupCodexProject(): { proj: string; home: string; root: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-exec-")));
  const proj = join(root, "proj");
  const home = join(root, "codex-home");
  mkdirSync(home, { recursive: true });
  cpSync(join(CODEX_DIST, ".codex"), join(proj, ".codex"), { recursive: true });
  cpSync(join(CODEX_DIST, ".agents"), join(proj, ".agents"), { recursive: true });
  cpSync(join(CODEX_DIST, "AGENTS.md"), join(proj, "AGENTS.md"));
  // The sibling aidlc/ memory shell ships beside the engine dir; copy it so the
  // rule-layer resolver finds it (same copy setupWorkspaceJourney does).
  cpSync(join(CODEX_DIST, "aidlc"), join(proj, "aidlc"), { recursive: true });

  // Seed a BORN feature record: the default intent record + cursors + registry +
  // pinned clone-id + the born-shape state fixture. Mirrors the per-intent shell
  // the tui/sdk fixtures seed (seedWorkspaceShell), inlined here because the
  // codex project is scaffolded from the dist tree rather than a fixture helper.
  const intentsDir = join(proj, "aidlc", "spaces", "default", "intents");
  const record = join(intentsDir, DEFAULT_RECORD_DIR);
  mkdirSync(record, { recursive: true });
  writeFileSync(join(proj, "aidlc", ".aidlc-clone-id"), `${FIXTURE_CLONE_ID}\n`, "utf-8");
  writeFileSync(join(proj, "aidlc", "active-space"), "default\n", "utf-8");
  writeFileSync(join(intentsDir, "active-intent"), `${DEFAULT_RECORD_DIR}\n`, "utf-8");
  writeFileSync(
    join(intentsDir, "intents.json"),
    `${JSON.stringify(
      [{ uuid: DEFAULT_INTENT_UUID, slug: DEFAULT_RECORD_DIR.replace(/-[0-9a-f]+$/, ""), status: "in-flight" }],
      null,
      2,
    )}\n`,
    "utf-8",
  );
  copyFileSync(
    join(FIXTURES_DIR, "state-initialization-done.md"),
    join(record, "aidlc-state.md"),
  );

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

// One codex turn. `resume: true` continues the newest recorded session for this
// cwd (`codex exec resume --last "<prompt>"`) instead of starting fresh. stderr
// is kept separate: the `session id:` line lives there and is the deterministic
// same-session proof.
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

/** The seeded record's state file (recompose writes back to this same file). */
function readState(proj: string): string {
  return readFileSync(join(seededRecordDir(proj), "aidlc-state.md"), "utf-8");
}

/** The pending-proposal marker (aidlc/.aidlc-compose-pending, project-root aidlc/). */
function markerPath(proj: string): string {
  return join(proj, "aidlc", ".aidlc-compose-pending");
}

function auditText(proj: string): string {
  const dir = join(seededRecordDir(proj), "audit");
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => readFileSync(join(dir, f), "utf-8"))
    .join("\n");
}

describe("t-exec-codex-compose-inflight - in-flight recompose over exec + exec resume", () => {
  test.skipIf(SKIP_REASON !== null)(
    `beat 1 stops at the gate with nothing applied; beat 2 resume-approves the SKIP flips${SKIP_REASON ? ` [SKIP: ${SKIP_REASON}]` : ""}`,
    () => {
      const { proj, home, root } = setupCodexProject();
      try {
        const before = readState(proj);
        expect(before).toMatch(/- \[ \] market-research .* EXECUTE/);
        expect(before).toMatch(/- \[ \] team-formation .* EXECUTE/);
        const cursorBefore = /- \*\*Current Stage\*\*: (.*)/.exec(before)?.[1];
        const totalBefore = Number(/- \*\*Total Stages\*\*: (\d+)/.exec(before)?.[1]);
        const markersBefore = [...before.matchAll(/^- \[[ xSR?-]\] \S+/gm)].map((m) => m[0]);
        expect(markersBefore.length).toBeGreaterThan(0);

        // Beat 1: the compose front. The turn must END at a human question (the
        // proposal gate, or - conductor-forwarding variance - the engine's
        // cold-start compose offer) with the marker written but NOTHING applied.
        const b1 = codexTurn(
          proj,
          home,
          'Use the $aidlc skill to run: /aidlc compose "drop market research and team formation from this workflow - we already know the market and the team"',
        );
        expect(b1.rc).toBe(0);
        const b1Session = sessionIdOf(b1.stderr);
        expect(b1Session).toBeDefined();

        // If the verb was dropped and the engine asked the compose OFFER instead
        // of the proposal gate, answer "compose" in-session; the next turn must
        // land on the gate. Still: nothing applied yet.
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
        // Marker written, nothing applied: state byte-unchanged, no RECOMPOSED.
        expect(existsSync(markerPath(proj))).toBe(true);
        expect(readState(proj)).toBe(before);
        expect(auditText(proj)).not.toContain("**Event**: RECOMPOSED");

        // Beat 2: answer the gate in the SAME session.
        const b2 = codexTurn(proj, home, "Approve", { resume: true });
        expect(b2.rc).toBe(0);
        // Same-session proof: resume continued beat 1's conversation.
        expect(sessionIdOf(b2.stderr)).toBe(b1Session);

        // The approve applied the flips as suffix edits; cursor + markers
        // byte-unchanged (a plan edit, not a stage advance).
        const after = readState(proj);
        expect(after).toMatch(/- \[ \] market-research .* SKIP/);
        const cursorAfter = /- \*\*Current Stage\*\*: (.*)/.exec(after)?.[1];
        expect(cursorAfter).toBe(cursorBefore);
        const markersAfter = [...after.matchAll(/^- \[[ xSR?-]\] \S+/gm)].map((m) => m[0]);
        expect(markersAfter).toEqual(markersBefore);
        // Derived fields rebuilt: total dropped by at least the one flip.
        const totalAfter = Number(/- \*\*Total Stages\*\*: (\d+)/.exec(after)?.[1]);
        expect(totalAfter).toBeLessThan(totalBefore);
        // And the rebuilt Stages to Skip names the flipped stage.
        expect(after).toMatch(/- \*\*Stages to Skip\*\*: .*market-research/);

        // RECOMPOSED audited and the marker gone (beat 2 returned only when the
        // turn fully resolved, so this is the settled end state - the strongest
        // proof the recompose verb ran, mirroring t196's audit assertion).
        expect(auditText(proj)).toContain("**Event**: RECOMPOSED");
        expect(existsSync(markerPath(proj))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
