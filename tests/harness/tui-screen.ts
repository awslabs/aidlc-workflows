import type { IBufferCell, Terminal } from "@xterm/headless";
import { createRequire } from "node:module";
import { StringDecoder } from "node:string_decoder";

export interface TuiColor {
  mode: "default" | "palette" | "rgb";
  value: number;
}

export interface TuiCell {
  chars: string;
  width: number;
  fg: TuiColor;
  bg: TuiColor;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  invisible: boolean;
  strikethrough: boolean;
}

export interface TuiSnapshot {
  /** Increments after each parsed output chunk or model resize; reads don't increment. */
  sequence: number;
  cols: number;
  rows: number;
  /** Zero based; x may equal cols when a wrap is pending (xterm's cursorX). */
  cursor: { x: number; y: number };
  buffer: "normal" | "alternate";
  /** Joined soft wraps, trimmed line ends/blank final lines, no terminating LF. */
  text: string;
  /** Full physical grid, SGR attributes and CRLF separators, reset at both ends. */
  ansi: string;
  lines: Array<{ wrapped: boolean; cells: TuiCell[] }>;
}

export type TuiTextLayout = "logical" | "physical";
export interface TuiTextViews {
  physical: string;
  logical: string;
}

/** Visible rows for automation; repaint-stale wrap flags must not join UI rows. */
export function physicalTuiText(snapshot: Pick<TuiSnapshot, "lines">): string {
  const rows = snapshot.lines.map(({ cells }) => cells
    .filter((cell) => cell.width !== 0)
    .map((cell) => cell.chars || " ")
    .join("")
    .replace(/ +$/, ""));
  while (rows.length && rows[rows.length - 1] === "") rows.pop();
  return rows.join("\n");
}

export interface TuiScreen {
  /** Copies bytes immediately. Throws on overflow; callers must handle/retry explicitly. */
  write(bytes: Uint8Array): void;
  /** Drains accepted operations; incomplete UTF-8 remains buffered for later bytes. */
  flush(): Promise<void>;
  /** Model only: the owner must resize its PTY separately. */
  resize(cols: number, rows: number): Promise<void>;
  /** An ordered read barrier: output accepted afterwards cannot tear this frame. */
  snapshot(): Promise<TuiSnapshot>;
  /** Input is queued behind output so DECSET/DECRST modes take effect first. */
  keys(keys: string, literal: boolean, noEnter: boolean): void;
  /** CRLF and lone LF become CR, lone CR is retained; no implicit Enter. */
  paste(text: string): void;
  dispose(): void;
}

// Bound both payload memory and tiny-chunk/operation overhead. Overflow never drops
// accepted output, and capacity becomes available again after flush().
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;
const MAX_QUEUED_OPERATIONS = 4096;

function validateGeometry(cols: number, rows: number): void {
  // xterm clamps columns below 2 (wide characters require two cells). Reject
  // instead of silently disagreeing with the owner's PTY geometry.
  if (
    !Number.isInteger(cols) || !Number.isInteger(rows) ||
    cols < 2 || rows < 1 || cols > 1000 || rows > 1000 || cols * rows > 100_000
  ) {
    throw new RangeError(
      "TUI geometry requires finite integers: cols 2..1000, rows 1..1000, at most 100000 cells",
    );
  }
}

function readCell(cell: IBufferCell): TuiCell {
  return {
    chars: cell.getChars(),
    width: cell.getWidth(),
    fg: {
      mode: cell.isFgRGB() ? "rgb" : cell.isFgPalette() ? "palette" : "default",
      value: cell.isFgDefault() ? 0 : cell.getFgColor(),
    },
    bg: {
      mode: cell.isBgRGB() ? "rgb" : cell.isBgPalette() ? "palette" : "default",
      value: cell.isBgDefault() ? 0 : cell.getBgColor(),
    },
    bold: !!cell.isBold(),
    dim: !!cell.isDim(),
    italic: !!cell.isItalic(),
    underline: !!cell.isUnderline(),
    inverse: !!cell.isInverse(),
    invisible: !!cell.isInvisible(),
    strikethrough: !!cell.isStrikethrough(),
  };
}

function colorSgr(color: TuiColor, background: boolean): string[] {
  const { mode, value } = color;
  if (mode === "default") return [];
  const extended = background ? 48 : 38;
  if (mode === "rgb") {
    return [`${extended};2;${value >> 16 & 255};${value >> 8 & 255};${value & 255}`];
  }
  if (value < 8) return [String((background ? 40 : 30) + value)];
  if (value < 16) return [String((background ? 100 : 90) + value - 8)];
  return [`${extended};5;${value}`];
}

function styleSgr(cell: TuiCell): string {
  return [
    ...(cell.bold ? ["1"] : []),
    ...(cell.dim ? ["2"] : []),
    ...(cell.italic ? ["3"] : []),
    ...(cell.underline ? ["4"] : []),
    ...(cell.inverse ? ["7"] : []),
    ...(cell.invisible ? ["8"] : []),
    ...(cell.strikethrough ? ["9"] : []),
    ...colorSgr(cell.fg, false),
    ...colorSgr(cell.bg, true),
  ].join(";");
}

