// covers: audit:SENSOR_FIRED audit:WORKSPACE_INITIALISED render-surface:statusline-agent-name
//
// COVERS NOTE — the custom scope/stages/sensor are NET-NEW units that exist only
// in the temp fixture, NOT in the shipped scope metadata / stage graph the
// registry enumerates, so there is no `scope:data-migration` /
// `stage:schema-snapshot` unit to claim — the registry universe is the shipped
// config. What this journey legitimately moves off zero is the SHIPPED audit
// units it fires in a real run: `audit:SENSOR_FIRED` (the custom sensor's fire
// is a real SENSOR_FIRED row — and this is the FIRST test to drive that event
// live; it was UNCOVERED) and `audit:WORKSPACE_INITIALISED` (the scope-routing
// init event). Both clear the audit bar (minMechanism=none) via either driver
// in the {sdk,tui} set. Per registry-honesty: the SENSOR_FIRED credit is earned
// ONLY by the AIDLC_TUI_LIVE tui half — regenerate the registry greens-only,
// after a watched live green, never on a skipped run.
//
// t-tui-custom-harness — the Phase-5 Harness-Engineer journey: the ONE genuine
// {sdk, tui} TWO-DRIVER test (§5-B). It calls BOTH driveAidlc() (sdk) AND spawns
// tui-drive.ts (tui) over ONE customHarness project, so the derive-by-driver
// registry (Phase 0 mechanismsOf) reads the set {sdk, tui} — the concrete
// two-driver case the old single-label filename suffix could not express. The
// journey is driven the way a human drives it (answer
// the gate by keystroke), and the sdk half is a genuine one-shot read of the
// tool-emitted audit.
//
// WHAT A HARNESS ENGINEER DOES (docs/harness-engineering/00-overview.md): reshape the
// framework WITHOUT code by editing DATA — a custom scope (which stages run),
// custom stages (what happens), how stages join up (a produce->consume chain),
// what artefacts get produced, the custom agent that leads those stages, custom
// knowledge that reaches that agent, bound sensors, and rules. The customHarness
// fixture (tests/harness/custom-harness.ts) seeds a `data-migration` scope with
// a TWO-STAGE CHAIN — the schema-snapshot stage (2.0, produces the `source-schema`
// artefact) -> the migration-plan stage (2.9, consumes `source-schema`, produces
// the `migration-strategy` artefact), both inception — plus a custom
// `Data Migration Agent`, a custom knowledge playbook, a `schema-validator`
// sensor, and a unique project-rule marker. Note the slug≠ artefact split
// (shipped convention: the stage is the ACTIVITY, the artefact is the named
// DELIVERABLE). "Harness Engineer" is the PERSONA; data-migration is the
// realistic domain workflow they define.
//
// THE GAP IT FILLS (§3b L-PERSONA). The "edit resolves at compile" half + every
// error mode live in the deterministic sibling (t-custom-harness-compile,
// tests/integration/, no tokens). What was UNBUILT — and what THIS file proves —
// is the "the agent actually SEES the custom harness in a REAL run" half: a grep
// across the suite for "seed a custom scope/sensor/rule then drive /aidlc to
// prove the agent picks it up" returned zero tests.
//
// THE SURFACES it proves the agent sees in a real run, each as DETERMINISTIC
// DATA (never graded LLM prose):
//   1. CUSTOM SCOPE ROUTES ITS STAGES — sdk: the init tool, driven by the real
//      orchestrator, records Scope=data-migration and routes to the custom head
//      stage (WORKSPACE_INITIALISED audit Details + Scope field; Current
//      Stage=schema-snapshot in state). schema-snapshot is the lowest non-init
//      EXECUTE in the scope, so init routes straight to it (the reachability
//      keystone — see the fixture header).
//   2. CUSTOM SENSOR FIRES — tui: answering the stage gate(s) by keystroke makes
//      the orchestrator write a produced artefact under aidlc-docs/, which trips
//      the custom sensor's matches glob while a custom stage is active ->
//      SENSOR_FIRED audit row + a detail dir under aidlc-docs/.aidlc-sensors/.
//      (This is provable only by a real human-driven run that actually answers
//      the gate so the artefact lands, which is the point.)
//   3. CUSTOM RULE REACHES THE AGENT — two ways, both data: (a) the compiled
//      stage-graph node carries aidlc/spaces/default/memory/project.md in
//      rules_in_context AND that file carries the unique custom-rule marker (the
//      compile-baked half, proven here + in the deterministic sibling); (b) the
//      live artefact the agent writes CITES the marker (runtime evidence the
//      rule reached the agent).
//   4. CUSTOM AGENT + STAGE RENDER IN THE STATUSLINE — tui: the painted
//      statusline shows "> schema-snapshot -- Data Migration Agent". The custom
//      stage slug falls through STAGE_DISPLAY as raw slug; the custom agent
//      display name derives from `.claude/agents/*.md` via loadAgents().
//
// HOW STAGES JOIN UP (the user's emphasis). The tui journey answers BOTH gates —
// schema-snapshot's, then migration-plan's — and terminates on the migration-plan
// artefact appearing on disk. migration-plan consumes what schema-snapshot
// produces, so reaching migration-plan's artefact proves the chain executed in
// order: the produce->consume edge is honoured at runtime, not just at compile.
//
// FINDING F1 (verified, surfaced — not softened). A custom scope is NOT
// recognized by NAME in freeform dispatch: detect-scope keyword-matches the
// `keywords[]` list, not the scope KEY, so `/aidlc data-migration ...` as
// freeform returns the default `feature` scope, NOT data-migration. The
// deterministic setup path is `aidlc-utility.ts init --scope data-migration`;
// the live halves then resume that custom-scope state.
//
// SOURCE-PINNED FACTS (verify-never-guess; each read off disk before coding):
//   - custom harness recipe + reachability (init auto-completes init-phase
//     stages; the custom head stage must be the lowest non-init number to become
//     firstPostInit): tests/harness/custom-harness.ts header + its constants.
//   - lead_agent appears in the run-stage directive from aidlc-orchestrate.ts,
//     populated directly from stage-graph.json.
//   - init records Scope + routes to firstPostInit + Lifecycle Phase=INCEPTION:
//     aidlc-utility.ts:2087-2112 (verified: init --scope data-migration writes
//     Lifecycle Phase: INCEPTION, Current Stage: schema-snapshot).
//   - SENSOR_FIRED event string + detail path: aidlc-sensor.ts:296 / :268-270.
//   - statusline raw-slug fallback: aidlc-statusline.ts:220.
//   - F1 freeform vs --scope dispatch: SKILL.md:110 (--scope) vs detect-scope.
//
// IRON RULE: a surface that fails here is a real FINDING about whether the
// framework actually honours a harness engineer's edit — surfaced to the user,
// never softened. Vacuous-pass guards below ensure each surface genuinely fired.
//
// COST: the tui half spends real Bedrock tokens (a human-driven run through both
// custom-stage gates) — gated behind AIDLC_TUI_LIVE=1. The sdk half also spends
// tokens (driveAidlc runs the orchestrator on Opus/Bedrock). The compile-rule
// test + the seeded-state statusline capture spend none. Absent
// tmux/claude/distributable -> SKIP with a reason, never a hollow pass.
//
// SPAWN, not import (D-TUI-7): tui-drive.ts runs as a subprocess (node on
// Windows so node-pty never loads under bun #748; bun elsewhere). The
// tui-drive.ts spawn is what DERIVES the tui mechanism; the driveAidlc() call is
// what derives sdk — together {sdk, tui}.

