// Token-free calibration of the public driver commands, using real native PTYs.
import { setDefaultTimeout, afterAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import fs from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunSessionPaths, createBunBackend } from "../harness/tui-bun-backend.ts";
import { publishSupervisorStop } from "../harness/tui-bun-process.ts";
import { acquireNativeLock, getNativeProcessIdentity } from "../harness/tui-process-identity.ts";
import { ensurePrivateRoot, privateDirectoryIdentity, publishTuiRecord, readPrivateRecord } from "../harness/tui-record-file.ts";
import { physicalTuiText, type TuiSnapshot } from "../harness/tui-screen.ts";
import {
  LIVE_CLEANUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS,
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const PROGRAM_BACKSTOP_MS = NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS;

const supported = process.platform === "linux" || process.platform === "win32" || process.platform === "darwin";
const scratch = mkdtempSync(join(tmpdir(), "aidlc-tui-native-calibration-"));
const root = join(scratch, "private");
ensurePrivateRoot(root);
const driver = join(import.meta.dir, "../harness/tui-drive.ts");
const target = join(root, "terminal target.ts");
const env = { ...process.env, AIDLC_TUI_BACKEND: "bun", AIDLC_TUI_BUN_ROOT: root };
const sessions = new Set<string>();
writeFileSync(target, `
const label = process.argv[2];
if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.TERM !== "xterm-256color") process.exit(42);
process.stdin.setRawMode(true);
let input = Buffer.alloc(0);
function paint() {
  process.stdout._refreshSize?.();
  const cols = process.stdout.columns, rows = process.stdout.rows;
  process.stdout.write("\\x1b[2J\\x1b[HREADY " + label + " 界✓\\r\\n" +
    "INPUT " + input.toString("hex") + "\\r\\nSIZE " + cols + "x" + rows +
    "\\x1b[" + rows + ";1H\\x1b[32mSTATUS " + label + "\\x1b[0m");
}
process.stdin.on("data", (data) => {
  if (data.equals(Buffer.from("Q"))) {
    process.stdout.write("\\x1b[2J\\x1b[HFINAL " + label + " 界✓");
    process.exit(7);
  }
  input = Buffer.concat([input, data]); paint();
});
process.stdout.on("resize", paint);
process.stdout.write("\\x1b[?2004h");
paint();
setTimeout(() => process.exit(99), ${PROGRAM_BACKSTOP_MS});
`);

type Run = { code: number; stdout: string; stderr: string };
async function drive(args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<Run> {
  const child = Bun.spawn([process.execPath, driver, ...args], {
    env: { ...env, ...extraEnv }, stdout: "pipe", stderr: "pipe",
    timeout: args[0] === "kill" || args[0] === "wait-dead"
      ? NATIVE_FIXTURE_SETUP_TIMEOUT_MS
      : remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS),
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

async function ok(args: string[]): Promise<string> {
  const result = await drive(args);
  if (result.code !== 0) throw new Error(`${args[0]} failed (${result.code}): ${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

async function start(label: string = randomUUID(), session = `native-${randomUUID()}`): Promise<string> {
  sessions.add(session);
  await ok(["start", "--session", session, "--cwd", root, "--width", "80", "--height", "16",
    "--", process.execPath, target, label]);
  await ok(["wait", "--session", session, "--pattern", `READY ${label}`, "--stable-ms", "0", "--timeout-ms", String(NATIVE_STARTUP_TIMEOUT_MS)]);
  return session;
}

async function stop(session: string): Promise<void> {
  await ok(["kill", "--session", session]);
  await ok(["wait-dead", "--session", session, "--timeout-ms", String(NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS)]);
  sessions.delete(session);
}

async function frame(session: string): Promise<TuiSnapshot> {
  return JSON.parse(await ok(["capture", "--session", session, "--json"])) as TuiSnapshot;
}

async function inputMatches(session: string, hex: string): Promise<void> {
  await ok(["wait", "--session", session, "--pattern", `INPUT ${hex}`, "--stable-ms", "0", "--timeout-ms", String(NATIVE_STARTUP_TIMEOUT_MS)]);
}

function record(session: string) {
  return JSON.parse(readFileSync(bunSessionPaths(session, env).record, "utf8"));
}

async function request(session: string, body: string, options: {
  allowReset?: boolean;
  label?: string;
  openSocket?: () => Socket;
} = {}): Promise<string> {
  return new Promise((accept, reject) => {
    const socket = options.openSocket?.() ?? connect(record(session).endpoint);
    let response = "";
    let offset = 0;
    let completedWrites = 0;
    let settled = false;
    let fragmentTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(fragmentTimer);
      socket.destroy();
      if (error) reject(error);
      else accept(response);
    };
    const deadline = setTimeout(() => finish(new Error(
      `probe IPC timed out (${options.label ?? "request"}; sent=${offset}/${body.length}; ` +
      `completedWrites=${completedWrites}; received=${response.length}; readableEnded=${socket.readableEnded})`,
    )), remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS));
    const onError = (error: NodeJS.ErrnoException) => {
      if (options.allowReset && response === "" && ["ECONNRESET", "EPIPE"].includes(error.code ?? "")) finish();
      else finish(error);
    };
    socket.setEncoding("utf8");
    socket.on("error", onError);
    socket.on("data", (data) => {
      response += data;
      // The protocol completes a reply at its newline, independently of socket teardown.
      if (response.includes("\n")) finish();
    });
    const receiveClosed = () => finish(
      options.allowReset && response === ""
        ? undefined
        : new Error(`probe IPC closed before a complete reply (${options.label ?? "request"})`),
    );
    // A rejecting peer can send EOF while our final fragment's write callback
    // is still pending. Waiting for local writable teardown can then time out.
    socket.on("end", receiveClosed);
    socket.on("close", receiveClosed);
    socket.on("connect", () => {
      const size = Math.max(1, Math.min(Math.floor(body.length / 2), 16 * 1024));
      const writeFragment = () => {
        if (settled) return;
        const fragment = body.slice(offset, offset + size);
        offset += fragment.length;
        // Bound queued output so a peer rejecting a large request can close promptly.
        socket.write(fragment, (error) => {
          completedWrites++;
          if (error) onError(error);
          else if (!settled && offset < body.length) fragmentTimer = setTimeout(writeFragment, 10);
        });
      };
      writeFragment();
    });
  });
}

afterAll(async () => {
  // Retain records and the fixture when cleanup fails; they are the evidence.
  const cleanup = await Promise.allSettled([...sessions].map(stop));
  const failed = cleanup.filter((result) => result.status === "rejected");
  if (failed.length) throw new Error(`native calibration cleanup failed; inspect ${root}: ${JSON.stringify(failed)}`);
  rmSync(scratch, { recursive: true, force: true });
}, LIVE_CLEANUP_TIMEOUT_MS);

describe("native IPC probe completion", () => {
  for (const allowReset of [true, false]) {
    test(`peer EOF settles a pending write for ${allowReset ? "oversized rejection" : "incomplete reply"}`, async () => {
      let pendingWrite = false;
      let closed = false;
      class EofSocket extends EventEmitter {
        readableEnded = false;
        setEncoding() { return this; }
        write(_fragment: string, _callback: unknown) {
          pendingWrite = true;
          // Model peer EOF while the final local write callback cannot
          // complete. Receiving EOF must settle independently of that callback.
          queueMicrotask(() => { this.readableEnded = true; this.emit("end"); });
          return false;
        }
        destroy() { closed = true; this.emit("close"); return this; }
      }
      const socket = new EofSocket();
      const result = request("synthetic-peer", "x".repeat(300_000), {
        allowReset, label: "pending-write EOF",
        openSocket: () => {
          queueMicrotask(() => socket.emit("connect"));
          return socket as unknown as Socket;
        },
      });
      if (allowReset) expect(await result).toBe("");
      else await expect(result).rejects.toThrow("closed before a complete reply");
      expect(pendingWrite).toBe(true);
      expect(closed).toBe(true);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }
});

describe.skipIf(!supported)("native launch namespace security", () => {
  test("an explicit root symlink/junction is refused without touching its target", async () => {
    const temp = mkdtempSync(join(root, "linked-root-"));
    const destination = join(temp, "destination");
    ensurePrivateRoot(destination);
    const alias = join(temp, "alias");
    symlinkSync(destination, alias, process.platform === "win32" ? "junction" : "dir");
    const result = await drive(["start", "--session", "refuse-linked-root", "--cwd", root,
      "--", process.execPath, "-e", "process.exit(0)"], { AIDLC_TUI_BUN_ROOT: alias });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("symlink/reparse");
    expect(readdirSync(destination)).toEqual([]);
  });

  for (const replaced of ["session", "parent"]) {
    test(`daemon refuses a replaced ${replaced} before PTY/supervisor creation`, async () => {
      const privateRoot = join(root, `replacement-${randomUUID()}`);
      ensurePrivateRoot(privateRoot);
      const childEnv = { ...env, AIDLC_TUI_BUN_ROOT: privateRoot };
      const session = `replaced-${randomUUID()}`;
      const paths = bunSessionPaths(session, childEnv);
      ensurePrivateRoot(paths.directory);
      const directoryIdentity = privateDirectoryIdentity(paths.directory);
      const marker = join(root, `${session}-executed`);
      const record = {
        schema: 1, backend: "bun", session, token: randomUUID(), generation: randomUUID(), endpoint: paths.endpoint,
        rootIdentity: privateDirectoryIdentity(privateRoot), directoryIdentity,
        phase: "starting", cwd: root, fixtureCwd: null, width: 80, height: 16,
        command: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed')`],
      };
      publishTuiRecord(paths.record, record, directoryIdentity);
      renameSync(replaced === "parent" ? privateRoot : paths.directory,
        `${replaced === "parent" ? privateRoot : paths.directory}-old`);
      if (replaced === "parent") ensurePrivateRoot(privateRoot);
      ensurePrivateRoot(paths.directory);
      publishTuiRecord(paths.record, record, privateDirectoryIdentity(paths.directory));
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "../harness/tui-bun-backend.ts"), "--daemon", paths.directory, record.generation], {
        env: childEnv, stdout: "pipe", stderr: "pipe", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(code).not.toBe(0);
      expect(stderr).toContain("directory identity mismatch");
      expect(existsSync(paths.status)).toBe(false);
      expect(existsSync(join(paths.directory, "supervisor-config.json"))).toBe(false);
      expect(existsSync(marker)).toBe(false);
      expect(JSON.parse(readFileSync(paths.record, "utf8"))).toMatchObject({ phase: "error", cleanupComplete: true });
    });
  }

});