function capture(term: Terminal, sequence: number): TuiSnapshot {
  const buffer = term.buffer.active;
  const scratch = buffer.getNullCell();
  const lines: TuiSnapshot["lines"] = [];
  for (let y = 0; y < term.rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y);
    if (!line) throw new Error(`Missing TUI viewport row ${y}`);
    const cells: TuiCell[] = [];
    for (let x = 0; x < term.cols; x++) {
      const cell = line.getCell(x, scratch);
      if (!cell) throw new Error(`Missing TUI viewport cell ${x},${y}`);
      cells.push(readCell(cell));
    }
    lines.push({ wrapped: line.isWrapped, cells });
  }

  const textLines: string[] = [];
  let logicalLine = "";
  let ansi = "\x1b[0m";
  let style = "";
  for (let y = 0; y < lines.length; y++) {
    const { cells } = lines[y];
    const next = lines[y + 1];
    // A wide glyph that wraps early leaves one unused cell on the preceding
    // row. Keep it in the physical grid, but don't invent a space in joined text.
    const padding = next?.wrapped && next.cells[0].width === 2 &&
      cells[cells.length - 1].chars === "";
    logicalLine += cells
      .slice(0, padding ? -1 : undefined)
      .filter((cell) => cell.width !== 0)
      .map((cell) => cell.chars || " ")
      .join("");
    if (!next?.wrapped) {
      textLines.push(logicalLine.replace(/ +$/, ""));
      logicalLine = "";
    }
    if (y) ansi += "\r\n";
    for (const cell of cells) {
      if (cell.width === 0) continue;
      const nextStyle = styleSgr(cell);
      if (nextStyle !== style) {
        ansi += `\x1b[0m${nextStyle ? `\x1b[${nextStyle}m` : ""}`;
        style = nextStyle;
      }
      ansi += cell.chars || " ";
    }
  }
  while (textLines.length && textLines[textLines.length - 1] === "") textLines.pop();
  return {
    sequence,
    cols: term.cols,
    rows: term.rows,
    cursor: { x: buffer.cursorX, y: buffer.cursorY },
    buffer: buffer.type,
    text: textLines.join("\n"),
    ansi: `${ansi}\x1b[0m`,
    lines,
  };
}

const CURSOR_KEYS: Record<string, string> = {
  Up: "A", Down: "B", Right: "C", Left: "D", Home: "H", End: "F",
};
const TILDE_KEYS: Record<string, number> = {
  Insert: 2, IC: 2, Delete: 3, DC: 3,
  PageUp: 5, PPage: 5, PageDown: 6, NPage: 6,
  F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24,
};
const NAMED_KEYS: Record<string, string> = {
  Enter: "\r", Return: "\r", Space: " ", Tab: "\t",
  Escape: "\x1b", Esc: "\x1b", BSpace: "\x7f", Backspace: "\x7f",
};

function encodeKeys(keys: string, applicationCursor: boolean): string {
  let key = keys;
  let shift = false;
  let alt = false;
  let ctrl = false;
  // tmux-style modifiers, with Ctrl/Alt/Shift aliases for direct API callers.
  for (;;) {
    const match = /^(C|Ctrl|M|A|Alt|S|Shift)-(.+)$/.exec(key);
    if (!match) break;
    if (match[1] === "C" || match[1] === "Ctrl") ctrl = true;
    else if (match[1] === "S" || match[1] === "Shift") shift = true;
    else alt = true;
    key = match[2];
  }
  const modifier = 1 + Number(shift) + 2 * Number(alt) + 4 * Number(ctrl);
  if (Object.hasOwn(CURSOR_KEYS, key)) {
    const final = CURSOR_KEYS[key];
    return modifier > 1 ? `\x1b[1;${modifier}${final}` :
      `\x1b${applicationCursor ? "O" : "["}${final}`;
  }
  if (/^F[1-4]$/.test(key)) {
    const final = "PQRS"[Number(key.slice(1)) - 1];
    return modifier > 1 ? `\x1b[1;${modifier}${final}` : `\x1bO${final}`;
  }
  if (Object.hasOwn(TILDE_KEYS, key)) {
    return `\x1b[${TILDE_KEYS[key]}${modifier > 1 ? `;${modifier}` : ""}~`;
  }
  if ((key === "Tab" && shift && !ctrl) || key === "BTab") {
    return `${alt ? "\x1b" : ""}\x1b[Z`;
  }
  let data = Object.hasOwn(NAMED_KEYS, key) ? NAMED_KEYS[key] : key;
  if (ctrl) {
    if (data === " " || data === "2") data = "\0";
    else if (data === "\x7f") data = "\x08";
    else if (data === "8" || data === "?") data = "\x7f";
    else if (/^[3-7]$/.test(data)) data = String.fromCharCode(Number(data) + 24);
    else if (data.length === 1 &&
      data.toUpperCase().charCodeAt(0) >= 64 && data.toUpperCase().charCodeAt(0) <= 95) {
      data = String.fromCharCode(data.toUpperCase().charCodeAt(0) & 31);
    } else return keys; // Unknown names retain the existing literal fallback.
  } else if (shift && data.length === 1) {
    data = data.toUpperCase();
  }
  if (!Object.hasOwn(NAMED_KEYS, key) && key.length !== 1 && modifier > 1) return keys;
  return `${alt ? "\x1b" : ""}${data}`;
}

