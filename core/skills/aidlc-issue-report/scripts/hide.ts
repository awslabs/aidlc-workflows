// Add names no machine record holds — a company, a customer, a product, a
// person — to the folder's redaction map, then clean safe.json with it. The
// person names them (SKILL.md step 3); from then on check.ts catches them like
// any other dictionary value. A one-word name that is also an ordinary word
// (`Will`) is not hidden on its own, since that would replace the word in every
// line; it is kept in the map's `skipped` list. One that is part of AI-DLC's own
// words (`Bolt` in `BOLT_FAILED`, `Acme` in `acme-aidlc-plugins`) or of the fixed
// text of an AI-DLC message is refused in the cover as a whole word, and safe.json
// keeps AI-DLC's word or text as it is. Both are
// listed in `notHidden` for the agent to ask the person once (SKILL.md step 3).
// With --everywhere the names of the call are hidden inside those words too: they
// go into the map and local/hide-anyway.json, and a new report collected from this
// one (collect.ts --from) reads AI-DLC's words without the ones that hold them, so
// every field's own rule labels them; the check reads either folder by the same
// list. The names themselves are never printed.
//
// The names come in a file the agent writes with its own file tool, never on the command line: no shell reads them
// (in Command Prompt `&` in `Marks & Spencer` ends a command, and an apostrophe ends a quoted name in every shell).
// The file is removed once its names are applied; until then it waits, and the check refuses.
//
// Usage: hide.ts --out <dir>                with <dir>/local/hide-names.json: [{ "kind": "<org|customer|product|person|other>", "name": "<value>" }, …]
//        hide.ts --out <dir> --everywhere   with the same list in <dir>/local/hide-everywhere.json

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkedLists, hiddenAnyway, keptVocab } from "./lib-check.ts";
import { EVERYWHERE_FILE, flagValue, NAMES_FILE, readAgentJson, refuse, reportFolder } from "./lib-cli.ts";
import { importSecretRules } from "./lib-project.ts";
import { type Dictionary, type Entry, namesAt, ordinaryWord, PERSON_KINDS, redactValue, useSecretRules } from "./redact.ts";

const KINDS = ["org", "customer", "product", "person", "other"] as const;
const KIND_LABEL: Record<(typeof KINDS)[number], string> = {
  org: "org",
  customer: "customer",
  product: "product",
  person: "person",
  other: "name",
};

const argv = process.argv.slice(2);
const out = reportFolder(flagValue("out", argv)) ?? refuse("usage: hide.ts --out <report folder made by collect.ts> [--everywhere]");
const mapPath = join(out, "local", "redaction-map.json");
const everywhere = argv.includes("--everywhere");
// The names to hide everywhere come in their own file, so a call that waits keeps the person's yes with its names.
const namesFile = `local/${everywhere ? EVERYWHERE_FILE : NAMES_FILE}`;
const namesPath = join(out, namesFile);

// The names in the order the file lists them. A refused file stays for the agent to correct.
const taken = readAgentJson(namesPath);
if (taken.kind === "none") refuse(`no names: write them to ${namesFile} in the report folder first`, { file: namesPath });
if (taken.kind === "not-json" || !Array.isArray(taken.value)) refuse(`${namesFile} is not a list of { "kind", "name" }`, { file: namesPath });
// An empty list hides nothing: every name was taken out of it.
if (taken.value.length === 0) {
  rmSync(namesPath, { force: true });
  console.log(JSON.stringify({ ok: true, added: 0 }));
  process.exit(0);
}
const listed = taken.value as { kind?: unknown; name?: unknown }[];
const entryOk = (e: { kind?: unknown; name?: unknown } | null) =>
  KINDS.includes((e?.kind ?? "other") as (typeof KINDS)[number]) && typeof e?.name === "string" && e.name.trim().length >= 2;
const wrong = listed.flatMap((e, i) => (entryOk(e) ? [] : [i + 1]));
if (wrong.length > 0)
  refuse(`each entry needs a kind (${KINDS.join(", ")}) and a name of at least two characters`, {
    entries: wrong,
    file: namesPath,
  });
const pairs = listed.map((e) => ({ kind: (e.kind ?? "other") as (typeof KINDS)[number], name: (e.name as string).trim() }));

