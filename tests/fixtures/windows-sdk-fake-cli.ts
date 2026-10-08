// Fake SDK CLI for t-sdk-process-containment-windows. Behaves like a
// conductor whose Bash tool is mid-flight when the SDK aborts: it starts a
// long-lived, detached grandchild, reports both PIDs as one JSON line, then
// keeps running after stdin EOF, which is exactly what the real CLI does while
// a tool call is still executing. Windows does not end children with their
// parent, so without containment the grandchild outlives kill("SIGKILL").
import { spawn } from "node:child_process";

const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
  windowsHide: true,
  detached: true,
});
grandchild.unref();
process.stdout.write(`${JSON.stringify({ pid: process.pid, grandchild: grandchild.pid })}\n`);
process.stdin.resume();
process.stdin.on("end", () => {
  setTimeout(() => process.exit(0), 60_000);
});
