// covers: file:skills/aidlc/SKILL.md, file:skills/aidlc/question-rendering.md
//
// Native Kiro IDE proof for the recovered Windows P3 failure. A workspace has
// one in-flight intent record but no per-user active-intent cursor. The user
// submits unrelated scoped work. Kiro must print the engine's typed
// numbered_prose_question with Other, end the turn, and never replace it after
// an `intent --json` query. Two follow-up turns prove the Other response route:
// bare 4 requests details without routing, then substantive prose returns
// unchanged through next and produces a fresh typed ask.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupTuiProject,
  KIRO_IDE_SRC,
  setupTuiProject,
} from "../harness/tui-fixtures.ts";
import {
  autoApprove,
  clickByText,
  generateKiroIdeSeed,
  KIRO_IDE_BIN,
  type KiroIdeDomSnapshot,
  launchKiroIde,
  pageTarget,
  removeSeedDir,
  snapshotChatDom,
  teardown,
  typeAndSubmit,
  waitForCdp,
  waitForChatInput,
} from "../harness/kiro-ide-driver.ts";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "600", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 600) * 1000;
const PORT = 9900 + (process.pid % 80);
const DIAGNOSTICS_PATH = process.env.AIDLC_KIRO_IDE_DIAGNOSTICS ?? "";
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
const OTHER_DETAIL_PROMPT = "What would you like me to do instead?";
const ALTERNATIVE =
  "Treat this as a documentation update for the existing work instead.";

interface RoutingDirective {
  kind: "ask";
  ask_type: "new-work-routing";
  response_route: "next";
  numbered_prose_question: string;
  new_work_description: string;
  available_intents?: string[];
}

interface ExtractedDirective {
  directive: RoutingDirective;
  end: number;
}

function diagnostic(event: string, fields: Record<string, unknown> = {}): void {
  if (!DIAGNOSTICS_PATH) return;
  appendFileSync(
    DIAGNOSTICS_PATH,
    `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields })}\n`,
    "utf-8",
  );
}

function extractRoutingDirective(
  text: string,
  fromIndex = 0,
): ExtractedDirective | null {
  const start = text.indexOf(
    '{"kind":"ask","ask_type":"new-work-routing"',
    fromIndex,
  );
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) {
        const directive = JSON.parse(
          text.slice(start, index + 1),
        ) as RoutingDirective;
        return { directive, end: index + 1 };
      }
    }
  }
  return null;
}

function routingDirectives(text: string): ExtractedDirective[] {
  const directives: ExtractedDirective[] = [];
  let fromIndex = 0;
  for (;;) {
    const extracted = extractRoutingDirective(text, fromIndex);
    if (!extracted) return directives;
    directives.push(extracted);
    fromIndex = extracted.end;
  }
}

function routingDescriptions(snapshots: KiroIdeDomSnapshot[]): string[] {
  return [
    ...new Set(
      snapshots.flatMap((snapshot) =>
        routingDirectives(snapshot.text).map(
          (extracted) => extracted.directive.new_work_description,
        )
      ),
    ),
  ].sort();
}

function primaryRoutingDirectiveCount(
  snapshots: KiroIdeDomSnapshot[],
): number {
  const snapshot = routingSnapshot(snapshots);
  return snapshot ? routingDirectives(snapshot.text).length : 0;
}

function combinedChatText(snapshots: KiroIdeDomSnapshot[]): string {
  return snapshots.map((snapshot) => snapshot.text).join("\n");
}

function routingEntryForDescription(
  snapshots: KiroIdeDomSnapshot[],
  description: string,
): { snapshot: KiroIdeDomSnapshot; extracted: ExtractedDirective } | undefined {
  return snapshots
    .flatMap((snapshot) =>
      routingDirectives(snapshot.text).map((extracted) => ({
        snapshot,
        extracted,
      }))
    )
    .filter(
      (entry) => entry.extracted.directive.new_work_description === description,
    )
    .sort((left, right) => right.snapshot.text.length - left.snapshot.text.length)[0];
}

function visibleMarkdown(text: string): string {
  return text
    .replaceAll("**", "")
    .replaceAll("`", "")
    .replace(/\s+/g, " ")
    .trim();
}

