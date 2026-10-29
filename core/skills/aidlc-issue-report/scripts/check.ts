// The check before anything is handed over (lib-check.ts). Exit 1 when anything is found, a file is refused or
// the report is not written yet.
//
// Usage: check.ts --out <dir>

import { existsSync } from "node:fs";
import { join } from "node:path";
import { checkFolder, REPORT } from "./lib-check.ts";

const i = process.argv.indexOf("--out");
const out = i > 0 ? process.argv[i + 1] : process.cwd();
const result = await checkFolder(out);
if (!result) {
  const finished = !existsSync(join(out, "local")) && existsSync(join(out, REPORT));
  const reason = finished
    ? "already finished: finish.ts ran this check, then removed local/ (and its redaction map), so it cannot run again"
    : "no redaction map - run collect.ts first";
  console.log(JSON.stringify({ ok: false, reason }));
  process.exit(2);
}
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
