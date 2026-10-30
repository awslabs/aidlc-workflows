// The check (lib-gate.ts) and redact() over many generated lines: words, labels, separators and planted values
// (this machine's paths, another person's home, hidden names, URLs, secrets, emails, IPs, account numbers)
// joined the way logs and chat join them, a label right against anything. Three properties:
//   1. the check refuses every line that holds a planted value, however the pieces meet;
//   2. the check refuses no line made only of safe pieces (words, labels, AI-DLC's and the tools' own paths);
//   3. redact(), the best-effort cleanup, removes each planted value from a line whose pieces are apart.
// The lines come from fixed seeds, so a failure reproduces; it is printed shrunk to the pieces that cause it.

import { describe, expect, test } from "bun:test";
import { textHits } from "../../core/skills/aidlc-issue-report/scripts/lib-gate.ts";
import { importSecretRules } from "../../core/skills/aidlc-issue-report/scripts/lib-project.ts";
import { type Dictionary, redact, useSecretRules } from "../../core/skills/aidlc-issue-report/scripts/redact.ts";

const RULES = `${import.meta.dir}/../../core/tools/aidlc-doctor-bundle.ts`; // rules-path
useSecretRules(await importSecretRules(RULES));

// What the check (lib-gate.ts) refuses in a line of the report, with no AI-DLC words known.
const gate = (text: string, dict: Dictionary) => textHits({ words: new Set(), dict, allowed: [] }, text);

const dict: Dictionary = {
  entries: [
    { value: "/Users/jdoe/work/shop", label: "<project>", kind: "path" },
    { value: "C:\\Users\\jdoe\\work\\shop", label: "<project>", kind: "path" },
    { value: "/Users/jdoe", label: "~", kind: "path" },
    { value: "C:\\Users\\jdoe", label: "~", kind: "path" },
    { value: "Contoso", label: "<customer-1>", kind: "named" },
    { value: "SAP", label: "<product-1>", kind: "named" },
    { value: "jdoe-mbp", label: "<host>", kind: "host" },
    { value: "jdoe", label: "<user>", kind: "os-user" },
    { value: "Jane Doe", label: "<user>", kind: "git-user" },
    { value: "jane@contoso.com", label: "<email>", kind: "git-email" },
    { value: "shop", label: "<project>", kind: "project-name" },
  ].sort((a, b) => b.value.length - a.value.length),
};

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length)];

// `secret`: text that must not be in the output (any case). An account number is one only between
// separators its rule reads as such (`1.123456789012` is a version, `123456789012-a` an id).
type Piece = { text: string; secret?: string; account?: boolean };
let serial = 0;
const unique = () => `zq${(serial++).toString(36)}x`;

const WORDS = ["the", "run", "failed", "at", "stage", "build", "and", "test", "ok", "note", "see", "x", "1", "2.11.1", "code-generation", "List<T>"];
const LABELS = ["<user>", "<project>", "<customer-1>", "<url>", "<path>", "<host>", "<redacted>", "<email>", "<intent-1>"];
const BETWEEN = [" ", " ", " ", "\t", ", ", "; ", " (", ") ", '"', "'", "`", " = ", ": ", " | ", " [", "] ", " -> "];
const BESIDE_LABEL = ["", "", "/", "-", ".", ...BETWEEN];

const GENERATORS: Array<(r: () => number) => Piece> = [
  (r) => ({ text: pick(r, WORDS) }),
  (r) => ({ text: pick(r, LABELS) }),
  (r) => {
    const v = pick(r, ["Contoso", "contoso", "CONTOSO", "Contosos", "SAP", "sap", "SAPs", "myContoso", "Contoso2026", "Contosoland"]);
    return { text: v, secret: /sap/i.test(v) ? "sap" : "contoso" };
  },
  (r) => {
    const t = unique();
    const v = pick(r, [
      `/Users/jdoe/${t}`, `/Users/jdoe/Clients/${t} Merger.pdf`, `~/${t}`, `~/Clients/${t}`, `C:\\Users\\jdoe\\${t}`,
      `C:\\\\Users\\\\jdoe\\\\${t}`, `/home/jdoe/${t}`, `/home/alice/${t}`, `/Users/Bob Smith/${t}`, `~/.kiro/settings/${t}`,
      `~/.claude/projects/${t}/x.jsonl`, `"/Users/jdoe/${t} Shared/a"`, `C:\\users\\bob\\${t}`, `/Users/jane doe/${t}`,
    ]);
    return { text: v, secret: t };
  },
  (r) => ({ text: pick(r, ["/Users/jdoe", "/Users/jdoe/work/shop", "/Users/jdoe/work/shop/src/app.ts", "~/.kiro/settings/cli.json", "~", "~/.claude"]) }),
  (r) => {
    const t = unique();
    const [text, hidden] = pick(r, [
      [`https://${t}.example.com/a`, true], [`https://github.com/${t}/repo`, true], [`s3://${t}/k`, true],
      [`git+ssh://git@${t}.io/x.git`, true], [`http://user:${t}@host/x`, true], [`https://kiro.dev#${t}`, true],
      [`https://github.com/awslabs/aidlc-workflows/issues/1?t=${t}`, true], [`https://kiro.dev/${t}`, false],
      [`__https://${t}.example.com/a__`, true], [`id_https://${t}.example.com/a`, true], [`www.${t}.example.com/a`, true],
    ] as Array<[string, boolean]>);
    return { text, secret: hidden ? t : undefined };
  },
  (r) => {
    const t = `${unique()}Ab9`;
    const [text, secret] = pick(r, [
      [`password=${t}`, t], [`"password": "${t}"`, t], [`api_key: ${t}`, t], [`TOKEN=${t}`, t], [`Bearer ${t}abcdefgh`, t],
      [`ghp_${t}abcdefghijklmnopqrstuvwxyz0123`, t], [`sk_live_${t}abcd`, t], [`glpat-${t}abcdefghijklmnop`, t],
      [["AKIA", "ABCDEFGHIJKLMNOP"].join(""), ["AKIA", "ABCDEFGHIJKLMNOP"].join("")], ["a1".repeat(21), "a1".repeat(21)],
    ] as Array<[string, string]>);
    return { text, secret };
  },
  (r) => {
    const [text, secret] = pick(r, [
      ["bob.smith@corp.example.org", "bob.smith@corp"], ["10.20.30.40", "10.20.30.40"], ["jane@contoso.com", "jane@"],
      ["jdoe-mbp", "jdoe-mbp"], ["Jane Doe", "jane doe"], ["rené@corp.example.org", "rené@"], ["김기현@corp.example.org", "김기현@"],
      ["fe80::1ff:fe23:4567:890a", "fe80::1ff"], ["2001:db8:85a3::8a2e:370:7334", "2001:db8"],
    ] as Array<[string, string]>);
    return { text, secret };
  },
  () => ({ text: "123456789012", secret: "123456789012", account: true }),
];