function visibleQuestionContent(text: string): string {
  return visibleMarkdown(text.replace(/^\s*\d+\.\s*/gm, ""));
}

function expectedOptionTexts(directive: RoutingDirective): string[] {
  return directive.numbered_prose_question
    .split(/\r?\n/)
    .filter((line) => /^\s*\d+\.\s*/.test(line))
    .map((line) => visibleMarkdown(line.replace(/^\s*\d+\.\s*/, "")));
}

function hasExactOrderedOptions(
  snapshots: KiroIdeDomSnapshot[],
  directive: RoutingDirective,
): boolean {
  const expected = expectedOptionTexts(directive);
  return snapshots
    .flatMap((snapshot) => snapshot.orderedLists)
    .some((items) =>
      items.length === expected.length &&
      items.every((item, index) => visibleMarkdown(item) === expected[index])
    );
}

function completedTurn(snapshots: KiroIdeDomSnapshot[]): boolean {
  const controls = snapshots.flatMap((snapshot) => snapshot.controls);
  const hasCopy = controls.some((control) =>
    /copy message/i.test(`${control.text} ${control.ariaLabel}`)
  );
  const hasCancel = controls.some((control) =>
    /\bcancel\b/i.test(`${control.text} ${control.ariaLabel}`)
  );
  return hasCopy && !hasCancel;
}

function routingSnapshot(
  snapshots: KiroIdeDomSnapshot[],
): KiroIdeDomSnapshot | undefined {
  return snapshots
    .filter((snapshot) =>
      snapshot.text.includes('"ask_type":"new-work-routing"')
    )
    .sort((left, right) => right.text.length - left.text.length)[0];
}

