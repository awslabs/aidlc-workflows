// Redaction for what collect.ts and hide.ts write into safe.json: best-effort cleanup after lib-shape.ts has kept
// every field to AI-DLC's own words, numbers, times and labels. It does not decide what may be sent: lib-gate.ts
// checks the finished files on its own rules, so whatever this misses is refused there. Three layers, applied to
// text normalized to NFC (a macOS folder name is stored decomposed; the same name typed is not):
//   1. a dictionary of values known on this machine (project and home paths, user name, git identity, git
//      remote org/repo, host name, intent/space/unit names, the names the person confirmed) -> labels;
//   2. patterns for values that are identifying wherever they appear (emails, URLs, IPs, account numbers,
//      home-folder paths, long ids);
//   3. AI-DLC's own secret rules (keys, tokens, passwords), loaded from the AI-DLC the project has
//      installed (useSecretRules): AI-DLC owns what a secret looks like, for its audit record and doctor
//      export alike.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { basename, resolve } from "node:path";
import { AUDIT_FIELDS } from "./lib-audit.ts";

export type Entry = { value: string; label: string; kind: string };
// `skipped`: one-word values left out because they are ordinary words or too short; kept in
// the local redaction map so the model can keep them out of the report by hand.
// `secretRulesFrom`: the installed AI-DLC file the secret rules came from, so check.ts and hide.ts use the same.
export type Dictionary = { entries: Entry[]; skipped?: Entry[]; secretRulesFrom?: string | null };