export async function createTuiScreen(
  cols: number,
  rows: number,
  onInput: (data: string | Uint8Array) => void,
): Promise<TuiScreen> {
  validateGeometry(cols, rows);
  // The installed 5.5 package is CJS; require avoids synthetic named-export
  // assumptions in Bun/Node ESM. Also tolerate an interop default wrapper.
  const module = createRequire(import.meta.url)("@xterm/headless") as {
    Terminal?: typeof Terminal;
    default?: { Terminal?: typeof Terminal };
  };
  const Constructor = module.Terminal ?? module.default?.Terminal;
  if (!Constructor) throw new Error("@xterm/headless does not export Terminal");
  const term = new Constructor({ cols, rows, allowProposedApi: true, scrollback: 0 });
  // xterm 5.5's byte decoder mistakes a saved 0x80 continuation byte for an
  // empty slot (it checks byte & 0x3f), dropping e.g. E2 80 | 94 ("—").
  // Decode incrementally before its public string API instead. Keep decoder
  // state across flush barriers; malformed UTF-8 is represented by U+FFFD.
  const decoder = new StringDecoder("utf8");
  let tail = Promise.resolve();
  let sequence = 0;
  let queuedBytes = 0;
  let queuedOperations = 0;
  let disposed = false;
  let failure: Error | undefined;
  let cancelWrite: ((error: Error) => void) | undefined;

  function assertOpen(): void {
    if (disposed) throw new Error("TUI screen is disposed");
    if (failure) throw failure;
  }
  function checkCapacity(bytes: number): void {
    assertOpen();
    if (queuedBytes + bytes > MAX_QUEUED_BYTES ||
      queuedOperations >= MAX_QUEUED_OPERATIONS) {
      throw new RangeError("TUI queue limit exceeded (8 MiB / 4096 operations); flush before retry");
    }
  }
  function enqueue<T>(operation: () => T | Promise<T>, bytes = 0): Promise<T> {
    checkCapacity(bytes);
    queuedBytes += bytes;
    queuedOperations++;
    const result = tail.then(() => {
      assertOpen();
      return operation();
    });
    // Observe failures even for the void write/keys/paste API. Later flush/read
    // calls surface the failure, and disposal can reject a pending parser write.
    tail = result.then(
      () => { queuedBytes -= bytes; queuedOperations--; },
      (error: unknown) => {
        queuedBytes -= bytes;
        queuedOperations--;
        failure ??= error instanceof Error ? error : new Error(String(error));
      },
    );
    return result;
  }
  function send(data: string | Uint8Array): void {
    if (disposed || failure) return;
    try {
      onInput(data);
    } catch (error) {
      // Don't throw through xterm's asynchronous parser event callback.
      failure = error instanceof Error ? error : new Error(String(error));
      cancelWrite?.(failure);
    }
  }
  const listeners = [
    term.onData(send),
    term.onBinary((data) => send(Uint8Array.from(data, (char) => char.charCodeAt(0) & 255))),
  ];

  return {
    write(bytes) {
      checkCapacity(bytes.byteLength);
      if (!bytes.byteLength) return;
      const owned = new Uint8Array(bytes); // Buffer.slice() would still share memory.
      void enqueue(() => new Promise<void>((resolve, reject) => {
        cancelWrite = reject;
        term.write(decoder.write(owned), () => {
          cancelWrite = undefined;
          if (failure) reject(failure);
          else { sequence++; resolve(); }
        });
      }), owned.byteLength);
    },
    async flush() {
      await tail;
      assertOpen();
    },
    async resize(nextCols, nextRows) {
      validateGeometry(nextCols, nextRows);
      await enqueue(() => { term.resize(nextCols, nextRows); sequence++; });
    },
    async snapshot() {
      return enqueue(() => capture(term, sequence));
    },
    keys(keys, literal, noEnter) {
      void enqueue(() => {
        const data = literal ? keys : encodeKeys(keys, term.modes.applicationCursorKeysMode);
        send(data + (noEnter ? "" : "\r"));
      }, keys.length * 2);
    },
    paste(text) {
      void enqueue(() => {
        const data = text.replace(/\r?\n/g, "\r");
        send(term.modes.bracketedPasteMode ? `\x1b[200~${data}\x1b[201~` : data);
      }, text.length * 2);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelWrite?.(new Error("TUI screen is disposed"));
      cancelWrite = undefined;
      for (const listener of listeners) listener.dispose();
      term.dispose();
    },
  };
}
