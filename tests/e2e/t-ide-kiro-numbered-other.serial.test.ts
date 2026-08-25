// covers: doc:harness/kiro-ide/skills/aidlc/question-rendering.md(numbered-other), file:tests/harness/kiro-ide-driver.ts(snapshotNumberedLists)

import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  writeFileSync,
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
  findCompleteNumberedListByLabels,
  generateKiroIdeSeed,
  KIRO_IDE_BIN,
  type KiroIdeNumberedListSnapshot,
  launchKiroIde,
  numberedListMarkersAreVisible,
  pageTarget,
  prepareKiroIdeChat,
  removeSeedDir,
  screenshot,
  snapshotChatDom,
  snapshotNumberedLists,
  teardown,
  typeAndSubmit,
  waitForCdp,
  waitForChatInput,
  watchMarkers,
} from "../harness/kiro-ide-driver.ts";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "900", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 900) * 1000;
const PORT = 9900 + (process.pid % 500);
const DIAGNOSTICS_PATH = process.env.AIDLC_KIRO_IDE_DIAGNOSTICS ?? "";
const SCREENSHOT_PATH = process.env.AIDLC_KIRO_IDE_SCREENSHOT ?? "";
const MODE_LABELS = ["Guide me", "I'll edit the file", "Chat", "Other"];

function diagnostic(event: string, fields: Record<string, unknown> = {}): void {
  if (!DIAGNOSTICS_PATH) return;
  appendFileSync(
    DIAGNOSTICS_PATH,
    `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields })}\n`,
    "utf-8",
  );
}

function removeSandbox(path: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      cleanupTuiProject(path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY";
      if (!retryable || attempt >= 20) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

function skipReason(): string | null {
  if (process.env.AIDLC_KIRO_IDE_LIVE !== "1") {
    return "set AIDLC_KIRO_IDE_LIVE=1 to run the live Kiro IDE visual journey";
  }
  if (platform() !== "win32") {
    return "the numbered-Other visual assertion runs on native Windows Kiro IDE";
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

describe("t-ide-kiro-numbered-other (native Windows visual question rendering)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `interaction mode visibly renders exactly one numbered Other as option 4${SKIP_REASON ? ` - SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const sandbox = setupTuiProject({
        harness: "kiro-ide",
        noAidlcDocs: true,
      });
      const seedDir = generateKiroIdeSeed(
        mkdtempSync(join(tmpdir(), "aidlc-kiro-numbered-other-seed-")),
      );
      const handle = launchKiroIde({
        workspace: sandbox,
        seedProfile: seedDir,
        port: PORT,
      });
      diagnostic("launched", { sandbox, seedDir, port: handle.port });

      try {
        expect(await waitForCdp(handle.port)).toBe(true);
        expect(await waitForChatInput(handle.port)).toBe(true);
        const prepared = await prepareKiroIdeChat(handle.port);
        expect(prepared.surface.chatFrameCount).toBeGreaterThan(0);
        expect(prepared.surface.blockingOverlays).toHaveLength(0);
        expect(prepared.surface.blockedHitPoints).toHaveLength(0);
        diagnostic("chat-ready", { migrationDismissed: prepared.dismissed });

        const target = await pageTarget(handle.port);
        await typeAndSubmit(
          target,
          "/aidlc poc Create a tiny TypeScript command-line program that prints Hello World.",
          handle.port,
        );
        target.close();
        diagnostic("prompt-submitted");

        let renderedMode: KiroIdeNumberedListSnapshot | null = null;
        const reachedMode = await watchMarkers(
          () => renderedMode !== null,
          Math.max(60_000, TEST_TIMEOUT_MS - 90_000),
          async () => {
            const clicked = await autoApprove(handle.port);
            const lists = await snapshotNumberedLists(handle.port);
            renderedMode = findCompleteNumberedListByLabels(lists, MODE_LABELS);
            const modePrefix = lists.find(
              (list) =>
                /^Guide me\b/i.test(list.items[0]?.text ?? "") &&
                /edit the file/i.test(list.items[1]?.text ?? "") &&
                /^Chat\b/i.test(list.items[2]?.text ?? ""),
            );
            if (clicked || modePrefix) {
              diagnostic("render-progress", {
                clicked,
                renderedMode,
                modePrefix,
                numberedLists: lists,
              });
            }
          },
          2_000,
        );

        expect(reachedMode).toBe(true);
        const rendered = renderedMode as KiroIdeNumberedListSnapshot | null;
        expect(rendered).not.toBeNull();
        if (rendered === null) {
          throw new Error("interaction mode did not render a complete numbered option list");
        }
        expect(rendered.listStyleType).not.toBe("none");
        expect(rendered.items.map((item) => item.ordinal)).toEqual([1, 2, 3, 4]);
        expect(rendered.items).toHaveLength(4);
        expect(rendered.items[3].text).toMatch(/^Other\b/i);
        expect(rendered.items.filter((item) => /^Other\b/i.test(item.text))).toHaveLength(1);
        expect(
          rendered.items.map((item) => ({
            ordinal: item.ordinal,
            markerContent: item.markerContent,
            listStyleType: item.listStyleType,
          })),
        ).toEqual([
          { ordinal: 1, markerContent: "normal", listStyleType: "decimal" },
          { ordinal: 2, markerContent: "normal", listStyleType: "decimal" },
          { ordinal: 3, markerContent: "normal", listStyleType: "decimal" },
          { ordinal: 4, markerContent: "normal", listStyleType: "decimal" },
        ]);
        expect(numberedListMarkersAreVisible(rendered)).toBe(true);

        const screenshotTarget = await pageTarget(handle.port);
        const png = await screenshot(screenshotTarget);
        screenshotTarget.close();
        expect(png).not.toBeNull();
        expect((png as Buffer).byteLength).toBeGreaterThan(5_000);
        if (SCREENSHOT_PATH) writeFileSync(SCREENSHOT_PATH, png as Buffer);
        diagnostic("asserted", {
          renderedMode: rendered,
          screenshotPath: SCREENSHOT_PATH || null,
          snapshots: await snapshotChatDom(handle.port),
        });
      } finally {
        teardown(handle);
        removeSandbox(sandbox);
        removeSeedDir(seedDir);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
