// Last step: run the check, then delete the local-only layer and open the folder to send.
// Usage: finish.ts --out <dir> [--no-open]
//        finish.ts --discard --out <dir>   remove a report folder that will not be sent (one a newer report replaced:
//                                          collect.ts --from); safe.json and the redaction map go last, so a stop
//                                          part way leaves a folder the scripts still know
//
// It deletes only a `local/` that collect.ts made: the folder must hold
// collect's `safe.json` and `local/redaction-map.json`. Without --out, or in
// any other folder, it refuses and deletes nothing, so a missing flag can never
// remove a `local/` folder of the person's own. When the check does not pass
// (lib-check.ts: a hit, a refused file, a missing cover or safe.json), it prints the check
// and deletes nothing: the redaction map in local/ is what the check needs to
// run again after a fix.

import { spawn } from "node:child_process";
import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { platform } from "node:os";
import { join, resolve } from "node:path";
import { flagValue, refuse, reportFolder } from "./lib-cli.ts";
import { checkFolder, OS_FILES } from "./lib-check.ts";

const given = flagValue("out") ?? refuse("--out <report folder> is required; nothing was deleted");
const out = reportFolder(given) ?? refuse(`${resolve(given)} is not a report folder made by collect.ts; nothing was deleted`);
if (process.argv.includes("--discard")) {
  // Only collect's and cover's own files: a folder holding anything else is left as it is.
  const own = new Set(["safe.json", "aidlc-issue-report.md", "local", ...OS_FILES]);
  const other = readdirSync(out).filter((f) => !own.has(f));
  if (other.length) {
    console.log(JSON.stringify({ ok: false, reason: "folder-holds-other-files", hint: "Move the other files out, then run it again; nothing was deleted." }));
    process.exit(1);
  }
  // safe.json and the redaction map go last, the map (which holds the names themselves) before safe.json (which holds
  // only labels): a stop before them leaves a folder these scripts still know and can remove, a stop between them a
  // folder with safe.json alone, which the person can delete.
  const map = join(out, "local", "redaction-map.json");
  try {
    for (const f of readdirSync(join(out, "local"))) if (f !== "redaction-map.json") rmSync(join(out, "local", f), { recursive: true, force: true });
    for (const f of readdirSync(out)) if (f !== "local" && f !== "safe.json") rmSync(join(out, f), { recursive: true, force: true });
    rmSync(map, { force: true });
    rmSync(join(out, "safe.json"), { recursive: true, force: true });
  } catch {
    // Once the map is gone the folder is no report folder any more, so it is deleted by hand, not by running this again.
    // The map is gone only when the system says so: an unreadable folder may still hold it.
    let mapLeft = true;
    try {
      lstatSync(map);
    } catch (e) {
      mapLeft = (e as NodeJS.ErrnoException).code !== "ENOENT";
    }
    const hint = mapLeft ? "Close what has the folder open, then run it again." : "Close what has the folder open, then delete it by hand: it holds no names any more.";
    console.log(JSON.stringify({ ok: false, reason: "folder-in-use", hint, folder: out }));
    process.exit(1);
  }
  // What is left is an empty folder (one held open as a shell's folder): nothing in it, so it is said, not refused.
  try {
    rmSync(out, { recursive: true, force: true });
  } catch {
    // Gone by now is empty; unreadable is not known to be. Either way the names went with the map.
    let empty = false;
    try {
      empty = readdirSync(out).length === 0;
    } catch (e) {
      empty = (e as NodeJS.ErrnoException).code === "ENOENT";
    }
    const hint = "Close what has the folder open, then delete it by hand: it holds no names any more.";
    console.log(JSON.stringify(empty ? { ok: true, discarded: out, emptyFolderLeft: out } : { ok: false, reason: "folder-in-use", hint, folder: out }));
    process.exit(empty ? 0 : 1);
  }
  console.log(JSON.stringify({ ok: true, discarded: out }));
  process.exit(0);
}
const check = await checkFolder(out);
if (!check?.ok) {
  console.log(JSON.stringify({ ok: false, reason: "the check did not pass; nothing was deleted", check }, null, 2));
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
console.log(JSON.stringify({ ok: true, folder: out, files, localRemoved: !existsSync(join(out, "local")) }, null, 2));
