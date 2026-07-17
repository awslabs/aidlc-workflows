// covers: doc:docs/reference/06-hooks-and-tools.md(hook-scope-count), file:settings.json, file:hooks/aidlc-*.ts
//
// t132 — Doc-count drift guard for the hook-scope sentence in
// docs/reference/06-hooks-and-tools.md. Migrated from
// tests/unit/t132-hooks-doc-count-sync.sh (TAP plan 8).
//
// Mechanism: none. The .sh shelled out to `ls` (disk count), `bun -e` (to
// parse settings.json WITHOUT a jq dependency — the framework ships jq-free),
// and `grep`/`sed` over the doc. None of that is a process-boundary contract:
// every byte the .sh inspected is a static file checked into the repo. The
// twin reads those three files in-process and asserts on their contents — no
// spawn, no LLM, no env seam. (The .sh's `bun -e` was a bash-portability
// workaround for the missing jq, not a tool/CLI under test; in TS we
// JSON.parse settings.json directly.)
//
// Subject (three ground-truth sources cross-checked against the doc prose):
//   A. dist/claude/.claude/hooks/aidlc-*.ts          — the hook scripts on disk
//   B. dist/claude/.claude/settings.json             — the `hooks` block command
//        count + the top-level `statusLine` key (1 when present)
//   C. docs/reference/06-hooks-and-tools.md           — the count-words in the
//        Wave-3-milestone-13 hook-scope sentence:
//        "This implementation uses ten hook scripts ... All ten are
//         **project-wide** ... the other nine via the `hooks` block ..."
//        (located at line 9 at migration time; matched by phrase, not by line).
//
// This mirrors t28's two-source set-equality discipline: it derives the count
// from disk + settings.json independently, then asserts the doc's count-words
// agree in BOTH directions (forward: doc cannot over/under-state; reverse: the
// doc's own block+statusLine split is arithmetically whole). t131 pins the
// settings.json WIRING; this pins the PROSE COUNT so a reword can't silently
// re-drift it away from ground truth.
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test()):
//   .sh test 1  assert_gt DISK_COUNT 0                        -> "ground truth A: hooks/aidlc-*.ts exist on disk"
//   .sh test 2  assert_eq SETTINGS_STATUSLINE_COUNT 1         -> "ground truth B: settings.json registers exactly 1 statusLine hook"
//   .sh test 3  assert_eq SETTINGS_TOTAL DISK_COUNT           -> "ground truth cross-check: settings total == disk files"
//   .sh test 4  doc three count-words parse cleanly           -> "doc: the three count-words parse cleanly (sentence not reworded)"
//   .sh test 5  assert_eq DOC_ALL_PW DOC_TOTAL                -> "doc internal: 'All N project-wide' matches 'uses N hook scripts'"
//   .sh test 6  assert_eq DOC_TOTAL DISK_COUNT                -> "doc forward: 'uses N hook scripts' == ground-truth total"
//   .sh test 7  assert_eq DOC_BLOCK SETTINGS_BLOCK_COUNT      -> "doc subcount: 'other N via the hooks block' == settings hooks-block count"
//   .sh test 8  assert_eq (DOC_BLOCK+1) DOC_TOTAL             -> "doc reverse: hooks-block (N) + statusLine (1) == total (whole split)"

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, REPO_ROOT } from "../harness/fixtures.ts";

const HOOKS_DIR = join(AIDLC_SRC, "hooks");
const SETTINGS = join(AIDLC_SRC, "settings.json");
const DOC = join(REPO_ROOT, "docs", "reference", "06-hooks-and-tools.md");

// --- Ground truth A: hook scripts on disk (hooks/aidlc-*.ts) -----------------
// The .sh did `ls -1 "$HOOKS_DIR"/aidlc-*.ts | wc -l`.
function diskHookCount(): number {
  return readdirSync(HOOKS_DIR).filter(
    (f) => f.startsWith("aidlc-") && f.endsWith(".ts"),
  ).length;
}

// --- Ground truth B: settings.json registrations ----------------------------
// The .sh's `bun -e` parse counted every command in the `hooks` block, which
// was 1:1 with scripts while each script had exactly one registration. The
// mint-presence hook is now wired at TWO events (UserPromptSubmit + PostToolUse
// AskUserQuestion), so count UNIQUE commands instead: the guard's subject is
// "scripts wired vs scripts on disk", and a wired-but-missing script still
// changes the unique count. statusLine stays +1 (its own top-level key).
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
  for (const ev of Object.keys(s.hooks ?? {})) {
    for (const g of s.hooks![ev]) {
      for (const h of g.hooks ?? []) {
        if (h.command) commands.add(h.command);
      }
    }
  }
  const statusline = s.statusLine?.command ? 1 : 0;
  return { block: commands.size, statusline, total: commands.size + statusline };
}

