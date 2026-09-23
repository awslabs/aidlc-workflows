// Token-free calibration of the public driver commands, using real native PTYs.
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunSessionPaths, createBunBackend } from "../harness/tui-bun-backend.ts";
import { publishSupervisorStop } from "../harness/tui-bun-process.ts";
import { acquireNativeLock, getNativeProcessIdentity } from "../harness/tui-process-identity.ts";
import { ensurePrivateRoot, privateDirectoryIdentity, publishTuiRecord } from "../harness/tui-record-file.ts";
import { physicalTuiText, type TuiSnapshot } from "../harness/tui-screen.ts";

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
`);

type Run = { code: number; stdout: string; stderr: string };
async function drive(args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<Run> {
  const child = Bun.spawn([process.execPath, driver, ...args], {
    env: { ...env, ...extraEnv }, stdout: "pipe", stderr: "pipe", timeout: 20_000,
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
  await ok(["wait", "--session", session, "--pattern", `READY ${label}`, "--stable-ms", "0", "--timeout-ms", "5000"]);
  return session;
}

async function stop(session: string): Promise<void> {
  await ok(["kill", "--session", session]);
  await ok(["wait-dead", "--session", session, "--timeout-ms", "5000"]);
  sessions.delete(session);
}

async function frame(session: string): Promise<TuiSnapshot> {
  return JSON.parse(await ok(["capture", "--session", session, "--json"])) as TuiSnapshot;
}

async function inputMatches(session: string, hex: string): Promise<void> {
  await ok(["wait", "--session", session, "--pattern", `INPUT ${hex}`, "--stable-ms", "0", "--timeout-ms", "5000"]);
}

function record(session: string) {
  return JSON.parse(readFileSync(bunSessionPaths(session, env).record, "utf8"));
}

async function request(session: string, body: string): Promise<string> {
  return new Promise((accept, reject) => {
    const socket = connect(record(session).endpoint);
    let response = "";
    socket.setEncoding("utf8");
    socket.setTimeout(5000, () => { socket.destroy(); reject(new Error("probe IPC timed out")); });
    socket.on("error", reject);
    socket.on("data", (data) => { response += data; });
    socket.on("close", () => accept(response));
    socket.on("connect", () => {
      const split = Math.floor(body.length / 2);
      socket.write(body.slice(0, split));
      setTimeout(() => socket.write(body.slice(split)), 10);
    });
  });
}

afterAll(async () => {
  // Retain records and the fixture when cleanup fails; they are the evidence.
  const cleanup = await Promise.allSettled([...sessions].map(stop));
  const failed = cleanup.filter((result) => result.status === "rejected");
  if (failed.length) throw new Error(`native calibration cleanup failed; inspect ${root}: ${JSON.stringify(failed)}`);
  rmSync(scratch, { recursive: true, force: true });
}, 30_000);

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

  test.each(["session", "parent"])("daemon refuses a replaced %s before PTY/supervisor creation", async (replaced) => {
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
      env: childEnv, stdout: "pipe", stderr: "pipe", timeout: 5000,
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("directory identity mismatch");
    expect(existsSync(paths.status)).toBe(false);
    expect(existsSync(join(paths.directory, "supervisor-config.json"))).toBe(false);
    expect(existsSync(marker)).toBe(false);
    expect(JSON.parse(readFileSync(paths.record, "utf8"))).toMatchObject({ phase: "error", cleanupComplete: true });
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
setTimeout(() => process.exit(99), 30000);
`);
    sessions.add(session);
    const previousRoot = process.env.AIDLC_TUI_BUN_ROOT;
    try {
      await ok(["start", "--session", session, "--cwd", root, "--width", "12", "--height", "8",
        "--", process.execPath, program]);
      await ok(["wait", "--session", session, "--pattern", "abcdefghijklmnop", "--stable-ms", "100", "--timeout-ms", "5000"]);
      await ok(["wait", "--session", session, "--pattern", "\\nmnop", "--stable-ms", "0", "--timeout-ms", "5000"]);
      await ok(["startup", "--session", session, "--ready-pattern", "abcdefghijklmnop", "--timeout-ms", "5000"]);
      await ok(["wait", "--session", session, "--pattern", "abcdefghijklmnop", "--view", "logical", "--stable-ms", "0", "--timeout-ms", "5000"]);
      await ok(["wait", "--session", session, "--pattern", "\\nmnop", "--view", "physical", "--stable-ms", "0", "--timeout-ms", "5000"]);
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
      await ok(["wait", "--session", session, "--pattern", "qrstuvwxyzabcdef", "--stable-ms", "0", "--timeout-ms", "5000"]);
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
  }, 30_000);

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
setTimeout(() => process.exit(99), 30000);
`);
    sessions.add(session);
    let answering: Promise<Run> | undefined;
    try {
      await ok(["start", "--session", session, "--cwd", root, "--width", "120", "--height", "14",
        "--", process.execPath, program]);
      await ok(["startup", "--session", session, "--ready-pattern", "\\nGRID_READY", "--timeout-ms", "5000"]);
      await ok(["send", "--session", session, "--keys", "p", "--literal", "--no-enter"]);
      await ok(["wait", "--session", session, "--pattern", "\\n❯ 1\\. Approve", "--stable-ms", "0", "--timeout-ms", "5000"]);
      const snapshot = await frame(session);
      expect(await ok(["capture", "--session", session])).toBe(snapshot.text);
      expect(await ok(["capture", "--session", session, "--physical"])).toBe(physicalTuiText(snapshot));
      expect(await ok(["capture", "--session", session, "--ansi"])).toBe(snapshot.ansi);
      expect(physicalTuiText(snapshot)).toContain("\n❯ 1. Approve\n");
      const conflicting = await drive(["capture", "--session", session, "--physical", "--json"]);
      expect(conflicting.code).not.toBe(0);
      expect(conflicting.stderr).toContain("--physical selects plain text");
      await ok(["send", "--session", session, "--keys", "s", "--literal", "--no-enter"]);
      await ok(["wait", "--session", session, "--pattern", "\\nGRID_READY", "--stable-ms", "0", "--timeout-ms", "5000"]);
      answering = drive(["answer-gate", "--session", session, "--project-dir", root,
        "--until-file", approved, "--overall-timeout-ms", "5000", "--per-gate-timeout-ms", "5000"], {
        AIDLC_TUI_TRACE_FILE: trace,
      });
      // Observe a real poll of the stale screen before allowing the live menu.
      const deadline = Date.now() + 5000;
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
      await ok(["wait", "--session", session, "--pattern", "\\nMENU_ACCEPTED", "--stable-ms", "0", "--timeout-ms", "5000"]);
      await stop(session);
      const final = await frame(session);
      expect(await ok(["capture", "--session", session])).toBe(final.text);
      expect(await ok(["capture", "--session", session, "--physical"])).toBe(physicalTuiText(final));
      expect(physicalTuiText(final)).not.toContain("Request Changes");
    } finally {
      if (sessions.has(session)) await stop(session);
      await answering;
    }
  }, 30_000);

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
      await ok(["wait", "--session", session, "--pattern", "SIZE 100x20", "--stable-ms", "0", "--timeout-ms", "5000"]);
      snapshot = await frame(session);
      expect(snapshot.cols).toBe(100);
      expect(snapshot.rows).toBe(20);
      expect(snapshot.lines[19].cells.slice(0, 6).map((cell) => cell.chars).join("")).toBe("STATUS");
    } finally { await stop(session); }
  }, 30_000);

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
  }, 60_000);

  test("natural exit drains final UTF-8, preserves the target exit code, and permits same-name restart", async () => {
    const session = `restart-${randomUUID()}`;
    for (let i = 0; i < 3; i++) {
      await start(`generation-${i}`, session);
      await ok(["send", "--session", session, "--keys", "Q", "--literal", "--no-enter"]);
      await ok(["wait-dead", "--session", session, "--timeout-ms", "5000"]);
      expect((await frame(session)).text).toBe(`FINAL generation-${i} 界✓`);
      expect(record(session)).toMatchObject({ phase: "exited", targetExitCode: 7, cleanupComplete: true });
    }
    await stop(session);
  }, 30_000);

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
      await ok(["wait-dead", "--session", session, "--timeout-ms", "5000"]);
      expect(record(session)).toMatchObject({ token: replacement.token, cleanupComplete: true });
    } finally {
      release.resolve();
      await failed;
      if (previousRoot === undefined) delete process.env.AIDLC_TUI_BUN_ROOT;
      else process.env.AIDLC_TUI_BUN_ROOT = previousRoot;
      await stop(session);
    }
  }, 30_000);

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
  }, 20_000);

  test("framed IPC accepts fragmented requests and refuses invalid ownership, malformed and oversized messages", async () => {
    const session = await start("protocol");
    try {
      const { token } = record(session);
      const reply = JSON.parse(await request(session, `${JSON.stringify({ id: "fragmented", token, method: "capture" })}\n`));
      expect(reply).toMatchObject({ id: "fragmented", ok: true });
      expect(reply.result.text).toContain("READY protocol");
      const refused = JSON.parse(await request(session, `${JSON.stringify({ id: "wrong", token: randomUUID(), method: "kill" })}\n`));
      expect(refused.ok).toBe(false);
      expect(refused.error).toContain("ownership");
      expect(JSON.parse(await request(session, "{malformed}\n")).ok).toBe(false);
      expect(await request(session, `${"x".repeat(300_000)}\n`)).toBe("");
      expect((await frame(session)).text).toContain("READY protocol");
      const invalidResize = await drive(["resize", "--session", session, "--width", "1", "--height", "20"]);
      expect(invalidResize.code).not.toBe(0);
      expect((await frame(session)).cols).toBe(80);
    } finally { await stop(session); }
  }, 30_000);

  test("failed target launch leaves a cleaned record and allows a same-name retry", async () => {
    const session = `bad-command-${randomUUID()}`;
    sessions.add(session);
    const result = await drive(["start", "--session", session, "--cwd", root,
      "--", join(root, `missing-executable-${randomUUID()}`)]);
    expect(result.code).not.toBe(0);
    await ok(["wait-dead", "--session", session, "--timeout-ms", "5000"]);
    expect(record(session)).toMatchObject({ phase: "error", cleanupComplete: true });
    expect((await drive(["capture", "--session", session])).code).not.toBe(0);
    await start("after-failed-launch", session);
    await stop(session);
  }, 30_000);

  test("an unfinished client cannot delay daemon retirement or produce a premature wait-dead", async () => {
    const session = await start("open-client");
    const owner = record(session);
    const socket = connect(owner.endpoint);
    socket.on("error", () => {});
    await new Promise<void>((accept) => socket.once("connect", accept));
    socket.write("{");
    const trickle = setInterval(() => socket.write(" "), 20);
    try {
      const before = Date.now();
      await stop(session);
      expect(Date.now() - before).toBeLessThan(5000);
      // Query the OS independently of the driver's cleanupComplete record.
      expect(await getNativeProcessIdentity(owner.daemonPid)).not.toBe(owner.daemonIdentity);
    } finally {
      clearInterval(trickle);
      socket.destroy();
      if (sessions.has(session)) await stop(session);
    }
  }, 20_000);
});