import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { assertAuditEvent, assertToolResultContains } from "../harness/assert.ts";
import {
  CUSTOM_RULE_MARKER,
  CUSTOM_AGENT_DISPLAY,
  CUSTOM_AGENT_SLUG,
  CUSTOM_KNOWLEDGE_MARKER,
  CUSTOM_SCOPE,
  CUSTOM_SENSOR_ID,
  PLAN_ARTIFACT,
  PLAN_OUTPUT_REL,
  PLAN_STAGE_PHASE,
  PLAN_STAGE_SLUG,
  SNAPSHOT_ARTIFACT,
  SNAPSHOT_STAGE_PHASE,
  SNAPSHOT_STAGE_SLUG,
} from "../harness/custom-harness.ts";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { driveAidlc, recordDirFor, stateFilePathFor } from "../harness/sdk-drive.ts";
import { resolveWinNode } from "../harness/tui-drive.ts";
import { cleanupTuiProject, setupTuiProject } from "../harness/tui-fixtures.ts";

const DRIVER = join(import.meta.dir, "..", "harness", "tui-drive.ts");
const IS_WIN = os.platform() === "win32";
const WIN_NODE = IS_WIN ? resolveWinNode() : null;
const DRIVE_BIN = IS_WIN ? (WIN_NODE as string) : process.execPath;
const DRIVE_PREFIX = IS_WIN ? ["--experimental-strip-types", DRIVER] : [DRIVER];

