// Add names no machine record holds — a company, a customer, a product, a
// person — to the report's redaction map, then clean safe.json with it. The
// model finds them in what it read and the person confirms them (SKILL.md
// step 4); from then on check.ts catches them like any other dictionary value.
// A one-word name that is also an ordinary word (`Will`) is not hidden
// automatically, since that would refuse every sentence holding the word; it is
// kept in the map's `skipped` list for the model to keep out of the report by
// hand. One that is part of AI-DLC's own words (`Bolt` in `BOLT_FAILED`, `Acme`
// in `acme-aidlc-plugins`) is refused in the report as a whole word, and safe.json
// keeps AI-DLC's word as it is. The names themselves are never printed.
//
// Usage: hide.ts --out <dir> (--kind <org|customer|product|person|other> --name <value>)…

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { importSecretRules } from "./lib-project.ts";
import { type Dictionary, ordinaryWord, redactValue, useSecretRules } from "./redact.ts";

const KINDS = ["org", "customer", "product", "person", "other"] as const;
const LABEL: Record<(typeof KINDS)[number], string> = {
  org: "org",
  customer: "customer",
  product: "product",
  person: "person",
  other: "name",
};

function refuse(reason: string): never {
  console.log(JSON.stringify({ ok: false, reason }));
  process.exit(2);
}

const argv = process.argv.slice(2);
const at = argv.indexOf("--out");
const out = at >= 0 ? argv[at + 1] : undefined;
const mapPath = out ? join(out, "local", "redaction-map.json") : "";
if (!out || !existsSync(mapPath) || !existsSync(join(out, "safe.json"))) {
  refuse("usage: hide.ts --out <report folder made by collect.ts> (--kind <kind> --name <value>)…");
}

// Pairs in order: each --name takes the --kind given before it.
const pairs: { kind: (typeof KINDS)[number]; name: string }[] = [];
let kind: (typeof KINDS)[number] = "other";
for (let k = 0; k < argv.length; k++) {
  if (argv[k] === "--kind") {
    const v = argv[++k] as (typeof KINDS)[number];
    if (!KINDS.includes(v)) refuse(`unknown kind; use one of ${KINDS.join(", ")}`);
    kind = v;
  } else if (argv[k] === "--name") {
    const v = (argv[++k] ?? "").trim();
    if (v.length < 2) refuse("a name needs at least two characters");
    pairs.push({ kind, name: v });
  }
}
if (pairs.length === 0) refuse("no --name given");

const dict = JSON.parse(readFileSync(mapPath, "utf8")) as Dictionary;
useSecretRules(await importSecretRules(dict.secretRulesFrom));
const vocabPath = join(out, "local", "vocab.json");
const aidlcParts = new Set(
  (existsSync(vocabPath) ? (JSON.parse(readFileSync(vocabPath, "utf8")) as string[]) : []).flatMap((w) => w.toLowerCase().split(/[-_ .:/]+/)),
);
let added = 0;
let skipped = 0;
for (const { kind: k, name } of pairs) {
  if (dict.entries.some((e) => e.value.toLowerCase() === name.toLowerCase())) continue;
  const n = dict.entries.filter((e) => (e.kind === "named" || e.kind === "report-only") && e.label.startsWith(`<${LABEL[k]}-`)).length + 1;
  if (!/\s/.test(name) && !ordinaryWord(name) && aidlcParts.has(name.toLowerCase())) {
    dict.entries.push({ value: name, label: `<${LABEL[k]}-${n}>`, kind: "report-only" });
    added++;
    continue;
  }
  if (!/\s/.test(name) && ordinaryWord(name)) {
    dict.skipped ??= [];
    if (!dict.skipped.some((e) => e.value.toLowerCase() === name.toLowerCase())) dict.skipped.push({ value: name, label: `<${LABEL[k]}>`, kind: "named" });
    skipped++;
    continue;
  }
  dict.entries.push({ value: name, label: `<${LABEL[k]}-${n}>`, kind: "named" });
  added++;
}
dict.entries.sort((a, b) => b.value.length - a.value.length);
writeFileSync(mapPath, JSON.stringify(dict, null, 2));
// safe.json already had its long ids replaced by collect.ts; names are all that is new.
const safePath = join(out, "safe.json");
writeFileSync(safePath, JSON.stringify(redactValue(JSON.parse(readFileSync(safePath, "utf8")), dict, { ids: false }), null, 2));
console.log(
  JSON.stringify({
    ok: true,
    added,
    hiddenNames: dict.entries.filter((e) => e.kind === "named" || e.kind === "report-only").map((e) => e.label),
    ...(skipped ? { notHidden: skipped, why: "also an ordinary word: keep it out of the report by hand" } : {}),
  }),
);
