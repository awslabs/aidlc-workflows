// The cover the person reads before sending: what the folder holds, written from safe.json by this script alone, so
// it says nothing the data does not. No analysis: which events matter is for whoever reads the data
// (references/data.md says what each part holds).
// Usage: cover.ts --out <report folder>

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flagValue, refuse, reportFolder } from "./lib-cli.ts";
import { gateContext, hiddenAnyway, keptVocab, withoutHidden } from "./lib-check.ts";
import { runSessions } from "./lib-tools.ts";
import { namesIn } from "./lib-gate.ts";
import { hideInWords, LABEL, labelKind, loadDictionary } from "./redact.ts";

const LEFT_OUT = "- (A line here held a name the person hid, so it was left out.)";

type Safe = {
  window?: { since?: string; until?: string; lastAidlcActivity?: string | null; notes?: string[] };
  environment?: {
    os?: string | null;
    native?: { version?: string | null } | null;
    tools?: Record<string, { version?: string | null; source?: string | null }>;
    toolsUsed?: string[];
    versionsMissing?: string[];
    toolsNamed?: string[];
  };
  trees?: { dir?: string; row?: string | null; stampVersion?: string | null; channel?: string }[];
  intents?: unknown[];
  audit?: { rowsInWindow?: number; rows?: { event?: string; fields?: [string, unknown][] }[] };
  transcripts?: { tool?: string; sessions?: number; reportSessions?: number; mixedSessions?: number; events?: unknown[]; error?: string; notes?: string[] }[];
  doctor?: { ran?: boolean; findings?: unknown[]; note?: string };
  hooks?: { drops?: unknown[] };
  knownGaps?: string[];
};

const out = reportFolder(flagValue("out")) ?? refuse("--out <report folder made by collect.ts> is required");
const safe = JSON.parse(readFileSync(join(out, "safe.json"), "utf8")) as Safe;
const text = JSON.stringify(safe);

const or = (v: unknown, none = "not recorded") => (v === null || v === undefined || v === "" ? none : String(v));
const lines: string[] = ["# AI-DLC run data", ""];
lines.push(
  "This folder holds what AI-DLC and the AI tool recorded about one run, gathered on the person's machine. Names, paths",
  "and anything a person or an agent wrote are replaced by labels (the same value, the same label); nothing in it was",
  "judged or summarised. `safe.json` is the data.",
  "",
  "## Window",
  "",
  `- From ${or(safe.window?.since)} to ${or(safe.window?.until)} (UTC); last AI-DLC activity ${or(safe.window?.lastAidlcActivity)}.`,
);
for (const n of safe.window?.notes ?? []) lines.push(`- ${n}`);

lines.push("", "## Versions", "");
const native = safe.environment?.native?.version;
if (native) lines.push(`- AI-DLC native install: ${native}`);
for (const t of safe.trees ?? []) lines.push(`- AI-DLC in ${or(t.dir)}: ${or(t.stampVersion)} (${or(t.row)}, ${or(t.channel)})`);
for (const tool of safe.environment?.toolsUsed ?? []) {
  const v = safe.environment?.tools?.[tool];
  const from = v?.source === "person" ? " (from the person)" : v?.source && v.source !== "log" ? " (at collection)" : "";
  // toolsNamed holds a tool only when no chat log showed the run in it (set-version.ts); the logs found are listed under
  // "What is in safe.json".
  const named = (safe.environment?.toolsNamed ?? []).includes(tool) ? " (named by the person; no chat log showed the run in it)" : "";
  lines.push(`- ${tool}: ${or(v?.version, "not found")}${v?.version ? from : ""}${named}`);
}
lines.push(`- OS: ${or(safe.environment?.os)}`);

