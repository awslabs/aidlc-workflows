// The cover the person reads before sending: what the folder holds, written from safe.json by this script alone, so
// it says nothing the data does not. No analysis: which events matter is for whoever reads the data
// (references/data.md says what each part holds).
// Usage: cover.ts --out <report folder>

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flagValue, refuse, reportFolder } from "./lib-cli.ts";
import { hideInWords, loadDictionary } from "./redact.ts";

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
  transcripts?: { tool?: string; sessions?: number; events?: unknown[]; error?: string; notes?: string[] }[];
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
  const named = (safe.environment?.toolsNamed ?? []).includes(tool) ? " (named by the person; no chat log of it was read)" : "";
  lines.push(`- ${tool}: ${or(v?.version, "not found")}${v?.version ? from : ""}${named}`);
}
lines.push(`- OS: ${or(safe.environment?.os)}`);

lines.push("", "## What is in safe.json", "");
lines.push(`- AI-DLC's record: ${safe.audit?.rows?.length ?? 0} rows in the window, every field (\`audit\` → \`rows\`).`);
lines.push(`- Intents: ${safe.intents?.length ?? 0}, with their state as it is now (\`intents\`).`);
for (const t of safe.transcripts ?? []) {
  if (t.error) lines.push(`- ${or(t.tool)}: the reader failed.`);
  else lines.push(`- ${or(t.tool)}: ${t.sessions ?? 0} session(s), ${t.events?.length ?? 0} events (\`transcripts\` → \`events\`).`);
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
const kinds = new Map<string, Set<string>>();
// Each distinct label once: `<unit-1>` (the redaction map's) and `<custom-unit-1>` (a row's) are two Units.
for (const m of text.matchAll(/<(?:custom-)?([a-z]+(?:-[a-z]+)*?)-\d{1,6}>/g)) {
  const set = kinds.get(m[1]) ?? new Set<string>();
  set.add(m[0]);
  kinds.set(m[1], set);
}
if (kinds.size === 0) lines.push("- none");
for (const [kind, set] of [...kinds].sort()) lines.push(`- ${kind}: ${set.size}`);

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
writeFileSync(join(out, "aidlc-issue-report.md"), hideInWords(lines.join("\n"), loadDictionary(join(out, "local", "redaction-map.json"))));
console.log(JSON.stringify({ ok: true, cover: join(out, "aidlc-issue-report.md") }));