// AI-DLC's own public locations stay readable: they are the same for everyone. The host (or repository)
// must end there, and a query or fragment, which can carry a tenant or a ticket, is dropped.
export const PUBLIC_URL = /^https?:\/\/(?:github\.com\/awslabs\/aidlc-workflows|kiro\.dev|docs\.github\.com|code\.claude\.com)(?=[/?#]|$)/i;

// The labels this skill and AI-DLC's own redaction write. A dictionary name is never looked for inside one
// (a Unit called `email` would break `<email>`); any other `<…>` is ordinary text, `List<Contoso>` included.
export const LABEL =
  /<(?:user|host|project|org|repo|email|url|ip|account|path|id|git-remote|aidlc-install|field|id:[0-9a-f]+|redacted(?:-(?:token|key|hex|jwt|aws-key|private-key))?|(?:intent|space|unit|org|customer|product|person|name)-\d+|custom-(?:stage|phase|scope|sensor|hook|agent|model|effort|tool|value|event|guard|harness|denial|mode|check|build|doctor-finding|unit|intent)-\d+)>/g;

// Too short or too generic to replace without wrecking the text.
const GENERIC = new Set([
  "user", "users", "admin", "administrator", "root", "home", "dev", "test", "main", "work", "src", "app",
  "aidlc", "kiro", "claude", "codex", "copilot", "cursor", "default", "project", "workspace", "ubuntu", "ec2-user",
]);

// A one-word value that is also an ordinary word would replace the word everywhere ("the agent <user>
// retry <project>-analysis"): AI-DLC's own names (passed in from lib-vocab.ts, with its phase and stage
// words here for an install that has none) and English words that are also first names, surnames or
// folder names. The full value (a whole name, a path) is still replaced; only the bare word is left alone.
const ORDINARY = new Set([
  "initialization", "ideation", "inception", "construction", "operation", "operations",
  "analysis", "approval", "build", "capture", "code", "contract", "definition", "delivery", "deployment", "design",
  "detection", "discovery", "domain", "engineering", "environment", "execution", "feasibility", "feedback",
  "formation", "functional", "generation", "handoff", "incident", "infrastructure", "intent", "market", "mockups",
  "observability", "optimization", "performance", "pipeline", "planning", "practices", "provisioning", "refined",
  "requirements", "research", "response", "reverse", "rough", "scaffold", "scope", "setup", "state", "stories",
  "team", "units", "unit", "validation", "bugfix", "classic", "enterprise", "express", "feature", "infra", "patch",
  "refactor", "security", "workshop", "product", "architect", "architecture", "developer", "quality", "compliance",
  "platform", "review", "reviewer", "stage", "gate", "bolt", "space", "plan", "spec", "sensor", "agent", "agents",
  "doctor", "status", "report", "replay", "config", "update", "hooks", "engine", "orchestrate", "replies", "trees",
  "will", "may", "mark", "bill", "grace", "hope", "joy", "rose", "june", "april", "august", "art", "dawn", "faith",
  "chase", "hunter", "page", "reed", "wood", "king", "young", "long", "brown", "white", "green", "black", "gray",
  "grey", "rich", "frank", "max", "sky", "summer", "star", "river", "stone", "lane", "hill", "park", "ford", "dean",
  "ray", "rob", "sun", "moon", "alpha", "beta", "demo", "sample", "example", "docs", "web", "api", "server",
  "client", "backend", "frontend", "service", "services", "portal", "apps", "site", "data", "core", "tools",
  "scripts", "lib", "new", "old", "temp", "tmp", "tests", "my", "our", "the", "and", "sandbox", "lab",
  "labs", "playground", "scratch", "projects", "repos", "git", "github", "source",
]);

export function ordinaryWord(value: string): boolean {
  const v = value.toLowerCase();
  return GENERIC.has(v) || ORDINARY.has(v);
}

function git(project: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", project, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function add(entries: Entry[], value: string | undefined, label: string, kind: string, skipped: Entry[], ordinary: Set<string>): void {
  const v = (value ?? "").trim().normalize("NFC");
  if (!v || GENERIC.has(v.toLowerCase())) return;
  // A value of one or two characters (`이진`, `Li`) would match inside other words: kept in `skipped` too, so the
  // model knows to keep it out of the report (a non-ASCII one is refused there anyway).
  if ([...v].length < 3) {
    if (kind !== "path" && !skipped.some((e) => e.value.toLowerCase() === v.toLowerCase())) skipped.push({ value: v, label, kind });
    return;
  }
  if (entries.some((e) => e.value.toLowerCase() === v.toLowerCase())) return;
  if (kind !== "path" && kind !== "git-remote" && !/[\s/\\]/.test(v) && (ORDINARY.has(v.toLowerCase()) || ordinary.has(v.toLowerCase()))) {
    if (!skipped.some((e) => e.value.toLowerCase() === v.toLowerCase())) skipped.push({ value: v, label, kind });
    return;
  }
  entries.push({ value: v, label, kind });
}

// Owner and repository from a git remote URL, in any of its usual shapes.
function remoteParts(url: string): { host?: string; owner?: string; repo?: string } {
  // A port after the host (`ssh://git@host:2222/team/repo.git`) is not part of the path.
  const m = url.match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+(?=\/))?[:/]+(.+?)(?:\.git)?\/?$/i);
  if (!m) return {};
  const parts = m[2].split("/").filter(Boolean);
  return { host: m[1], owner: parts.length > 1 ? parts.slice(0, -1).join("/") : undefined, repo: parts.at(-1) };
}

