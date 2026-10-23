// covers: file:skills/aidlc/SKILL.md, hook:aidlc-record-human-turn, subcommand:aidlc-orchestrate:report, cli:aidlc-log(answer)
//
// t-live-gate-fuzz: replies as people give them, met by real agents on real tools at the questions the engine knows,
// and judged by what the person got (tests/harness/live-gate-fuzz.ts: P1 the decision they meant is on record, or one
// question when the reply is really ambiguous; P2 nothing refused or asked again; P3 nothing moved on without their
// turn; P4 their words kept whole; P5 no loop and no dead end).
//
// On demand only: AIDLC_GATE_FUZZ_LIVE=1 opens it; no CI job sets it. AIDLC_GATE_FUZZ_TOOLS picks the tools (default
// claude,claude-cli,codex,kiro,opencode,cursor; copilot when its account has quota), AIDLC_GATE_FUZZ_SAMPLE a comma list of reply
// ids or a number per wait point (default 1) and AIDLC_GATE_FUZZ_ALSO ids beside it, AIDLC_GATE_FUZZ_SEED the sample's seed, AIDLC_GATE_FUZZ_REPORT_DIR the
// report folder (default tests/logs/gate-fuzz-live; each reply's record and what the agent said are kept under its
// traces/). Scratch projects; the tools' scratch homes where a tool has one
// (Claude Code's own config folder, CODEX_HOME, opencode's XDG_CONFIG_HOME, COPILOT_HOME) with self-updates off; the
// person's homes are hashed before and after, and a change in one the run owes unchanged fails the file. Kiro CLI keeps
// its own records under ~/.kiro and the Cursor agent under ~/.cursor: reported, not asserted. One Kiro leg at a time:
// whoever runs it holds the box's Kiro lock. A reply that misses is reported with what the person read; the file fails
// on a miss unless AIDLC_GATE_FUZZ_REPORT_ONLY=1 (the baseline on today's main).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { sampleByGroup } from "../harness/live-corpus.ts";
import {
  claudeBinary, driveReply, homeDigests, LIVE_TOOLS, type LiveTool, loadCorpus, REAL_HOMES, type Reply, type Verdict, writeReport,
} from "../harness/live-gate-fuzz.ts";

setDefaultTimeout(60 * 60_000);

const LIVE = process.env.AIDLC_GATE_FUZZ_LIVE === "1";
const REPORT_ONLY = process.env.AIDLC_GATE_FUZZ_REPORT_ONLY === "1";
const TOOLS = (process.env.AIDLC_GATE_FUZZ_TOOLS ?? "claude,claude-cli,codex,kiro,opencode,cursor").split(",").filter(Boolean) as LiveTool[];
const REPORT_DIR = process.env.AIDLC_GATE_FUZZ_REPORT_DIR ?? join(REPO_ROOT, "tests", "logs", "gate-fuzz-live");
const BINARIES: Record<LiveTool, string> = { claude: "claude", "claude-cli": claudeBinary(), codex: "codex", kiro: "kiro-cli", opencode: "opencode", cursor: "agent", copilot: "copilot" };

/** The replies a tool can meet: Codex and Kiro CLI type `$aidlc` and `/aidlc` lines as they take them; box picks stay with Claude Code. */
function eligible(tool: LiveTool): Reply[] {
  return loadCorpus().filter((reply) => !(reply.shownBy === "box" && tool !== "claude") && !(reply.inputs.some((i) => i.startsWith("$aidlc")) && tool !== "codex") &&
    reply.wait !== "guard-recovery");
}
// AIDLC_GATE_FUZZ_ALSO: reply ids run beside the sample (the measured losses, say).
const sample = (tool: LiveTool) => {
  const picked = sampleByGroup(eligible(tool), process.env.AIDLC_GATE_FUZZ_SAMPLE ?? "1", process.env.AIDLC_GATE_FUZZ_SEED, (reply) => reply.wait);
  const also = (process.env.AIDLC_GATE_FUZZ_ALSO ?? "").split(",").filter(Boolean);
  return [...picked, ...eligible(tool).filter((reply) => also.includes(reply.id) && !picked.some((p) => p.id === reply.id))];
};

const verdicts: Verdict[] = [];
const before = new Map<LiveTool, Record<string, string>>();
let judgeDir = "";

beforeAll(() => {
  judgeDir = mkdtempSync(join(tmpdir(), "gate-fuzz-judge-"));
  mkdirSync(join(judgeDir, "config"), { recursive: true });
  for (const tool of TOOLS) before.set(tool, homeDigests(tool));
});

afterAll(() => {
  const changed: string[] = [];
  for (const tool of TOOLS) {
    const now = homeDigests(tool);
    for (const [home, digest] of Object.entries(before.get(tool) ?? {})) if (now[home] !== digest) changed.push(`${tool}: ${home}`);
  }
  if (verdicts.length > 0) {
    const file = writeReport(REPORT_DIR, verdicts, [
      `Tools: ${TOOLS.join(", ")}. Sample ${process.env.AIDLC_GATE_FUZZ_SAMPLE ?? "1"} per wait point, seed ${process.env.AIDLC_GATE_FUZZ_SEED ?? "1"}.`,
      `Homes changed during the run: ${changed.join("; ") || "none"}.`,
    ]);
    console.log(`live gate fuzz: ${verdicts.filter((v) => v.failures.length === 0).length} of ${verdicts.length} passed. Report: ${file}`);
  }
  if (!LIVE) return;
  const owed = changed.filter((line) => TOOLS.some((tool) => REAL_HOMES[tool].owed.some((home) => line.endsWith(home))));
  expect(owed, "a home the run owes unchanged changed").toEqual([]);
});

for (const tool of LIVE_TOOLS) {
  describe(`${tool}: replies at the questions the engine knows, through a real agent`, () => {
    const off = !LIVE ? "set AIDLC_GATE_FUZZ_LIVE=1 to drive real agents (spends tokens)"
      : !TOOLS.includes(tool) ? `not in AIDLC_GATE_FUZZ_TOOLS (${TOOLS.join(",")})`
      : Bun.which(BINARIES[tool]) === null ? `${BINARIES[tool]} is not installed` : null;
    if (off !== null) {
      test.skip(`skipped: ${off}`, () => {});
      return;
    }
    for (const reply of sample(tool)) {
      test(`${reply.id} ${reply.wait} ${reply.replyClass} ${JSON.stringify(reply.inputs)}`, async () => {
        const verdict = await driveReply(reply, tool, judgeDir, join(REPORT_DIR, "traces"));
        verdicts.push(verdict);
        if (!REPORT_ONLY) expect(verdict.failures, `${reply.meaning}\nThe person read: ${verdict.read.slice(-600)}`).toEqual([]);
      });
    }
  });
}
