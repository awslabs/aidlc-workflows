// Last step: run the check, then delete the local-only layer and open the folder to send.
// Usage: finish.ts --out <dir> [--no-open]
//
// It deletes only a `local/` that collect.ts made: the folder must hold
// collect's `safe.json` and `local/redaction-map.json`. Without --out, or in
// any other folder, it refuses and deletes nothing, so a missing flag can never
// remove a `local/` folder of the person's own. When the check does not pass
// (lib-check.ts: a hit, a refused file, or no report yet), it prints the check
// and deletes nothing: the redaction map in local/ is what the check needs to
// run again after a fix.

import { spawn } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { platform } from "node:os";
import { join, resolve } from "node:path";
import { checkFolder, OS_FILES } from "./lib-check.ts";

function refuse(message: string): never {
  console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(2);
}

const i = process.argv.indexOf("--out");
const given = i > 0 ? process.argv[i + 1] : undefined;
if (!given || given.startsWith("--")) refuse("--out <report folder> is required; nothing was deleted");
const out = resolve(given);
if (!existsSync(join(out, "safe.json")) || !existsSync(join(out, "local", "redaction-map.json"))) {
  refuse(`${out} is not a report folder made by collect.ts; nothing was deleted`);
}
const check = await checkFolder(out);
if (!check?.ok) {
  console.log(JSON.stringify({ ok: false, error: "the check did not pass; nothing was deleted", check }, null, 2));
  process.exit(1);
}
rmSync(join(out, "local"), { recursive: true, force: true });
for (const f of OS_FILES) rmSync(join(out, f), { force: true });
const files = readdirSync(out);
if (!process.argv.includes("--no-open")) {
  const opener = platform() === "darwin" ? ["open", out] : platform() === "win32" ? ["explorer", out] : ["xdg-open", out];
  try {
    // A missing opener (headless Linux, WSL) reports ENOENT as an event, not a throw.
    const child = spawn(opener[0], opener.slice(1), { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // no desktop: the path below is enough
  }
}
console.log(JSON.stringify({ ok: true, folder: out, files, localRemoved: !existsSync(join(out, "local")), allowedValues: check.allowedValues }, null, 2));
