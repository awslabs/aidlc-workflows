// Record a raw value the person chose to include in the report, exactly as it is written there (one error line, a
// file name). The check (lib-gate.ts) then passes that exact text in the report and nothing around it; safe.json
// never takes it. The values are not printed back.
//
// Usage: allow.ts --out <dir> --value '<exact text>' [--value …]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flagValue, refuse, reportFolder } from "./lib-cli.ts";

const argv = process.argv.slice(2);
const out = reportFolder(flagValue("out", argv)) ?? refuse("usage: allow.ts --out <report folder made by collect.ts> --value <exact text>…");
const values = argv.flatMap((a, k) => (a === "--value" ? [argv[k + 1] ?? ""] : []));
if (values.length === 0) refuse("no --value given");
if (values.some((v) => v.trim().length < 2 || /[\r\n]/.test(v))) refuse("a value is one line of at least two characters");
const path = join(out, "local", "allowed.json");
const list: string[] = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
for (const v of values) if (!list.includes(v)) list.push(v);
writeFileSync(path, JSON.stringify(list, null, 2));
console.log(JSON.stringify({ ok: true, allowedValues: list.length }));
