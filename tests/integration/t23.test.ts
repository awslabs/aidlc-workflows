// covers: hook:aidlc-record-human-turn, subcommand:aidlc-utility:help
//
// t23.test.ts - drives the real /aidlc --help through the Claude Agent SDK and
// asserts ONLY on deterministic surfaces, never on assistantText.
//
// THE DETERMINISTIC SURFACE. Claude Code's prompt hook answers a typed help
// request itself: it hands the agent the help (renderHelpText, the same text
// `aidlc-utility.ts help` prints) with the person's message, and the agent
// shows it with no command to run. The SDK reports what the UserPromptSubmit
// hook printed (capturePromptHooks), byte for byte, before the model rewords
// anything.
//
// ASSERTION MAP (.sh test -> SDK surface):
//   1 OUTPUT contains AI-DLC    -> the prompt hook's context carries the help header
//   2 OUTPUT contains --status  -> ... the Utilities block's --status line
//   3 OUTPUT contains --init    -> --init/--force are gone from help: the help lists
//                                 the verbs `intent`/`space`, and --init/--force are
//                                 ABSENT (mirrors tests/integration/t31-help.test.ts)
//   4 OUTPUT contains --doctor  -> ... the Utilities block's --doctor line
//   5 OUTPUT contains enterprise-> ... a scope line rendered from the scope mapping
//   6 /aidlc --help exits 0     -> the drive ends without an error (assertResultOk)
//
// The help is shown once: no command result in the drive carries it again (an
// agent that showed the hook's help and then ran the help as well would put it
// in front of the person twice).
//
// MECHANISM. Plain t23.test.ts: mechanism `sdk` is DERIVED from the driveAidlc(
// call, no filename segment.
//
// It SPENDS TOKENS: driveAidlc drives the real /aidlc on Opus/Bedrock.
// Generous per-test timeout so a hung canUseTool fails LOUD via bun:test.
import {
  liveCaseTimeoutMs,
  LIVE_LONG_OPERATION_TIMEOUT_MS,
  remainingOperationTimeoutMs,
  fileCleanupReserveMs,
} from "../harness/test-budget.ts";
import { describe, expect, test } from "bun:test";
import { assertResultOk } from "../harness/assert.ts";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { driveAidlc } from "../harness/sdk-drive.ts";

// The case and file own the work budget; each SDK call uses what remains.
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? String(LIVE_LONG_OPERATION_TIMEOUT_MS / 1000), 10);
const LIVE_WORK_TIMEOUT_MS = Number.isFinite(TIMEOUT_S) && TIMEOUT_S > 0
  ? TIMEOUT_S * 1000 : LIVE_LONG_OPERATION_TIMEOUT_MS;
// Setup and cleanup allowances belong to the case; calls share its remaining work.
const TEST_TIMEOUT_MS = liveCaseTimeoutMs(LIVE_WORK_TIMEOUT_MS);

// Known-answer help strings, read from the shipped handler (see header).
const HELP_HEADER = "AI-DLC - AI-Driven Development Life Cycle"; // HELP_TEXT_HEAD, aidlc-utility.ts
const HELP_STATUS = "--status"; // HELP_TEXT_TAIL Utilities block, aidlc-utility.ts
// The engine auto-creates; the workspace shell ships in dist/. The help lists
// the intent/space verb families - assert those PLUS the absence of
// --init/--force.
const HELP_INTENT = "intent"; // verb family, renderHelpText
const HELP_SPACE = "space"; // verb family, renderHelpText
const HELP_DOCTOR = "--doctor"; // HELP_TEXT_TAIL Utilities block, aidlc-utility.ts
const HELP_ENTERPRISE = "enterprise"; // scope line via renderHelpText and loadScopeMapping

// What the prompt hooks handed the agent: the context of each JSON reply.
function handedToAgent(printed: readonly string[]): string {
  const texts: string[] = [];
  for (const out of printed) {
    for (const line of out.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      try {
        const parsed = JSON.parse(line) as { additionalContext?: unknown; hookSpecificOutput?: { additionalContext?: unknown } };
        const text = parsed.hookSpecificOutput?.additionalContext ?? parsed.additionalContext;
        if (typeof text === "string") texts.push(text);
      } catch {
        texts.push(line);
      }
    }
  }
  return texts.join("\n");
}

describe("t23 /aidlc --help (sdk)", () => {
  // -------------------------------------------------------------------------
  // /aidlc --help is answered by the prompt hook: the help, with every
  // advertised section, reaches the agent with the person's message, and the
  // drive ends cleanly with the help shown once.
  // -------------------------------------------------------------------------
  test(
    "the prompt hook hands the agent the help with every advertised section, and it is shown once",
    async () => {
      const deadlineMs = Date.now() + TEST_TIMEOUT_MS;
      const proj = setupIntegrationProject({ noAidlcDocs: true });
      try {
        const r = await driveAidlc("/aidlc --help", {
          projectDir: proj,
          timeoutMs: remainingOperationTimeoutMs(LIVE_WORK_TIMEOUT_MS, {
            deadlineMs, reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS), phase: "integration SDK drive",
          }),
          capturePromptHooks: true,
        });
        // A drive that ended in an error says why (an API error, a crash, a
        // timeout) before the content checks below say what is missing.
        assertResultOk(r);
        // Which tools the agent used, for reading a red: names only, no inputs or results.
        console.log(`t23 tools: ${JSON.stringify(r.toolResults.map((t) => t.toolName))}`);

        const handed = handedToAgent(r.promptHooks ?? []);
        for (const literal of [HELP_HEADER, HELP_STATUS, HELP_DOCTOR, HELP_INTENT, HELP_SPACE, HELP_ENTERPRISE]) {
          expect(handed, `the prompt hook did not hand over ${literal}`).toContain(literal);
        }
        // --init/--force are ABSENT (a re-introduced flag in the help reds here).
        const help = handed.slice(handed.indexOf(HELP_HEADER));
        expect(help).not.toContain("--init");
        expect(help).not.toContain("--force");

        // Shown once: no command the agent ran brought the help back a second time.
        const again = r.toolResults.filter((t) => t.resultText.includes(HELP_HEADER));
        expect(again.map((t) => t.toolName), "the help was fetched again after the hook handed it over").toEqual([]);
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