export function buildDictionary(
  project: string,
  extra: {
    intents?: string[];
    spaces?: string[];
    units?: string[];
    paths?: { value: string; label: string }[];
    ordinary?: Set<string>;
  } = {},
): Dictionary {
  const entries: Entry[] = [];
  const skipped: Entry[] = [];
  const ordinary = new Set([...(extra.ordinary ?? [])].map((w) => w.toLowerCase()));
  const put = (value: string | undefined, label: string, kind: string) => add(entries, value, label, kind, skipped, ordinary);
  const projectAbs = resolve(project);
  const home = homedir();
  // Paths first and longest first, so "<project>" wins over "~".
  // Each path also as the other separator writes it (`D:\\work\\shop` is `D:/work/shop` in a tool's log).
  const path = (value: string, label: string) => {
    put(value, label, "path");
    put(value.replaceAll("\\", "/"), label, "path");
    put(value.replaceAll("/", "\\"), label, "path");
  };
  path(projectAbs, "<project>");
  for (const { value, label } of extra.paths ?? []) path(value, label);
  path(home, "~");
  put(basename(projectAbs), "<project>", "project-name");
  let user = "";
  try {
    user = userInfo().username;
  } catch {
    user = process.env.USER ?? process.env.USERNAME ?? "";
  }
  put(user, "<user>", "os-user");
  put(basename(home), "<user>", "os-user");
  put(hostname(), "<host>", "host");
  put(hostname().split(".")[0], "<host>", "host");
  const gitName = git(projectAbs, ["config", "user.name"]);
  put(gitName, "<user>", "git-user");
  for (const part of gitName.split(/\s+/)) put(part, "<user>", "git-user");
  put(git(projectAbs, ["config", "user.email"]), "<email>", "git-email");
  for (const remote of git(projectAbs, ["remote"]).split("\n").filter(Boolean)) {
    const url = git(projectAbs, ["remote", "get-url", remote]);
    const { host, owner, repo } = remoteParts(url);
    put(url, "<git-remote>", "git-remote");
    if (host && !/^(github\.com|gitlab\.com|bitbucket\.org)$/i.test(host)) put(host, "<host>", "git-host");
    if (owner) for (const o of owner.split("/")) put(o, "<org>", "git-owner");
    put(repo, "<repo>", "git-repo");
  }
  // An intent's folder (`261017-shop-checkout`) and its bare slug are one intent, one label.
  for (const [i, v] of (extra.intents ?? []).entries()) {
    put(v, `<intent-${i + 1}>`, "intent");
    put(v.replace(/^\d{6}-/, ""), `<intent-${i + 1}>`, "intent");
  }
  for (const [i, v] of (extra.spaces ?? []).entries()) put(v, `<space-${i + 1}>`, "space");
  for (const [i, v] of (extra.units ?? []).entries()) put(v, `<unit-${i + 1}>`, "unit");
  entries.sort((a, b) => b.value.length - a.value.length);
  return { entries, skipped };
}

