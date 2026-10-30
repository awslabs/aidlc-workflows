// What may leave the machine, decided on the files themselves and never through redaction: redact.ts cleans
// what collect.ts and hide.ts write as best it can, and this module refuses whatever is still not clearly safe,
// so a value redaction did not understand is refused here rather than passed.
//
// The report (English the model wrote) is refused line by line wherever a shape that can carry identity
// appears: an address, an email, an IP, a path or a dotted name outside AI-DLC's and the AI tools' own, an
// opaque token, a credential, an encoded spelling, markup, a letter outside ASCII, or a name in the redaction
// map. A label (`<project>`), a value the person allowed (allow.ts) and the fixed text of one of AI-DLC's own
// messages (lib-vocab.ts phrases) exempt only their own span: what a message filled in is read like any other word.
// What it is for: a value the model copies by mistake from a log or a record, in the form such values are usually
// written. It does not try to defeat text written to get past it (a name split by invisible characters or by a
// reference link); the model writes the report, and SKILL.md tells it how.
// safe.json is closed: each string, and each key that is data, is one of AI-DLC's words (local/vocab.json),
// this skill's own words (the literals in its scripts), a label, a time, a version, a count, a public model id
// or its field's own shape; the skill's own sentences (notes, knownGaps) get the report's rules.
// A refusal names the line or field and the reason, never the value.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Dictionary, findSecrets, KNOWN_FILE, KNOWN_SUB, keepsKey, LABEL, namesAt, PUBLIC_URL, TOOL_DIRS } from "./redact.ts";
import { isOsLine, isVersion, KERNEL_RELEASE, OWN, PUBLIC_MODEL } from "./lib-shape.ts";

export type GateContext = {
  // AI-DLC's words (collect.ts keeps them in local/vocab.json) and this skill's own.
  words: Set<string>;
  dict: Dictionary;
  // Exact values the person chose to include (allow.ts); they pass in the report only.
  allowed: string[];
  // The fixed text of AI-DLC's own messages (local/phrases.json), so one can be quoted as it is.
  phrases?: string[];
};
export type GateHit = { line: number; reason: string; field?: string };

// Every string literal in this skill's code: its own enumerations, kinds, labels and fixed words
// (`kiro (v3: Kiro CLI)`), which are the skill's text, never the person's. Comments are left out: their examples
// (`~/Clients/Contoso Merger.pdf`) are made-up names, not the skill's words.
const OWN_LITERAL = /"([^"\\\n]{1,120})"|'([^'\\\n]{1,120})'/g;
export function skillWords(dir = import.meta.dir): Set<string> {
  const words = new Set<string>();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".ts")) continue;
    const code = readFileSync(join(dir, f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .map((l) => l.replace(/\s\/\/\s.*$/, ""))
      .join("\n");
    for (const m of code.matchAll(OWN_LITERAL)) words.add(m[1] ?? m[2]);
  }
  return words;
}

// Stands in for a label or an allowed value while the rules read the text, one for each character it covers, so
// places in the text hold: not a letter, a digit, a space or any character a rule looks for, so the text around it
// is read as written and the span itself never matches. Text that already holds one is refused.
const MASK = "\uE000";
const MASKS = new RegExp(`${MASK}+`, "g");
const isMask = (v: string) => v.length > 0 && /^\uE000+$/.test(v);
const PRIVATE_USE = /[\uE000-\uF8FF]/;

// A label holds a small number (`<customer-12>`, a short `<id:…>`): a long one can carry an account in its name, and
// stays as text, which the markup rule refuses.
function labelMask(text: string): string {
  return text.replace(LABEL, (m) => (/\d{5}|id:[0-9a-f]{17}/.test(m) ? m : MASK.repeat(m.length)));
}

// The folder and file names a path may hold: AI-DLC's and the AI tools' own.
const PATH_WORDS = new Set([
  ...TOOL_DIRS.flat(), ...KNOWN_SUB, "~", ".", "..", "aidlc", "spaces", "intents", "diagnostics", "issue-reports", "tools",
  "hooks", "agents", "data", "stages", "sensors", "scopes", "knowledge", "memory", "aidlc-common", "local",
]);
const OWN_FILES = new Set(["safe.json", "aidlc-issue-report.md", "report.json", "SKILL.md", "AGENTS.md", "CLAUDE.md"]);
const ABBREVIATIONS = new Set(["e.g", "i.e", "etc", "vs", "a.m", "p.m", "node.js", "next.js", "vue.js", "nuxt.js", "express.js", "asp.net"]);
const TIME = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?Z?)?$/;