const isLabel = (p?: Piece) => !!p && /^<[^>]+>$/.test(p.text);

// Values at even places, a separator between each two. `apart`: every separator is one of BETWEEN; otherwise a
// label may meet its neighbour with nothing, a slash, a dash or a dot between.
function line(r: () => number, apart: boolean, gens = GENERATORS, between = BETWEEN): Piece[] {
  const out: Piece[] = [];
  for (let i = 0, n = 2 + Math.floor(r() * 8); i < n; i++) {
    const p = pick(r, gens)(r);
    const prev = out.at(-1);
    if (prev) out.push({ text: !apart && (isLabel(prev) || isLabel(p)) ? pick(r, BESIDE_LABEL) : pick(r, between) });
    out.push(p);
  }
  return out;
}

const SAFE: Array<(r: () => number) => Piece> = [
  (r) => ({ text: pick(r, WORDS.filter((w) => !w.includes("<"))) }),
  (r) => ({ text: pick(r, LABELS) }),
  (r) => ({ text: pick(r, ["~/.kiro/settings/cli.json", "~", "~/.claude", "~/<path>", "/Users/<user>/<path>", "<project>", "2026-10-30T08:00:00Z", "3/5"]) }),
];

type Property = (pieces: Piece[]) => string | null;

const refusesPlanted: Property = (pieces) =>
  pieces.some((p) => p.secret) && gate(pieces.map((p) => p.text).join(""), dict).length === 0 ? "the check passes a line with a planted value" : null;

const passesSafe: Property = (pieces) => {
  const hits = gate(pieces.map((p) => p.text).join(""), dict);
  return hits.length ? `the check refuses a safe line (${hits.map((h) => h.reason).join("; ")})` : null;
};

const redactsPlanted: Property = (pieces) => {
  const out = redact(pieces.map((p) => p.text).join(""), dict);
  // An account number beside a dot, a dash or a word is not one by redaction's rule (`1.123456789012` is a version).
  const notAccount = (i: number) => /[\w.-]$/.test(pieces[i - 1]?.text ?? "") || /^[\w.-]/.test(pieces[i + 1]?.text ?? "");
  const accountsKept = pieces.some((p, i) => p.account && notAccount(i));
  for (const p of pieces) {
    if (!p.secret || (p.account && accountsKept)) continue;
    if (out.toLowerCase().includes(p.secret.toLowerCase())) return "redact() leaves a planted value";
  }
  return null;
};

// Drop one value with a separator beside it while the line still breaks the same property.
function shrink(pieces: Piece[], property: Property, why: string): Piece[] {
  let cur = pieces;
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < cur.length; i += 2) {
      const next = i + 1 < cur.length ? cur.filter((_, j) => j !== i && j !== i + 1) : cur.slice(0, Math.max(0, i - 1));
      if (next.length && property(next) === why) {
        cur = next;
        changed = true;
        break;
      }
    }
  }
  return cur;
}

function failures(property: Property, make: (r: () => number) => Piece[]): string[] {
  const out: string[] = [];
  for (let seed = 1; seed <= 4000 && out.length < 10; seed++) {
    const pieces = make(rng(seed));
    const why = property(pieces);
    if (!why) continue;
    out.push(`seed ${seed}: ${why}: ${JSON.stringify(shrink(pieces, property, why).map((p) => p.text).join(""))}`);
  }
  return out;
}

describe("generated lines", () => {
  test("the check refuses every line with a planted value, however its pieces meet", () => {
    expect(failures(refusesPlanted, (r) => line(r, false))).toEqual([]);
  });
  test("the check refuses no line made only of safe pieces", () => {
    // Prose puts a space between words; a quote glued to the next word is not safe text.
    expect(failures(passesSafe, (r) => line(r, true, SAFE, BETWEEN.filter((b) => /\s/.test(b))))).toEqual([]);
  });
  test("redact() removes the planted values from a line whose pieces are apart", () => {
    expect(failures(redactsPlanted, (r) => line(r, true))).toEqual([]);
  });
});