export function loadDictionary(path: string): Dictionary {
  if (!existsSync(path)) return { entries: [] };
  return JSON.parse(readFileSync(path, "utf8")) as Dictionary;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A name matched in any case, letter by letter, so the case boundaries above can still be read.
function caseless(value: string): string {
  return [...value]
    .map((ch) => {
      const lower = ch.toLowerCase();
      const upper = ch.toUpperCase();
      return lower === upper ? escapeRe(ch) : `[${escapeRe(lower)}${escapeRe(upper)}]`;
    })
    .join("");
}

// A path in any case, a backslash also matching the doubled one JSON writes.
function pathPattern(value: string): string {
  return [...value.normalize("NFC")].map((ch) => (ch === "\\" ? "\\\\{1,2}" : caseless(ch))).join("");
}

// A word that starts another path or an address (`/home/alice`, `~/x`, `C:\\x`, `(s3://b`): a path read through a
// space stops before one.
const STARTS_PATH = String.raw`[(\[{"'${"`"}]*(?:[/\\~]|[A-Za-z]:[\\/]|[a-z][a-z0-9+.-]*:\/\/)`;

// Windows' own home folder, in any case (`C:\\users\\bob`); `/Users/` and `/home/` are written as they are, since
// a lowercase `/users/42` is a web route.
const WIN_USERS = String.raw`[A-Za-z]:\\{1,2}[Uu][Ss][Ee][Rr][Ss]\\{1,2}`;

// One compiled pattern per entry. A name the person hid starts and ends at a word or a case change; other
// names keep word-ish boundaries.
const compiled = new WeakMap<Entry, RegExp>();
function entryRe(e: Entry): RegExp {
  let re = compiled.get(e);
  if (!re) {
    const body = escapeRe(e.value.normalize("NFC"));
    // A path takes the rest of its last folder name with it (`/srv/shop.Contoso` beside `/srv/shop` is
    // `<project>`, never `<project>.Contoso`), up to a space, a quote or a sentence's last dot.
    // In quotes that close on the same line, the last folder name is read to the next separator or the closing
    // quote, spaces and all (`"/srv/shop Finance Shared/x"`), but not into another path; a quote that never closes is
    // not read past a space.
    if (e.kind === "path") {
      re = new RegExp(
        `(?<=(["'\`]))${pathPattern(e.value)}(?:[^/\\\\"'\`\\s]| (?!${STARTS_PATH}))*(?=(?:[/\\\\][^"'\`\\n]*)?\\1)|${pathPattern(e.value)}(?:[^/\\\\\\s"'\`<>,;)\\]]*[^/\\\\\\s"'\`<>,;)\\].])?`,
        "gu",
      );
    }
    else if (e.kind === "git-remote") re = new RegExp(body, "gi");
    // A name the person hid that is also part of AI-DLC's own words (`Acme` in `acme-aidlc-plugins`): a whole word
    // outside those words, read in the report only.
    else if (e.kind === "report-only") re = new RegExp(`(?<![\\p{L}\\p{N}_-])${body}(?![\\p{L}\\p{N}_-])`, "giu");
    // A name the person hid starts at a word or a case change (`SAPClient`, `myContoso`, `contoso2026`), so a short
    // one is not found inside an ordinary word (`Dan` in `guidance`). It may go on into a longer word when it has
    // five letters or more (`Contosoland`); a shorter one takes a plural only (`SAPs`, not `Danish`), and ends where a
    // word of capitals would go on (`SK` is not in `STAGE_SKIPPED`; it is in `SKClient`).
    else if (e.kind === "named") {
      const v = e.value.normalize("NFC");
      re = new RegExp(`(?:(?<![\\p{L}\\p{N}])|(?<=\\p{Ll})(?=\\p{Lu}))${caseless(v)}${[...v].length >= 5 ? "" : "(?:e?s)?(?!\\p{Ll})(?!\\p{Lu}(?!\\p{Ll}))"}`, "gu");
    }
    else re = new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "giu");
    compiled.set(e, re);
  }
  re.lastIndex = 0;
  return re;
}

// Apply `fn` to the parts of `text` outside the labels.
function outsideLabels(text: string, fn: (part: string) => string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(LABEL)) {
    out += fn(text.slice(last, m.index)) + m[0];
    last = (m.index ?? 0) + m[0].length;
  }
  return out + fn(text.slice(last));
}