// A public model id holds no long number (an account in `claude-123456789012`).
function known(ctx: GateContext, word: string): boolean {
  return (
    ctx.words.has(word) ||
    (PUBLIC_MODEL.test(word) && !/\d{10}/.test(word)) ||
    TIME.test(word) ||
    KERNEL_RELEASE.test(word) ||
    isVersion(word)
  );
}

// A dotted word that is not a version: a host, a domain or a file name, unless it is one of AI-DLC's.
function dottedOk(ctx: GateContext, word: string): boolean {
  return known(ctx, word) || KNOWN_FILE.test(word) || OWN_FILES.has(word) || ABBREVIATIONS.has(word.toLowerCase());
}

// A home folder's own root (`/Users/<user>`, `C:\\Users\\<user>`) is a path's first part, and the user's name after it
// a label; a doubled separator (JSON's `\\\\`) reads as one.
const ROOTS = new Set(["Users", "users", "home"]);
// A path starts where AI-DLC's and the tools' own do: a label (`<project>/…`), the home folder, a home root, a drive, a
// relative `.`, or one of their own folders (`.kiro/…`, `aidlc/…`); a fraction (`3/5`) is not a path. A file is named
// with its line too (a state file's name, a colon and the line number).
const PATH_STARTS = new Set(["~", ".", "..", "aidlc", "local", ...TOOL_DIRS.map((d) => d[0])]);
function pathOk(ctx: GateContext, raw: string): boolean {
  const token = raw.replace(/:\d{1,6}(?::\d{1,4})?$/, "");
  if (/^\d{1,4}\/\d{1,4}$/.test(token)) return true;
  const segs = token.split(/[\\/]+/);
  const first = segs.find((x) => x !== "") ?? "";
  if (!(isMask(first) || PATH_STARTS.has(first) || ROOTS.has(first) || /^[A-Za-z]:$/.test(first))) return false;
  return segs.every((s, i) => {
    if (s === "") return i === 0 || i === segs.length - 1;
    if (i <= 1 && /^[A-Za-z]:$/.test(s)) return true;
    if (i <= 2 && ROOTS.has(s)) return segs[i + 1] === undefined || isMask(segs[i + 1]);
    if (isMask(s) || /^\d{1,4}$/.test(s)) return true;
    return PATH_WORDS.has(s) || ctx.words.has(s) || (s.includes(".") && dottedOk(ctx, s));
  });
}

