import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  createTuiScreen,
  physicalTuiText,
  type TuiScreen,
  type TuiSnapshot,
} from "../harness/tui-screen.ts";
import { gridHasMenu, matchTuiPattern } from "../harness/tui-drive.ts";
import { completedClaudeTurnPattern } from "../harness/tui-fixtures.ts";

const screens: TuiScreen[] = [];
const encoder = new TextEncoder();
const plain = { mode: "default", value: 0 } as const;
const PREFLIGHT_TEXT = "AIDLC_TUI_PREFLIGHT_OK · ←→ ▓░ ✓✔ ❯☐☒ — ordinary text";
const PREFLIGHT_BYTES = encoder.encode(`\x1b[32m${PREFLIGHT_TEXT}\x1b[0m\r\n`);

async function screen(
  cols = 20,
  rows = 4,
  onInput: (data: string | Uint8Array) => void = () => {},
): Promise<TuiScreen> {
  const result = await createTuiScreen(cols, rows, onInput);
  screens.push(result);
  return result;
}

function write(target: TuiScreen, text: string): void {
  target.write(encoder.encode(text));
}

function grid(snapshot: TuiSnapshot): string[] {
  return snapshot.lines.map((line) => line.cells
    .filter((cell) => cell.width > 0)
    .map((cell) => cell.chars || " ").join(""));
}

function paintedLines(snapshot: TuiSnapshot): TuiSnapshot["lines"] {
  // An ANSI frame paints null cells as spaces; compare their appearance/attrs.
  return snapshot.lines.map((line) => ({
    ...line,
    cells: line.cells.map((cell) => ({
      ...cell, chars: cell.width > 0 ? cell.chars || " " : cell.chars,
    })),
  }));
}

function expectPreflightFrame(snapshot: TuiSnapshot, partition: string): void {
  expect({ partition, text: snapshot.text }).toEqual({ partition, text: PREFLIGHT_TEXT });
  expect(snapshot.lines[0].cells.slice(0, PREFLIGHT_TEXT.length).map((cell) => ({
    chars: cell.chars, width: cell.width, fg: cell.fg,
  }))).toEqual([...PREFLIGHT_TEXT].map((chars) => ({
    chars, width: 1, fg: { mode: "palette", value: 2 },
  })));
  expect(snapshot.ansi).toContain(`\x1b[32m${PREFLIGHT_TEXT}`);
}

afterEach(() => {
  for (const target of screens.splice(0)) target.dispose();
});