// A path under the home folder. AI-DLC's and the AI tools' own folders keep their name and one known
// sub-folder (`~/.kiro/settings`, `~/.claude/projects`), and a known file directly in it; anything deeper is
// the person's (the chat-log folders are named after their project paths, an agent file after their agent)
// and becomes `<path>`, as does every other path under home. A space inside a path is read through when a
// separator or a dot follows it in the same word (`~/Clients/Contoso Merger.pdf`), or a capitalized word
// (`~/Clients/Contoso Merger`: every folder under home is the person's, so taking a word too many is the safe
// side) or a name the person hid, unless that word starts another path (`mv ~/a /home/alice/b`); a `<user>` inside
// is read through, so what follows it is not left behind; a quoted path is read to its closing quote.
export const TOOL_DIRS: string[][] = [
  [".claude"], [".kiro"], [".codex"], [".copilot"], [".cursor"], [".agents"], [".aidlc"], [".config"], [".vscode"],
  [".local", "share", "aidlc"], ["AppData", "Local", "aidlc"], ["Library", "Application Support", "Kiro"],
  ["Library", "Application Support", "Code"], ["Library", "Application Support", "Cursor"],
];
export const KNOWN_SUB = new Set(["settings", "logs", "skills", "steering", "prompts", "versions", "sessions", "projects", "session-state", "extensions", "User", "bin"]);
export const KNOWN_FILE = /^(?:cli\.json|settings(?:\.local)?\.json|mcp\.json|config\.toml|hooks\.json|kiro\.log|active-executable|active-version)$/;
const HOME_PATH = new RegExp(
  String.raw`(~|\/Users\/<user>|\/home\/<user>|${WIN_USERS}<user>)(\\{1,2}(?!\\)|\/)((?:[^\s"'${"`"}<>,;)\]]|<user>| (?!${STARTS_PATH})(?:(?=[^\s"'${"`"}<>,;)\]]*[/\\.])|(?=[A-Z][a-z])|(?=QQ[a-z]{6}n\d+qq)))+)`,
  "g",
);
// A quoted path is read to its closing quote, spaces and all (`"~/Clients/Contoso Merger.pdf"`).
const QUOTED_HOME_PATH = new RegExp(String.raw`(["'${"`"}])(~|\/Users\/<user>|\/home\/<user>|${WIN_USERS}<user>)(\\{1,2}(?!\\)|\/)([^"'${"`"}\n]+)\1`, "g");
function homePath(match: string, home: string, sep: string, tail: string): string {
  const segs = tail.split(/\\{1,2}|\//).filter(Boolean);
  const tool = TOOL_DIRS.find((dir) => dir.every((d, i) => segs[i] === d));
  if (!tool) return `${home}${sep}<path>`;
  const keep = segs.slice(0, tool.length);
  let rest = segs.slice(tool.length);
  if (rest.length && KNOWN_SUB.has(rest[0])) {
    keep.push(rest[0]);
    rest = rest.slice(1);
  }
  if (rest.length === 0 || (rest.length === 1 && KNOWN_FILE.test(rest[0]))) return match;
  return `${home}${sep}${keep.join(sep)}${sep}<path>`;
}

type Pattern = { kind: string; re: RegExp; replace: (match: string, ...groups: string[]) => string };

// A URL is replaced whole first, before a secret rule or the email pattern takes a part of it; any scheme
// (s3://, git+ssh://) counts, and so does a `www.` host with no scheme. A scheme starts where no scheme character
// stands before it (`id_https://…`, `__https://…__`) or right after a held label (rewrite's stand-ins, below), and
// never runs through one (`<email>https://x` is an address after a label, not a scheme `…https`); starting only
// there also keeps a long run of letters and dots to one try.
const URL_PATTERN: Pattern = {
  kind: "url",
  re: /(?:(?<![A-Za-z0-9+.-])|(?<=QQ[a-z]{6}[lnp]\d+qq))(?:(?!QQ[a-z]{6}[lnp]\d+qq)[A-Za-z0-9])(?:(?!QQ[a-z]{6}[lnp]\d+qq)[A-Za-z0-9+.-])*:\/\/[^\s)"'`<>\]]+|(?<![\w.])www\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?:[/?#:][^\s)"'`<>\]]*)?/g,
  replace: (m) => (PUBLIC_URL.test(m) ? m.replace(/[?#].*$/, "") : "<url>"),
};

// The patterns that replace a fragment run after the secret rules, so a secret's value is masked whole
// before an IP or an email inside it would be (`password=192.168.0.1-tail`).
export const PATTERNS: Pattern[] = [
  // Letters of any script (`김기현@…`), starting only where no name character stands before it.
  { kind: "email", re: /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}(?![\p{L}\p{N}])/gu, replace: () => "<email>" },
  // A WSL kernel release (`5.15.167.4-microsoft-standard-WSL2`) is not an address.
  { kind: "ipv4", re: /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b(?!-microsoft-standard-WSL2)/g, replace: () => "<ip>" },
  // IPv6 in full (eight groups) or with `::`, with a run of three hex digits somewhere, so a time (`10:20:30`), a
  // slice (`[1::2]`) or a path (`std::fs`) is not one.
  {
    kind: "ipv6",
    re: /(?<![\w:])(?=[0-9A-Fa-f:]*[0-9A-Fa-f]{3})(?:(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{0,4}::(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{1,4})(?!\w|:[0-9A-Fa-f:])/g,
    replace: () => "<ip>",
  },
  { kind: "aws-account", re: /(?<![\w.-])\d{12}(?![\w.-])/g, replace: () => "<account>" },
  // Another person's home folder, quoted: all of it, since its name can hold a space (`"/Users/Jane Doe/…"`).
  {
    kind: "other-home-quoted",
    re: new RegExp(String.raw`(["'${"`"}])(\/Users\/|\/home\/|${WIN_USERS})(?!\\|<user>[/\\"'${"`"}])[^"'${"`"}\n]+\1`, "g"),
    replace: (_m, q, prefix) => `${q}${prefix}<user>${prefix.endsWith("/") ? "/" : (prefix.match(/\\+$/)?.[0] ?? "\\")}<path>${q}`,
  },
  // A user name, or `<user>` with more of a name after it (`/home/<user><customer-1>/x`). A name goes on through a
  // space to a capitalized word or to a word the path goes on after (`/Users/jane doe/x`), never into another path.
  {
    kind: "home-user",
    re: new RegExp(
      String.raw`(\/Users\/|\/home\/|${WIN_USERS})(?:<user>(?=[^/\\\s"'<>]))?(?!<user>)[^/\\\s"'<>]+(?: (?!${STARTS_PATH})(?=[A-Z][a-z]|[^/\\\s"'<>]+[/\\])[^/\\\s"'<>]+)*`,
      "g",
    ),
    replace: (_m, prefix) => `${prefix}<user>`,
  },
  { kind: "home-quoted", re: QUOTED_HOME_PATH, replace: (m, q, home, sep, tail) => `${q}${homePath(m.slice(1, -1), home, sep, tail)}${q}` },
  { kind: "home-path", re: HOME_PATH, replace: (m, home, sep, tail) => homePath(m, home, sep, tail) },
];

function applyPattern(p: Pattern, text: string): string {
  p.re.lastIndex = 0;
  const out = text.replace(p.re, p.replace);
  p.re.lastIndex = 0;
  return out;
}

// Long opaque ids (uuids, hashes), only where the caller says so.
const LONG_ID = /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,64})\b/gi;

type SecretRules = (text: string) => string;
let secretRules: SecretRules | null = null;

// AI-DLC's `redactSecretPatterns` (lib-project.ts importSecretRules), or null when the project's
// install has none: redact() then leaves secrets to lib-gate.ts's own credential rules.
export function useSecretRules(rules: SecretRules | null): void {
  secretRules = rules;
}

// Text is redacted with every label in it, and each known path, standing in as a run of letters, so no rule stops
// halfway at a `<` (`https://<user>@host/x`, `password=<customer-1>Secret1`) and no rule takes part of a path:
//   0. the known paths (project before home; the home folder itself becomes `~`, which the home rules read);
//   1. whole values, the names the person hid left as written, so a value is still known by its own shape
//      (`password=…` with `password` hidden, `192.168.1.12` with `192` hidden): URLs (a public one that holds a hidden
//      name too), then AI-DLC's secret rules, then emails, IPs and account numbers;
//   2. the home-folder rules, with each name the person hid standing in as letters too, so no path rule cuts one in
//      half (`~/Clients/Contoso SAP/x`) and a home path reads through one. `<user>` is put back as written for them.
// A stand-in carries a nonce the text does not hold, so it never meets text of the same shape. It starts with two
// capitals, so a home path's rule for a capitalized word after a space does not read into one. Being letters, a
// stand-in hides the word boundary a value's rule needs beside it (`<redacted>123456789012`), so the value rules
// also run on the parts between stand-ins.
type Held = { tag: string; labels: string[]; named: Entry[] };
function newHeld(text: string, named: Entry[]): Held {
  let tag = "";
  do tag = Array.from({ length: 6 }, () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)]).join("");
  while (text.includes(tag));
  return { tag, labels: [], named };
}
const heldRe = (h: Held) => new RegExp(`QQ${h.tag}([lnp])(\\d+)qq`, "g");
function stand(h: Held, label: string): string {
  return `QQ${h.tag}l${h.labels.push(label) - 1}qq`;
}
// Apply `fn` to the parts of `text` outside the stand-ins (and, for names, outside a literal `<user>`).
function outsideHeld(text: string, h: Held, fn: (part: string) => string, user = false): string {
  const re = new RegExp(user ? `${heldRe(h).source}|<user>` : heldRe(h).source, "g");
  let out = "";
  let last = 0;
  for (const m of text.matchAll(re)) {
    out += fn(text.slice(last, m.index)) + m[0];
    last = (m.index ?? 0) + m[0].length;
  }
  return out + fn(text.slice(last));
}
function holdLabels(text: string, h: Held): string {
  return outsideHeld(text, h, (part) => part.replace(LABEL, (m) => stand(h, m)));
}
function holdNames(text: string, h: Held): string {
  let out = text;
  h.named.forEach((e, i) => {
    out = outsideHeld(out, h, (part) => part.replace(entryRe(e), `QQ${h.tag}n${i}qq`), true);
  });
  return out;
}
function release(text: string, h: Held): string {
  return text.replace(heldRe(h), (m, kind, n) => (kind === "n" ? h.named[Number(n)]?.label : h.labels[Number(n)]) ?? m);
}
// `<user>` stand-ins back as written, for the home-folder rules that read it.
function showUser(text: string, h: Held): string {
  return text.replace(heldRe(h), (m, kind, n) => (kind === "l" && h.labels[Number(n)] === "<user>" ? "<user>" : m));
}

const VALUE_PATTERNS = new Set(["email", "ipv4", "ipv6", "aws-account"]);

// Steps 0, 1 and 2 above; the dictionary's other names are the caller's.
function rewrite(text: string, dict: Dictionary): string {
  const nfc = text.normalize("NFC");
  const named = dict.entries.filter((e) => e.kind === "named");
  const h = newHeld(nfc, named);
  let out = holdLabels(nfc, h);
  for (const e of dict.entries) {
    if (e.kind === "path") out = outsideHeld(out, h, (part) => part.replace(entryRe(e), () => (e.label === "~" ? "~" : stand(h, e.label))));
  }
  // A public address that holds a hidden name (its scheme, its path) is not public.
  out = out.replace(URL_PATTERN.re, (m) => (PUBLIC_URL.test(m) && !named.some((e) => entryRe(e).test(m)) ? m.replace(/[?#].*$/, "") : stand(h, "<url>")));
  URL_PATTERN.re.lastIndex = 0;
  const values = (part: string) => {
    let v = secretRules ? secretRules(part) : part;
    for (const p of PATTERNS) if (VALUE_PATTERNS.has(p.kind)) v = applyPattern(p, v);
    return v;
  };
  out = outsideHeld(values(out), h, values);
  out = holdNames(showUser(holdLabels(out, h), h), h);
  for (const p of PATTERNS) if (!VALUE_PATTERNS.has(p.kind)) out = applyPattern(p, out);
  return release(out, h);
}

export function redact(text: string, dict: Dictionary, opts: { ids?: boolean } = {}): string {
  let out = rewrite(text, dict);
  for (const e of dict.entries) {
    if (e.kind !== "path" && e.kind !== "named" && e.kind !== "report-only") out = outsideLabels(out, (part) => part.replace(entryRe(e), e.label));
  }
  if (opts.ids) out = out.replace(LONG_ID, "<id>");
  return out;
}

// The safe.json maps whose keys are data (an event, a command, a model, a stage) rather than field names.
const DATA_MAPS = new Set([
  "counts", "aidlcCommands", "denials", "aidlcHookBlocks", "toolVersions", "models", "efforts", "agents",
  "approvalModes", "reportModels", "subagents", "stages", "last",
]);

// The field names collect.ts writes into safe.json: its own, the audit fields it copies (lib-audit.ts) and the
// tools' keys. One of them is kept as it is outside the data maps; any other key, and every key of a data map,
// is data.
const SAFE_FIELDS = new Set([
  ...AUDIT_FIELDS, "Error Group", "kiro-ide", "kiro-cli",
  "absence", "agentEngine", "agents", "aidlcCommands", "aidlcHookBlocks", "approvalModes", "approvalPrompts", "audit",
  "buildVersion", "bun", "channel", "check", "checked", "checksFailed", "claude", "codex", "completed", "copilot", "count",
  "counts", "currentStage", "degraded", "denials", "depth", "detail", "dir", "dispatches", "doctor", "drops", "efforts",
  "engine", "environment", "error", "event", "exe", "exists", "exit", "file", "findings", "firstTs", "generatedAt",
  "guardPolicy", "guardsOff", "guardsOn", "handRunChecks", "hook", "hooks", "id", "inProgress", "inRunningTurn", "intent",
  "intents", "kind", "kiroEngine", "kiroHomeEngine", "kiroIdePending", "knownGaps", "last", "lastAidlcActivity", "lastTs",
  "lastUpdated", "mixedSessions", "models", "native", "nextStage", "noTime", "notRecorded", "note", "notes", "openQuestions", "os",
  "otherStores", "pass", "phase", "pin", "planApproval", "problems", "prompts", "questionsAsked", "ran", "reason",
  "recorded", "repeats", "replies", "reportModels", "reportSessions", "revisionCount", "row", "rowsInWindow", "rowsTotal",
  "sameAsBeforeInTurn", "schema", "scope", "secretRules", "sensors", "sessions", "sessionsFolder", "severity", "since",
  "source", "sourceRef", "stage", "stages", "stampVersion", "status", "stopFeedback", "subagents", "testStrategy",
  "timeline", "tool", "toolCalls", "toolErrors", "toolVersions", "tools", "toolsUsed", "totalStages", "transcriptCursors",
  "transcripts", "trees", "ts", "unboundApprovals", "until", "version", "versionsMissing", "window",
]);

// `parent`: the field the object sits under, "" below a data map's key. lib-check.ts reads safe.json by the
// same rule.
export function keepsKey(parent: string, key: string): boolean {
  return !DATA_MAPS.has(parent) && SAFE_FIELDS.has(key);
}

// A JSON value redacted string by string, so a rule never sees JSON's own quotes and escapes and the result
// stays valid JSON.
export function redactValue(value: unknown, dict: Dictionary, opts: { ids?: boolean } = {}, parent = ""): unknown {
  if (typeof value === "string") return redact(value, dict, opts);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, dict, opts, parent));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        const own = keepsKey(parent, k);
        return [own ? k : redact(k, dict, opts), redactValue(v, dict, opts, own ? k : "")];
      }),
    );
  }
  return value;
}

// Every place a name in the dictionary stands, and how long it is there (labels are blanked one for one, so places
// hold).
export function namesAt(text: string, dict: Dictionary): { entry: Entry; at: number; length: number }[] {
  const bare = text.normalize("NFC").replace(LABEL, (m) => " ".repeat(m.length));
  const out: { entry: Entry; at: number; length: number }[] = [];
  for (const e of dict.entries) {
    for (const m of bare.matchAll(entryRe(e))) out.push({ entry: e, at: m.index ?? 0, length: m[0].length });
  }
  return out;
}

// Where AI-DLC's secret rules still find a secret, as written: line by line, then in the whole text, since a
// secret over several lines (a PEM key, a value on the line after its name) shows only there. lib-gate.ts
// refuses what this finds, beside its own credential shapes.
export function findSecrets(raw: string): { line: number }[] {
  if (!secretRules) return [];
  const rules = secretRules;
  const text = raw.normalize("NFC");
  const hits: { line: number }[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (rules(line) !== line) hits.push({ line: i + 1 });
  });
  const whole = rules(text);
  if (hits.length === 0 && whole !== text) {
    let at = 0;
    while (at < text.length && text[at] === whole[at]) at++;
    hits.push({ line: text.slice(0, at).split(/\r?\n/).length });
  }
  return hits;
}