const WRAP_START = /^[`"'([{*_>|]+/;
const WRAP_END = /[`"')\]}*_,;:!?.|]+$/;
// A closing bracket the word opened stays (`claude-opus-5-5[1m]`).
function unwrap(raw: string): string {
  const t = raw.replace(WRAP_START, "");
  const end = t.match(WRAP_END)?.[0] ?? "";
  const keep = t.includes("[") && end.startsWith("]") ? 1 : 0;
  return t.slice(0, t.length - end.length + keep);
}

// IPv6, full or with `::` (`fe80::1ff:fe23:4567:890a`, `10:20::30:40`): a time (`10:20:30`) has no `::`, and a slice
// (`[1::2]`) has two groups, without a run of three hex digits.
function ipv6(t: string): boolean {
  if (/(?<![\w:])(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}(?![\w:])/.test(t)) return true;
  for (const m of t.matchAll(/(?<![\w:])[0-9A-Fa-f:]*::[0-9A-Fa-f:]*(?![\w:])/g)) {
    const groups = m[0].split(":").filter(Boolean);
    if (groups.every((g) => g.length <= 4) && (groups.length >= 3 || (groups.length >= 1 && /[0-9A-Fa-f]{3}/.test(m[0])))) return true;
  }
  return false;
}

// The reasons one whitespace-separated word of a masked line is refused for.
function wordReasons(ctx: GateContext, raw: string): string[] {
  const out: string[] = [];
  // Read before its signs are trimmed (`2001:db8::`); a slice in brackets (`[1::2]`) is not one.
  const bare = raw.replace(/^[`"'(*_>|]+|[`"')*_,;.!?|]+$/g, "");
  if (!/^\[.*\]$/.test(bare) && /^[0-9A-Fa-f:]*::[0-9A-Fa-f:]*$/.test(bare) && /[0-9A-Fa-f]/.test(bare) && bare.split(":").every((g) => g.length <= 4)) {
    out.push("an IP address");
  }
  const t = unwrap(raw).replace(/(\.[A-Za-z]{1,5}):\d{1,6}(?::\d{1,4})?$/, "$1");
  if (!t || isMask(t)) return out;
  // AI-DLC's own public addresses are not the person's (redact.ts PUBLIC_URL): one whose path is plain words, with no
  // query, fragment, sign or address after the host, as an issue or a docs page is linked.
  if (PUBLIC_URL.test(t) && /^https?:\/\/[\w.-]+(?:\/[A-Za-z0-9_-]+(?:\.[A-Za-z]{1,5})?)*\/?$/.test(t)) return out;
  if (/:\/\/|(?:^|[^\w.])www\./i.test(t)) out.push("an address");
  if (/[\w.%+-]@[\w\uE000]|@[\w-]+\.[A-Za-z]/.test(t)) out.push("an email address");
  if (/%[0-9A-Fa-f]{2}|&#?[A-Za-z0-9]{2,40};|\\u\{?[0-9A-Fa-f]{4}|\\x[0-9A-Fa-f]{2}/.test(t)) out.push("an encoded spelling");
  // A WSL kernel release (`5.15.167.4-microsoft-standard-WSL2`) is not an IPv4 address; a host name that spells one
  // (`ip-10-0-1-23`, `ec2-3-91-12-4`) is.
  if ((/(?<!\d)\d{1,3}(?:\.\d{1,3}){3}(?!\d)/.test(t) && !KERNEL_RELEASE.test(t)) || ipv6(t) || /(?<!\d)\d{1,3}(?:-\d{1,3}){3}(?!\d)/.test(t)) {
    out.push("an IP address");
  }
  if (/(?<![\w:-])(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}(?![\w:-])/.test(t)) out.push("a hardware address");
  if (/\barn:aws[\w-]*:/i.test(t) || /\b(?:sg|subnet|vpc|i|ami|eni|vol|snap|rtb|igw|nat|acl|eipalloc|lt|tgw|pcx|vpce)-[0-9a-f]{8,17}\b/.test(t)) {
    out.push("a cloud resource name");
  }
  // A file whose name is a dot and a word (`.env`) or a number and an extension (`2026.csv`), unless the tools' own.
  // A path is read by its parts above.
  if (!/[\\/]/.test(t) && ((/^\.[A-Za-z][\w-]*$/.test(t) && !PATH_WORDS.has(t) && !ABBREVIATIONS.has(t.toLowerCase())) || /^\d+\.[A-Za-z][A-Za-z0-9]{0,4}$/.test(t))) {
    out.push("a dotted name (a host or a file name)");
  }
  if (/<[A-Za-z/!?]/.test(t)) out.push("markup, or a placeholder left from the template");
  if (/[\\/]/.test(t) && /[\w\uE000]/.test(t) && !out.includes("an address") && !pathOk(ctx, t)) out.push("a path (write `<project>`, `<path>` or describe it; write \"or\", not a slash)");
  // A name around a label (`<customer-1>.com`) reads as a name around any word.
  const plain = t.replace(MASKS, "x");
  for (const w of plain.split(/[\\/]/)) {
    if (/(?<![\w-])[A-Za-z][\w-]*\.[\w-]*[A-Za-z]/.test(w) && !dottedOk(ctx, w)) {
      out.push("a dotted name (a host or a file name)");
      break;
    }
  }
  // A name and its value (`SENSOR_PASSED=29`) are two words; the credential rules read the pair.
  for (const f of t.split(/[\uE000\\/=:,]+/)) {
    if (!f || known(ctx, f)) continue;
    const mixed = f.length >= 16 && /[A-Za-z]/.test(f) && /\d/.test(f);
    const long = f.length >= 28 && /^[A-Za-z0-9+/=_-]+$/.test(f) && !/^[a-z]+(?:-[a-z]+)+$/.test(f);
    if (mixed || long) {
      out.push("an opaque token (an id, a key or a hash)");
      break;
    }
  }
  return out;
}

// A credential is refused whatever its value, unless the value is a label (`password=<redacted>`) or a value the
// person allowed. Its name is read by its words, however it is spelled (`db_password`, `dbPassword`, `GITHUB_TOKEN`,
// `api-key`, `PGPASSWORD`): one of SECRET_WORDS, `key` in a name of several words (`Key finding:` is prose), or a
// one-word name in capitals that holds a long one. A name that also says it holds a count, a limit or a mode
// (`token_count`, `AUTH_MODE`) is not one, and neither is this skill's own `secretRules` field.
const SECRET_WORDS = new Set([
  "password", "passwd", "pwd", "pw", "pass", "passphrase", "passcode", "secret", "token", "apikey", "credential",
  "credentials", "auth", "authorization", "bearer", "cookie", "sid",
]);
const LONG_SECRET_WORDS = ["password", "passwd", "secret", "token", "apikey"];
const NOT_SECRET_WORDS = new Set(["count", "counts", "limit", "max", "min", "total", "mode", "budget", "usage", "size", "ttl", "type", "kind", "status", "length", "file", "path", "url", "stdin", "expiry", "expires"]);
// What an auth setting says, not a secret (`auth: ok`, `Auth: none`).
const AUTH_STATES = /^(?:ok|none|null|true|false|yes|no|on|off|enabled|disabled|required|optional|oauth|sso|iam|basic|bearer)$/i;
// A word of prose after a name (`GITHUB_TOKEN was set`) is not its value.
const PROSE = new Set(["is", "was", "were", "are", "be", "been", "set", "unset", "not", "missing", "empty", "expired", "exported", "variable", "env", "value", "flag", "file", "and", "or", "in", "on", "to", "for", "from", "with", "without", "the", "a", "an", "of", "that", "which", "if", "when", "reset", "prompt"]);
function nameWords(name: string): string[] {
  return name
    .replace(/(?<=[a-z0-9])(?=[A-Z])/g, " ")
    .split(/[\s_.-]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}
function secretName(name: string): boolean {
  if (name === "secretRules") return false;
  const words = nameWords(name);
  if (words.some((w) => NOT_SECRET_WORDS.has(w))) return false;
  if (words.some((w) => SECRET_WORDS.has(w)) || (words.length > 1 && words.includes("key"))) return true;
  return /^[A-Z][A-Z0-9]{3,}$/.test(name) && LONG_SECRET_WORDS.some((s) => words[0] !== s && words[0].includes(s) && !words[0].endsWith("s"));
}
// A name's value is not a secret when it is a label, a pass count (`Pass: 29`), or an auth setting.
function exempt(name: string, v: string): boolean {
  if (!v || isMask(v)) return true;
  const words = nameWords(name);
  if (/^\d{1,9}$/.test(v) && (words.join("") === "pass" || words.join("") === "passed")) return true;
  if (words.join("") === "pass" && /^(?:true|false|null)$/.test(v)) return true;
  return words.some((w) => w === "auth" || w === "authorization") && !words.some((w) => LONG_SECRET_WORDS.includes(w) || w === "pwd") && AUTH_STATES.test(v);
}
const VALUE = String.raw`(?=["'\x60]?([^\s"'\x60,;]+))`;
// `name: value`, `name=value`, a value on the next line too. The value is read without being taken, so a name inside
// it (`error: DB_PASSWORD=…`) is read as a name in its turn.
const NAMED_VALUE = new RegExp(String.raw`(?<![A-Za-z0-9_.-])([A-Za-z][A-Za-z0-9_.-]*)["'\x60]?\s*[:=]\s*${VALUE}`, "g");
// `--password value`, `--token=value`.
const FLAG_VALUE = new RegExp(String.raw`(?<![\w-])--?([A-Za-z][\w-]*)(?:\s+|=)${VALUE}`, "g");
// A code-style name and its value after a space (`PGPASSWORD hunter2`, `apiKey hunter2`).
const CODE_VALUE = new RegExp(String.raw`(?<![\w.-])([A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+|[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][A-Z0-9]{3,})\s+${VALUE}`, "g");

// Where each credential stands in `masked`, labels masked one for one (it may span lines: a value can follow its name
// on the next one).
function credentialSpans(masked: string): [number, number][] {
  const out: [number, number][] = [];
  const span = (m: RegExpMatchArray, extra = 0) => out.push([m.index ?? 0, (m.index ?? 0) + m[0].length + extra]);
  // A value loses the Markdown and the sentence signs after it, never its own (`pw='!!!'` is a value).
  const value = (v: string) => {
    const t = v.replace(/[*_`'")\]}]+$/, "").replace(/(?<=\w)[.,:;!?]+$/, "");
    return /^[*_`]*$/.test(v) ? "" : t || v;
  };
  // An authorization header takes a label and nothing else.
  for (const m of masked.matchAll(/\bauthorization\b["'`]?\s*[:=]\s*["'`]?(?:basic|bearer)\s+([^\s"'`,;]+)/gi)) if (!isMask(value(m[1]))) span(m);
  for (const m of masked.matchAll(NAMED_VALUE)) {
    const v = value(m[2]);
    // A value of signs only (`**password:** <redacted>`) is the next word's: the visible reading takes it.
    if (!secretName(m[1]) || exempt(m[1], v)) continue;
    if (/^(?:basic|bearer)$/i.test(v) && nameWords(m[1]).some((w) => w === "authorization" || w === "auth")) continue;
    span(m, m[2].length + 1);
  }
  for (const re of [FLAG_VALUE, CODE_VALUE]) {
    for (const m of masked.matchAll(re)) {
      const v = value(m[2]);
      if (secretName(m[1]) && !exempt(m[1], v) && !v.startsWith("-") && !PROSE.has(v.toLowerCase())) span(m, m[2].length + 1);
    }
  }
  // `password hunter2` in prose or a .netrc line: a value with a digit or a sign, or any value after `login <name>`.
  for (const m of masked.matchAll(/\b(?:password|passwd|pwd)\s+(?=["'`]?([^\s"'`,;]+))/gi)) {
    const v = value(m[1]);
    if (!isMask(v) && (/[^A-Za-z]/.test(v) || /\blogin\s+\S+\s+$/i.test(masked.slice(0, m.index)))) span(m, m[1].length);
  }
  // A JVM property (`-Dpassword=…`, `-Ddb.secret=…`).
  for (const m of masked.matchAll(/(?<![\w-])-D([\w.-]+)=([^\s"'`,;]+)/g)) {
    if (secretName(m[1].split(".").at(-1) ?? "") && !isMask(value(m[2]))) span(m);
  }
  // Commands that take a user and a password: `curl -u admin:secret`, `mysql -u admin -pSecret`, `docker login -u bob
  // -p secret`, `sshpass -p secret`, `redis-cli -a secret`. A port (`ssh -p 22`) is a number.
  for (const m of masked.matchAll(/(?<![\w-])(?:-u|--user)\s*[^\s:]+:([^\s"'`]+)/g)) if (!isMask(value(m[1]))) span(m);
  let offset = 0;
  for (const line of masked.split(/(?=\n)/)) {
    const userGiven = /(?<![\w-])(?:-u|--user)\s*\S|\b(?:mysql|mariadb|mysqldump|psql|sshpass)\b/.test(line);
    const pass = userGiven ? [...line.matchAll(/(?<![\w-])-p(?:\s+["'`]?([^\s"'`]+)|([^\s"'`]+))/g)] : [];
    for (const m of pass) {
      const v = value(m[1] ?? m[2] ?? "");
      if (v && !isMask(v) && !/^\d{1,5}$/.test(v) && !v.startsWith("-")) out.push([offset + (m.index ?? 0), offset + (m.index ?? 0) + m[0].length]);
    }
    for (const m of line.matchAll(/\bredis-cli\b[^\n]*?(?<![\w-])-a\s+["'`]?([^\s"'`]+)/g)) if (!isMask(value(m[1]))) out.push([offset + (m.index ?? 0), offset + (m.index ?? 0) + m[0].length]);
    offset += line.length;
  }
  for (const m of masked.matchAll(/\b(?:set-)?cookie\s*:\s*([^\s]+)/gi)) if (!isMask(value(m[1]))) span(m);
  // `bearer token`, said in prose, is not a credential; `Basic Onboarding` is a word, not base64.
  for (const m of masked.matchAll(/\bbearer\s+([^\s"'`,;]+)/gi)) if (!isMask(value(m[1])) && !/^[a-z]{1,12}$/.test(m[1])) span(m);
  for (const m of masked.matchAll(/\bbasic\s+([A-Za-z0-9+/]{6,}={0,2})(?![\w+/=])/gi)) if (!/^[A-Z]?[a-z]+$/.test(m[1])) span(m);
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY/.test(masked)) out.push([masked.indexOf("-----BEGIN"), masked.length]);
  return out;
}

// The typographic signs a report may use beside printable ASCII; anything else (a control character, a letter of
// another script, a full-width sign, an invisible or a non-breaking space) can carry or hide a name.
const OUTSIDE_ASCII = /[^\t\r -~\uE000—–·→←…×“”‘’•✓✗≥≤±°]/u;

// Numbers that name a person or an account: ten digits or more in a row (a card, a phone, an account), a phone number
// in its usual groups, a social security number, an account or a card in groups of four.
function numberReason(masked: string): string | null {
  const digits = masked.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, " ");
  if (/(?<!\d)\d{10,}(?!\d)/.test(digits)) return "a long number (an account, a card or a phone)";
  if (/(?<![\w.])(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?|\d{2,4}[ .-])\d{3,4}[ .-]\d{4}(?![\w.])/.test(digits)) return "a phone number";
  // International phone numbers in their own groups (`+33 1 23 45 67 89`): eight digits or more after the country code.
  for (const m of digits.matchAll(/\+\d{1,3}(?:[ .-]?\(?\d{1,4}\)?){2,6}/g)) if (m[0].replace(/\D/g, "").length >= 9) return "a phone number";
  // A social security number, a Korean resident number.
  if (/(?<!\d)\d{3}([- ])\d{2}\1\d{4}(?!\d)|(?<!\d)\d{6}-\d{7}(?!\d)/.test(digits)) return "a personal number";
  if (/(?<!\d)\d{12}(?!\d)|(?<!\d)\d{4}([- ])\d{4}\1\d{4}(?:\1\d{4})?(?!\d)|(?<!\d)\d{4}([- ])\d{6}\2\d{5}(?!\d)/.test(digits)) return "an account number";
  return null;
}

function lineReasons(ctx: GateContext, masked: string): string[] {
  const out = new Set<string>();
  if (OUTSIDE_ASCII.test(masked)) out.add("a character outside ASCII (write it in English, or hide the name)");
  for (const word of masked.split(/\s+/)) for (const r of wordReasons(ctx, word)) out.add(r);
  const n = numberReason(masked);
  if (n) out.add(n);
  return [...out];
}

// Where each value the person allowed stands as a whole word: start or end of the line, a space, a bracket, a quote or
// emphasis around it (`10` never inside `192.168.10.5`, `password` never in `password=…`).
function allowedSpans(ctx: GateContext, text: string): [number, number][] {
  const out: [number, number][] = [];
  for (const v of ctx.allowed) {
    const body = v.normalize("NFC").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!body) continue;
    const re = new RegExp(String.raw`(?<=^|[\s(\[{"'\x60*_~])${body}(?=$|[\s)\]}"'\x60*_~,;!?]|\.(?:\s|$))`, "gm");
    for (const m of text.matchAll(re)) out.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  return out;
}
const inside = (spans: [number, number][], [s, e]: [number, number]) => spans.some(([a, b]) => a <= s && e <= b);
// Where AI-DLC's own message text stands, as written.
function phraseSpans(ctx: GateContext, text: string): [number, number][] {
  const out: [number, number][] = [];
  for (const p of ctx.phrases ?? []) {
    for (let at = text.indexOf(p); at >= 0; at = text.indexOf(p, at + p.length)) out.push([at, at + p.length]);
  }
  return out;
}
function maskAllowed(text: string, spans: [number, number][]): string {
  let out = text;
  for (const [a, b] of spans) out = out.slice(0, a) + MASK.repeat(b - a) + out.slice(b);
  return out;
}

// The text as it reads once Markdown's emphasis, inline links, entities, invisible characters and line breaks are
// gone and spaces collapsed, so a hidden name written `Con**toso**`, `Acme  Corp` or over two lines, and a credential
// written `**password**: …`, are read whole. `lineOf` maps a place back to its line.
function visible(text: string): { text: string; lineOf: (at: number) => number } {
  const starts: number[] = [];
  let joined = "";
  for (const line of text.split(/\r?\n/)) {
    starts.push(joined.length);
    const v = line
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/&#?[A-Za-z0-9]{2,40};/g, "")
      .replace(/[*`~\u00AD\u200B-\u200D\u2060\uFEFF]|(?<!\w)_+|_+(?!\w)/g, "")
      .replace(/\s+/g, " ");
    joined += `${v} `;
  }
  return { text: joined, lineOf: (at) => starts.filter((s) => s <= at).length };
}

const lineAt = (text: string, at: number) => text.slice(0, at).split(/\r?\n/).length;

// The report, or any text the model wrote: every line refused for each reason that holds in it.
export function textHits(ctx: GateContext, raw: string): GateHit[] {
  const text = raw.normalize("NFC");
  const hits: GateHit[] = [];
  const allowed = [...allowedSpans(ctx, text), ...phraseSpans(ctx, text)];
  const labelled = labelMask(text);
  const masked = labelMask(maskAllowed(text, allowed));
  // Shapes, word by word, with labels and allowed values standing in.
  masked.split(/\r?\n/).forEach((line, i) => {
    for (const reason of lineReasons(ctx, line)) hits.push({ line: i + 1, reason });
  });
  text.split(/\r?\n/).forEach((line, i) => {
    if (PRIVATE_USE.test(line)) hits.push({ line: i + 1, reason: "a character outside ASCII (write it in English, or hide the name)" });
  });
  // Credentials and names, as written: an allowed value exempts one only when it covers the whole of it.
  for (const span of credentialSpans(labelled)) if (!inside(allowed, span)) hits.push({ line: lineAt(text, span[0]), reason: "a credential" });
  for (const { entry, at, length } of namesAt(text, ctx.dict)) {
    if (!inside(allowed, [at, at + length])) hits.push({ line: lineAt(text, at), reason: `a name in the redaction map (write ${entry.label})` });
  }
  // The same on the visible text, with allowed values left out.
  const shown = visible(masked);
  for (const [at] of credentialSpans(shown.text)) hits.push({ line: shown.lineOf(at), reason: "a credential" });
  for (const { entry, at } of namesAt(visible(maskAllowed(text, allowed)).text, ctx.dict)) {
    hits.push({ line: shown.lineOf(at), reason: `a name in the redaction map (write ${entry.label})` });
  }
  // AI-DLC's own secret rules, when the install has them, find what the shapes above do not.
  for (const s of findSecrets(maskAllowed(text, allowed))) hits.push({ line: s.line, reason: "a secret, by AI-DLC's own rules" });
  return dedupe(hits);
}

function dedupe(hits: GateHit[]): GateHit[] {
  const seen = new Set<string>();
  return hits.filter((h) => {
    const k = `${h.field ?? ""}|${h.line}|${h.reason}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// safe.json fields that hold this skill's own sentences: read as text.
const PROSE_FIELDS = new Set(["notes", "note", "knownGaps", "error", "otherStores"]);
// Fields with a shape of their own.
const HEX_FIELDS = new Set(["Error Fingerprint", "Error Group"]);
const PATH_FIELDS = new Set(["dir", "exe", "secretRules"]);
const labelOr = (ctx: GateContext, v: string) => known(ctx, v) || isMask(labelMask(v));

function atomOk(ctx: GateContext, value: string, field: string): boolean {
  if (value === "") return true;
  const v = value.endsWith(OWN) ? value.slice(0, -OWN.length) : value;
  if (PRIVATE_USE.test(v)) return false;
  if (isMask(labelMask(v)) || known(ctx, v)) return true;
  // A count (`3`, `2 / 5`), or a mark of a few signs (a stage's `-`).
  if (/^\d{1,9}(?:\s*\/\s*\d{1,9})?$/.test(v) || /^[!-/:-@[-`{-~]{1,3}$/.test(v)) return true;
  // A stage's mark in the state file (`x`, `S`, `-`).
  if (field === "stages" && /^[A-Za-z]{1,2}$/.test(v)) return true;
  if (HEX_FIELDS.has(field)) return /^[0-9a-f]{6,64}$/i.test(v);
  if (field === "sourceRef") return /^[0-9a-f]{7,13}$/.test(v) || /^refs\/tags\/v\d{1,4}\.\d{1,4}\.\d{1,4}(?:-preview\.\d{8}\.\d{1,4})?$/.test(v);
  if (field === "os") return isOsLine(v);
  // The project's own AI-DLC file the secret rules came from (`.claude/tools/aidlc-doctor-bundle.ts`).
  if (field === "secretRules" && /^\.[a-z][\w-]*[\\/]tools[\\/]aidlc-doctor-bundle\.ts$/.test(v)) return true;
  // An error repeated on one tool, and an engine check the agent ran by hand.
  const repeated = v.match(/^same-error-repeated x\d{1,6} \((.+)\)$/);
  if (field === "kind" && repeated) return repeated[1] === "?" || labelOr(ctx, repeated[1]);
  const check = v.match(/^sensor-([a-z][a-z-]*|<[^>]+>)(?: --stage (\S+))?$/);
  if (field === "check" && check) return labelOr(ctx, check[1]) && (!check[2] || labelOr(ctx, check[2]));
  if (PATH_FIELDS.has(field)) return !/:\/\//.test(v) && pathOk(ctx, labelMask(v));
  // A command AI-DLC gave: AI-DLC's words with its own spacing.
  const parts = v.split(/ |, /);
  return parts.length > 1 && parts.every((p) => labelOr(ctx, p));
}

// safe.json, decoded: each string checked by its field, each key that is data (not one of this skill's field
// names) checked as a value. `line` is the field's place among the leaves.
export function safeHits(ctx: GateContext, value: unknown): GateHit[] {
  const hits: GateHit[] = [];
  // A name kept for the report only (part of AI-DLC's own words) is left to AI-DLC's words in safe.json.
  const names = (v: string) => namesAt(v, ctx.dict).filter((n) => n.entry.kind !== "report-only").map((n) => `a name in the redaction map (write ${n.entry.label})`);
  let n = 0;
  const walk = (v: unknown, path: string, field: string, parent: string) => {
    if (Array.isArray(v)) {
      for (const [i, x] of v.entries()) walk(x, `${path}[${i}]`, field, parent);
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        const own = keepsKey(parent, k);
        // A data key and its value read together, as `name=value`: a secret's name in the key, its value beside it.
        // This skill's own field names (`pass`, `secretRules`) are not secrets' names.
        const pair = (val: unknown) => credentialSpans(labelMask(`${k}=${String(val)}`)).length > 0;
        const leaves = Array.isArray(x) ? x : [x];
        if (!own && leaves.some((val) => val === null || typeof val !== "object") && leaves.some((val) => (val === null || typeof val !== "object") && pair(val))) {
          hits.push({ line: n + 1, field: `${path}.<key>`, reason: "a credential" });
        }
        if (!own) {
          n++;
          if (!atomOk(ctx, k, parent)) hits.push({ line: n, field: `${path} (a key)`, reason: "not one of AI-DLC's words, a label or a known shape" });
          for (const reason of names(k)) hits.push({ line: n, field: `${path} (a key)`, reason });
        }
        walk(x, `${path}.${own ? k : "<key>"}`, own ? k : field, own ? k : "");
      }
      return;
    }
    n++;
    // A count holds up to nine digits; a longer number can be an account or a phone number.
    if (typeof v === "number" && Math.abs(v) >= 1e9) hits.push({ line: n, field: path, reason: "a long number (replace it with <redacted>)" });
    if (typeof v !== "string") return;
    // The skill's own sentences get the report's rules, unless one is a sentence of this skill as written; a value the
    // person allowed is for the report only.
    if (PROSE_FIELDS.has(field) && ctx.words.has(v)) {
      // one of this skill's fixed sentences
    } else if (PROSE_FIELDS.has(field)) {
      for (const h of textHits({ ...ctx, allowed: [], phrases: [] }, v)) hits.push({ line: n, field: path, reason: h.reason });
    } else if (!atomOk(ctx, v, field)) {
      hits.push({ line: n, field: path, reason: "not one of AI-DLC's words, a label or a known shape (replace it with <redacted>)" });
    }
    for (const reason of names(v)) hits.push({ line: n, field: path, reason });
  };
  walk(value, "safe", "", "");
  return dedupe(hits);
}