const dict = JSON.parse(readFileSync(mapPath, "utf8")) as Dictionary;
useSecretRules(await importSecretRules(dict.secretRulesFrom));
// AI-DLC's words as collect.ts kept them for this folder, as the check reads them. A name is in one when the
// redaction would find it there (`Bolt` in `BOLT_FAILED`, `Deploy` in `deployment-planning`).
const kept = keptVocab(out);
const holds = (list: Iterable<string>, e: Entry) => {
  for (const w of list) if (namesAt(w, { entries: [e] }).length > 0) return true;
  return false;
};
// In a word or in the fixed text of one of AI-DLC's messages, the lists the check reads (lib-check.ts): safe.json keeps
// that text as AI-DLC wrote it, so the name stays there unless the person has it hidden anyway (a new report without
// that text).
const inAidlcWords = (e: Entry) => holds(kept.words, e) || holds(kept.phrases, e);
// Every list the check reads without a name hidden anyway (lib-check.ts withoutHidden): while one still holds it, this
// folder needs a new report.
const stillHeld = (e: Entry) => checkedLists(kept).some((set) => holds(set, e));
let added = 0;
// The names of this call not hidden, by their place in its file (1 is the first): `aidlc-word` (part of
// AI-DLC's own words) or `ordinary-word`.
const notHidden: { name: number; label: string; why: "aidlc-word" | "ordinary-word" }[] = [];
// A name the map hid before this run (the machine's user, a folder, a name added earlier) keeps the label it has.
const before = new Set(dict.entries.map((e) => e.value.toLowerCase()));
const already = new Set<string>();
// The names hidden inside AI-DLC's words and ordinary words too (--everywhere), this call's and earlier ones'.
const anywayPath = join(out, "local", "hide-anyway.json");
const anyway: Entry[] = hiddenAnyway(out);
let rebuild = false;
// The next label of a kind, after every one the map, its skipped list and the names hidden anyway hold.
const serial = (k: (typeof KINDS)[number]) =>
  new Set(
    [...dict.entries, ...(dict.skipped ?? []), ...anyway].filter((e) => PERSON_KINDS.has(e.kind) && e.label.startsWith(`<${KIND_LABEL[k]}-`)).map((e) => e.label),
  ).size + 1;
for (const [i, { kind: k, name }] of pairs.entries()) {
  const same = (e: { value: string }) => e.value.toLowerCase() === name.toLowerCase();
  const skippedBefore = (dict.skipped ?? []).find((e) => same(e) && PERSON_KINDS.has(e.kind));
  const known = dict.entries.find(same);
  const left = known?.kind === "report-only" ? known : !known ? skippedBefore : undefined;
  if (everywhere && anyway.some(same)) {
    // Asked again: a new report is needed only while this folder's words still hold it.
    if (stillHeld(anyway.find(same) as Entry)) rebuild = true;
    continue;
  }
  if (everywhere && (left || !known)) {
    const entry: Entry = { value: name, label: left?.label ?? `<${KIND_LABEL[k]}-${serial(k)}>`, kind: "named" };
    anyway.push(entry);
    // In the map at once, so the check refuses the name even if the folder is not collected again.
    dict.entries = dict.entries.filter((e) => !same(e));
    dict.entries.push(entry);
    dict.skipped = (dict.skipped ?? []).filter((e) => !same(e));
    rebuild = true;
    added++;
    continue;
  }
  if (known) {
    if (known.kind === "report-only") notHidden.push({ name: i + 1, label: known.label, why: "aidlc-word" });
    else if (before.has(name.toLowerCase())) already.add(known.label);
    continue;
  }
  if (skippedBefore) {
    notHidden.push({ name: i + 1, label: skippedBefore.label, why: "ordinary-word" });
    continue;
  }
  const entry: Entry = { value: name, label: `<${KIND_LABEL[k]}-${serial(k)}>`, kind: "named" };
  if (!/\s/.test(name) && ordinaryWord(name)) {
    dict.skipped = [...(dict.skipped ?? []), entry];
    notHidden.push({ name: i + 1, label: entry.label, why: "ordinary-word" });
  } else if (inAidlcWords(entry)) {
    dict.entries.push({ ...entry, kind: "report-only" });
    notHidden.push({ name: i + 1, label: entry.label, why: "aidlc-word" });
  } else {
    dict.entries.push(entry);
    added++;
  }
}
dict.entries.sort((a, b) => b.value.length - a.value.length);
writeFileSync(mapPath, JSON.stringify(dict, null, 2));
const said = {
  hiddenNames: [...new Set([...dict.entries.filter((e) => e.kind === "named").map((e) => e.label), ...anyway.map((e) => e.label)])],
  ...(already.size ? { alreadyHidden: [...already] } : {}),
  ...(notHidden.length
    ? {
        notHidden,
        next: `ask the person once about the aidlc-word and ordinary-word ones: hide these anyway (write only them to local/${EVERYWHERE_FILE} and run hide.ts with --everywhere), or leave them`,
      }
    : {}),
};
if (rebuild) {
  // Hidden anyway: a new report is collected from this one (collect.ts --from), which reads AI-DLC's words without the
  // ones holding these names. Meanwhile the check reads this folder the same way, so it refuses them where they stand.
  writeFileSync(anywayPath, JSON.stringify(anyway, null, 2));
  rmSync(namesPath, { force: true });
  console.log(JSON.stringify({ ok: true, added, ...said, next: "collect a new report from this folder: collect.ts --from with the folder in `from`", from: out }));
  process.exit(0);
}
// safe.json already had its long ids replaced by collect.ts; names are all that is new.
const safePath = join(out, "safe.json");
writeFileSync(safePath, JSON.stringify(redactValue(JSON.parse(readFileSync(safePath, "utf8")), dict, { ids: false }), null, 2));
rmSync(namesPath, { force: true });
console.log(JSON.stringify({ ok: true, added, ...said }));