describe.skipIf(!supported)("native record publication races", () => {
  function fixture() {
    const parent = join(root, `record-race-${randomUUID()}`);
    const directory = join(parent, "session");
    ensurePrivateRoot(parent);
    ensurePrivateRoot(directory);
    const directoryIdentity = privateDirectoryIdentity(directory);
    const file = join(directory, "session.json");
    const value = { directoryIdentity, token: randomUUID(), phase: "starting" };
    publishTuiRecord(file, value, directoryIdentity);
    return { parent, directory, directoryIdentity, file, value };
  }

  test("a reader retries atomic publications and returns only a fully validated record", () => {
    const f = fixture();
    const open = fs.openSync;
    let attempts = 0;
    const hook = spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
      if (String(path) === f.file && ++attempts <= 2) {
        publishTuiRecord(f.file, { ...f.value, phase: `update-${attempts}` }, f.directoryIdentity);
      }
      return open(path, flags, mode);
    });
    try {
      expect(readPrivateRecord<typeof f.value>(f.directory, f.file)).toEqual({ ...f.value, phase: "update-2" });
      expect(attempts).toBe(3);
    } finally { hook.mockRestore(); }
  });

  test("continuous replacement is bounded and closes every discarded descriptor", () => {
    const f = fixture();
    const open = fs.openSync;
    const close = fs.closeSync;
    const pending = new Set<number>();
    let attempts = 0;
    const opener = spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
      const reading = String(path) === f.file;
      if (reading) publishTuiRecord(f.file, { ...f.value, update: ++attempts }, f.directoryIdentity);
      const fd = open(path, flags, mode);
      if (reading) pending.add(fd);
      return fd;
    });
    const closer = spyOn(fs, "closeSync").mockImplementation((fd) => {
      close(fd);
      pending.delete(fd);
    });
    try {
      expect(() => readPrivateRecord(f.directory, f.file)).toThrow("record identity changed while opening");
      expect(attempts).toBe(3);
      expect(pending.size).toBe(0);
    } finally { opener.mockRestore(); closer.mockRestore(); }
  });

  for (const replaced of ["session", "parent"]) {
    test(`a retry cannot adopt a replaced ${replaced} directory`, () => {
      const f = fixture();
      const open = fs.openSync;
      let attempts = 0;
      const hook = spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
        if (String(path) === f.file && ++attempts === 1) {
          const moved = replaced === "parent" ? f.parent : f.directory;
          renameSync(moved, `${moved}-old`);
          if (replaced === "parent") ensurePrivateRoot(f.parent);
          ensurePrivateRoot(f.directory);
          const replacement = privateDirectoryIdentity(f.directory);
          publishTuiRecord(f.file, { ...f.value, directoryIdentity: replacement }, replacement);
        }
        return open(path, flags, mode);
      });
      try {
        expect(() => readPrivateRecord(f.directory, f.file)).toThrow("directory identity mismatch");
        expect(attempts).toBe(1);
      } finally { hook.mockRestore(); }
    });
  }

  test("a replacement still needs the pinned directory identity in its content", () => {
    const f = fixture();
    const open = fs.openSync;
    let attempts = 0;
    const hook = spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
      if (String(path) === f.file && ++attempts === 1) {
        publishTuiRecord(f.file, { ...f.value, directoryIdentity: { dev: "other", ino: "other" } }, f.directoryIdentity);
      }
      return open(path, flags, mode);
    });
    try {
      expect(() => readPrivateRecord(f.directory, f.file)).toThrow("directory identity mismatch");
      expect(attempts).toBe(2);
    } finally { hook.mockRestore(); }
  });

  test("open failures propagate immediately without retrying or consuming record content", () => {
    const f = fixture();
    const open = fs.openSync;
    const failure = Object.assign(new Error("record access denied"), { code: "EACCES" });
    let attempts = 0;
    const hook = spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
      if (String(path) === f.file) { attempts++; throw failure; }
      return open(path, flags, mode);
    });
    try {
      expect(() => readPrivateRecord(f.directory, f.file)).toThrow(failure);
      expect(attempts).toBe(1);
    } finally { hook.mockRestore(); }
  });
});

