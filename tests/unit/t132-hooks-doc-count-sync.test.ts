// covers: doc:docs/reference/06-hooks-and-tools.md(hook-scope-count), file:settings.json, file:hooks/aidlc-*.ts
//
// t132 — Doc-count drift guard for the hook-scope sentence in
// docs/reference/06-hooks-and-tools.md.
//
// Subject (three ground-truth sources cross-checked against the doc prose):
//   A. dist/claude/.claude/hooks/aidlc-*.ts          — the hook scripts on disk
//   B. dist/claude/.claude/settings.json             — the `hooks` block command
//        count, + the shipped `statusLine` in tools/data/harness.json (1 when
//        present), which each person's own settings.local.json wires on their yes (#1407)
//   C. docs/reference/06-hooks-and-tools.md           — the count-words in the
//        hook-scope sentence:
//        "This implementation uses seventeen TypeScript hook sources ... All
//         seventeen are **project-wide** ... the other sixteen via the `hooks`
//         block ..."
//
// This mirrors t28's two-source set-equality discipline: it derives the count
// from disk + settings.json independently, then asserts the doc's count-words
// agree in BOTH directions (forward: doc cannot over/under-state; reverse: the
// doc's own block+statusLine split is arithmetically whole). t131 pins the
// settings.json WIRING; this pins the PROSE COUNT so a reword can't silently
// re-drift it away from ground truth.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hookGroupMemberNames } from "../../core/tools/aidlc-command.ts";
import { AIDLC_SRC, REPO_ROOT } from "../harness/fixtures.ts";

const HOOKS_DIR = join(AIDLC_SRC, "hooks");
const SETTINGS = join(AIDLC_SRC, "settings.json");
const DOC = join(REPO_ROOT, "docs", "reference", "06-hooks-and-tools.md");

// --- Ground truth A: hook scripts on disk (hooks/aidlc-*.ts) -----------------
function diskHookCount(): number {
  return readdirSync(HOOKS_DIR).filter(
    (f) => f.startsWith("aidlc-") && f.endsWith(".ts"),
  ).length;
}

// --- Ground truth B: settings.json registrations ----------------------------
// The human-turn hook (record-human-turn) is wired at TWO events
// (UserPromptSubmit + PostToolUse AskUserQuestion), so count UNIQUE commands: the
// guard's subject is "scripts wired vs scripts on disk", and a wired-but-missing
// script still changes the unique count. statusLine stays +1 (its own top-level
// key).
//
// One registration can also run SEVERAL hooks in one process (#2066: the four
// tool-call checks ride `engine hook guard-tool-call`), so a group command
// counts as the hooks it stands for, exactly as the doctor's roster expands it.
// A script on disk that no registration reaches, directly or through a group,
// still fails the cross-check below.
interface SettingsCounts {
  block: number;
  statusline: number;
  total: number;
}
function settingsCounts(): SettingsCounts {
  const s = JSON.parse(readFileSync(SETTINGS, "utf-8")) as {
    hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
    statusLine?: { command?: string };
  };
  const commands = new Set<string>();
  const add = (command: string): void => {
    const target = /engine hook ([A-Za-z0-9_-]+)\s*$/.exec(command)?.[1];
    const members = target ? hookGroupMemberNames(target) : [];
    if (members.length === 0) {
      commands.add(command);
      return;
    }
    for (const hook of members) commands.add(`${command} :: ${hook}`);
  };
  for (const ev of Object.keys(s.hooks ?? {})) {
    for (const g of s.hooks![ev]) {
      for (const h of g.hooks ?? []) {
        if (h.command) add(h.command);
      }
    }
  }
  // AI-DLC's status line ships in harness.json; the person's own
  // settings.local.json wires it once they choose it (#1407).
  const shipped = JSON.parse(readFileSync(join(AIDLC_SRC, "tools", "data", "harness.json"), "utf-8")) as {
    statusLine?: { command?: string };
  };
  const statusline = !s.statusLine?.command && shipped.statusLine?.command ? 1 : 0;
  return { block: commands.size, statusline, total: commands.size + statusline };
}

// --- Doc count-words (number-word -> int) ------------------------------------
// NaN if not a known word.
const WORD2INT: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
};
function word2int(word: string | undefined): number {
  if (word === undefined || !(word in WORD2INT)) return Number.NaN;
  return WORD2INT[word];
}

/** First capture-group match of `re` against the doc, or undefined. */
function docWord(re: RegExp): string | undefined {
  const m = readFileSync(DOC, "utf-8").match(re);
  return m ? m[1] : undefined;
}

// The three pinned count-words. The subject noun "This implementation" /
// "AI-DLC" is deliberately NOT pinned - only the count.
//   "uses <word> TypeScript hook sources" -> total
//   "All <word> are **project-wide**"     -> total restatement
//   "the other <word> via the `hooks` block" -> hooks-block subcount
const DOC_TOTAL_WORD = docWord(/uses ([a-z]+) TypeScript hook sources/);
const DOC_ALL_PW_WORD = docWord(/All ([a-z]+) are\s+\*\*project-wide\*\*/);
const DOC_BLOCK_WORD = docWord(/the other ([a-z]+) via the `hooks` block/);

const DOC_TOTAL = word2int(DOC_TOTAL_WORD);
const DOC_ALL_PW = word2int(DOC_ALL_PW_WORD);
const DOC_BLOCK = word2int(DOC_BLOCK_WORD);

describe("t132 hook-scope doc-count drift guard (migrated from t132-hooks-doc-count-sync.sh, plan 8)", () => {
  test("1: ground truth A — hooks/aidlc-*.ts exist on disk [.sh test 1]", () => {
    expect(diskHookCount()).toBeGreaterThan(0);
  });

  test("2: ground truth B — settings.json registers exactly 1 statusLine hook [.sh test 2]", () => {
    expect(settingsCounts().statusline).toBe(1);
  });

  test("3: ground truth cross-check — settings total registrations == hook files on disk [.sh test 3]", () => {
    const { total } = settingsCounts();
    expect(total).toBe(diskHookCount());
  });

  test("4: doc — the three count-words parse cleanly (sentence not reworded) [.sh test 4]", () => {
    // A reword that drops the pinned phrasing yields undefined -> NaN here,
    // tripping this before any equality check.
    expect(DOC_TOTAL_WORD).toBeDefined();
    expect(DOC_ALL_PW_WORD).toBeDefined();
    expect(DOC_BLOCK_WORD).toBeDefined();
    expect(Number.isNaN(DOC_TOTAL)).toBe(false);
    expect(Number.isNaN(DOC_ALL_PW)).toBe(false);
    expect(Number.isNaN(DOC_BLOCK)).toBe(false);
  });

  test("5: doc internal — 'All N project-wide' matches the hook-source total [.sh test 5]", () => {
    expect(DOC_ALL_PW).toBe(DOC_TOTAL);
  });

  test("6: doc forward — documented hook-source total == ground-truth total [.sh test 6]", () => {
    const disk = diskHookCount();
    expect(DOC_TOTAL).toBe(disk);
    expect(DOC_TOTAL).toBe(settingsCounts().total);
  });

  test("7: doc subcount — 'other N via the hooks block' == settings.json hooks-block count [.sh test 7]", () => {
    expect(DOC_BLOCK).toBe(settingsCounts().block);
  });

  test("8: doc reverse — hooks-block (N) + statusLine (1) == total (whole split) [.sh test 8]", () => {
    // Catches a half-correction that fixes one count-word but not the other.
    expect(DOC_BLOCK + 1).toBe(DOC_TOTAL);
  });
});
