// The check check.ts prints and finish.ts runs before it deletes local/. The folder sends two files: the report
// (aidlc-issue-report.md) and safe.json; anything else in it, a link or a folder other than local/ is refused, and
// a folder with no report is not ready. Both files are read as written, by lib-gate.ts's rules: the report line by
// line, safe.json as its decoded fields, every key and string by its field (a JSON file with a repeated key is
// refused, since parsing keeps only the last value). AI-DLC's own secret rules, when the install has them, run over
// both as written too. Reports where each hit is and why, never the value.

import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type GateContext, type GateHit, safeHits, skillWords, textHits } from "./lib-gate.ts";
import { importSecretRules } from "./lib-project.ts";
import { type RowVocab, VOCAB_KINDS } from "./lib-rows.ts";
import { type Dictionary, findSecrets, loadDictionary, useSecretRules } from "./redact.ts";
import { emptyVocab, type Vocab } from "./lib-vocab.ts";

export const REPORT = "aidlc-issue-report.md";
// Files the operating system writes into any folder the person opens: not sent, and removed by finish.ts.
export const OS_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const SENT = new Set([REPORT, "safe.json"]);

export type Hit = { file: string; line: number; reason: string; field?: string };
export type CheckResult = {
  ok: boolean;
  checked: string[];
  hits: Hit[];
  refused?: string[];
  refusedWhy?: string;
  missing?: string;
};

// AI-DLC's words as collect.ts read them from the install, kept in the folder's local/ (never sent) for the check and
// hide.ts: an update or a moved project after collect.ts ran changes nothing for this folder. With none kept, none,
// and every row value must then be a label.
const KEPT = ["words", "phrases", ...VOCAB_KINDS] as const;
export function keepVocab(out: string, v: Vocab): void {
  writeFileSync(join(out, "local", "vocab.json"), JSON.stringify(Object.fromEntries(KEPT.map((k) => [k, [...v[k]].sort()]))));
}
export function keptVocab(out: string): Vocab {
  const v = emptyVocab();
  let kept: unknown;
  try {
    kept = JSON.parse(readFileSync(join(out, "local", "vocab.json"), "utf8"));
  } catch {
    return v;
  }
  if (!kept || typeof kept !== "object" || Array.isArray(kept)) return v;
  for (const k of KEPT) {
    const list = (kept as Record<string, unknown>)[k];
    if (Array.isArray(list)) for (const x of list) if (typeof x === "string") v[k].add(x);
  }
  return v;
}

export function gateContext(vocab: Vocab, dict: Dictionary): GateContext {
  // A row's values are read against AI-DLC's words only, never this skill's own.
  const rows: RowVocab = { words: vocab.words, phrases: vocab.phrases, ...Object.fromEntries(VOCAB_KINDS.map((k) => [k, vocab[k]])) } as RowVocab;
  return { words: new Set([...vocab.words, ...skillWords()]), dict, phrases: [...vocab.phrases], rows };
}

const STRING_TOKEN = /"(?:[^"\\]|\\.)*"/g;

export async function checkFolder(out: string): Promise<CheckResult | null> {
  const dict: Dictionary = loadDictionary(join(out, "local", "redaction-map.json"));
  if (dict.entries.length === 0) return null;
  useSecretRules(await importSecretRules(dict.secretRulesFrom));
  const ctx = gateContext(keptVocab(out), dict);

  const hits: Hit[] = [];
  const refused: string[] = [];
  for (const f of readdirSync(out).sort()) {
    const st = lstatSync(join(out, f));
    if ((f === "local" && st.isDirectory()) || (OS_FILES.has(f) && st.isFile())) continue;
    if (st.isSymbolicLink()) refused.push(`${f} (link)`);
    else if (!st.isFile()) refused.push(`${f} (not a file)`);
    else if (!SENT.has(f)) refused.push(f);
  }
  const add = (file: string, list: GateHit[]) => {
    for (const h of list) hits.push({ file, line: h.line, reason: h.reason, ...(h.field ? { field: h.field } : {}) });
  };
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const read = (f: string): string | null => {
    try {
      const text = utf8.decode(readFileSync(join(out, f)));
      if (text.includes("\u0000")) throw new Error("binary");
      return text;
    } catch {
      refused.push(`${f} (not text)`);
      return null;
    }
  };
  const checked: string[] = [];

  const hasSafe = existsSync(join(out, "safe.json")) && lstatSync(join(out, "safe.json")).isFile();
  if (hasSafe) {
    const text = read("safe.json");
    if (text !== null) {
      checked.push("safe.json");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        refused.push("safe.json (not valid JSON)");
      }
      // Every key and string in the file is one string token; a repeated key leaves fewer after parsing.
      // A number written in another form (`123456789000e-3`) parses into a short one while the file keeps the long one.
      const numbers = text.replace(STRING_TOKEN, '""').match(/-?\d[\d.eE+-]*/g) ?? [];
      if (parsed !== undefined && (text.match(STRING_TOKEN) ?? []).length !== (JSON.stringify(parsed).match(STRING_TOKEN) ?? []).length) {
        refused.push("safe.json (a key appears twice)");
      } else if (numbers.some((x) => !/^-?\d{1,9}(?:\.\d{1,6})?$/.test(x))) {
        refused.push("safe.json (a number that is long or written in another form)");
      } else if (parsed !== undefined) {
        add("safe.json", safeHits(ctx, parsed));
        add("safe.json", findSecrets(text).map((s) => ({ line: s.line, reason: "a secret, by AI-DLC's own rules" })));
      }
    }
  }
  const hasReport = existsSync(join(out, REPORT)) && lstatSync(join(out, REPORT)).isFile();
  if (hasReport) {
    const text = read(REPORT);
    if (text !== null) {
      checked.push(REPORT);
      add(REPORT, textHits(ctx, text));
    }
  }
  return {
    ok: hits.length === 0 && refused.length === 0 && hasReport && hasSafe,
    checked,
    hits,
    ...(refused.length ? { refused, refusedWhy: `only ${REPORT} and safe.json are sent: move anything else out of the folder` } : {}),
    ...(hasReport ? (hasSafe ? {} : { missing: "safe.json is missing: put back the one collect.ts wrote" }) : { missing: `${REPORT} is not written yet` }),
  };
}