// --- Doc count-words (number-word -> int) ------------------------------------
// The .sh's word2int case statement. "MISS" (here: NaN) if not a known word.
const WORD2INT: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13,
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

// The three pinned count-words. Same patterns the .sh grepped (the subject noun
// "This implementation" / "AI-DLC" is deliberately NOT pinned — only the count).
//   "uses <word> hook scripts"            -> total
//   "All <word> are **project-wide**"     -> total restatement
//   "the other <word> via the `hooks` block" -> hooks-block subcount
const DOC_TOTAL_WORD = docWord(/uses ([a-z]+) hook scripts/);
const DOC_ALL_PW_WORD = docWord(/All ([a-z]+) are \*\*project-wide\*\*/);
const DOC_BLOCK_WORD = docWord(/the other ([a-z]+) via the `hooks` block/);

const DOC_TOTAL = word2int(DOC_TOTAL_WORD);
const DOC_ALL_PW = word2int(DOC_ALL_PW_WORD);
const DOC_BLOCK = word2int(DOC_BLOCK_WORD);

describe("t132 hook-scope doc-count drift guard (migrated from t132-hooks-doc-count-sync.sh, plan 8)", () => {
  // --- Ground truth A ---
  test("1: ground truth A — hooks/aidlc-*.ts exist on disk [.sh test 1]", () => {
    expect(diskHookCount()).toBeGreaterThan(0);
  });

  // --- Ground truth B ---
  test("2: ground truth B — settings.json registers exactly 1 statusLine hook [.sh test 2]", () => {
    expect(settingsCounts().statusline).toBe(1);
  });

  // --- Ground truth cross-check: disk == settings total ---
  test("3: ground truth cross-check — settings total registrations == hook files on disk [.sh test 3]", () => {
    const { total } = settingsCounts();
    expect(total).toBe(diskHookCount());
  });

  // --- Doc parse: the three count-words survived (no silent reword) ---
  test("4: doc — the three count-words parse cleanly (sentence not reworded) [.sh test 4]", () => {
    // The .sh's `[ "$DOC_TOTAL" != "MISS" ] && ...` for all three. A reword
    // that drops the pinned phrasing yields undefined -> NaN here, tripping
    // this before any equality check.
    expect(DOC_TOTAL_WORD).toBeDefined();
    expect(DOC_ALL_PW_WORD).toBeDefined();
    expect(DOC_BLOCK_WORD).toBeDefined();
    expect(Number.isNaN(DOC_TOTAL)).toBe(false);
    expect(Number.isNaN(DOC_ALL_PW)).toBe(false);
    expect(Number.isNaN(DOC_BLOCK)).toBe(false);
  });

  // --- Doc internal consistency ---
  test("5: doc internal — 'All N project-wide' matches 'uses N hook scripts' [.sh test 5]", () => {
    expect(DOC_ALL_PW).toBe(DOC_TOTAL);
  });

  // --- Doc forward: doc total cannot over/under-state ground truth ---
  test("6: doc forward — 'uses N hook scripts' == ground-truth total [.sh test 6]", () => {
    // The .sh asserts against DISK_COUNT; SETTINGS_TOTAL was already proven
    // equal to DISK_COUNT in test 3, so this pins the doc to both at once.
    const disk = diskHookCount();
    expect(DOC_TOTAL).toBe(disk);
    expect(DOC_TOTAL).toBe(settingsCounts().total);
  });

  // --- Doc subcount: hooks-block word == settings hooks-block count ---
  test("7: doc subcount — 'other N via the hooks block' == settings.json hooks-block count [.sh test 7]", () => {
    expect(DOC_BLOCK).toBe(settingsCounts().block);
  });

  // --- Doc reverse: the doc's own split is arithmetically whole ---
  test("8: doc reverse — hooks-block (N) + statusLine (1) == total (whole split) [.sh test 8]", () => {
    // Catches a half-correction that fixes one count-word but not the other.
    expect(DOC_BLOCK + 1).toBe(DOC_TOTAL);
  });
});