// Wedge-ceiling, never a budget (the timer lesson): one generous cap; pass on
// the on-disk signal, not the clock. Matches the suite convention.
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "2400", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 2400) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(120_000, TEST_TIMEOUT_MS - 15_000);

interface Run {
  rc: number;
  stdout: string;
  stderr: string;
}
function drive(args: string[]): Run {
  const res = spawnSync(DRIVE_BIN, [...DRIVE_PREFIX, ...args], { encoding: "utf-8" });
  return { rc: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}
function waitFor(session: string, pattern: string, timeoutMs: number, stableMs: number): boolean {
  return (
    drive([
      "wait",
      "--session",
      session,
      "--pattern",
      pattern,
      "--timeout-ms",
      String(timeoutMs),
      "--stable-ms",
      String(stableMs),
    ]).rc === 0
  );
}

// ABSENT / opt-in gating, AIDLC_TUI_LIVE first (a bare --e2e run reports the
// clear opt-in reason, not a substrate miss). Mirrors t-tui-workshop.
function skipReason(): string | null {
  if (process.env.AIDLC_TUI_LIVE !== "1") {
    return "set AIDLC_TUI_LIVE=1 to run the live harness-engineer journey (uses Bedrock tokens)";
  }
  if (!IS_WIN && spawnSync("tmux", ["-V"], { encoding: "utf-8" }).status !== 0) {
    return "tmux not found";
  }
  if (IS_WIN) {
    if (!WIN_NODE) return "node not found (required to run tui-drive on Windows — #748)";
    if (spawnSync(WIN_NODE, ["-e", "require('node-pty')"], { encoding: "utf-8" }).status !== 0) {
      return "node-pty not node-resolvable (npm install node-pty so node can require it)";
    }
  }
  if (spawnSync("claude", ["--version"], { encoding: "utf-8" }).status !== 0) {
    return "claude CLI not found";
  }
  return null;
}
const SKIP_REASON = skipReason();

/** Extract every audit event-type string from the active intent's audit shards,
 *  in order. P9 shards the audit per clone under <record>/audit/. */
function auditEvents(proj: string): string[] {
  return readAllAuditShards(proj)
    .split("\n")
    .filter((l) => l.startsWith("**Event**:"))
    .map((l) => l.replace("**Event**:", "").trim());
}

/** Read a `- **Field**: value` from a state-file string. */
function stateField(state: string, field: string): string | undefined {
  const esc = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = state.match(new RegExp(`^-\\s*\\*\\*${esc}\\*\\*:\\s*(.*)$`, "m"));
  return m ? m[1].trim() : undefined;
}

describe("t-tui-custom-harness (the {sdk,tui} two-driver journey)", () => {
  // -------------------------------------------------------------------------
  // SURFACE 3a + the compile-baked rule proof (DETERMINISTIC, no driver, no
  // tokens). The customHarness fixture compiled the graph at seed time; assert
  // the custom head stage's node carries the project-rule path AND the rule
  // file carries the unique marker. This is the "edit resolves at compile"
  // half, proven on disk — the floor the live halves build on. (The full
  // compile/error matrix lives in the deterministic sibling
  // t-custom-harness-compile; this single check keeps the live file
  // self-grounding without an AIDLC_TUI_LIVE gate.)
  // -------------------------------------------------------------------------
  test("compile bakes the custom rule path into the custom stage node + the rule file carries the marker", () => {
    const proj = setupTuiProject({ customHarness: true });
    try {
      const graph = JSON.parse(
        readFileSync(join(proj, ".claude", "tools", "data", "stage-graph.json"), "utf8"),
      ) as Array<{
        slug: string;
        rules_in_context?: Array<{ path: string; scope: string }>;
        sensors_applicable?: Array<{ id: string }>;
      }>;
      const node = graph.find((s) => s.slug === SNAPSHOT_STAGE_SLUG);
      // VACUOUS-PASS GUARD: the custom stage must exist in the compiled graph.
      expect(node).toBeDefined();
      const rulePaths = (node?.rules_in_context ?? []).map((r) => r.path);
      // The method relocated (P5/fe7f470) to the harness-neutral workspace-root
      // aidlc/spaces/default/memory/ tree (neutral basenames). The compile bakes
      // the neutral display path; verified against the actual emitted array
      // ["…/org.md","…/team.md","…/project.md","…/phases/inception.md"].
      expect(rulePaths).toContain("aidlc/spaces/default/memory/project.md");
      // the project rule FILE carries the unique custom-rule marker
      const rule = readFileSync(
        join(proj, "aidlc", "spaces", "default", "memory", "project.md"),
        "utf8",
      );
      expect(rule).toContain(CUSTOM_RULE_MARKER);
    } finally {
      cleanupTuiProject(proj);
    }
  });

  // -------------------------------------------------------------------------
  // SURFACE 4 (STATUSLINE), seeded-state, NO tokens. Drive a real init for the
  // custom scope so aidlc-state.md carries Current Stage = schema-snapshot (the
  // same deterministic state a workflow run reaches), launch claude, and prove
  // the painted statusline renders the custom stage's raw slug AND the custom
  // agent display name derived from the temp .claude/agents file. Mirrors
  // t-tui-render-statusline.serial.test.ts.
  // -------------------------------------------------------------------------
  test.skipIf(SKIP_REASON !== null)(
    `statusline renders "> ${SNAPSHOT_STAGE_SLUG} -- ${CUSTOM_AGENT_DISPLAY}"${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    () => {
      const session = `aidlc_he_statusline_${process.pid}`;
      const proj = setupTuiProject({ customHarness: true });
      try {
        const init = spawnSync(
          "bun",
          [join(proj, ".claude", "tools", "aidlc-utility.ts"), "intent-birth", "--scope", CUSTOM_SCOPE],
          { cwd: proj, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: proj } },
        );
        expect(init.status).toBe(0);
        // sanity: the seeded state really does point Current Stage at the custom slug
        const state = readFileSync(stateFilePathFor(proj), "utf8");
        expect(stateField(state, "Current Stage")).toBe(SNAPSHOT_STAGE_SLUG);
        expect(stateField(state, "Active Agent")).toBe(CUSTOM_AGENT_SLUG);

        expect(
          drive([
            "start",
            "--session",
            session,
            "--cwd",
            proj,
            "--width",
            "120",
            "--height",
            "40",
            "--",
            "claude",
            "--dangerously-skip-permissions",
          ]).rc,
        ).toBe(0);
        if (waitFor(session, "trust this folder", 60000, 600)) {
          drive(["send", "--session", session, "--keys", "1"]);
        }
        if (waitFor(session, "Bypass Permissions mode", 15000, 600)) {
          drive(["send", "--session", session, "--keys", "2"]);
        }
        // The custom stage is in INCEPTION — wait for the workflow statusline.
        // P9: the orientation prefix ("<intent-slug> · ") sits between [AIDLC] and
        // the phase, so match with .* rather than a contiguous gap.
        const sawMarker = waitFor(session, "\\[AIDLC\\].*INCEPTION", 45000, 1000);
        const pane = drive(["capture", "--session", session]).stdout;
        if (!sawMarker) {
          throw new Error(
            `workflow statusline "[AIDLC] INCEPTION" never painted.\n---- pane ----\n${pane}\n--------------`,
          );
        }
        // THE ASSERTION: the raw custom slug renders after the "> " stage marker.
        expect(pane).toContain(`> ${SNAPSHOT_STAGE_SLUG}`);
        expect(pane).toContain(`-- ${CUSTOM_AGENT_DISPLAY}`);
      } finally {
        drive(["kill", "--session", session]);
        cleanupTuiProject(proj);
      }
    },
    90_000,
  );

  // -------------------------------------------------------------------------
  // THE TWO-DRIVER PAIR: the file calls BOTH driveAidlc() (sdk) AND spawns
  // tui-drive.ts (tui), so the derive-by-driver registry reads the FILE's set as
  // {sdk, tui} (mechanismsOf scans the whole file's code, not one test block).
  // The two journeys are SEPARATE tests so each gets its OWN wedge ceiling — a
  // single combined test summed the sdk drive (~4.5 min) and the cold-start tui
  // drive (~5+ min) against one 2400s cap and timed out on wall-clock under load
  // (NOT a logic failure — the tui drive was verified to complete in ~5 min from
  // an already-running session). Splitting removes the additive-timeout pressure;
  // the timer lesson says give each independent journey its own backstop, never
  // crank one shared ceiling.
  // -------------------------------------------------------------------------

  // ===================== sdk journey (surface 1) =========================
  // Drive birth-init through the real SDK prompt. The SDK surface asserts the
  // invariant routing seam: a custom scope is accepted by the live conductor,
  // the init tool records it, and the first post-init stage is the custom head
  // stage (`schema-snapshot`). We stop immediately after that Bash tool_result;
  // the full custom stage body is the TUI half below.
  test.skipIf(SKIP_REASON !== null)(
    `[sdk] the custom scope initializes and routes to the custom workflow in a real run${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const sdkProj = setupTuiProject({ customHarness: true });
      try {
        const r = await driveAidlc(`/aidlc --init --scope ${CUSTOM_SCOPE}`, {
          projectDir: sdkProj,
          timeoutMs: DRIVE_TIMEOUT_MS,
          stopAfterToolResult: {
            toolName: "Bash",
            resultIncludes: `First post-init stage: ${SNAPSHOT_STAGE_SLUG}`,
          },
        });
        // The custom scope was accepted + recorded — the scope ROUTED.
        assertAuditEvent(r, "WORKFLOW_STARTED");
        assertAuditEvent(r, "WORKSPACE_INITIALISED");
        const state = r.stateFile ?? "";
        expect(stateField(state, "Scope")).toBe(CUSTOM_SCOPE);
        // The init-emitted WORKSPACE_INITIALISED block names the custom HEAD stage
        // as the routing target — deterministic tool stdout, emitted pre-gate,
        // INVARIANT regardless of how far the auto-driven run advanced. This is
        // the airtight "the custom scope routed to the custom workflow" proof.
        const auditMd = readAllAuditShards(sdkProj);
        const wiBlock = auditMd.split(/\n---\n/).find((b) => /WORKSPACE_INITIALISED/.test(b)) ?? "";
        expect(wiBlock).toContain(SNAPSHOT_STAGE_SLUG);
        expect(wiBlock).toContain(`routing to ${SNAPSHOT_STAGE_SLUG}`);
        assertToolResultContains(r, "Bash", `First post-init stage: ${SNAPSHOT_STAGE_SLUG}`);
        expect(stateField(state, "Current Stage")).toBe(SNAPSHOT_STAGE_SLUG);
        expect(stateField(state, "Active Agent")).toBe(CUSTOM_AGENT_SLUG);
      } finally {
        cleanupTuiProject(sdkProj);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // ===================== sdk directive journey (agent delegation) =========
  // Start from a deterministic init state, then drive plain `/aidlc` through
  // the SDK just far enough to capture the engine's run-stage directive. The
  // directive is the data seam: lead_agent must be the custom agent slug, proving
  // the custom stage actually delegates to the custom persona instead of falling
  // back to orchestrator. Use `/aidlc`, not `/aidlc --resume`: the latter is a
  // separate human resume-menu journey covered by the tui half below, while this
  // probe is about the next-stage directive seam. The no-error guard prevents a
  // recovered run from masking conductor/state errors before the directive.
  test.skipIf(SKIP_REASON !== null)(
    `[sdk] the run-stage directive delegates the custom stage to ${CUSTOM_AGENT_SLUG}${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const sdkProj = setupTuiProject({ customHarness: true });
      try {
        const init = spawnSync(
          "bun",
          [join(sdkProj, ".claude", "tools", "aidlc-utility.ts"), "intent-birth", "--scope", CUSTOM_SCOPE],
          { cwd: sdkProj, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: sdkProj } },
        );
        expect(init.status).toBe(0);
        const r = await driveAidlc("/aidlc", {
          projectDir: sdkProj,
          timeoutMs: DRIVE_TIMEOUT_MS,
          stopAfterToolResult: {
            toolName: "Bash",
            resultIncludes: `"lead_agent":"${CUSTOM_AGENT_SLUG}"`,
          },
        });
        const engineErrors = r.toolResults
          .filter((tr) => tr.toolName === "Bash")
          .map((tr) => tr.resultText)
          .filter((text) => text.includes('"kind":"error"') || text.includes("Transition rejected"));
        expect(engineErrors).toEqual([]);
        const directiveText = r.toolResults
          .filter((tr) => tr.toolName === "Bash")
          .map((tr) => tr.resultText)
          .find((text) => text.includes(`"lead_agent":"${CUSTOM_AGENT_SLUG}"`));
        expect(directiveText).toBeDefined();
        const directive = JSON.parse((directiveText as string).trim()) as {
          kind?: string;
          stage?: string;
          lead_agent?: string;
          consumes?: string[];
        };
        expect(directive.kind).toBe("run-stage");
        expect(directive.stage).toBe(SNAPSHOT_STAGE_SLUG);
        expect(directive.lead_agent).toBe(CUSTOM_AGENT_SLUG);
      } finally {
        cleanupTuiProject(sdkProj);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // ===================== tui journey (surfaces 2 + 3b + 4-in-motion + chain) ===
  // Drive the REAL claude TUI through BOTH custom-stage gates by KEYSTROKE.
  // Answering makes the orchestrator write each produced artefact
  // under aidlc-docs/ — those writes trip the custom sensor while a custom stage
  // is active (SENSOR_FIRED), the artefacts cite the custom rule marker (the rule
  // reached the agent), and reaching the migration-strategy artefact proves the
  // produce->consume chain ran in order. Terminate on the terminal artefact,
  // never a wait-timeout.
  test.skipIf(SKIP_REASON !== null)(
    `[tui] the agent runs the chained custom stages, fires the sensor + cites the rule${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const session = `aidlc_he_journey_${process.pid}`;
      const tuiProj = setupTuiProject({ customHarness: true });
      try {
        const init = spawnSync(
          "bun",
          [join(tuiProj, ".claude", "tools", "aidlc-utility.ts"), "intent-birth", "--scope", CUSTOM_SCOPE],
          { cwd: tuiProj, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: tuiProj } },
        );
        expect(init.status).toBe(0);
        const state = readFileSync(stateFilePathFor(tuiProj), "utf8");
        expect(stateField(state, "Current Stage")).toBe(SNAPSHOT_STAGE_SLUG);

        expect(
          drive([
            "start",
            "--session",
            session,
            "--cwd",
            tuiProj,
            "--width",
            "120",
            "--height",
            "45",
            "--",
            "claude",
            "--dangerously-skip-permissions",
          ]).rc,
        ).toBe(0);
        if (waitFor(session, "trust this folder", 60000, 600)) {
          drive(["send", "--session", session, "--keys", "1"]);
        }
        if (waitFor(session, "Bypass Permissions mode", 15000, 600)) {
          drive(["send", "--session", session, "--keys", "2"]);
        }
        expect(waitFor(session, "\\[AIDLC\\].*(ready|INCEPTION)", 45000, 800)).toBe(true);

        // Resume the pre-initialized custom-scope workflow. The first menu is
        // the resume gate; answer-gate below handles it and the custom-stage
        // approval gates by keystroke.
        drive([
          "send",
          "--session",
          session,
          "--keys",
          "/aidlc --resume",
          "--literal",
          "--no-enter",
        ]);
        drive(["send", "--session", session, "--keys", "Enter", "--no-enter"]);

        // Answer the custom stages' gates by keystroke (Recommended default per
        // menu) and TERMINATE on the migration-plan artefact appearing on disk —
        // the deterministic signal that BOTH custom stages ran their write step
        // in order (migration-plan is the chain's tail). answer-gate loops over
        // every gate until the terminator is met; its own backstops error loud
        // on a real hang.
        const gateRc = await new Promise<number>((resolve) => {
          const child = spawn(
            DRIVE_BIN,
            [
              ...DRIVE_PREFIX,
              "answer-gate",
              "--session",
              session,
              "--project-dir",
              tuiProj,
              "--until-file",
              PLAN_OUTPUT_REL,
              "--overall-timeout-ms",
              String(Math.max(60000, TEST_TIMEOUT_MS - 30000)),
            ],
            { stdio: "inherit" },
          );
          child.on("exit", (code) => resolve(code ?? -1));
          child.on("error", () => resolve(-1));
        });
        expect(gateRc).toBe(0);

        // --- SURFACE 2: the custom sensor fired on the artefact write(s) ------
        // The custom sensor is wired to BOTH stages and its matches glob covers
        // the aidlc-docs tree, so each stage's artefact write trips it: SENSOR_FIRED
        // is the deterministic proof the harness engineer's custom sensor ran in a
        // real execution, and this is the FIRST live driver of that
        // audit event.
        //
        // FINDING (verified against aidlc-sensor.ts:267-271 + :319-326 + :581 — NOT
        // softened): a sensor's DETAIL FILE under aidlc-docs/.aidlc-sensors/<stage>/
        // is written ONLY when the sensor FAILS (the "Detail path" audit field is
        // likewise emitted only in the SENSOR_FAILED branch). The reused
        // required-sections sensor PASSES on these well-formed artefacts (they carry
        // the required ## Summary / ## Origin H2s), so NO detail file is written —
        // by design. Asserting a detail-dir entry would assert a failure that must
        // not happen on the golden path. The honest passing-sensor signal is the
        // SENSOR_FIRED audit ROW naming the custom stage + the artefact output path.
        const events = auditEvents(tuiProj);
        // VACUOUS-PASS GUARD: the audit recorded events at all.
        expect(events.length).toBeGreaterThan(0);
        const auditMd = readAllAuditShards(tuiProj);
        const firedBlocks = auditMd
          .split(/\n---\n/)
          .filter((b) => /\*\*Event\*\*:\s*SENSOR_FIRED/.test(b));
        // the custom sensor fired at least once...
        expect(firedBlocks.length).toBeGreaterThan(0);
        // ...and a fire names the custom sensor on a custom stage, writing a custom
        // artefact path — proving it was OUR sensor on OUR stage, not a shipped one.
        const ourFire = firedBlocks.find(
          (b) =>
            b.includes(`**Sensor ID**: ${CUSTOM_SENSOR_ID}`) &&
            (b.includes(`**Stage slug**: ${SNAPSHOT_STAGE_SLUG}`) ||
              b.includes(`**Stage slug**: ${PLAN_STAGE_SLUG}`)),
        );
        expect(ourFire).toBeDefined();

        // --- THE CHAIN: both artefacts exist; the tail consumes the head ------
        // Resolve the CONCRETE born-intent record (the *_OUTPUT_REL constants
        // carry a `*` for the runtime-minted intent dir, used by --until-file; the
        // existence reads need the resolved record).
        const headArtifact = join(recordDirFor(tuiProj), SNAPSHOT_STAGE_PHASE, SNAPSHOT_STAGE_SLUG, `${SNAPSHOT_ARTIFACT}.md`);
        const tailArtifact = join(recordDirFor(tuiProj), PLAN_STAGE_PHASE, PLAN_STAGE_SLUG, `${PLAN_ARTIFACT}.md`);
        expect(existsSync(headArtifact)).toBe(true);
        expect(existsSync(tailArtifact)).toBe(true);

        // --- SURFACE 3b: the custom rule reached the agent's output -----------
        // The artefacts the agent wrote cite the unique custom-rule marker (the
        // stage bodies instruct it to, per the project rule) — runtime evidence
        // the rule was in the agent's context, asserted as file bytes. At least
        // one artefact must carry it (both stage bodies request it).
        const headCites = readFileSync(headArtifact, "utf8").includes(CUSTOM_RULE_MARKER);
        const tailCites = readFileSync(tailArtifact, "utf8").includes(CUSTOM_RULE_MARKER);
        expect(headCites || tailCites).toBe(true);

        // --- SURFACE 5: custom knowledge reached the agent's output ----------
        // The stage bodies do NOT contain this marker; it exists only in the
        // custom knowledge playbook. Seeing it in an artefact proves the custom
        // knowledge file reached the active custom-agent context.
        const headKnowledge = readFileSync(headArtifact, "utf8").includes(CUSTOM_KNOWLEDGE_MARKER);
        const tailKnowledge = readFileSync(tailArtifact, "utf8").includes(CUSTOM_KNOWLEDGE_MARKER);
        expect(headKnowledge || tailKnowledge).toBe(true);
      } finally {
        drive(["kill", "--session", session]);
        cleanupTuiProject(tuiProj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
