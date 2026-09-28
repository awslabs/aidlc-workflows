// Owner fixture for t-sdk-process-containment-windows: creates a containment,
// spawns the fake CLI through it, reports the PIDs, then exits WITHOUT calling
// terminate(). The outer test proves the kill-on-close limit ends the tree when
// the owning test process dies, which is the timeout/crash safety net.
import { fileURLToPath } from "node:url";
import { createSdkProcessContainment } from "../harness/sdk-process-containment.ts";

const containment = await createSdkProcessContainment();
if (!containment) throw new Error("owner fixture requires Windows");
const child = containment.spawn({
  command: process.execPath,
  args: [fileURLToPath(new URL("./windows-sdk-fake-cli.ts", import.meta.url))],
  env: { ...process.env },
  signal: new AbortController().signal,
});
let buffered = "";
child.stdout.on("data", (chunk: Buffer) => {
  buffered += chunk.toString("utf8");
  const line = buffered.indexOf("\n");
  if (line < 0) return;
  process.stdout.write(`${buffered.slice(0, line)}\n`);
  // Exit abruptly: no terminate(), no stdin end. The OS closes the job handle.
  process.exit(0);
});