function seedSecondIntent(project: string): void {
  const result = spawnSync(
    process.execPath,
    [
      join(project, ".kiro", "tools", "aidlc-utility.ts"),
      "intent-create",
      "--scope",
      "poc",
      "--label",
      "second fixture",
      "--project-dir",
      project,
    ],
    { cwd: project, encoding: "utf-8" },
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

function skipReason(): string | null {
  if (process.env.AIDLC_KIRO_IDE_LIVE !== "1") {
    return "set AIDLC_KIRO_IDE_LIVE=1 to run the native Kiro IDE routing proof (uses Kiro credits)";
  }
  if (platform() !== "win32") {
    return "this acceptance test is native-Windows-only";
  }
  if (!existsSync(KIRO_IDE_BIN)) {
    return `Kiro IDE binary not found at ${KIRO_IDE_BIN}`;
  }
  if (!existsSync(KIRO_IDE_SRC)) {
    return `distributable missing: ${KIRO_IDE_SRC}`;
  }
  return null;
}
const SKIP_REASON = skipReason();

describe("t-ide-kiro-new-work-routing (native unselected typed ask)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `engine ask remains authoritative and Other completes its next response route${SKIP_REASON ? ` - SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const project = setupTuiProject({
        harness: "kiro-ide",
        withState: "state-mid-ideation.md",
      });
      seedSecondIntent(project);
      rmSync(
        join(
          project,
          "aidlc",
          "spaces",
          "default",
          "intents",
          "active-intent",
        ),
        { force: true },
      );
      const seedDir = generateKiroIdeSeed(
        mkdtempSync(join(tmpdir(), "aidlc-kiro-routing-seed-")),
      );
      const handle = launchKiroIde({
        workspace: project,
        seedProfile: seedDir,
        port: PORT,
      });

      try {
        expect(await waitForCdp(handle.port)).toBe(true);
        expect(await waitForChatInput(handle.port)).toBe(true);
        await clickByText(handle.port, ["remind me later"]);

        const target = await pageTarget(handle.port);
        await typeAndSubmit(
          target,
          "/aidlc poc Create a tiny TypeScript command-line program that prints Hello World.",
          handle.port,
        );
        target.close();

        const deadline = Date.now() + Math.min(90_000, TEST_TIMEOUT_MS - 30_000);
        let chatText = "";
        let assistantTail = "";
        let directive: RoutingDirective | null = null;
        let finalSnapshots: KiroIdeDomSnapshot[] = [];
        while (Date.now() < deadline) {
          await autoApprove(handle.port);
          const snapshots = await snapshotChatDom(handle.port);
          const snapshot = routingSnapshot(snapshots);
          if (snapshot) {
            const extracted = extractRoutingDirective(snapshot.text);
            if (extracted) {
              const tail = snapshot.text.slice(extracted.end);
              const expected = visibleQuestionContent(
                extracted.directive.numbered_prose_question,
              );
              chatText = snapshot.text;
              assistantTail = tail;
              directive = extracted.directive;
              finalSnapshots = snapshots;
              if (
                completedTurn(snapshots) &&
                visibleMarkdown(tail).includes(expected) &&
                hasExactOrderedOptions(snapshots, extracted.directive)
              ) {
                // Re-snapshot after idle so a late tool query or replacement
                // prompt cannot race the assertion.
                await sleep(2_000);
                const settled = await snapshotChatDom(handle.port);
                const settledSnapshot = routingSnapshot(settled);
                const settledExtracted = settledSnapshot
                  ? extractRoutingDirective(settledSnapshot.text)
                  : null;
                if (settledSnapshot && settledExtracted && completedTurn(settled)) {
                  const settledTail = settledSnapshot.text.slice(
                    settledExtracted.end,
                  );
                  chatText = settledSnapshot.text;
                  assistantTail = settledTail;
                  directive = settledExtracted.directive;
                  finalSnapshots = settled;
                  if (
                    visibleMarkdown(settledTail).includes(expected) &&
                    hasExactOrderedOptions(settled, settledExtracted.directive)
                  ) {
                    break;
                  }
                }
              }
            }
          }
          await sleep(1_500);
        }

        expect(directive).not.toBeNull();
        expect(directive?.kind).toBe("ask");
        expect(directive?.ask_type).toBe("new-work-routing");
        expect(directive?.response_route).toBe("next");
        expect(directive?.available_intents).toHaveLength(2);
        const expected = visibleQuestionContent(
          directive?.numbered_prose_question ?? "",
        );
        // Compare only assistant output AFTER the tool JSON. Raw tool bytes
        // cannot satisfy this assertion.
        expect(visibleMarkdown(assistantTail)).toContain(expected);
        expect(hasExactOrderedOptions(finalSnapshots, directive!)).toBe(true);
        expect(completedTurn(finalSnapshots)).toBe(true);
        expect(chatText).not.toMatch(/aidlc-utility\.ts intent --json/i);

        const initialDescriptions = routingDescriptions(finalSnapshots);
        const initialDirectiveCount =
          primaryRoutingDirectiveCount(finalSnapshots);
        expect(initialDirectiveCount).toBeGreaterThan(0);
        const otherTarget = await pageTarget(handle.port);
        await typeAndSubmit(otherTarget, "4", handle.port);
        otherTarget.close();

        let otherSnapshots: KiroIdeDomSnapshot[] = [];
        let otherChatText = "";
        const otherDeadline =
          Date.now() + Math.min(90_000, TEST_TIMEOUT_MS - 30_000);
        while (Date.now() < otherDeadline) {
          await autoApprove(handle.port);
          const snapshots = await snapshotChatDom(handle.port);
          const combined = combinedChatText(snapshots);
          otherSnapshots = snapshots;
          otherChatText = combined;
          if (
            completedTurn(snapshots) &&
            visibleMarkdown(combined).includes(OTHER_DETAIL_PROMPT)
          ) {
            break;
          }
          await sleep(1_500);
        }
        await sleep(2_000);
        const settledOther = await snapshotChatDom(handle.port);
        if (
          completedTurn(settledOther) &&
          visibleMarkdown(combinedChatText(settledOther)).includes(
            OTHER_DETAIL_PROMPT,
          )
        ) {
          otherSnapshots = settledOther;
          otherChatText = combinedChatText(settledOther);
        }
        expect(visibleMarkdown(otherChatText)).toContain(OTHER_DETAIL_PROMPT);
        expect(completedTurn(otherSnapshots)).toBe(true);
        expect(routingDescriptions(otherSnapshots)).toEqual(
          initialDescriptions,
        );
        expect(primaryRoutingDirectiveCount(otherSnapshots)).toBe(
          initialDirectiveCount,
        );
        expect(otherChatText).not.toMatch(/aidlc-utility\.ts intent --json/i);
        expect(otherChatText).not.toMatch(/aidlc-orchestrate\.ts report/i);

        const alternativeTarget = await pageTarget(handle.port);
        await typeAndSubmit(alternativeTarget, ALTERNATIVE, handle.port);
        alternativeTarget.close();

        let alternativeSnapshots: KiroIdeDomSnapshot[] = [];
        let alternativeChatText = "";
        let alternativeTail = "";
        let alternativeDirective: RoutingDirective | null = null;
        const alternativeDeadline =
          Date.now() + Math.min(90_000, TEST_TIMEOUT_MS - 30_000);
        while (Date.now() < alternativeDeadline) {
          await autoApprove(handle.port);
          const snapshots = await snapshotChatDom(handle.port);
          const entry = routingEntryForDescription(snapshots, ALTERNATIVE);
          alternativeSnapshots = snapshots;
          alternativeChatText = combinedChatText(snapshots);
          if (entry) {
            const tail = entry.snapshot.text.slice(entry.extracted.end);
            const alternativeExpected = visibleQuestionContent(
              entry.extracted.directive.numbered_prose_question,
            );
            alternativeTail = tail;
            alternativeDirective = entry.extracted.directive;
            if (
              completedTurn(snapshots) &&
              visibleMarkdown(tail).includes(alternativeExpected) &&
              hasExactOrderedOptions(snapshots, entry.extracted.directive)
            ) {
              break;
            }
          }
          await sleep(1_500);
        }
        await sleep(2_000);
        const settledAlternative = await snapshotChatDom(handle.port);
        const settledAlternativeEntry = routingEntryForDescription(
          settledAlternative,
          ALTERNATIVE,
        );
        alternativeSnapshots = settledAlternative;
        alternativeChatText = combinedChatText(settledAlternative);
        if (settledAlternativeEntry) {
          alternativeDirective =
            settledAlternativeEntry.extracted.directive;
          alternativeTail = settledAlternativeEntry.snapshot.text.slice(
            settledAlternativeEntry.extracted.end,
          );
        }
        expect(alternativeDirective).not.toBeNull();
        expect(alternativeDirective?.response_route).toBe("next");
        expect(alternativeDirective?.new_work_description).toBe(ALTERNATIVE);
        expect(visibleMarkdown(alternativeTail)).toContain(
          visibleQuestionContent(
            alternativeDirective?.numbered_prose_question ?? "",
          ),
        );
        expect(
          hasExactOrderedOptions(alternativeSnapshots, alternativeDirective!),
        ).toBe(true);
        expect(completedTurn(alternativeSnapshots)).toBe(true);
        expect(alternativeChatText).not.toMatch(
          /aidlc-orchestrate\.ts report/i,
        );
        expect(alternativeChatText).not.toMatch(
          /aidlc-utility\.ts intent --json/i,
        );
        expect(primaryRoutingDirectiveCount(alternativeSnapshots)).toBe(
          initialDirectiveCount + 1,
        );
        expect(routingDescriptions(alternativeSnapshots)).toContain(ALTERNATIVE);
        diagnostic("verified", {
          platform: platform(),
          directive,
          assistant_tail: visibleMarkdown(assistantTail),
          ordered_lists: finalSnapshots.flatMap(
            (snapshot) => snapshot.orderedLists,
          ),
          completed_turn: completedTurn(finalSnapshots),
          intent_query_present:
            /aidlc-utility\.ts intent --json/i.test(chatText),
          other_prompt: visibleMarkdown(otherChatText).includes(
            OTHER_DETAIL_PROMPT,
          ),
          alternative_directive: alternativeDirective,
          alternative_completed_turn: completedTurn(alternativeSnapshots),
          report_route_present:
            /aidlc-orchestrate\.ts report/i.test(alternativeChatText),
        });
      } finally {
        teardown(handle);
        cleanupTuiProject(project);
        removeSeedDir(seedDir);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