describe("native TUI screen transcripts", () => {
  test("captures palette/RGB, every exposed attribute, and selective resets", async () => {
    const target = await screen(12, 2);
    write(target, "\x1b[32mG\x1b[38;2;17;34;51;48;2;68;85;102mR");
    write(target, "\x1b[1;2;3;4;7;8;9mA\x1b[22;23;24;27;28;29;39;49mN");
    write(target, "\x1b[38;5;196;48;5;21mP\x1b[92;104mB\x1b[0mD");
    const snap = await target.snapshot();
    const cells = snap.lines[0].cells;
    expect(snap.text).toBe("GRANPBD");
    expect(cells[0].fg).toEqual({ mode: "palette", value: 2 });
    expect(cells[1]).toMatchObject({
      fg: { mode: "rgb", value: 0x112233 },
      bg: { mode: "rgb", value: 0x445566 },
    });
    expect(cells[2]).toMatchObject({
      bold: true, dim: true, italic: true, underline: true,
      inverse: true, invisible: true, strikethrough: true,
    });
    expect(cells[3]).toMatchObject({
      fg: plain, bg: plain, bold: false, dim: false, italic: false,
      underline: false, inverse: false, invisible: false, strikethrough: false,
    });
    expect(cells[4]).toMatchObject({
      fg: { mode: "palette", value: 196 }, bg: { mode: "palette", value: 21 },
    });
    expect(cells[5]).toMatchObject({
      fg: { mode: "palette", value: 10 }, bg: { mode: "palette", value: 12 },
    });
    expect(snap.ansi).toContain("\x1b[32mG");
    expect(snap.ansi).toContain("38;2;17;34;51;48;2;68;85;102");
    expect(snap.ansi).toContain("\x1b[0mN");
    expect(snap.ansi).toContain("38;5;196;48;5;21");
    expect(snap.ansi).toContain("92;104");
    expect(snap.ansi.endsWith("\x1b[0m")).toBe(true);

    // Repainting a fresh terminal from capture must preserve all physical cells,
    // including styled blanks; text-only or raw-history captures cannot do this.
    const replay = await screen(12, 2);
    write(replay, snap.ansi);
    const repainted = await replay.snapshot();
    expect(paintedLines(repainted)).toEqual(paintedLines(snap));
    expect(repainted.text).toBe(snap.text);
  });

  test("erasure removes history and retains the erase background on blank cells", async () => {
    const target = await screen(10, 3);
    write(target, "\x1b[31mOLD-DATA\r\x1b[0;44m\x1b[2K\x1b[0mnew");
    const snap = await target.snapshot();
    expect(snap.text).toBe("new");
    expect(snap.ansi).not.toContain("OLD-DATA");
    expect(snap.lines[0].cells[2].bg).toEqual(plain);
    expect(snap.lines[0].cells[3]).toMatchObject({
      chars: "", width: 1, fg: plain, bg: { mode: "palette", value: 4 }, bold: false,
    });
    expect(snap.lines).toHaveLength(3);
    expect(snap.lines.every((line) => line.cells.length === 10)).toBe(true);
    const replay = await screen(10, 3);
    write(replay, snap.ansi);
    expect(paintedLines(await replay.snapshot())).toEqual(paintedLines(snap));
    write(target, "\x1b[0m\x1b[2J\x1b[H");
    const cleared = await target.snapshot();
    expect(cleared.text).toBe("");
    expect(cleared.lines[0].cells[3].bg).toEqual(plain);
  });

  test("split UTF-8, combining characters, and wide cells retain column positions", async () => {
    const target = await screen(10, 2);
    const bytes = Buffer.from("A界e\u0301中Z");
    for (const byte of bytes) {
      const shared = new Uint8Array([byte]);
      target.write(shared);
      shared[0] = 0x58; // Parser must own each byte before this callback returns.
    }
    const snap = await target.snapshot();
    expect(snap.text).toBe("A界e\u0301中Z");
    expect(snap.cursor).toEqual({ x: 7, y: 0 });
    expect(snap.lines[0].cells.slice(0, 7).map(({ chars, width }) => [chars, width]))
      .toEqual([["A", 1], ["界", 2], ["", 0], ["e\u0301", 1], ["中", 2], ["", 0], ["Z", 1]]);
    expect(grid(snap)[0]).toBe("A界e\u0301中Z   ");
    expect(snap.ansi.match(/界/g)).toHaveLength(1);
    expect(snap.ansi.match(/中/g)).toHaveLength(1);
    expect(snap.ansi).toContain("A界e\u0301中Z");
  });

  test("exact preflight payload survives every two-chunk byte partition", async () => {
    for (let split = 0; split <= PREFLIGHT_BYTES.length; split++) {
      const target = await screen(120, 4);
      try {
        target.write(PREFLIGHT_BYTES.subarray(0, split));
        await target.flush();
        target.write(PREFLIGHT_BYTES.subarray(split));
        expectPreflightFrame(await target.snapshot(), `split=${split}`);
      } finally {
        target.dispose();
      }
    }
  });

  test("exact preflight payload survives every fixed chunk size with separate parser drains", async () => {
    for (let size = 1; size <= PREFLIGHT_BYTES.length; size++) {
      const target = await screen(120, 4);
      try {
        for (let offset = 0; offset < PREFLIGHT_BYTES.length; offset += size) {
          target.write(PREFLIGHT_BYTES.subarray(offset, offset + size));
          // Each callback finishes before the next fragment arrives, like the
          // real preflight's paced PTY writes, without depending on wall time.
          await target.flush();
        }
        expectPreflightFrame(await target.snapshot(), `chunk-size=${size}`);
      } finally {
        target.dispose();
      }
    }
    // Hundreds of separate parser drains exceed Bun's default 5s budget on Windows.
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("every partition of 2/3/4-byte UTF-8 preserves zero-bit continuation bytes", async () => {
    for (const glyph of ["Ā", "—", "\u1000", "\u{10000}", "\u{40000}"]) {
      const bytes = encoder.encode(glyph);
      for (let mask = 0; mask < 1 << (bytes.length - 1); mask++) {
        const target = await screen();
        try {
          write(target, "A");
          let start = 0;
          for (let end = 1; end <= bytes.length; end++) {
            if (end !== bytes.length && !(mask & 1 << (end - 1))) continue;
            target.write(bytes.subarray(start, end));
            await target.flush();
            start = end;
          }
          write(target, "Z");
          const snap = await target.snapshot();
          expect({ glyph, mask, text: snap.text }).toEqual({ glyph, mask, text: `A${glyph}Z` });
          expect(snap.lines[0].cells.map((cell) => cell.chars).join("")).toBe(`A${glyph}Z`);
        } finally {
          target.dispose();
        }
      }
    }
  });

  test("flush retains incomplete UTF-8 for the next write without inventing replacement cells", async () => {
    const target = await screen();
    write(target, "start");
    for (const byte of [0xe2, 0x80]) {
      target.write(new Uint8Array([byte]));
      await target.flush();
      expect((await target.snapshot()).text).toBe("start");
    }
    target.write(new Uint8Array([0x94]));
    expect((await target.snapshot()).text).toBe("start—");
  });

  test("malformed UTF-8 is visible as replacement cells instead of silently dropping bytes", async () => {
    const target = await screen();
    target.write(new Uint8Array([0xe2, 0x80]));
    await target.flush();
    expect((await target.snapshot()).text).toBe("");
    target.write(new Uint8Array([0x58, 0xff]));
    const snap = await target.snapshot();
    expect(snap.text).toBe("\uFFFDX\uFFFD");
    expect(snap.lines[0].cells.slice(0, 3).map((cell) => cell.chars))
      .toEqual(["\uFFFD", "X", "\uFFFD"]);
  });

  test("copies Buffer subarrays rather than retaining a view of reused PTY memory", async () => {
    const target = await screen();
    const bytes = Buffer.from("-final-");
    target.write(bytes.subarray(1, 6));
    bytes.fill(0x58);
    await target.flush();
    expect((await target.snapshot()).text).toBe("final");
  });

  test("joins soft wraps, preserves intervening spaces, and keeps the physical grid", async () => {
    const target = await screen(5, 5);
    write(target, "ab   cd\r\n\r\nend");
    const snap = await target.snapshot();
    expect(snap.text).toBe("ab   cd\n\nend");
    expect(physicalTuiText(snap)).toBe("ab\ncd\n\nend");
    const views = { physical: physicalTuiText(snap), logical: snap.text };
    expect(matchTuiPattern(views, /ab {3}cd/)).toBe("logical");
    expect(matchTuiPattern(views, /\ncd/)).toBe("physical");
    expect(matchTuiPattern(views, /ab {3}cd/, "physical")).toBeNull();
    expect(matchTuiPattern(views, /\ncd/, "logical")).toBeNull();
    expect(snap.lines.map((line) => line.wrapped)).toEqual([false, true, false, false, false]);
    expect(grid(snap)).toEqual(["ab   ", "cd   ", "     ", "end  ", "     "]);
    const wide = await screen(5, 3);
    write(wide, "ABCD界Z");
    const wrapped = await wide.snapshot();
    expect(wrapped.text).toBe("ABCD界Z");
    expect(physicalTuiText(wrapped)).toBe("ABCD\n界Z");
    expect(grid(wrapped)).toEqual(["ABCD ", "界Z  ", "     "]);
    expect(wrapped.lines[1].wrapped).toBe(true);
  });

  test("cursor-addressed repaint exposes approval rows even when old soft-wrap flags survive", async () => {
    const target = await screen(120, 14);
    // Visible labels from Windows R32 t50's retained timeout frame, line 2617.
    // The archive has logical text, not raw PTY bytes; these real VT operations
    // reproduce the stale-wrap state without assigning emulator internals.
    const rows = [
      "─".repeat(120),
      " ☐ Approve RE",
      "",
      "│ The code knowledge base is ready. Approve it and continue to Requirements Analysis, or request changes?",
      "",
      "❯ 1. Approve",
      "     Accept the knowledge base and continue to Requirements Analysis.",
      "  2. Request Changes",
      "     Something in the scan or artifacts needs adjusting before continuing — I'll ask what.",
      "  3. Type something.",
      "─".repeat(120),
      "  4. Chat about this",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
      "",
    ];
    write(target, "old wrapped output ".repeat(90));
    for (let row = 0; row < rows.length; row++) {
      write(target, `\x1b[${row + 1};1H${rows[row].padEnd(120)}`);
    }
    const snap = await target.snapshot();
    expect(snap.lines[5].wrapped).toBe(true);
    expect(gridHasMenu(snap.text)).toBe(false);
    expect(physicalTuiText(snap)).toBe(rows.slice(0, -1).join("\n"));
    expect(gridHasMenu(physicalTuiText(snap))).toBe(true);
    // Projection does not rewrite logical text, wrap flags, attributes or ANSI.
    expect(await target.snapshot()).toEqual(snap);
    expect(snap.ansi).toContain("❯ 1. Approve");

    // Repaint every row, including the old options. Echoed caret text on an
    // ordinary output line must not become a menu by relaxing the detector.
    const stale = ["Earlier output mentioned ❯ 1. Approve", "Enter to select · old footer"];
    for (let row = 0; row < rows.length; row++) {
      write(target, `\x1b[${row + 1};1H${(stale[row] ?? "").padEnd(120)}`);
    }
    const erased = await target.snapshot();
    expect(physicalTuiText(erased)).toBe(stale.join("\n"));
    expect(gridHasMenu(physicalTuiText(erased))).toBe(false);
    expect(physicalTuiText(erased)).not.toContain("Request Changes");
  });

  test("t27's exact completed-turn pattern matches the physical idle caret after a repaint", async () => {
    const target = await screen(120, 5);
    const repaint = (rows: string[]) => {
      for (let row = 0; row < 5; row++) {
        write(target, `\x1b[${row + 1};1H${(rows[row] ?? "").padEnd(120)}`);
      }
    };
    write(target, "x".repeat(120 * 4));
    repaint(["Invalid depth extreme", "─".repeat(120), "❯", "bypass permissions on"]);
    const snap = await target.snapshot();
    const views = { physical: physicalTuiText(snap), logical: snap.text };
    const pattern = new RegExp(completedClaudeTurnPattern("extreme"));
    expect(pattern.test(views.logical)).toBe(false);
    expect(matchTuiPattern(views, pattern)).toBe("physical");
    // A mentioned caret is not the returned empty prompt required by t27.
    repaint(["Invalid depth extreme", "Earlier response quoted ❯", "bypass permissions on"]);
    const streaming = await target.snapshot();
    expect(matchTuiPattern({
      physical: physicalTuiText(streaming), logical: streaming.text,
    }, pattern)).toBeNull();
  });

  test("captures only the active viewport and restores the normal buffer", async () => {
    const target = await screen(8, 2);
    write(target, "gone\r\nkept\r\nlast");
    const normal = await target.snapshot();
    expect(normal.buffer).toBe("normal");
    expect(normal.text).toBe("kept\nlast");
    expect(normal.ansi).not.toContain("gone");
    write(target, "\x1b[?1049h\x1b[H\x1b[2JALT");
    const alternate = await target.snapshot();
    expect(alternate.buffer).toBe("alternate");
    expect(alternate.text).toBe("ALT");
    expect(alternate.ansi).not.toContain("kept");
    write(target, "\x1b[?1049l");
    const restored = await target.snapshot();
    expect(restored.buffer).toBe("normal");
    expect(restored.text).toBe(normal.text);
    expect(restored.cursor).toEqual(normal.cursor);
  });

  test("flush drains a final fragment without requiring newline or a later output event", async () => {
    const target = await screen();
    write(target, "\x1b[38;2;1;");
    await target.flush();
    expect((await target.snapshot()).text).toBe("");
    write(target, "2;3mfinal");
    await target.flush();
    const snap = await target.snapshot();
    expect(snap.text).toBe("final");
    expect(snap.lines[0].cells[0].fg).toEqual({ mode: "rgb", value: 0x010203 });
  });

  test("snapshots are ordered, independent frames; reads cannot return stale cached output", async () => {
    const target = await screen(10, 2);
    const initial = await target.snapshot();
    write(target, "\x1b[31mfirst");
    const firstPromise = target.snapshot();
    write(target, "\r\x1b[0;32m\x1b[2Ksecond");
    const secondPromise = target.snapshot();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(initial.sequence).toBe(0);
    expect(first.sequence).toBeGreaterThan(initial.sequence);
    expect(second.sequence).toBeGreaterThan(first.sequence);
    expect(first.text).toBe("first");
    expect(second.text).toBe("second");
    expect(first.lines[0].cells[0].fg).toEqual({ mode: "palette", value: 1 });
    expect(second.lines[0].cells[0].fg).toEqual({ mode: "palette", value: 2 });
    expect((await target.snapshot()).sequence).toBe(second.sequence);
    first.lines[0].cells[0].fg.value = 7;
    second.lines[0].cells[0].chars = "X";
    expect((await target.snapshot()).text).toBe("second");
    expect((await target.snapshot()).lines[0].cells[0].fg.value).toBe(2);
  });

  test("resize is ordered with output and snapshots and resizes both xterm buffers", async () => {
    const target = await screen(8, 3);
    write(target, "normal");
    const before = target.snapshot();
    const resizing = target.resize(6, 2);
    write(target, "\x1b[?1049h\x1b[Halt");
    await resizing;
    const alternate = await target.snapshot();
    expect((await before).cols).toBe(8);
    expect(alternate).toMatchObject({ cols: 6, rows: 2, buffer: "alternate", text: "alt" });
    expect(alternate.lines.every((line) => line.cells.length === 6)).toBe(true);
    write(target, "\x1b[?1049l");
    const normal = await target.snapshot();
    expect(normal).toMatchObject({ cols: 6, rows: 2, buffer: "normal", text: "normal" });
    expect(normal.lines).toHaveLength(2);
  });
});

describe("native TUI input transcripts", () => {
  test("named keys and literal fallback retain exact bytes and optional Enter", async () => {
    const input: Array<string | Uint8Array> = [];
    const target = await screen(20, 4, (data) => { input.push(data); });
    const cases: Array<[string, boolean, boolean, string]> = [
      ["Enter", false, true, "\r"], ["Enter", false, false, "\r\r"],
      ["Space", false, true, " "], ["Tab", false, true, "\t"],
      ["Escape", false, true, "\x1b"], ["BSpace", false, true, "\x7f"],
      ["C-c", false, true, "\x03"], ["C-d", false, true, "\x04"],
      ["C-a", false, true, "\x01"], ["C-z", false, true, "\x1a"],
      ["C-Space", false, true, "\0"], ["C-[", false, true, "\x1b"],
      ["C-\\", false, true, "\x1c"], ["C-]", false, true, "\x1d"],
      ["C-^", false, true, "\x1e"], ["C-_", false, true, "\x1f"],
      ["C-BSpace", false, true, "\x08"],
      ["C-?", false, true, "\x7f"], ["M-x", false, true, "\x1bx"],
      ["1", false, false, "1\r"], ["2", false, true, "2"],
      ["arbitrary text", false, false, "arbitrary text\r"],
      ["constructor", false, true, "constructor"],
      ["C-unknown", false, true, "C-unknown"],
      ["Enter", true, false, "Enter\r"], ["C-c\r\n", true, true, "C-c\r\n"],
    ];
    for (const [keys, literal, noEnter] of cases) target.keys(keys, literal, noEnter);
    await target.flush();
    expect(input).toEqual(cases.map((entry) => entry[3]));
  });

  test("cursor modes, modifiers, navigation and F1..F12 use exact terminal sequences", async () => {
    const input: Array<string | Uint8Array> = [];
    const target = await screen(20, 4, (data) => { input.push(data); });
    const normal: Array<[string, string]> = [
      ["Up", "\x1b[A"], ["Down", "\x1b[B"], ["Right", "\x1b[C"], ["Left", "\x1b[D"],
      ["Home", "\x1b[H"], ["End", "\x1b[F"],
      ["Insert", "\x1b[2~"], ["Delete", "\x1b[3~"], ["PageUp", "\x1b[5~"], ["PageDown", "\x1b[6~"],
      ["F1", "\x1bOP"], ["F2", "\x1bOQ"], ["F3", "\x1bOR"], ["F4", "\x1bOS"],
      ["F5", "\x1b[15~"], ["F6", "\x1b[17~"], ["F7", "\x1b[18~"], ["F8", "\x1b[19~"],
      ["F9", "\x1b[20~"], ["F10", "\x1b[21~"], ["F11", "\x1b[23~"], ["F12", "\x1b[24~"],
    ];
    for (const [key] of normal) target.keys(key, false, true);
    write(target, "\x1b[?1h");
    const application: Array<[string, string]> = [
      ["Up", "\x1bOA"], ["Down", "\x1bOB"], ["Right", "\x1bOC"], ["Left", "\x1bOD"],
      ["Home", "\x1bOH"], ["End", "\x1bOF"],
      ["S-Up", "\x1b[1;2A"], ["M-Left", "\x1b[1;3D"], ["C-Down", "\x1b[1;5B"],
      ["C-S-Right", "\x1b[1;6C"], ["C-M-S-Home", "\x1b[1;8H"],
      ["Alt-End", "\x1b[1;3F"], ["Ctrl-Shift-F1", "\x1b[1;6P"],
      ["C-Delete", "\x1b[3;5~"], ["S-PageDown", "\x1b[6;2~"], ["M-F12", "\x1b[24;3~"],
      ["S-Tab", "\x1b[Z"],
    ];
    for (const [key] of application) target.keys(key, false, true);
    write(target, "\x1b[?1l");
    target.keys("Up", false, true);
    await target.flush();
    expect(input).toEqual([...normal, ...application].map((entry) => entry[1]).concat("\x1b[A"));
  });

  test("paste follows bracketed mode, normalizes line endings, and never appends Enter", async () => {
    const input: Array<string | Uint8Array> = [];
    const target = await screen(20, 4, (data) => { input.push(data); });
    target.paste("a\r\nb\nc\rd");
    write(target, "\x1b[?2004h");
    target.paste("界\r\nx\ny\r");
    target.keys("raw\n", true, true);
    write(target, "\x1b[?2004l");
    target.paste("last");
    await target.flush();
    expect(input).toEqual([
      "a\rb\rc\rd", "\x1b[200~界\rx\ry\r\x1b[201~", "raw\n", "last",
    ]);
  });

  test("emulator queries reply through onInput in parse order without painting replies", async () => {
    const input: Array<string | Uint8Array> = [];
    const target = await screen(10, 4, (data) => { input.push(data); });
    write(target, "\x1b[2;3H\x1b[5");
    write(target, "n\x1b[6n");
    target.keys("C-d", false, true);
    await target.flush();
    expect(input).toEqual(["\x1b[0n", "\x1b[2;3R", "\x04"]);
    const snap = await target.snapshot();
    expect(snap.text).toBe("");
    expect(snap.cursor).toEqual({ x: 2, y: 1 });
  });

  test("reply callback errors reject flush and snapshots instead of hanging the parser", async () => {
    const target = await screen(10, 4, () => { throw new Error("PTY input closed"); });
    write(target, "\x1b[5n");
    await expect(target.flush()).rejects.toThrow("PTY input closed");
    await expect(target.snapshot()).rejects.toThrow("PTY input closed");
  });
});

describe("native TUI bounds and lifetime", () => {
  test("invalid or oversized geometry is rejected before construction and resize", async () => {
    const target = await screen();
    for (const [cols, rows] of [
      [0, 4], [1, 4], [-1, 4], [2.5, 4], [20, 0], [20, -1], [20, 1.5],
      [Number.NaN, 4], [20, Number.NaN], [Infinity, 4], [20, Infinity],
      [1001, 4], [20, 1001], [1000, 101],
    ]) {
      await expect(createTuiScreen(cols, rows, () => {})).rejects.toThrow("geometry");
      await expect(target.resize(cols, rows)).rejects.toThrow("geometry");
    }
    expect(await target.snapshot()).toMatchObject({ cols: 20, rows: 4, sequence: 0 });
    const minimum = await screen(2, 1);
    expect(await minimum.snapshot()).toMatchObject({ cols: 2, rows: 1 });
  });

  test("large writes and cumulative queued output reject explicitly without losing accepted bytes", async () => {
    const target = await screen();
    expect(() => target.write(new Uint8Array(8 * 1024 * 1024 + 1))).toThrow("queue limit");
    const chunk = new Uint8Array(2 * 1024 * 1024); // NULs are valid ignored output.
    for (const char of "ABCD") {
      chunk[chunk.length - 1] = char.charCodeAt(0);
      target.write(chunk);
    }
    expect(() => write(target, "rejected")).toThrow("queue limit");
    await target.flush();
    expect((await target.snapshot()).text).toBe("ABCD");
    write(target, "accepted");
    expect((await target.snapshot()).text).toBe("ABCDaccepted");
  });

  test("many tiny operations are bounded separately from byte payloads", async () => {
    let received = 0;
    const target = await screen(2, 1, () => { received++; });
    for (let i = 0; i < 4096; i++) target.keys("x", true, true);
    expect(() => target.keys("y", true, true)).toThrow("queue limit");
    await target.flush();
    expect(received).toBe(4096);
    target.keys("z", true, true);
    await target.flush();
    expect(received).toBe(4097);
  });

  test("dispose is idempotent and settles a queued snapshot even during a pending write", async () => {
    const input: Array<string | Uint8Array> = [];
    const target = await screen(20, 4, (data) => { input.push(data); });
    write(target, "pending");
    const pending = target.snapshot();
    // Attach a normal observer now: Bun's eager rejects matcher can drain the
    // parser before execution reaches dispose(), making this snapshot valid.
    const outcome = pending.then(
      (value) => ({ status: "fulfilled", value }),
      (error: unknown) => ({ status: "rejected", error }),
    );
    target.keys("must not reach PTY", true, true);
    // A microtask starts the queued write without running xterm's parser timer.
    await Promise.resolve();
    target.dispose();
    target.dispose();
    expect(await outcome).toMatchObject({
      status: "rejected",
      error: { message: "TUI screen is disposed" },
    });
    expect(input).toEqual([]);
    await expect(target.flush()).rejects.toThrow("disposed");
    await expect(target.snapshot()).rejects.toThrow("disposed");
    await expect(target.resize(10, 2)).rejects.toThrow("disposed");
    expect(() => write(target, "late")).toThrow("disposed");
    expect(() => target.keys("Enter", false, true)).toThrow("disposed");
    expect(() => target.paste("late")).toThrow("disposed");
  });
});