lines.push("", "## What is in safe.json", "");
lines.push(`- AI-DLC's record: ${safe.audit?.rows?.length ?? 0} rows in the window, every field (\`audit\` → \`rows\`).`);
lines.push(`- Intents: ${safe.intents?.length ?? 0}, with their state as it is now (\`intents\`).`);
for (const t of safe.transcripts ?? []) {
  if (t.error) lines.push(`- ${or(t.tool)}: the reader failed.`);
  else {
    // The sessions that only made this report are counted apart: their events are not the run's.
    const run = runSessions(t);
    const own = Math.max(0, (t.sessions ?? 0) - run);
    lines.push(`- ${or(t.tool)}: ${run} session(s) of the run${own ? `, ${own} that only made this report` : ""}, ${t.events?.length ?? 0} events (\`transcripts\` → \`events\`).`);
  }
}
lines.push(
  safe.doctor?.ran
    ? `- AI-DLC doctor: ${safe.doctor.findings?.length ?? 0} finding(s) (\`doctor\`).`
    : `- AI-DLC doctor: did not run (${or(safe.doctor?.note, "no reason recorded")}).`,
);
lines.push(`- Hook drops: ${safe.hooks?.drops?.length ?? 0} (\`hooks\`).`);
const stack = (safe.audit?.rows ?? []).some((r) => (r.fields ?? []).some(([name]) => name === "Languages" || name === "Frameworks"));
if (stack) lines.push("- The project's languages and frameworks as AI-DLC's workspace scan recorded them.");

lines.push("", "## Replaced by labels", "");
// Filled in below, once the cover's own words have had the hidden names replaced (they may add labels).
const inventoryAt = lines.length;

lines.push("", "## Not in this folder", "");
lines.push(
  "- Code, document contents, what the person typed, and what an agent wrote (each is a label at most).",
  "- Names of people, companies, customers, Units and intents, and paths outside AI-DLC's own folders.",
  "- AI-DLC's doctor export archive.",
);

if ((safe.knownGaps ?? []).length) {
  lines.push("", "## What the records cannot show", "");
  for (const g of safe.knownGaps ?? []) lines.push(`- ${g}`);
}
const notes = (safe.transcripts ?? []).flatMap((t) => t.notes ?? []);
if (notes.length) {
  lines.push("", "## Notes from the readers", "");
  for (const n of notes) lines.push(`- ${n}`);
}
lines.push("", "Each part of `safe.json` is described in the data guide among this skill's references.", "");

// A name the person hid is kept out of the cover's own words too.
const dict = loadDictionary(join(out, "local", "redaction-map.json"));
const written = lines.map((l) => hideInWords(l, dict));
// Each distinct label once, in safe.json and on the cover, by its kind (redact.ts labelKind). A label with no number
// (`<path>`, `<user>`, `<redacted>`) stands for every value of its kind, so it is listed without a count. The count
// lines are not hidden: a hidden name that is also a kind word takes its line out below, as any line of the cover.
const counted = new Map<string, Set<string>>();
const uncounted = new Set<string>();
for (const m of `${text}\n${written.join("\n")}`.matchAll(LABEL)) {
  const { kind, numbered } = labelKind(m[0]);
  if (!numbered) uncounted.add(kind);
  else counted.set(kind, (counted.get(kind) ?? new Set<string>()).add(m[0]));
}
const kinds = [...new Set([...counted.keys(), ...uncounted])].sort();
const inventory = kinds.flatMap((kind) => [
  ...(counted.has(kind) ? [`- ${kind}: ${counted.get(kind)?.size}`] : []),
  ...(uncounted.has(kind) ? [`- ${kind}: one label for every value`] : []),
]);
if (inventory.length === 0) inventory.push("- none");
written.splice(inventoryAt, 0, ...inventory);
// A hidden name the check would still find, across a line end or the cover's own markup, takes its lines out.
const ctx = gateContext(withoutHidden(keptVocab(out), hiddenAnyway(out)), dict);
for (let pass = 0; pass < written.length; pass++) {
  const hit = new Set(namesIn(ctx, written.join("\n")).flatMap((n) => n.lines));
  if (hit.size === 0) break;
  // The note itself may hold a hidden word (`line`, `here`): then a line with no words, then an empty line, so each
  // line changes at most three times.
  const before = written.join("\n");
  for (const l of hit) {
    const w = written[l - 1];
    written[l - 1] = w === "" ? "" : w === LEFT_OUT ? "- (...)" : w === "- (...)" ? "" : LEFT_OUT;
  }
  if (written.join("\n") === before) break;
}
writeFileSync(join(out, "aidlc-issue-report.md"), written.join("\n"));
console.log(JSON.stringify({ ok: true, cover: join(out, "aidlc-issue-report.md") }));