describe.skipIf(!supported)("native Bun terminal driver commands", () => {
  test("wrap-spanning wait patterns keep logical compatibility and both views share one snapshot", async () => {
    const session = `wrapped-${randomUUID()}`;
    const program = join(root, `${session}.ts`);
    writeFileSync(program, `
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write("\\x1b[2J\\x1b[Habcdefghijklmnop");
process.stdin.on("data", () => process.stdout.write("\\x1b[2J\\x1b[Hqrstuvwxyzabcdef"));
setTimeout(() => process.exit(99), ${PROGRAM_BACKSTOP_MS});
`);
    sessions.add(session);
    const previousRoot = process.env.AIDLC_TUI_BUN_ROOT;
    try {
      await ok(["start", "--session", session, "--cwd", root, "--width", "12", "--height", "8",
        "--", process.execPath, program]);
      await ok(["wait", "--session", session, "--pattern", "abcdefghijklmnop", "--stable-ms", "100", "--timeout-ms", String(NATIVE_STARTUP_TIMEOUT_MS)]);
      await ok(["wait", "--session", session, "--pattern", "\\nmnop", "--stable-ms", "0", "--timeout-ms", String(NATIVE_STARTUP_TIMEOUT_MS)]);
      await ok(["startup", "--session", session, "--ready-pattern", "abcdefghijklmnop", "--timeout-ms", String(NATIVE_STARTUP_TIMEOUT_MS)]);
      await ok(["wait", "--session", session, "--pattern", "abcdefghijklmnop", "--view", "logical", "--stable-ms", "0", "--timeout-ms", String(NATIVE_STARTUP_TIMEOUT_MS)]);
      await ok(["wait", "--session", session, "--pattern", "\\nmnop", "--view", "physical", "--stable-ms", "0", "--timeout-ms", String(NATIVE_STARTUP_TIMEOUT_MS)]);
      const wrongView = await drive(["wait", "--session", session, "--pattern", "abcdefghijklmnop",
        "--view", "physical", "--stable-ms", "0", "--timeout-ms", "250"]);
      expect(wrongView.code).toBe(1);
      expect(wrongView.stderr).toContain("timed out");
      const wrongLogicalView = await drive(["wait", "--session", session, "--pattern", "\\nmnop",
        "--view", "logical", "--stable-ms", "0", "--timeout-ms", "250"]);
      expect(wrongLogicalView.code).toBe(1);
      const notEmpty = await drive(["startup", "--session", session, "--ready-pattern", "^$", "--timeout-ms", "250"]);
      expect(notEmpty.code).toBe(1);
      const invalid = await drive(["wait", "--session", session, "--pattern", "abc", "--view", "unknown"]);
      expect(invalid.code).toBe(2);
      expect(invalid.stderr).toContain("--view requires");
      const first = await frame(session);
      expect(first.text).toBe("abcdefghijklmnop");
      expect(physicalTuiText(first)).toBe("abcdefghijkl\nmnop");
      await ok(["send", "--session", session, "--keys", "x", "--literal", "--no-enter"]);
      await ok(["wait", "--session", session, "--pattern", "qrstuvwxyzabcdef", "--stable-ms", "0", "--timeout-ms", String(NATIVE_STARTUP_TIMEOUT_MS)]);
      const second = await frame(session);
      // The transport can deliver a different real frame on each call. A
      // physical read followed by a logical read would mix these observations.
      let reads = 0;
      process.env.AIDLC_TUI_BUN_ROOT = root;
      const backend = createBunBackend({ fixtureCwd: () => null }, async (_owner, method) => {
        expect(method).toBe("capture");
        return reads++ === 0 ? first : second;
      });
      expect(await backend.captureViews(session)).toEqual({
        physical: physicalTuiText(first), logical: first.text,
      });
      expect(reads).toBe(1);
    } finally {
      if (previousRoot === undefined) delete process.env.AIDLC_TUI_BUN_ROOT;
      else process.env.AIDLC_TUI_BUN_ROOT = previousRoot;
      if (sessions.has(session)) await stop(session);
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("physical repaint rows drive wait, startup and approval while public logical capture stays compatible", async () => {
    const session = `physical-${randomUUID()}`;
    const approved = join(root, `${session}-approved`);
    const unexpected = join(root, `${session}-unexpected`);
    const trace = join(process.env.AIDLC_TEST_LOG_DIR ?? root, `${session}.ndjson`);
    const program = join(root, `${session}.ts`);
    // The labels are from R32 Windows t50's retained visible approval frame.
    // Initial wrapping + cursor-addressed row replacement creates real stale
    // wrap metadata in the emulator; no internal xterm properties are assigned.
    writeFileSync(program, `
import { writeFileSync } from "node:fs";
process.stdin.setRawMode(true);
process.stdin.resume();
const esc = String.fromCharCode(27);
let state = "stale";
const stale = ["Earlier output mentioned ❯ 1. Approve", "Enter to select · old footer", "GRID_READY"];
const menu = ["─".repeat(120), " ☐ Approve RE", "",
  "│ The code knowledge base is ready. Approve it and continue to Requirements Analysis, or request changes?", "",
  "❯ 1. Approve", "     Accept the knowledge base and continue to Requirements Analysis.",
  "  2. Request Changes", "  3. Type something.", "  4. Chat about this",
  "Enter to select · ↑/↓ to navigate · Esc to cancel"];
function paint(rows) {
  for (let row=0; row<14; row++) process.stdout.write(esc+"["+(row+1)+";1H"+(rows[row]??"").padEnd(120));
}
process.stdout.write("old wrapped output ".repeat(90));
paint(stale);
process.stdin.on("data", bytes => {
  for (const byte of bytes) {
    if (byte === 112 || byte === 114) { state="menu"; paint(menu); }
    else if (byte === 115) { state="stale"; paint(stale); }
    else if (byte === 13 && state === "menu") {
      state="accepted";
      writeFileSync(${JSON.stringify(approved)}, "menu:Enter");
      paint(["Current result", "MENU_ACCEPTED"]);
    } else {
      writeFileSync(${JSON.stringify(unexpected)}, state+":"+byte);
    }
  }
});
setTimeout(() => process.exit(99), ${PROGRAM_BACKSTOP_MS});
`);
    sessions.add(session);
    let answering: Promise<Run> | undefined;
    try {
      await ok(["start", "--session", session, "--cwd", root, "--width", "120", "--height", "14",
        "--", process.execPath, program]);
      await ok(["startup", "--session", session, "--ready-pattern", "\\nGRID_READY", "--timeout-ms", String(NATIVE_STARTUP_TIMEOUT_MS)]);
      await ok(["send", "--session", session, "--keys", "p", "--literal", "--no-enter"]);
      await ok(["wait", "--session", session, "--pattern", "\\n❯ 1\\. Approve", "--stable-ms", "0", "--timeout-ms", String(NATIVE_STARTUP_TIMEOUT_MS)]);
      const snapshot = await frame(session);
      expect(await ok(["capture", "--session", session])).toBe(snapshot.text);
      expect(await ok(["capture", "--session", session, "--physical"])).toBe(physicalTuiText(snapshot));
      expect(await ok(["capture", "--session", session, "--ansi"])).toBe(snapshot.ansi);
      expect(physicalTuiText(snapshot)).toContain("\n❯ 1. Approve\n");
      const conflicting = await drive(["capture", "--session", session, "--physical", "--json"]);
      expect(conflicting.code).not.toBe(0);
      expect(conflicting.stderr).toContain("--physical selects plain text");
      await ok(["send", "--session", session, "--keys", "s", "--literal", "--no-enter"]);
      await ok(["wait", "--session", session, "--pattern", "\\nGRID_READY", "--stable-ms", "0", "--timeout-ms", String(NATIVE_STARTUP_TIMEOUT_MS)]);
      answering = drive(["answer-gate", "--session", session, "--project-dir", root,
        "--until-file", approved, "--overall-timeout-ms", String(NATIVE_STARTUP_TIMEOUT_MS), "--per-gate-timeout-ms", String(NATIVE_STARTUP_TIMEOUT_MS)], {
        AIDLC_TUI_TRACE_FILE: trace,
      });
      // Observe a real poll of the stale screen before allowing the live menu.
      const deadline = Date.now() + remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS)!;
      let observedStale = false;
      while (Date.now() < deadline && !observedStale) {
        if (existsSync(trace)) {
          observedStale = readFileSync(trace, "utf8").split("\n").filter(Boolean).some((line) => {
            const event = JSON.parse(line);
            return event.event === "answer_gate_poll" && event.hasMenu === false &&
              event.screen.includes("Earlier output mentioned ❯ 1. Approve");
          });
        }
        if (!observedStale) await Bun.sleep(20);
      }
      expect(observedStale).toBe(true);
      expect(existsSync(approved)).toBe(false);
      expect(existsSync(unexpected)).toBe(false);
      await ok(["send", "--session", session, "--keys", "r", "--literal", "--no-enter"]);
      const result = await answering;
      expect(result.code, result.stderr).toBe(0);
      expect(readFileSync(approved, "utf8")).toBe("menu:Enter");
      expect(existsSync(unexpected)).toBe(false);
      await ok(["wait", "--session", session, "--pattern", "\\nMENU_ACCEPTED", "--stable-ms", "0", "--timeout-ms", String(NATIVE_STARTUP_TIMEOUT_MS)]);
      await stop(session);
      const final = await frame(session);
      expect(await ok(["capture", "--session", session])).toBe(final.text);
      expect(await ok(["capture", "--session", session, "--physical"])).toBe(physicalTuiText(final));
      expect(physicalTuiText(final)).not.toContain("Request Changes");
    } finally {
      if (sessions.has(session)) await stop(session);
      await answering;
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("plain/ANSI/cell capture, literal/named input, bracketed paste, and real resize", async () => {
    const session = await start("interaction");
    try {
      let snapshot = await frame(session);
      expect(snapshot.cols).toBe(80);
      expect(snapshot.rows).toBe(16);
      expect(snapshot.lines[15].cells[0].fg).toEqual({ mode: "palette", value: 2 });
      expect(snapshot.text).toContain("READY interaction 界✓");
      expect(await ok(["capture", "--session", session, "--ansi"])).toContain("\x1b[32m");
      await ok(["send", "--session", session, "--keys", "abc", "--literal", "--no-enter"]);
      await inputMatches(session, "616263");
      await ok(["send", "--session", session, "--keys", "Down", "--no-enter"]);
      await inputMatches(session, "6162631b5b42");
      await ok(["send", "--session", session, "--keys", "C-c", "--no-enter"]);
      await inputMatches(session, "6162631b5b4203");
      await ok(["paste", "--session", session, "--text", "x\ny"]);
      await inputMatches(session, "6162631b5b42031b5b3230307e780d791b5b3230317e");
      await ok(["resize", "--session", session, "--width", "100", "--height", "20"]);
      // Input causes an application repaint even when its cached Windows stdout
      // dimensions have not refreshed through a resize event yet.
      await ok(["send", "--session", session, "--keys", "z", "--literal", "--no-enter"]);
      await ok(["wait", "--session", session, "--pattern", "SIZE 100x20", "--stable-ms", "0", "--timeout-ms", String(NATIVE_STARTUP_TIMEOUT_MS)]);
      snapshot = await frame(session);
      expect(snapshot.cols).toBe(100);
      expect(snapshot.rows).toBe(20);
      expect(snapshot.lines[19].cells.slice(0, 6).map((cell) => cell.chars).join("")).toBe("STATUS");
    } finally { await stop(session); }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("eight concurrent sessions isolate their screens, input, and teardown", async () => {
    const labels = Array.from({ length: 8 }, (_, i) => `worker-${i}-${randomUUID().slice(0, 8)}`);
    const started = await Promise.all(labels.map((label) => start(label)));
    try {
      await Promise.all(started.map(async (session, i) => {
        await ok(["send", "--session", session, "--keys", labels[i], "--literal", "--no-enter"]);
        await inputMatches(session, Buffer.from(labels[i]).toString("hex"));
        const snapshot = await frame(session);
        expect(snapshot.text).toContain(labels[i]);
        for (const label of labels.filter((_, j) => i !== j)) expect(snapshot.text).not.toContain(label);
      }));
      await stop(started[0]);
      for (const session of started.slice(1)) expect((await frame(session)).text).toContain("STATUS");
    } finally { await Promise.all(started.filter((session) => sessions.has(session)).map(stop)); }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("natural exit drains final UTF-8, preserves the target exit code, and permits same-name restart", async () => {
    const session = `restart-${randomUUID()}`;
    for (let i = 0; i < 3; i++) {
      await start(`generation-${i}`, session);
      await ok(["send", "--session", session, "--keys", "Q", "--literal", "--no-enter"]);
      await ok(["wait-dead", "--session", session, "--timeout-ms", String(NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS)]);
      expect((await frame(session)).text).toBe(`FINAL generation-${i} 界✓`);
      expect(record(session)).toMatchObject({ phase: "exited", targetExitCode: 7, cleanupComplete: true });
    }
    await stop(session);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("a delayed old-generation kill fallback cannot stop or overwrite a replacement's stop", async () => {
    const session = await start("old-generation");
    const old = record(session);
    const paths = bunSessionPaths(session, env);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const previousRoot = process.env.AIDLC_TUI_BUN_ROOT;
    // Inject only the pending transport outcome, after kill has captured the
    // real generation. The replacement still uses the full public native CLI.
    process.env.AIDLC_TUI_BUN_ROOT = root;
    const backend = createBunBackend({ fixtureCwd: () => null }, async (owner, method) => {
      expect(owner.token).toBe(old.token);
      expect(method).toBe("kill");
      entered.resolve();
      await release.promise;
      throw new Error("old transport closed after retirement");
    });
    const pending = backend.kill(session);
    const failed = pending.then(() => undefined, (error: unknown) => error);
    try {
      await Promise.race([
        entered.promise,
        failed.then((error) => { throw error ?? new Error("kill never entered the transport"); }),
      ]);
      await start("replacement-generation", session);
      const replacement = record(session);
      expect(replacement.token).not.toBe(old.token);
      release.resolve();
      expect(String(await failed)).toContain("old transport closed");
      await Bun.sleep(150); // Several supervisor polls must observe and ignore the stale request.
      expect((await frame(session)).text).toContain("READY replacement-generation");
      expect(record(session).cleanupComplete).not.toBe(true);
      const requests = () => readdirSync(paths.stop).map((file) =>
        JSON.parse(readFileSync(join(paths.stop, file), "utf8")));
      expect(requests().map((value) => value.token)).toEqual([old.token]);
      const fresh = { token: replacement.token, requestId: randomUUID() };
      publishSupervisorStop(paths.stop, fresh);
      publishSupervisorStop(paths.stop, { token: old.token, requestId: randomUUID() });
      expect(requests()).toContainEqual(fresh); // Old publication cannot erase the new request.
      await ok(["wait-dead", "--session", session, "--timeout-ms", String(NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS)]);
      expect(record(session)).toMatchObject({ token: replacement.token, cleanupComplete: true });
    } finally {
      release.resolve();
      await failed;
      if (previousRoot === undefined) delete process.env.AIDLC_TUI_BUN_ROOT;
      else process.env.AIDLC_TUI_BUN_ROOT = previousRoot;
      await stop(session);
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("kill completes while its caller already holds the native session lock", async () => {
    const session = await start("caller-owned-lock");
    const unlock = await acquireNativeLock(`${bunSessionPaths(session, env).directory}.lock`);
    try {
      await stop(session);
      expect(record(session).cleanupComplete).toBe(true);
    } finally {
      unlock();
      if (sessions.has(session)) await stop(session);
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("framed IPC accepts fragmented requests and refuses invalid ownership, malformed and oversized messages", async () => {
    const session = await start("protocol");
    try {
      const { token } = record(session);
      const reply = JSON.parse(await request(session, `${JSON.stringify({ id: "fragmented", token, method: "capture" })}\n`, { label: "fragmented capture" }));
      expect(reply).toMatchObject({ id: "fragmented", ok: true });
      expect(reply.result.text).toContain("READY protocol");
      const refused = JSON.parse(await request(session, `${JSON.stringify({ id: "wrong", token: randomUUID(), method: "kill" })}\n`, { label: "wrong ownership" }));
      expect(refused.ok).toBe(false);
      expect(refused.error).toContain("ownership");
      expect(JSON.parse(await request(session, "{malformed}\n", { label: "malformed JSON" })).ok).toBe(false);
      expect(await request(session, `${"x".repeat(300_000)}\n`, { allowReset: true, label: "oversized request" })).toBe("");
      expect((await frame(session)).text).toContain("READY protocol");
      const invalidResize = await drive(["resize", "--session", session, "--width", "1", "--height", "20"]);
      expect(invalidResize.code).not.toBe(0);
      expect((await frame(session)).cols).toBe(80);
    } finally { await stop(session); }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("failed target launch leaves a cleaned record and allows a same-name retry", async () => {
    const session = `bad-command-${randomUUID()}`;
    sessions.add(session);
    const result = await drive(["start", "--session", session, "--cwd", root,
      "--", join(root, `missing-executable-${randomUUID()}`)]);
    expect(result.code).not.toBe(0);
    await ok(["wait-dead", "--session", session, "--timeout-ms", String(NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS)]);
    expect(record(session)).toMatchObject({ phase: "error", cleanupComplete: true });
    expect((await drive(["capture", "--session", session])).code).not.toBe(0);
    await start("after-failed-launch", session);
    await stop(session);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("an unfinished client cannot delay daemon retirement or produce a premature wait-dead", async () => {
    const session = await start("open-client");
    const owner = record(session);
    const socket = connect(owner.endpoint);
    socket.on("error", () => {});
    await new Promise<void>((accept) => socket.once("connect", accept));
    socket.write("{");
    const trickle = setInterval(() => socket.write(" "), 20);
    try {
      await stop(session);
      // Query the OS independently of the driver's cleanupComplete record.
      expect(await getNativeProcessIdentity(owner.daemonPid)).not.toBe(owner.daemonIdentity);
    } finally {
      clearInterval(trickle);
      socket.destroy();
      if (sessions.has(session)) await stop(session);
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});
