// The check before anything is handed over (lib-check.ts). Exit 1 when anything is found, a file is refused or
// the report is not written yet.
//
// Usage: check.ts --out <dir>

import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { flagValue, refuse } from "./lib-cli.ts";
import { checkFolder, REPORT } from "./lib-check.ts";

const given = flagValue("out") ?? refuse("usage: check.ts --out <report folder made by collect.ts>");
const dir = resolve(given);
// collect.ts's redaction map marks its folder; a missing safe.json is the check's to name (`missing`).
const out = existsSync(dir) && statSync(dir).isDirectory() && existsSync(join(dir, "local", "redaction-map.json")) ? dir : null;
if (!out) {
  // What finish.ts leaves: the report and safe.json, no local/ (its redaction map went with it).
  const finished = !existsSync(join(dir, "local")) && existsSync(join(dir, REPORT)) && existsSync(join(dir, "safe.json"));
  refuse(
    finished
      ? "already finished: finish.ts ran this check, then removed local/ (and its redaction map), so it cannot run again"
      : `${dir} is not a report folder made by collect.ts`,
  );
}
const result = await checkFolder(out);
if (!result) refuse("no redaction map - run collect.ts first");
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
