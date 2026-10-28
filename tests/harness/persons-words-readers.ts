// persons-words-readers.ts - every place in the engine that reads the person's words, and the scanner that finds them.
//
// The design (reading-lead's DESIGN.md, sections 2.4 and 4.2): the agent reads what the person typed and calls the
// engine with exact arguments; the engine records the words and never reads them to decide. This file holds the one
// list two tests check: tests/unit/t-persons-words-pin.test.ts (the code: which functions use the words, and how) and
// the text-blind fuzz (tests/harness/text-blind-fuzz.ts: what a run records when only the words change). A place that
// stays is on ALLOWED with its reason; a reader a slice of the reading work removes is on STILL_TO_GO with its slice
// and row, and that slice deletes the line. The pin fails both ways: a place found that no line names, and a line
// whose place no longer reads the words.
//
// What the scanner follows, by the TypeScript checker (a field is known by its declaration, never by its name):
//   - Sources: the message store's `StoredMessage` text, words and picker; the gate-words record's messages; the
//     prompt as the human-turn hook parses it from its payload. A typed field that is handed the words becomes a
//     source too (`personsGateReply().words`, the protected response's words, the plan ask's replies), and so does
//     an audit row field the writer puts the words in (Person Reply, Feedback, Reason, Details, Picked), read by
//     `auditBlockField`, and a field of the same name on a value that came out of JSON.parse. The questions files'
//     `[Answer]:` line is a source by the functions that read it out of the file (ANSWER_LINE_READERS).
//   - Flow: locals, destructuring, array elements, string and array methods, a parameter handed the words, and a
//     call's result where the callee hands back what it was given (each function's summary, so a helper is a reader
//     only where it is given the words). Booleans and numbers carry nothing: a comparison's result is the decision,
//     and its place is where it is made.
//   - Shape reads are followed no further: `isNonAnswer` and the `/aidlc` parse (BOUNDARY). The person's own line
//     taken as `next`'s flags (`takePersonsOwnLine`) hands back structure.
//   - A place is a named function (`file#name`, the outermost one): the use there is "decides" when the words are
//     compared, matched, searched, decoded or handed to a parameter that is, and "keeps" otherwise (copied, cut,
//     hashed, tested for presence or blankness). A place the words reach only through its parameters also names the
//     places that hand them over (`from`), so a new caller is seen.
//
// What it does not see: the adapters' own parsing of their host's input (untyped JSON in harness/*/hooks); the three
// host-text identities and the legacy nonce match are on ALLOWED whether or not the scan reaches them, so a typed read
// there is caught the day it appears. The `[Answer]:` line read inline from the file's text (a stage's questions
// counted, the claim-sources sensor) is on ALLOWED_UNREACHED by name.

import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import * as ts from "typescript";
import { REPO_ROOT } from "./fixtures.ts";

export type Use = "decides" | "keeps";
export type Slice = "S2a" | "S2b" | "S2c" | "S3" | "S6" | "S9" | "PA-fixes";

export interface Allowed {
  use: Use;
  why: string;
  /** For a place the words reach only through its parameters: the places that hand them over. */
  from?: readonly string[];
}
export interface ToGo extends Allowed {
  slice: Slice;
  /** The design's row (DESIGN.md section 2.2a). */
  row: string;
  /** The casts out of PersonsWords it reads through until its slice lands (`as unknown as string`), never an unwrap. */
  widenings?: number;
}

export interface Found {
  use: Use;
  /** Each use kind met, with one line where. */
  uses: Map<string, string>;
  /** The sources read here directly. */
  sources: Set<string>;
  /** The places that hand the words to this one's parameters. */
  from: Set<string>;
}

// ---------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------

/** The person's words as the human-turn hook's payload carries them (core/hooks/aidlc-record-human-turn.ts). */
const PROMPT_FIELDS = new Set(["prompt", "user_prompt", "message", "tool_response", "toolResponse", "picker_reply"]);
/**
 * Records the engine keeps a copy of the person's words in, written through an untyped literal the checker cannot tie
 * to its interface (a JSON string), so named here by declaration. The pin checks each is written with the words.
 */
export const RECORD_COPIES: ReadonlyArray<{ file: string; type: string; field: string }> = [
  { file: "core/tools/aidlc-lib.ts", type: "ProtectedResponse", field: "words" },
  { file: "core/tools/aidlc-plan-approval-ask.ts", type: "PlanApprovalAskReply", field: "text" },
  { file: "core/tools/aidlc-question-store.ts", type: "StoredQuestion", field: "text" },
  { file: "core/tools/aidlc-lib.ts", type: "SayOnceNote", field: "say" },
];
/**
 * The questions files' `[Answer]:` line, by the functions that read it out of the file. Mostly the agent writes it (the
 * summary's tag, a choice it records), but the Code Generation plan file asks the person to write their own answer
 * there, and a stage's questions file may be answered there too. `field`: the line is that field of the result.
 */
export const ANSWER_LINE_READERS: ReadonlyArray<{ file: string; fn: string; field?: string }> = [
  { file: "core/tools/aidlc-lib.ts", fn: "summaryAnswerFromFile" },
  { file: "core/tools/aidlc-plan-approval-ask.ts", fn: "answerWrittenInFile" },
  { file: "core/tools/aidlc-testing-posture.ts", fn: "latestPlanApproval", field: "answer" },
];
/**
 * The person's free text as `next`'s flag parse hands it out: the request the agent forwards (`intent`), the words a
 * flag-shaped token rode with (`personWords`) and the one line a `--resume` picked up (`pickedUp`). The closed-set
 * flags (a scope, a stage, a setting) are structure.
 */
const NEXT_FREE_TEXT = new Set(["intent", "personWords", "pickedUp"]);
/** The audit row fields the writer puts the words in, before the scan adds any it finds. */
const AUDIT_WORD_FIELDS = ["Person Reply", "Feedback", "Reason", "Details", "Picked"];
/**
 * An audit field the writer also fills with other text is read as the person's words only where the reader names an
 * event it carries them in. The writer's own words writes name most of these events; this adds the one the scan cannot
 * see: QUESTION_ANSWERED's Details is the agent's account of the answer, often their words as typed.
 */
const AUDIT_FIELD_EVENTS: ReadonlyArray<[string, string]> = [["Details", "QUESTION_ANSWERED"]];
/** The functions that read one field of an audit block by its name. */
const FIELD_READERS = new Set(["auditBlockField", "auditField"]);
/** Shape reads, followed no further, and what each hands back: nothing, the words, or an object of their fields. */
const BOUNDARY: Record<string, "clean" | "words" | "object"> = {
  isNonAnswer: "clean",
  aidlcEntryWords: "words",
  isAidlcCommandPrompt: "clean",
  splitKiroCommandArgs: "words",
  withTypedSpacing: "words",
  parseNextFlags: "object",
  typedSettingModifiers: "clean",
  classifyTerminalCommand: "clean",
  resolveAction: "clean",
};
/** Where the person's records are kept: a JSON.parse beside one of these reads a record, whose fields are known by name. */
const RECORD_PATHS = new Set(["messageRel", "gateWordsPath", "gateWordsDir", "protectedResponsePath", "planApprovalRuntimeDir"]);
/** Followed inside, but what they hand back is structure: the person's own `/aidlc` line taken as `next`'s flags. */
const STRUCTURE_RESULT = new Set(["takePersonsOwnLine"]);

const COMPARE_OPS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.InKeyword,
  ts.SyntaxKind.InstanceOfKeyword,
]);
const SEARCH = new Set(["includes", "startsWith", "endsWith", "indexOf", "lastIndexOf", "search", "match", "matchAll", "localeCompare", "test", "exec"]);
const DECODE = new Set(["Number", "parseInt", "parseFloat", "Number.parseInt", "Number.parseFloat", "JSON.parse"]);
const MUTATE = new Set(["push", "unshift", "splice", "set", "add"]);
const NONWORD = ts.TypeFlags.BooleanLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.VoidLike |
  ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Never | ts.TypeFlags.ESSymbolLike;
const WORDS = "W";

const posix = (path: string) => path.split(sep).join("/");
// A file as the compiler names it: forward slashes and no "." or ".." step (Windows: "C:/..."), whatever form it was given in.
const fileKey = (path: string) => {
  const key = resolve(path).replace(/\\/g, "/");
  return process.platform === "win32" ? key.toLowerCase() : key;
};

/** The files the pin scans in this repository: the shipped engine and its hosts' surfaces. */
function shippedFiles(root: string): { program: string[]; options: ts.CompilerOptions; scanned: Map<string, string> } {
  const read = (name: string) => {
    const config = ts.readConfigFile(join(root, name), ts.sys.readFile);
    if (config.error) throw new Error(`${name}: ${ts.flattenDiagnosticMessageText(config.error.messageText, "\n")}`);
    return ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  };
  const main = read("tsconfig.json");
  const adapters = read("tsconfig.adapters.json");
  const program = [...new Set([...main.fileNames, ...adapters.fileNames])];
  const scanned = new Map<string, string>();
  for (const file of program) {
    const rel = posix(relative(root, file));
    if (/^(?:core|harness|plugins)\//.test(rel) && !rel.endsWith(".d.ts")) scanned.set(file, rel);
    // An adapter is checked as the packager emits it (its sibling imports resolve there) and named by its source.
    const emitted = /^dist\/([^/]+)\/[^/]+\/hooks\/([^/]+-adapter\.ts)$/.exec(rel);
    if (emitted) scanned.set(file, `harness/${emitted[1]}/hooks/${emitted[2]}`);
  }
  return { program, options: { ...main.options, noEmit: true }, scanned };
}

// One program per set of files, so the brand's scan reads the checker the words' scan has already filled.
const programs = new Map<string, { program: ts.Program; scannedNames: Map<string, string> }>();
function pinProgram(options: { root?: string; files?: string[] }): { program: ts.Program; scannedNames: Map<string, string> } {
  const key = JSON.stringify([options.root ?? REPO_ROOT, options.files ?? null]);
  let built = programs.get(key);
  if (!built) {
    built = buildPinProgram(options);
    programs.set(key, built);
  }
  return built;
}
function buildPinProgram(options: { root?: string; files?: string[] }): { program: ts.Program; scannedNames: Map<string, string> } {
  const root = options.root ?? REPO_ROOT;
  let programFiles: string[];
  let compilerOptions: ts.CompilerOptions;
  let scannedNames: Map<string, string>;
  if (options.files) {
    programFiles = options.files;
    compilerOptions = shippedFiles(root).options;
    scannedNames = new Map(options.files.map((file) => [fileKey(file), posix(relative(root, resolve(file)))]));
  } else {
    let shipped: Map<string, string>;
    ({ program: programFiles, options: compilerOptions, scanned: shipped } = shippedFiles(root));
    scannedNames = new Map([...shipped].map(([file, name]) => [fileKey(file), name]));
  }
  return { program: ts.createProgram(programFiles, compilerOptions), scannedNames };
}

/** The outermost named function `n` sits in, as a place names it (`file#name`). */
function unitName(n: ts.Node): string {
  let name = "<module>";
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) && p.name) name = p.name.text;
    else if (ts.isMethodDeclaration(p) && p.name) {
      const cls = ts.isClassLike(p.parent) && p.parent.name ? `${p.parent.name.text}.` : "";
      name = `${cls}${p.name.getText()}`;
    } else if (ts.isConstructorDeclaration(p)) {
      name = `${ts.isClassLike(p.parent) && p.parent.name ? p.parent.name.text : "class"}.constructor`;
    } else if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isVariableDeclaration(p.parent) &&
      ts.isIdentifier(p.parent.name) && ts.isVariableStatement(p.parent.parent.parent) && ts.isSourceFile(p.parent.parent.parent.parent)) {
      name = p.parent.name.text;
    }
  }
  return name;
}

/**
 * Every place in `files` (default: the shipped engine) where the person's words are used, keyed `file#name`.
 * `files` given: only those are scanned, with the engine they import as the sources' home.
 */
export function scanPersonsWords(options: { root?: string; files?: string[] } = {}): Map<string, Found> {
  const { program, scannedNames } = pinProgram(options);
  const checker = program.getTypeChecker();
  const scanned = program.getSourceFiles().filter((sf) => scannedNames.has(fileKey(sf.fileName)));
  const scannedSet = new Set(scanned);
  // Sources live in the engine whether or not it is scanned: a fixture reads them too.
  const engineFiles = program.getSourceFiles().filter((sf) => /[\\/]core[\\/](?:tools|hooks)[\\/][^\\/]+\.ts$/.test(sf.fileName));

  const symOf = (n: ts.Node): ts.Symbol | undefined => {
    if (n.parent && ts.isShorthandPropertyAssignment(n.parent) && n.parent.name === n) {
      return checker.getShorthandAssignmentValueSymbol(n.parent);
    }
    const s = checker.getSymbolAtLocation(n);
    return s && s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
  };
  const rootsOf = (s: ts.Symbol): ts.Symbol[] => [s, ...checker.getRootSymbols(s)];

  // --- labels: the words (W), or a function's own parameter (P<i>@<fn>) ---
  const symLabels = new Map<ts.Symbol, Set<string>>();
  const sourceName = new Map<ts.Symbol, string>();
  const answerLineFns = new Map<ts.Node, string>();
  const ret = new Map<ts.Node, Set<string>>();
  const reached = new Map<ts.Node, Set<number>>();
  const fnId = new Map<ts.Node, number>();
  const idFn: ts.Node[] = [];
  const objectSyms = new Set<ts.Symbol>();
  const parsedSyms = new Set<ts.Symbol>();
  const wordFieldNames = new Set<string>(AUDIT_WORD_FIELDS);
  // The audit row fields the writer puts the words in, by event; a field it also writes with anything else is read as
  // the person's words only where the reading function names one of those events.
  const auditWordEvents = new Map<string, Set<string>>(AUDIT_WORD_FIELDS.map((f) => [f, new Set<string>()]));
  const auditPlainFields = new Set<string>();
  let auditReadsAreSources = false;
  const unitEvents = new Map<ts.Node, Set<string>>();
  const eventsNamedIn = (n: ts.Node): Set<string> => {
    let fn: ts.Node | undefined = enclosingFn(n);
    while (fn && enclosingFn(fn)) fn = enclosingFn(fn);
    const scope = fn ?? n.getSourceFile();
    let v = unitEvents.get(scope);
    if (!v) {
      const found = new Set<string>();
      const visit = (k: ts.Node) => {
        if (ts.isStringLiteralLike(k) && /^[A-Z][A-Z_]+$/.test(k.text)) found.add(k.text);
        ts.forEachChild(k, visit);
      };
      visit(scope);
      v = found;
      unitEvents.set(scope, v);
    }
    return v;
  };
  const auditFieldIsWords = (name: string, at: ts.Node): boolean => {
    if (!auditReadsAreSources) return false;
    const events = auditWordEvents.get(name);
    if (!events) return false;
    if (!auditPlainFields.has(name)) return true;
    const named = eventsNamedIn(at);
    return [...events].some((event) => named.has(event));
  };
  let changed = false;
  const EMPTY: ReadonlySet<string> = new Set();
  const union = (...ls: ReadonlySet<string>[]): Set<string> => {
    const out = new Set<string>();
    for (const l of ls) for (const x of l) out.add(x);
    return out;
  };
  const labelsOfSym = (s: ts.Symbol | undefined): Set<string> => {
    const out = new Set<string>();
    if (!s) return out;
    for (const r of rootsOf(s)) for (const l of symLabels.get(r) ?? []) out.add(l);
    return out;
  };
  const addTo = <K>(map: Map<K, Set<string>>, key: K, ls: Iterable<string>) => {
    let cur = map.get(key);
    if (!cur) {
      cur = new Set();
      map.set(key, cur);
    }
    for (const l of ls) {
      if (!cur.has(l)) {
        cur.add(l);
        changed = true;
      }
    }
  };
  const addSym = (s: ts.Symbol | undefined, ls: ReadonlySet<string>) => {
    if (s && ls.size > 0) addTo(symLabels, s, ls);
  };
  // A declared field carries only the words, never one function's parameter: it is read everywhere.
  const addField = (s: ts.Symbol | undefined, ls: ReadonlySet<string>, why: string) => {
    if (!s || !ls.has(WORDS)) return;
    for (const r of rootsOf(s)) {
      addTo(symLabels, r, [WORDS]);
      if (!sourceName.has(r)) sourceName.set(r, why);
    }
    wordFieldNames.add(s.name);
  };
  const seed = (s: ts.Symbol | undefined, why: string, record = true) => {
    if (!s) return;
    symLabels.set(s, new Set([WORDS]));
    sourceName.set(s, why);
    if (record) wordFieldNames.add(s.name);
  };

  // Function ids, and each parameter labelled as its own.
  for (const sf of program.getSourceFiles()) {
    if (!scannedSet.has(sf) && !engineFiles.includes(sf)) continue;
    const visit = (n: ts.Node) => {
      if (ts.isFunctionLike(n) && (n as ts.FunctionLikeDeclaration).body) {
        const id = idFn.length;
        fnId.set(n, id);
        idFn.push(n);
        (n as ts.FunctionLikeDeclaration).parameters.forEach((p, i) => {
          const bind = (b: ts.BindingName) => {
            if (ts.isIdentifier(b)) {
              const s = symOf(b);
              if (s) symLabels.set(s, new Set([`P${i}@${id}`]));
            } else for (const el of b.elements) if (!ts.isOmittedExpression(el)) bind(el.name);
          };
          bind(p.name);
        });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  // The sources.
  for (const sf of engineFiles) {
    const file = posix(sf.fileName);
    const visit = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n) && n.name) {
        for (const reader of ANSWER_LINE_READERS) {
          if (reader.fn !== n.name.text || !file.endsWith(`/${reader.file}`)) continue;
          const why = `the [Answer]: line (${reader.fn})`;
          if (reader.field === undefined) {
            ret.set(n, new Set([WORDS]));
            answerLineFns.set(n, why);
          } else if (n.type && ts.isTypeLiteralNode(n.type)) {
            for (const m of n.type.members) if (m.name && ts.isIdentifier(m.name) && m.name.text === reader.field) seed(symOf(m.name), why, false);
          }
        }
      }
      if (ts.isInterfaceDeclaration(n) && n.name.text === "StoredMessage" && file.endsWith("/aidlc-message-store.ts")) {
        for (const m of n.members) {
          if (m.name && ts.isIdentifier(m.name) && ["text", "words", "picker"].includes(m.name.text)) seed(symOf(m.name), `message store ${m.name.text}`);
        }
      }
      if (ts.isInterfaceDeclaration(n) && n.name.text === "GateWordsRecord" && file.endsWith("/aidlc-lib.ts")) {
        const inner = (k: ts.Node) => {
          if (ts.isPropertySignature(k) && ts.isIdentifier(k.name) && ["messages", "text"].includes(k.name.text)) seed(symOf(k.name), "gate words");
          ts.forEachChild(k, inner);
        };
        inner(n);
      }
      if (ts.isInterfaceDeclaration(n) && n.name.text === "ParsedFlags" && file.endsWith("/aidlc-orchestrate.ts")) {
        for (const m of n.members) if (m.name && ts.isIdentifier(m.name) && NEXT_FREE_TEXT.has(m.name.text)) seed(symOf(m.name), `next's free text ${m.name.text}`);
      }
      if (ts.isInterfaceDeclaration(n)) {
        for (const copy of RECORD_COPIES) {
          if (copy.type !== n.name.text || !file.endsWith(`/${copy.file}`)) continue;
          for (const m of n.members) if (m.name && ts.isIdentifier(m.name) && m.name.text === copy.field) seed(symOf(m.name), `${copy.type}.${copy.field}`);
        }
      }
      if (ts.isTypeLiteralNode(n) && file.endsWith("/aidlc-record-human-turn.ts") && ts.isAsExpression(n.parent) &&
        ts.isCallExpression(n.parent.expression) && n.parent.expression.expression.getText() === "JSON.parse") {
        for (const m of n.members) {
          if (m.name && ts.isIdentifier(m.name) && PROMPT_FIELDS.has(m.name.text)) seed(symOf(m.name), `the hook's prompt ${m.name.text}`, false);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  const typeCache = new Map<ts.Node, boolean>();
  const carries = (n: ts.Node): boolean => {
    let v = typeCache.get(n);
    if (v === undefined) {
      const f = (t: ts.Type): boolean => (t.isUnion() ? t.types.some(f) : !(t.flags & NONWORD));
      v = f(checker.getTypeAtLocation(n));
      typeCache.set(n, v);
    }
    return v;
  };
  const opaqueCache = new Map<ts.Node, boolean>();
  // A value whose fields the checker cannot tell apart: a string, an array, unknown, any, a bare `object`.
  // A cast does not change what the value is: `(response as Record<string, unknown>).answers` reads the parsed reply.
  const opaque = (n: ts.Node): boolean => {
    let v = opaqueCache.get(n);
    if (v === undefined) {
      const f = (t: ts.Type): boolean => t.isUnion() ? t.types.some(f)
        : !!(t.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.Unknown | ts.TypeFlags.Any | ts.TypeFlags.NonPrimitive)) || checker.isArrayType(t) ||
          checker.isTupleType(t);
      v = f(checker.getTypeAtLocation(n)) ||
        ((ts.isAsExpression(n) || ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n)) && opaque(n.expression));
      opaqueCache.set(n, v);
    }
    return v;
  };
  const declName = (d: ts.Node): string => {
    const name = (d as ts.FunctionLikeDeclaration).name;
    if (name && ts.isIdentifier(name)) return name.text;
    if (d.parent && ts.isVariableDeclaration(d.parent) && ts.isIdentifier(d.parent.name)) return d.parent.name.text;
    return "";
  };
  const calleeCache = new Map<ts.Node, ts.FunctionLikeDeclaration | null>();
  const callee = (call: ts.CallExpression | ts.NewExpression): ts.FunctionLikeDeclaration | null => {
    let d = calleeCache.get(call);
    if (d === undefined) {
      const decl = checker.getResolvedSignature(call)?.declaration;
      d = decl && !ts.isJSDocSignature(decl) && fnId.has(decl) ? (decl as ts.FunctionLikeDeclaration) : null;
      calleeCache.set(call, d);
    }
    return d;
  };
  const enclosingFn = (n: ts.Node): ts.Node | undefined => {
    for (let p = n.parent; p; p = p.parent) if (fnId.has(p)) return p;
    return undefined;
  };
  const stringOf = (e: ts.Expression): string | null => {
    if (ts.isStringLiteralLike(e)) return e.text;
    const t = checker.getTypeAtLocation(e);
    return t.isStringLiteral() ? t.value : null;
  };
  // A JSON.parse in a function that names where a record of the person's is kept reads that record.
  const recordParseCache = new Map<ts.Node, boolean>();
  const recordParse = (call: ts.CallExpression): boolean => {
    let fn: ts.Node | undefined = enclosingFn(call);
    while (fn && enclosingFn(fn)) fn = enclosingFn(fn);
    const scope = fn ?? call.getSourceFile();
    let v = recordParseCache.get(scope);
    if (v === undefined) {
      let hit = false;
      const visit = (n: ts.Node) => {
        if (hit) return;
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && RECORD_PATHS.has(n.expression.text)) hit = true;
        else ts.forEachChild(n, visit);
      };
      visit(scope);
      v = hit;
      recordParseCache.set(scope, v);
    }
    return v;
  };
  // A value that came out of JSON.parse of a record, through casts and fields: its fields are known only by name.
  const fromParse = (e: ts.Expression): boolean => {
    let c: ts.Expression = e;
    for (;;) {
      if (ts.isParenthesizedExpression(c) || ts.isAsExpression(c) || ts.isNonNullExpression(c) || ts.isSatisfiesExpression(c)) c = c.expression;
      else if (ts.isPropertyAccessExpression(c) || ts.isElementAccessExpression(c)) c = c.expression;
      else break;
    }
    if (ts.isCallExpression(c) && c.expression.getText() === "JSON.parse") return recordParse(c);
    const s = ts.isIdentifier(c) ? symOf(c) : undefined;
    return s !== undefined && parsedSyms.has(s);
  };

  let memo = new Map<ts.Node, Set<string>>();
  const label = (e: ts.Node): ReadonlySet<string> => {
    const m = memo.get(e);
    if (m) return m;
    memo.set(e, new Set());
    const v = label0(e);
    memo.set(e, v);
    return v;
  };
  const label0 = (e: ts.Node): Set<string> => {
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isAwaitExpression(e) ||
      ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e)) return union(label(e.expression));
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e) || ts.isObjectLiteralExpression(e)) return new Set();
    if (!ts.isExpression(e) || !carries(e)) return new Set();
    if (ts.isIdentifier(e)) return labelsOfSym(symOf(e));
    if (ts.isPropertyAccessExpression(e)) {
      const r = e.expression;
      const rs = ts.isIdentifier(r) ? symOf(r) : undefined;
      const own = labelsOfSym(symOf(e.name));
      if (own.size === 0 && wordFieldNames.has(e.name.text) && fromParse(r)) own.add(WORDS);
      return union(own, opaque(r) || (rs !== undefined && objectSyms.has(rs)) ? label(r) : EMPTY);
    }
    if (ts.isElementAccessExpression(e)) {
      const key = stringOf(e.argumentExpression);
      const own = key !== null && wordFieldNames.has(key) && fromParse(e.expression) ? new Set([WORDS]) : new Set<string>();
      // A field picked by a key the code computes is any field: `picks[key]` of a parsed reply is the reply.
      return union(own, opaque(e.expression) || key === null ? label(e.expression) : EMPTY);
    }
    if (ts.isCallExpression(e) || ts.isNewExpression(e)) {
      const args = e.arguments ?? ts.factory.createNodeArray<ts.Expression>();
      const d = callee(e);
      if (d && FIELD_READERS.has(declName(d)) && args.length >= 2) {
        const name = stringOf(args[1]);
        return name !== null && auditFieldIsWords(name, e) ? new Set([WORDS]) : new Set();
      }
      if (d && BOUNDARY[declName(d)] !== undefined) return BOUNDARY[declName(d)] === "clean" ? new Set() : union(...args.map(label));
      if (d && STRUCTURE_RESULT.has(declName(d))) return new Set();
      if (d) {
        const id = fnId.get(d);
        const out = new Set<string>();
        for (const l of ret.get(d) ?? []) {
          if (l === WORDS) {
            out.add(WORDS);
            continue;
          }
          const m = /^P(\d+)@(\d+)$/.exec(l);
          if (!m || Number(m[2]) !== id) continue;
          const i = Number(m[1]);
          const rest = d.parameters[i]?.dotDotDotToken !== undefined;
          args.forEach((a, k) => {
            if (k === i || (rest && k > i)) for (const x of label(a)) out.add(x);
          });
        }
        return out;
      }
      const recv = ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) ? label(e.expression.expression) : EMPTY;
      return union(recv, ...args.map(label));
    }
    if (ts.isBinaryExpression(e)) return union(label(e.left), label(e.right));
    if (ts.isConditionalExpression(e)) return union(label(e.whenTrue), label(e.whenFalse));
    if (ts.isTemplateExpression(e)) return union(...e.templateSpans.map((s) => label(s.expression)));
    if (ts.isArrayLiteralExpression(e)) return union(...e.elements.map(elementLabel));
    if (ts.isSpreadElement(e)) return union(label(e.expression));
    return new Set();
  };
  // An array holding objects that hold the words holds the words: what an element of it carries.
  const elementLabel = (e: ts.Node): ReadonlySet<string> => {
    if (!ts.isObjectLiteralExpression(e)) return label(e);
    return union(...e.properties.map((p) => ts.isPropertyAssignment(p) ? elementLabel(p.initializer)
      : ts.isShorthandPropertyAssignment(p) ? label(p.name) : ts.isSpreadAssignment(p) ? label(p.expression) : EMPTY));
  };
  const live = (ls: ReadonlySet<string>): boolean => {
    if (ls.has(WORDS)) return true;
    for (const l of ls) {
      const m = /^P(\d+)@(\d+)$/.exec(l);
      if (m && reached.get(idFn[Number(m[2])])?.has(Number(m[1]))) return true;
    }
    return false;
  };
  const bindAll = (b: ts.BindingName, ls: ReadonlySet<string>) => {
    if (ts.isIdentifier(b)) addSym(symOf(b), ls);
    else for (const el of b.elements) if (!ts.isOmittedExpression(el)) bindAll(el.name, ls);
  };
  const bindPattern = (p: ts.BindingName, init: ts.Expression) => {
    const whole = label(init);
    if (ts.isIdentifier(p)) {
      addSym(symOf(p), whole);
      const s = symOf(p);
      if (s && fromParse(init) && !parsedSyms.has(s)) {
        parsedSyms.add(s);
        changed = true;
      }
      if (s && whole.size > 0 && ts.isCallExpression(init)) {
        const d = callee(init);
        if (d && BOUNDARY[declName(d)] === "object" && !objectSyms.has(s)) {
          objectSyms.add(s);
          changed = true;
        }
      }
      return;
    }
    const type = checker.getTypeAtLocation(p);
    for (const el of p.elements) {
      if (ts.isOmittedExpression(el)) continue;
      const prop = ts.isObjectBindingPattern(p) ? type.getProperty((el.propertyName ?? el.name).getText()) : undefined;
      bindAll(el.name, union(ts.isArrayBindingPattern(p) || opaque(init) ? whole : EMPTY, labelsOfSym(prop)));
    }
  };
  // The event of the audit writer call this object literal is the fields of; undefined when it is no such literal.
  const auditWriterEvent = (lit: ts.ObjectLiteralExpression): string | null | undefined => {
    let c: ts.Node = lit;
    while (c.parent && (ts.isParenthesizedExpression(c.parent) || ts.isAsExpression(c.parent) || ts.isSpreadAssignment(c.parent) ||
      (ts.isObjectLiteralExpression(c.parent) && c !== lit) || ts.isConditionalExpression(c.parent))) c = c.parent;
    const call = c.parent;
    if (!call || !ts.isCallExpression(call) || !call.arguments.includes(c as ts.Expression)) return undefined;
    const d = callee(call);
    if (!d || !/^(?:appendAuditEntry|appendAuditEntryUnlocked|emitAudit)$/.test(declName(d))) return undefined;
    return call.arguments[0] ? stringOf(call.arguments[0]) : null;
  };
  let census = false;
  const noteAuditField = (n: ts.PropertyAssignment | ts.ShorthandPropertyAssignment, words: boolean, plain: boolean) => {
    if (!census) return;
    const lit = n.parent as ts.ObjectLiteralExpression;
    const event = auditWriterEvent(lit);
    if (event === undefined) return;
    const name = ts.isComputedPropertyName(n.name) ? stringOf(n.name.expression) : n.name.getText().replace(/^["']|["']$/g, "");
    if (!name) return;
    if (!words) {
      if (event && plain) auditPlainFields.add(name);
      return;
    }
    const events = auditWordEvents.get(name) ?? new Set<string>();
    auditWordEvents.set(name, events);
    if (event) events.add(event);
  };
  const step = (n: ts.Node): void => {
    if (fnId.has(n) && BOUNDARY[declName(n)] !== undefined) return;
    if (ts.isVariableDeclaration(n) && n.initializer) bindPattern(n.name, n.initializer);
    else if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const v = label(n.right);
      if (ts.isIdentifier(n.left)) addSym(symOf(n.left), v);
      else if (ts.isPropertyAccessExpression(n.left)) addField(symOf(n.left.name), v, `${n.left.name.text} (assigned)`);
      else if (ts.isElementAccessExpression(n.left) && ts.isIdentifier(n.left.expression)) addSym(symOf(n.left.expression), v);
    } else if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const args = n.arguments ?? ts.factory.createNodeArray<ts.Expression>();
      const d = callee(n);
      if (d && BOUNDARY[declName(d)] === undefined) {
        // A function declared inside the caller is its closure: its parameters take what the caller hands them.
        const closure = (() => {
          for (let p = d.parent; p; p = p.parent) if (p === enclosingFn(n)) return true;
          return false;
        })();
        args.forEach((a, i) => {
          const v = label(a);
          const pi = Math.min(i, d.parameters.length - 1);
          if (pi >= 0 && closure) bindAll(d.parameters[pi].name, v);
          if (pi < 0 || !live(v)) return;
          let r = reached.get(d);
          if (!r) {
            r = new Set();
            reached.set(d, r);
          }
          if (!r.has(pi)) {
            r.add(pi);
            changed = true;
          }
        });
      } else if (!d && ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const recv = n.expression.expression;
        const rv = label(recv);
        if (rv.size > 0) {
          for (const a of args) if ((ts.isArrowFunction(a) || ts.isFunctionExpression(a)) && a.parameters[0]) bindAll(a.parameters[0].name, rv);
        }
        if (MUTATE.has(n.expression.name.text)) {
          const v = union(...args.map(elementLabel));
          if (ts.isIdentifier(recv)) addSym(symOf(recv), v);
          else if (ts.isPropertyAccessExpression(recv)) addField(symOf(recv.name), v, `${recv.name.text} (added to)`);
        }
      }
    } else if (ts.isReturnStatement(n) && n.expression) {
      const f = enclosingFn(n);
      if (f) addTo(ret, f, label(n.expression));
    } else if (ts.isArrowFunction(n) && !ts.isBlock(n.body)) {
      addTo(ret, n, label(n.body));
    } else if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && ts.isObjectLiteralExpression(n.parent)) {
      const v = ts.isPropertyAssignment(n) ? label(n.initializer) : label(n.name);
      noteAuditField(n, live(v), v.size === 0);
      if (v.has(WORDS)) {
        const name = ts.isComputedPropertyName(n.name) ? stringOf(n.name.expression) : n.name.getText().replace(/^["']|["']$/g, "");
        const owner = enclosingFn(n);
        const why = `${owner ? declName(owner) || "a function" : "module"} field ${name}`;
        addField(checker.getSymbolAtLocation(n.name), v, why);
        const ct = checker.getContextualType(n.parent);
        if (ct && name) for (const t of ct.isUnion() ? ct.types : [ct]) addField(t.getProperty(name), v, why);
      }
    } else if (ts.isForOfStatement(n)) {
      const v = label(n.expression);
      if (ts.isVariableDeclarationList(n.initializer)) {
        for (const d of n.initializer.declarations) {
          if (!ts.isObjectBindingPattern(d.name)) {
            bindAll(d.name, v);
            continue;
          }
          // Each element's fields by its type: `for (const { reply } of entries)` reads the field.
          const type = checker.getTypeAtLocation(d.name);
          for (const el of d.name.elements) bindAll(el.name, union(v, labelsOfSym(type.getProperty((el.propertyName ?? el.name).getText()))));
        }
      }
    }
    ts.forEachChild(n, step);
  };
  const all = [...new Set([...scanned, ...engineFiles])];
  const settle = () => {
    for (let round = 0; round < 40; round++) {
      changed = false;
      memo = new Map();
      for (const sf of all) step(sf);
      if (!changed) break;
    }
  };
  // First the record's own sources; then what the writer puts in each audit field, as it stands; then its reads too.
  settle();
  census = true;
  memo = new Map();
  for (const sf of all) step(sf);
  census = false;
  for (const [field, event] of AUDIT_FIELD_EVENTS) auditWordEvents.get(field)?.add(event);
  auditReadsAreSources = true;
  settle();
  memo = new Map();
  if (process.env.AIDLC_PIN_DEBUG) {
    for (const [f, ev] of auditWordEvents) console.log(`audit field ${f}: ${auditPlainFields.has(f) ? "shared" : "words only"} [${[...ev].join(", ")}]`);
  }

  // --- the places, and how each uses the words ---
  const isNullish = (e: ts.Expression) => e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === "undefined") || ts.isVoidExpression(e);
  const isEmptyString = (e: ts.Expression) => (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) && e.text === "";
  const decidesParam = new Map<ts.Node, Set<number>>();
  const useKind = (n: ts.Node): string => {
    // A value carried on by `??`, `||`, `&&`, a branch, a template or `+` is used where that expression is.
    const carriedOn = (child: ts.Node, parent: ts.Node): boolean =>
      ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isNonNullExpression(parent) ||
      ts.isAwaitExpression(parent) || ts.isSatisfiesExpression(parent) || ts.isTemplateSpan(parent) || ts.isTemplateExpression(parent) ||
      (ts.isConditionalExpression(parent) && parent.condition !== child) ||
      (ts.isBinaryExpression(parent) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.PlusToken].includes(parent.operatorToken.kind) && !(parent.left === child && isTest(parent)));
    // `a && b` or `a || b` as a condition tests `a`; `a ?? b` and `a + b` never do.
    const isTest = (b: ts.BinaryExpression): boolean => {
      if (b.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || b.operatorToken.kind === ts.SyntaxKind.PlusToken) return false;
      let q: ts.Node = b;
      while (q.parent && (ts.isParenthesizedExpression(q.parent) || (ts.isBinaryExpression(q.parent) && q.parent.operatorToken.kind === b.operatorToken.kind))) q = q.parent;
      const r = q.parent;
      return !!r && ((ts.isIfStatement(r) || ts.isWhileStatement(r)) && r.expression === q || (ts.isConditionalExpression(r) && r.condition === q) ||
        (ts.isPrefixUnaryExpression(r) && r.operator === ts.SyntaxKind.ExclamationToken) || (ts.isBinaryExpression(r) && r.operatorToken.kind !== b.operatorToken.kind && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(r.operatorToken.kind)) ||
        carries(q) === false);
    };
    let c: ts.Node = n;
    while (c.parent && carriedOn(c, c.parent)) c = c.parent;
    const p = c.parent;
    if (!p) return "copy";
    if (ts.isBinaryExpression(p) && COMPARE_OPS.has(p.operatorToken.kind)) {
      const other = p.left === c ? p.right : p.left;
      if (isNullish(other)) return "presence";
      if (isEmptyString(other)) return "blank";
      return live(label(other)) ? "match" : "compare";
    }
    if (ts.isBinaryExpression(p) && p.left === c && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(p.operatorToken.kind)) return "presence";
    if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) return "presence";
    if ((ts.isIfStatement(p) || ts.isWhileStatement(p)) && p.expression === c) return "presence";
    if (ts.isConditionalExpression(p) && p.condition === c) return "presence";
    if (ts.isSwitchStatement(p) || ts.isCaseClause(p)) return "compare";
    if (ts.isPropertyAccessExpression(p) && p.expression === c) {
      if (p.name.text === "length") return "shape";
      if (SEARCH.has(p.name.text) && ts.isCallExpression(p.parent) && p.parent.expression === p) return "compare";
      return "copy";
    }
    if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.some((a) => a === c)) {
      const fn = p.expression;
      if (DECODE.has(fn.getText())) return "decode";
      if (ts.isPropertyAccessExpression(fn) && SEARCH.has(fn.name.text)) return "compare";
      const d = callee(p);
      if (d && BOUNDARY[declName(d)] !== undefined) return `shape read ${declName(d)}`;
      if (d) {
        const i = p.arguments.indexOf(c as ts.Expression);
        if (decidesParam.get(d)?.has(Math.min(i, d.parameters.length - 1))) return `decides through ${declName(d)}`;
      }
      return "copy";
    }
    return "copy";
  };
  // A name that declares something (a field, a function, a binding) is no use of a value.
  const namesADeclaration = (p: ts.Node): boolean => ts.isPropertyAssignment(p) || ts.isPropertySignature(p) ||
    ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isMethodSignature(p) || ts.isFunctionDeclaration(p) ||
    ts.isClassDeclaration(p) || ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p) || ts.isEnumDeclaration(p) ||
    ts.isEnumMember(p) || ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p) ||
    ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p) || ts.isImportSpecifier(p) || ts.isExportSpecifier(p) ||
    ts.isNamespaceImport(p) || ts.isImportClause(p) || ts.isModuleDeclaration(p) || ts.isTypeParameterDeclaration(p) ||
    ts.isFunctionExpression(p) || ts.isClassExpression(p);
  const DECIDING = (kind: string) => kind === "compare" || kind === "match" || kind === "decode" || kind.startsWith("decides through");
  const valueNodes = (sf: ts.SourceFile, each: (n: ts.Expression) => void) => {
    const visit = (n: ts.Node) => {
      if (fnId.has(n) && BOUNDARY[declName(n)] !== undefined) return;
      if ((ts.isIdentifier(n) || ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || ts.isCallExpression(n)) &&
        !(n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) &&
        !(n.parent && namesADeclaration(n.parent) && (n.parent as { name?: ts.Node }).name === n) &&
        !(n.parent && ts.isTypeNode(n.parent))) {
        each(n);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  };
  // Which parameters decide, through every function that hands them on.
  for (let round = 0; round < 12; round++) {
    let grew = false;
    for (const sf of all) {
      valueNodes(sf, (n) => {
        const ls = label(n);
        if (ls.size === 0 || !DECIDING(useKind(n))) return;
        for (const l of ls) {
          const m = /^P(\d+)@(\d+)$/.exec(l);
          if (!m) continue;
          const f = idFn[Number(m[2])];
          const set = decidesParam.get(f) ?? new Set<number>();
          if (!set.has(Number(m[1]))) {
            set.add(Number(m[1]));
            decidesParam.set(f, set);
            grew = true;
          }
        }
      });
    }
    if (!grew) break;
  }
  const places = new Map<string, Found>();
  const placeOf = (sf: ts.SourceFile, n: ts.Node): string => `${scannedNames.get(fileKey(sf.fileName))}#${unitName(n)}`;
  for (const sf of scanned) {
    valueNodes(sf, (n) => {
      const ls = label(n);
      if (ls.size === 0 || !live(ls)) return;
      const key = placeOf(sf, n);
      const found = places.get(key) ?? { use: "keeps", uses: new Map(), sources: new Set(), from: new Set() };
      const kind = useKind(n);
      const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
      if (!found.uses.has(kind)) found.uses.set(kind, `${line}: ${(n.parent ?? n).getText().replace(/\s+/g, " ").slice(0, 100)}`);
      if (DECIDING(kind)) found.use = "decides";
      if (ls.has(WORDS)) {
        const s = ts.isPropertyAccessExpression(n) ? symOf(n.name) : ts.isIdentifier(n) ? undefined : undefined;
        const named = s ? rootsOf(s).map((r) => sourceName.get(r)).find(Boolean) : undefined;
        if (named) found.sources.add(named);
        else if (ts.isCallExpression(n)) {
          const d = callee(n);
          if (d && FIELD_READERS.has(declName(d))) found.sources.add(`audit field ${stringOf(n.arguments[1]) ?? "?"}`);
          else if (d && answerLineFns.has(d)) found.sources.add(answerLineFns.get(d) as string);
        }
      }
      places.set(key, found);
    });
  }
  // Who hands the words over, for the places they reach through parameters.
  for (const sf of all) {
    const visit = (n: ts.Node) => {
      if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && scannedSet.has(sf)) {
        const d = callee(n);
        if (d && BOUNDARY[declName(d)] === undefined && (n.arguments ?? []).some((a) => live(label(a)))) {
          const target = d.getSourceFile();
          if (scannedSet.has(target)) {
            const key = placeOf(target, d.body ?? d);
            const from = placeOf(sf, n);
            if (key !== from) places.get(key)?.from.add(from);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return places;
}

// ---------------------------------------------------------------------------
// The brand
// ---------------------------------------------------------------------------

/** The one way from PersonsWords back to text (core/tools/aidlc-lib.ts). */
export const UNWRAP = "core/tools/aidlc-lib.ts#personsWordsText";

/** What a place does across the brand: its calls of the unwrap, and its casts out of PersonsWords and into it. */
export interface BrandUse {
  unwraps: number;
  /** One line each: an `as` whose operand's type holds PersonsWords and whose target's does not. */
  castsOut: string[];
  /** One line each: the other way round. */
  castsIn: string[];
}

/**
 * The places in `files` (default: the shipped engine) that call the unwrap or cast across the brand, keyed `file#name`.
 * A type holds PersonsWords when it is the brand, or a union, a field, an element or a type argument holds it, as the
 * checker resolves them; `x as unknown as string` is one cast out, its inner half.
 */
export function scanPersonsWordsBrand(options: { root?: string; files?: string[] } = {}): Map<string, BrandUse> {
  const { program, scannedNames } = pinProgram(options);
  const checker = program.getTypeChecker();
  const lib = program.getSourceFiles().find((sf) => posix(sf.fileName).endsWith("/core/tools/aidlc-lib.ts"));
  let brand: ts.Symbol | undefined;
  let unwrap: ts.Node | undefined;
  for (const st of lib?.statements ?? []) {
    if (ts.isInterfaceDeclaration(st) && st.name.text === "PersonsWords") brand = checker.getSymbolAtLocation(st.name);
    if (ts.isFunctionDeclaration(st) && st.name?.text === UNWRAP.split("#")[1]) unwrap = st;
  }
  if (!brand || !unwrap) throw new Error("core/tools/aidlc-lib.ts declares no PersonsWords or no personsWordsText");
  const held = new Map<ts.Type, boolean>();
  const holds = (t: ts.Type, depth = 0): boolean => {
    const known = held.get(t);
    if (known !== undefined) return known;
    held.set(t, false);
    let v = false;
    if (t.isUnionOrIntersection()) v = t.types.some((x) => holds(x, depth + 1));
    else if (t.getSymbol() === brand) v = true;
    else if (depth < 6 && t.flags & ts.TypeFlags.Object) {
      const args = (t as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference ? checker.getTypeArguments(t as ts.TypeReference) : [];
      v = args.some((x) => holds(x, depth + 1)) ||
        checker.getPropertiesOfType(t).some((p) => holds(checker.getTypeOfSymbol(p), depth + 1));
    }
    held.set(t, v);
    return v;
  };
  const uses = new Map<string, BrandUse>();
  for (const sf of program.getSourceFiles()) {
    const file = scannedNames.get(fileKey(sf.fileName));
    if (file === undefined) continue;
    const at = (n: ts.Node) => {
      const key = `${file}#${unitName(n)}`;
      const entry = uses.get(key) ?? { unwraps: 0, castsOut: [], castsIn: [] };
      uses.set(key, entry);
      return entry;
    };
    const line = (n: ts.Node) => `${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}: ${n.getText().replace(/\s+/g, " ").slice(0, 100)}`;
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && checker.getResolvedSignature(n)?.declaration === unwrap) at(n).unwraps++;
      if ((ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) && !ts.isConstTypeReference(n.type)) {
        const from = holds(checker.getTypeAtLocation(n.expression));
        const to = holds(checker.getTypeFromTypeNode(n.type));
        if (from && !to) at(n).castsOut.push(line(n));
        else if (!from && to) at(n).castsIn.push(line(n));
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return uses;
}

/** The fixture files of the pin's reds. */
export function pinFixtureFiles(): string[] {
  const dir = join(REPO_ROOT, "tests", "fixtures", "persons-words-pin");
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".ts")).sort().map((name) => join(dir, name)) : [];
}

// ---------------------------------------------------------------------------
// The lists
// ---------------------------------------------------------------------------

const HOOK = "core/hooks/aidlc-record-human-turn.ts";
const LIB = "core/tools/aidlc-lib.ts";
const LOG = "core/tools/aidlc-log.ts";
const STORE = "core/tools/aidlc-message-store.ts";
const STATE = "core/tools/aidlc-state.ts";
const ORCH = "core/tools/aidlc-orchestrate.ts";
const ASK = "core/tools/aidlc-plan-approval-ask.ts";
const POSTURE = "core/tools/aidlc-testing-posture.ts";
const READER = "core/tools/aidlc-reply-reader.ts";
const AUDIT = "core/tools/aidlc-audit.ts";
const UNIT_CP = "core/tools/aidlc-construction-checkpoints.ts";
const SWARM_CP = "core/tools/aidlc-swarm-checkpoints.ts";
const SWARM = "core/tools/aidlc-swarm.ts";
const SWITCHES = "core/tools/aidlc-recorded-switches.ts";
const GUARD_SWITCH = "core/tools/aidlc-guard-switch.ts";
const LOCKS = "core/tools/aidlc-locks.ts";

/**
 * The places that stay, by category, each with its reason. `use` is what the place may do with the words; a keeper
 * that starts to decide on them is a new reader.
 */
export const ALLOWED: Record<string, Allowed> = {
  // The writer: the human-turn hook keeps the message, its words and the box's reply on the record.
  [`${HOOK}#respond`]: { use: "decides", why: "the human-turn hook: keeps the message and its words; it decides only through the places below (the host identities, the box's payload, the parse), and the cut check compares their words with their own words cut" },
  [`${HOOK}#pickerReplies`]: { use: "decides", why: "a question box's payload, host structure: parses the box's JSON into its questions and replies for QUESTION_REPLIED" },
  [`${HOOK}#pickedLabels`]: { use: "decides", why: "a question box's payload, host structure: the labels the box reports picked, for the HUMAN_TURN row's Picked", from: [`${HOOK}#respond`] },
  [`${HOOK}#carriesSeveralPicks`]: { use: "decides", why: "a question box's payload, host structure: whether the box reports more than one pick", from: [`${HOOK}#respond`] },
  [`${LIB}#emptyPickerResult`]: { use: "decides", why: "a question box's payload, host structure: whether a dismissed box carried any answer", from: [`${HOOK}#respond`] },
  "core/tools/aidlc-audit.ts#maskSecretShapes": { use: "keeps", why: "key shapes only: whether the turn held one, for the one line about it (saySecretMaskedOnce), and the isolated run's committed request kept masked; the words are kept whole in the message record", from: [`${HOOK}#respond`, `${ORCH}#ensureSingleStageStarted`] },
  [`${LIB}#boxPicksAddANote`]: { use: "decides", why: "a question box's pick, host structure (reading-lead, S7a answers Q3): the latest box reply's labels, never typed words" },
  [`${LIB}#recordGateWords`]: { use: "keeps", why: "the gate-words record's writer: keeps a typed message for the stage gate's record" },
  [`${LIB}#readGateWords`]: { use: "keeps", why: "the gate-words record's own read: checks the file's shape" },
  [`${LIB}#forgetGateWords`]: { use: "keeps", why: "the gate-words record's own write: forgets a message by its offset" },
  [`${LIB}#gateWordsSinceUnitReview`]: { use: "keeps", why: "the gate-words record: hands a checkpoint the replies typed while its review ran, blank ones left out" },
  [`${STORE}#parseMessage`]: { use: "keeps", why: "the message store's own read: checks a record's shape" },
  [`${STORE}#isPickerList`]: { use: "keeps", why: "the message store's own read: checks the box entries' shape", from: [`${STORE}#parseMessage`] },
  [`${STORE}#latestMessage`]: { use: "keeps", why: "the presence shape: a message with words or none (words === null)" },
  [`${STORE}#messageIsReply`]: { use: "keeps", why: "the presence shape: a message with words or none (words === null)" },
  [`${STORE}#noReplySince`]: { use: "keeps", why: "the presence shape: a line of settings alone is no reply (words === null)" },
  [`${ORCH}#handOutSettingsLine`]: { use: "keeps", why: "the presence shape: a line of settings alone (words === null) is handed to its setter once" },
  [UNWRAP]: { use: "keeps", why: "the brand's one way back to text, for the places below that read the message store or the gate-words record", from: [`${LIB}#gateWordsSinceUnitReview`, `${LIB}#personsGateReply`, `${LIB}#requireProtectedResponse`, `${LOG}#answerEnginePlanApproval`, `${ORCH}#takePersonsOwnLine`, `${STATE}#parkedWords`, `${STATE}#personsWordsFields`, `${GUARD_SWITCH}#saidInChat`, `${ORCH}#emit`, `${SWITCHES}#recordSwitchChange`, `${STATE}#requireHumanConstructionPolicyChange`, "core/tools/aidlc-utility.ts#handleReclassify", `${STATE}#handleReject`, `${LOG}#handleAnswer`, `${LIB}#keptRepliesSinceStageStart`, `${LIB}#latestReplyAfter`, `${UNIT_CP}#approveConstructionCheckpoint`, `${LIB}#personsWordsKept`, `${SWARM}#handleAllowChange`] },
  [`${LIB}#keptRepliesSinceStageStart`]: { use: "keeps", why: "the resume re-show: every reply since the stage started that nothing has used yet, a typed message's words and a box's replies, unpaired (R26: the agent pairs them)" },
  [`${LIB}#latestReplyAfter`]: { use: "keeps", why: "the audit writer: the plan override receipt's Person Reply, their latest reply since the offer, with its message" },
  [`${LIB}#protectedResponseFields`]: { use: "keeps", why: "the audit writer: a protected question's decision row, the response's words with every message they came in (Message Ids)" },
  [`${LIB}#readProtectedResponse`]: { use: "decides", why: "the protected response's own read: checks its fields' form (the digest's hex)" },
  [`${LIB}#withdrawProtectedReplyWords`]: { use: "decides", why: "drops a kept reply by its message id (the scan reads a reply's id as its words), and keeps the words of the replies that stay" },
  [`${AUDIT}#appendAuditEntry`]: { use: "keeps", why: "the audit writer", from: [`${LOG}#emitAudit`] },
  [`${AUDIT}#appendAuditEntryUnlocked`]: { use: "keeps", why: "the audit writer", from: [`${AUDIT}#appendAuditEntry`, `${LOG}#emitAudit`] },
  [`${AUDIT}#tapAuditMetric`]: { use: "keeps", why: "the audit writer: the row's metric", from: [`${AUDIT}#appendAuditEntryUnlocked`] },
  [`${LOG}#emitAudit`]: { use: "keeps", why: "the audit writer", from: [`${LOG}#handleAnswer`, `${LOG}#handleReview`] },
  [`${STATE}#personsWordsFields`]: { use: "keeps", why: "the audit writer: a gate row's Person Reply and Message Id from S1's window" },
  [`${LIB}#personsGateReply`]: { use: "keeps", why: "the audit writer: S1's window, every unspent reply since the stage's floor, blank ones and ones an earlier answer recorded (but the latest) left out" },
  [`${STATE}#approvedTogetherWordsFields`]: { use: "keeps", why: "the audit writer: copies the together gate's Person Reply onto the stages it approved" },
  [`${STATE}#personsFeedbackOutput`]: { use: "keeps", why: "the reject's output to the agent names whether their words were kept", from: [`${STATE}#handleReject`] },
  [`${STATE}#refuseForAgent`]: { use: "keeps", why: "a reject's refusal shows a blank reply as received (formatReceivedReply)", from: [`${STATE}#handleReject`] },
  [`${STATE}#DecisionNotMadeError.constructor`]: { use: "keeps", why: "the refusal's message, as above", from: [`${STATE}#refuseForAgent`] },
  [`${READER}#formatReceivedReply`]: { use: "keeps", why: "shows a blank reply as received in a refusal", from: [`${STATE}#handleReject`] },
  [`${LIB}#hasUnsafeSingleLineCharacter`]: { use: "keeps", why: "the audit writer's guard against a line break in a one-line field", from: [`${UNIT_CP}#rejectConstructionCheckpoint`, `${SWARM_CP}#rejectSwarmCheckpoint`] },
  [`${UNIT_CP}#approveConstructionCheckpoint`]: { use: "keeps", why: "the audit writer: the checkpoint approval's Person Reply" },
  [`${LOG}#answerEnginePlanApproval`]: { use: "keeps", why: "the audit writer: the plan answer's Person Reply" },
  [`${LOG}#handleReview`]: { use: "keeps", why: "the audit writer: the review request's Person Reply" },
  [`${LOG}#handleAnswers`]: { use: "keeps", why: "the audit writer: a batch of answers, blank details left out" },
  [`${LOG}#handleAnswer`]: { use: "keeps", why: "the audit writer: an answer's Person Reply, the message named or every unspent reply of this chat an earlier answer did not record" },
  "core/tools/aidlc-jump.ts#handleReopen": { use: "keeps", why: "the audit writer: a reopen for a change keeps their words as Feedback" },
  [`${STATE}#parkedWords`]: { use: "keeps", why: "the audit writer: the park row's Person Reply" },
  // The recorded answer's Details is the choice the agent recorded, never the file's [Answer]: line (S2a's R31).
  [`${LIB}#offeredChoiceLabel`]: { use: "decides", why: "the agent's --details, or a recorded answer's Details, against the labels the question offered (O4)", from: [`${LIB}#blockingSensorPicks`, `${ORCH}#learningsSinceStageStart`, "core/tools/aidlc-sensor-claim-sources.ts#assumptionsAcceptedOnRecord"] },
  "core/tools/aidlc-sensor-claim-sources.ts#assumptionsAcceptedOnRecord": { use: "decides", why: "the claim-sources sensor reads whether the Intent Capture assumptions were accepted from the recorded answer to that question" },
  [`${STATE}#requireHumanConstructionPolicyChange`]: { use: "keeps", why: "the audit writer: the Construction policy row's Person Reply" },
  [`${STATE}#emitConstructionPolicySet`]: { use: "keeps", why: "the audit writer: the Construction policy row's Person Reply, the words of the message the setter names" },
  [`${SWITCHES}#recordSwitchChange`]: { use: "keeps", why: "the switch record keeps the words that switched a check off" },
  [`${SWITCHES}#switchOffLine`]: { use: "keeps", why: "status: says a check is off with the words that switched it off" },
  [`${SWITCHES}#quoted`]: { use: "keeps", why: "status: quotes those words, cut", from: [`${GUARD_SWITCH}#askedSwitchLine`, `${SWITCHES}#switchOffLine`, `${SWARM}#handleAllowChange`] },
  [`${SWARM}#handleAllowChange`]: { use: "keeps", why: "the audit writer: a change the person asked for in the main checkout while the Units are built, their words as the row's Person Reply and quoted in the one line they hear" },
  [`${SWITCHES}#switchesOffLines`]: { use: "keeps", why: "status: the lines above" },
  [`${SWITCHES}#switchOffNotices`]: { use: "keeps", why: "status: the lines above" },
  [`${ASK}#correctReadRequestChanges`]: { use: "keeps", why: "the audit writer: the replies kept since a Request Changes are the correction's words" },
  [`${ASK}#rejectionRevision`]: { use: "keeps", why: "the plan's revision keeps the rejection's Feedback and the words said since it" },
  [`${ASK}#wordsSinceRejection`]: { use: "keeps", why: "the plan's revision: the replies since the rejection in the chat that asked for it (personsGateReply's window)" },
  [`${LIB}#freshReviewReceipts`]: { use: "keeps", why: "the presence shape: whether a review row carries Feedback" },
  [`${LIB}#plainSummaryAttemptRecorded`]: { use: "keeps", why: "the summary's answer as the agent recorded it (Details), for its recovery" },
  [`${LIB}#isSummaryConfirmationChoice`]: { use: "keeps", why: "as above", from: [`${LIB}#plainSummaryAttemptRecorded`] },
  [`${ORCH}#withKeptReplies`]: { use: "keeps", why: "the resume re-show: hands the agent the replies a stage kept" },
  [`${ORCH}#chatReplies`]: { use: "keeps", why: "the presence shape: whether an answer recorded now carries their words (words !== null), for the step at an open question" },
  [`${LIB}#personsWordsKept`]: { use: "keeps", why: "the presence shape: whether the chat's latest message has any text (a host that hands the hook an empty prompt keeps none), for the step at a question shown again" },
  // next's request (S2b): kept and quoted, never compared; what was read is the message id.
  [`${ORCH}#routeNext`]: { use: "decides", why: "next itself: quotes and previews the request (quoteCommandArgument) and whether one is there" },
  [`${ORCH}#freshWorkRoute`]: { use: "decides", why: "hands the request to the plan proposal step", from: [`${ORCH}#routeNext`] },
  [`${ORCH}#planProposalDirective`]: { use: "decides", why: "keeps the request as a question and previews it; reuses the question the words came through without comparing them", from: [`${ORCH}#freshWorkRoute`, `${ORCH}#routeNext`] },
  [`${ORCH}#saveReadingQuestion`]: { use: "keeps", why: "keeps the words as a routing question with the message they came in", from: [`${ORCH}#newWorkRoutingAskDirective`, `${ORCH}#routeNext`] },
  [`${ORCH}#takePersonsOwnLine`]: { use: "keeps", why: "the /aidlc parse of the person's own line; already read is the message id" },
  [`${ORCH}#keptWordsStep`]: { use: "decides", why: "the pick step's command: the words a reading step kept from this message, handed on as kept (wordsForNextStep)" },
  [`${ORCH}#resumeWithWords`]: { use: "keeps", why: "a resume with words beside it: whether words are there, then the line read again without --resume" },
  [`${ORCH}#resumeAgain`]: { use: "decides", why: "the unpark step's re-run: the words typed with the resume, handed on as typed (wordsForNextStep)" },
  [`${ORCH}#wordsForNextStep`]: { use: "decides", why: "a step's command: the words go to a request file of their own as given, or quoted onto the line when that file cannot be written", from: [`${ORCH}#keptWordsStep`, `${ORCH}#resumeAgain`] },
  [`${LIB}#writeRecordFileNoFollow`]: { use: "keeps", why: "writes a step's request file with the words as given, and the isolated run's request", from: [`${ORCH}#wordsForNextStep`, `${LIB}#keepSingleRunRequest`] },
  [`${LOCKS}#writeBufferAtomic`]: { use: "keeps", why: "the atomic write under writeRecordFileNoFollow", from: [`${LIB}#writeRecordFileNoFollow`] },
  [`${ORCH}#emit`]: { use: "decides", why: "the words the person said belong to the work in progress are kept once as the code plan question's reply (keepRoutedPlanApprovalReply), and leave it by their message id" },
  [`${ORCH}#withParkedReply`]: { use: "keeps", why: "the resume re-show: the words they parked the work with" },
  [`${ORCH}#wordsAtPark`]: { use: "keeps", why: "the resume re-show: reads the park row's Person Reply" },
  [`${ORCH}#emitSingleRunStage`]: { use: "decides", why: "a stage run on its own: hands the words typed with it to its start, which decides as below", from: [`${ORCH}#routeNext`] },
  [`${ORCH}#ensureSingleStageStarted`]: { use: "decides", why: "a stage run on its own with no work: keeps the words typed with it as its request, and starts the run over when they are not the same bytes as the ones its start kept (their digest; identity, never meaning)", from: [`${ORCH}#emitSingleRunStage`] },
  [`${LIB}#singleRunRequestDigest`]: { use: "keeps", why: "the isolated run's request: the digest that binds the kept words to their start", from: [`${LIB}#keepSingleRunRequest`, `${ORCH}#ensureSingleStageStarted`] },
  [`${LIB}#keepSingleRunRequest`]: { use: "keeps", why: "the isolated run's request: the words typed with it, kept whole beside its start for project-description", from: [`${ORCH}#ensureSingleStageStarted`] },
  [`${READER}#stripRecommendedDecorator`]: { use: "keeps", why: "a cut of the agent's \"(Recommended)\" mark, given words by the places that compare (each listed)", from: [`${LIB}#isSummaryConfirmationChoice`, `${LIB}#offeredChoiceLabel`, `${READER}#exactOptionPick`, `${READER}#isOneOfChoices`, `${POSTURE}#recordPlanApprovalHumanResponse`] },
  [`${READER}#isOneOfChoices`]: { use: "decides", why: "a question box's pick, host structure: whether the box offered the protected question's own labels", from: [`${POSTURE}#pickerAsksProtectedQuestion`] },
  [`${POSTURE}#pickerAsksProtectedQuestion`]: { use: "decides", why: "a question box's pick, host structure (DESIGN 2.2 item 6: a box pick stays structure)", from: [`${POSTURE}#recordProtectedHumanResponse`] },
  [`${LIB}#guardRecoveryTextSha256`]: { use: "keeps", why: "the digest of the guard-recovery reply its record keeps (consumeSharedDirectiveAsk writes it)", from: [`${LIB}#consumeSharedDirectiveAsk`] },
  [`${LIB}#normalizeGuardRecoveryText`]: { use: "keeps", why: "the spacing cut before that digest", from: [`${LIB}#guardRecoveryTextSha256`] },
  [`${LIB}#contentSha256`]: { use: "keeps", why: "that digest", from: [`${LIB}#guardRecoveryTextSha256`] },
  // A question box's pick of an engine-handed list, host structure since S3 (#2926): a typed reply is the agent's to read.
  [`${HOOK}#extractResponseText`]: { use: "decides", why: "a question box's payload, host structure: unwraps the box's JSON (a typed prompt is kept as typed since S3)", from: [`${HOOK}#respond`] },
  [`${LIB}#consumeSharedDirectiveAsk`]: { use: "decides", why: "guard recovery: the box's pick when the box offered the remedies, and the reply's digest the recovery record keeps (from emit: a routed request's message, kept again as the reply the routing question took from the recovery question)", from: [`${HOOK}#respond`, `${ORCH}#emit`] },
  [`${POSTURE}#recordProtectedHumanResponse`]: { use: "decides", why: "the protected question's response: the box's pick only, and the words kept with presence", from: [`${HOOK}#respond`] },
  [`${READER}#protectedQuestionPick`]: { use: "decides", why: "a question box's pick of the protected question's choices", from: [`${POSTURE}#recordProtectedHumanResponse`] },
  [`${ASK}#keepRoutedPlanApprovalReply`]: { use: "decides", why: "hands the routed words to the plan question once, in the order sent: reads their message's id and time, never the words", from: [`${ORCH}#emit`] },
  [`${ASK}#notePlanApprovalAskReply`]: { use: "decides", why: "Plan Approval: the box's pick only, and the replies after the ask kept for the record", from: [`${HOOK}#respond`, `${ASK}#keepRoutedPlanApprovalReply`] },
  [`${READER}#exactOptionPick`]: { use: "decides", why: "a box's pick matched to the engine's list the box offered (DESIGN 2.2 item 6)", from: [`${LIB}#consumeSharedDirectiveAsk`, `${ASK}#notePlanApprovalAskReply`, `${READER}#protectedQuestionPick`, `${POSTURE}#recordPlanApprovalHumanResponse`] },
  [`${UNIT_CP}#askConstructionCheckpoint`]: { use: "keeps", why: "the audit writer: the replies typed while the review ran become the checkpoint's response" },
  [`${UNIT_CP}#rejectConstructionCheckpoint`]: { use: "keeps", why: "the audit writer: the checkpoint reject's Feedback and Reason" },
  [`${SWARM_CP}#rejectSwarmCheckpoint`]: { use: "keeps", why: "the audit writer: the batch reject's Feedback and Reason" },
  [`${LIB}#changeRequestWords`]: { use: "keeps", why: "the reject's lines joined as the change to make", from: [`${UNIT_CP}#rejectConstructionCheckpoint`, `${SWARM_CP}#rejectSwarmCheckpoint`] },
  [`${LIB}#requireProtectedResponse`]: { use: "keeps", why: "the audit writer: a named message's words become the protected response's" },
  // The setters (S6): a setting the person asked for keeps the words of the message the agent names, as Person Reply
  // and in the line that says it is set by them; nothing compares them.
  [`${GUARD_SWITCH}#saidInChat`]: { use: "keeps", why: "a setting is theirs on the message the agent names: its words for the record" },
  [`${GUARD_SWITCH}#applyIntentSettings`]: { use: "keeps", why: "the audit writer: a setting's Person Reply, the named message's words" },
  [`${GUARD_SWITCH}#askedSwitchLine`]: { use: "keeps", why: "the line that says a check is off quotes the words they asked in", from: [`${GUARD_SWITCH}#applyIntentSettings`] },
  "core/tools/aidlc-utility.ts#writeSettings": { use: "keeps", why: "hands the setter's lines on to its output" },
  "core/tools/aidlc-utility.ts#applyKeptToPickedWork": { use: "keeps", why: "as above, for settings kept for the work the person picks" },
  "core/tools/aidlc-utility.ts#handleConfigChange": { use: "keeps", why: "prints the setter's lines" },
  [`${LIB}#leaveSayOnceNote`]: { use: "keeps", why: "the say-once note's writer: copies the setter's lines, which quote their words, for the model to say once", from: ["core/tools/aidlc-utility.ts#handleConfigChange"] },
  [`${LIB}#sayOnceNoteLine`]: { use: "keeps", why: "the say-once note's own read: hands the setter's lines to the model as written, or drops them; it takes the note by its chat and message id, never by its text" },
  "core/tools/aidlc-utility.ts#handleIntent": { use: "keeps", why: "prints the lines of the settings kept for the work they pick" },
  "core/tools/aidlc-utility.ts#handleSpace": { use: "keeps", why: "as above, for the space they pick" },
  "core/tools/aidlc-utility.ts#handleRecompose": { use: "keeps", why: "prints the setter's lines with the plan change" },
  "core/tools/aidlc-utility.ts#handleScopeChange": { use: "decides", why: "prints the setter's lines, each ended with a full stop when it has none (the line's last character) for the person's next line" },
  "core/tools/aidlc-utility.ts#handleReclassify": { use: "keeps", why: "the audit writer: the reclassify row's Person Reply, the named message's words" },
  [`${STATE}#handleReject`]: { use: "keeps", why: "the audit writer: a reject's Feedback (their words) and Message Id, the agent's text beside them as Conductor Summary" },
  // The questions files' `[Answer]:` line (ANSWER_LINE_READERS): its presence, and the agent's own writes checked
  // against its own arguments (O4's class), never what the person wrote there.
  [`${LIB}#checkSummaryConfirmationEvidence`]: { use: "decides", why: "O4: the summary's [Answer]: tag is the agent's write (log's summary step has it write the choice label), checked against the engine's own label (SUMMARY_ANSWER_INVALID)" },
  [`${POSTURE}#planApprovalQuestionEvidence`]: { use: "decides", why: "O4: the plan file's [Answer]: label, written by the agent itself, checked against its own --details (blank before the question); on the engine's plan question the recorder writes the line and never runs this" },
  [`${POSTURE}#planApprovalAnswerLabel`]: { use: "keeps", why: "cuts the recorder's option letter and quotes off that label", from: [`${POSTURE}#planApprovalQuestionEvidence`] },
  [`${POSTURE}#questionsFileHasPendingPlanApproval`]: { use: "decides", why: "the presence shape: whether the plan file's [Answer]: line is still blank (or underscores)" },
  [`${ASK}#onlyTheirAnswerDiffers`]: { use: "keeps", why: "the presence shape: the person's answer in the plan file stays while the same question stands (the engine never erases what they wrote)" },
  [`${ASK}#requestPlanApprovalReviewNow`]: { use: "keeps", why: "the presence shape: a recorded answer on the plan file's line is cleared when the person asks to review the plan again" },
  [`${ASK}#answerLineAsFound`]: { use: "decides", why: "the engine's own line: the plan file's line is left out when it is exactly a mark the engine wrote there (the recorded answer's mark, either mark while the person edits, \"Plan approval off\"), so the engine's line is never kept as theirs; nothing else of theirs is read" },
  [`${ASK}#approveTarget`]: { use: "keeps", why: "the audit writer: the approval row keeps the plan file's line as the person left it (Answer Line In File) before the engine writes its mark there" },
  [`${ASK}#requestChangesFor`]: { use: "keeps", why: "the audit writer: as above, on the Request Changes answer row" },
  // The request the agent forwards to next (its free text) and the question store that keeps it: shown back, quoted
  // into a command, kept; each with its reason.
  "core/tools/aidlc-runtime-paths.ts#quoteCommandArgument": { use: "decides", why: "shell-quotes their words into a command the agent runs", from: [`${ORCH}#reshapeReplyArgument`, `${ORCH}#routeNext`, `${ORCH}#routingQuestionReplyDirective`, `${ORCH}#wordsForNextStep`] },
  "core/tools/aidlc-runtime-paths.ts#readsAlikeInDoubleQuotes": { use: "decides", why: "whether every shell reads their words alike in double quotes, for quoteCommandArgument", from: ["core/tools/aidlc-runtime-paths.ts#quoteCommandArgument"] },
  [`${LIB}#parseLiteralShellInvocation`]: { use: "decides", why: "as above", from: [`${LIB}#isTerminalConfigurationDispatch`] },
  [`${LIB}#isTerminalConfigurationDispatch`]: { use: "decides", why: "reads the engine's own step message (which may quote their request) for a configuration command" },
  [`${LIB}#addPendingPersonLines`]: { use: "keeps", why: "keeps a step's narration, or a setter's lines, for the person's next line", from: [`${ORCH}#sayPendingPersonLines`, `core/tools/aidlc-utility.ts#handleScopeChange`] },
  [`${LIB}#authoritativeProjectDescription`]: { use: "decides", why: "a shape read: splits a pasted <document> block, exact markers, from the directions around it", from: [`${ORCH}#authoritativeRequest`, `${ORCH}#documentSplitSentence`, `${ORCH}#namedDocumentNote`, `${ORCH}#pastedDocumentNote`] },
  "core/tools/aidlc-question-store.ts#parseQuestion": { use: "keeps", why: "the question store's own read: checks a record's shape" },
  "core/tools/aidlc-question-store.ts#saveQuestion": { use: "keeps", why: "the question store's writer: keeps the request as the question's text", from: [`${ORCH}#composeOfferAskDirective`, `${ORCH}#createPrintDirective`, `${ORCH}#planProposalDirective`, `${ORCH}#routeNext`, `${ORCH}#saveReadingQuestion`, `${ORCH}#scopeConfirmAskDirective`] },
  "core/tools/aidlc-utility.ts#handleIntentCreate": { use: "keeps", why: "creates the work with the request's words (the question's text)" },
  [`${ORCH}#isKeptRequest`]: { use: "keeps", why: "the presence shape: whether next carries a request" },
  [`${ORCH}#noteRestartRequest`]: { use: "keeps", why: "keeps a new chat's request for the step that asks about it" },
  [`${ORCH}#speaksToPerson`]: { use: "keeps", why: "as above" },
  [`${ORCH}#sayPendingPersonLines`]: { use: "keeps", why: "a step's narration, which may carry their request" },
  [`${ORCH}#prepareEmission`]: { use: "decides", why: "the step's text cut at a character boundary" },
  [`${ORCH}#authoritativeRequest`]: { use: "decides", why: "the request a question shows back: its directions outside a pasted document", from: [`${ORCH}#composeDispatchDirective`, `${ORCH}#newWorkRoutingAskDirective`, `${ORCH}#requestPreview`] },
  [`${ORCH}#requestPreview`]: { use: "decides", why: "the request a question shows back, cut to 240 characters", from: [`${ORCH}#freshWorkOfferDirective`, `${ORCH}#intentPickPromptIfRecordsExist`, `${ORCH}#planProposalDirective`, `${ORCH}#routeNext`] },
  [`${ORCH}#documentSplitSentence`]: { use: "decides", why: "the one line a question adds when the request carries a pasted document", from: [`${ORCH}#createPrintDirective`, `${ORCH}#freshWorkOfferDirective`, `${ORCH}#intentPickPromptIfRecordsExist`, `${ORCH}#planProposalDirective`, `${ORCH}#routeNext`] },
  [`${ORCH}#scopeConfirmAskDirective`]: { use: "keeps", why: "as above (the scope confirmation)", from: [`${ORCH}#freshWorkOfferDirective`] },
  [`${ORCH}#namedDocumentNote`]: { use: "decides", why: "as above, for the compose offer", from: [`${ORCH}#composeOfferAskDirective`] },
  [`${ORCH}#composeOfferAskDirective`]: { use: "decides", why: "as above (the compose offer)", from: [`${ORCH}#freshWorkOfferDirective`] },
  [`${ORCH}#routingQuestionReplyDirective`]: { use: "decides", why: "the routing question's reply step hands their words back, quoted, in its command", from: [`${ORCH}#routeNext`] },
  [`${ORCH}#reshapeReplyArgument`]: { use: "decides", why: "a print between a reshape answer and the composer hands their reply on, quoted, in its command, when the answer carried one" },
  [`${ORCH}#newWorkRoutingAskDirective`]: { use: "decides", why: "as above (the routing question)", from: [`${ORCH}#intentPickPromptIfRecordsExist`, `${ORCH}#routeNext`] },
  [`${ORCH}#printDirective`]: { use: "keeps", why: "prints a step, which may carry their request", from: [`${ORCH}#jumpStepPrint`, `${ORCH}#routeNext`, `${ORCH}#routingQuestionReplyDirective`] },
  [`${ORCH}#jumpStepPrint`]: { use: "keeps", why: "as above, for a step that names one jump", from: [`${ORCH}#emitTypedResumeChoice`] },
  [`${ORCH}#projectTypeIsWholeRequest`]: { use: "keeps", why: "the presence shape: the line is only the project type" },
  [`${ORCH}#parkedDirective`]: { use: "keeps", why: "a step's narration, which may carry their words", from: [`${ORCH}#parkAfterApproval`] },
  [`${ORCH}#parkAfterApproval`]: { use: "keeps", why: "as above" },
  [`${ORCH}#nextArgsAreOnlyWords`]: { use: "keeps", why: "the presence shape: next carries only words" },
  [`${ORCH}#planTypedAloneBesideWork`]: { use: "keeps", why: "the presence shape: a plan's name with no words after it" },
  [`${ORCH}#freshWorkOfferDirective`]: { use: "decides", why: "as above (the plan offer)" },
  [`${ORCH}#createPrintDirective`]: { use: "decides", why: "a question that shows their request back and keeps it in the question store" },
  [`${ORCH}#planNamedAloneStep`]: { use: "keeps", why: "as above" },
  [`${ORCH}#pastedDocumentNote`]: { use: "decides", why: "as above, for the composer", from: [`${ORCH}#composeDispatchDirective`] },
  [`${ORCH}#composeDispatchDirective`]: { use: "decides", why: "as above (the composer's step)" },
  [`${ORCH}#intentPickPromptIfRecordsExist`]: { use: "decides", why: "as above (the pick question)" },
  [`${ORCH}#buildRunStageDirective`]: { use: "keeps", why: "as above" },
  [`${ORCH}#applyGateOnlyShape`]: { use: "keeps", why: "as above" },
  [`${ORCH}#emitTypedResumeChoice`]: { use: "keeps", why: "as above" },
  [`${ORCH}#handleReport`]: { use: "keeps", why: "as above" },
  [`${ORCH}#main`]: { use: "keeps", why: "as above: clears the kept restart request" },
  // The shape reads: the blank test and the `/aidlc` parse (BOUNDARY), with the callers that run them.
  [`${HOOK}#messageParse`]: { use: "keeps", why: "the /aidlc parse: the flags the engine's own parser finds, and the words after them", from: [`${HOOK}#respond`] },
  [`${HOOK}#helpRelay`]: { use: "keeps", why: "the /aidlc parse: a typed help request relays AI-DLC's help", from: [`${HOOK}#respond`] },
  [`${LIB}#terminalCommandRelay`]: { use: "keeps", why: "the /aidlc parse: the relayed command line", from: [`${HOOK}#helpRelay`] },
  [`${GUARD_SWITCH}#setterCommandNames`]: { use: "keeps", why: "the /aidlc parse (reading-lead, S7a answers Q3): whether the typed line is the setter command itself, by the dispatcher's own parse", from: [`${GUARD_SWITCH}#saidInChat`] },
  // The host-text identities kept where the host gives no mark (Arden 2026-10-22, DESIGN section 3 item 4).
  [`${LIB}#hostEnvelopeTurnText`]: { use: "decides", why: "host-text identity: Kiro Crew's request header (P2)", from: [`${HOOK}#respond`] },
  [`${LIB}#hostTemplateOrigin`]: { use: "decides", why: "host-text identity: the Kiro CLI v2, Claude no-row and Kiro workflow brief templates (P1)", from: [`${HOOK}#respond`] },
  [`${LIB}#claudeTranscriptOrigin`]: { use: "decides", why: "host-text identity: finds Claude Code's transcript row for this prompt (P1's marked path)", from: [`${HOOK}#respond`] },
  [`${LIB}#newestUserEntry`]: { use: "decides", why: "host-text identity: the transcript row whose text is this prompt", from: [`${LIB}#claudeTranscriptOrigin`] },
  // The legacy Kiro IDE nonce match, while that window exists (DESIGN 2.2a R11).
  [`${POSTURE}#recordPlanApprovalHumanResponse`]: { use: "decides", why: "the legacy Kiro IDE nonce match: the hash of their text against the hashed nonce labels, the only chat proof where no box exists", from: [`${HOOK}#respond`] },
  // The agent's own recorded answer (O4): the agent-argument checks over what the agent recorded, never a message.
  [`${LIB}#latestRecordedAnswerMode`]: { use: "decides", why: "O4: the answer mode the agent recorded (QUESTION_ANSWERED Details)" },
  [`${LIB}#answerModeFromReply`]: { use: "decides", why: "O4: reads the agent's recorded answer mode", from: [`${LIB}#latestRecordedAnswerMode`] },
  [`${LIB}#blockingSensorPicks`]: { use: "decides", why: "O4: the agent's recorded Fix findings or override choice (QUESTION_ANSWERED Details) against the engine's labels or their number on the decision's own Options list" },
  [`${ORCH}#learningsSinceStageStart`]: { use: "decides", why: "O4 and a question box's pick, host structure: whether every learnings pick since the stage started is exactly \"Nothing to add\" or \"Keep none of these\", from the recorded answer's Details and the box reply's labels for the ritual's two questions; never typed words" },
};

/**
 * Names on the allowlist the scan does not reach today (the adapters' host input is untyped), so a typed read there
 * is held to its use the day it appears.
 */
export const ALLOWED_UNREACHED: Record<string, Allowed> = {
  "harness/copilot/hooks/aidlc-copilot-adapter.ts#run": { use: "decides", why: "host-text identity: Copilot's subagent briefs by the digest of a brief AI-DLC recorded (P4: briefingDigest, checkBriefing)" },
  "harness/kiro/hooks/aidlc-kiro-adapter.ts#run": { use: "decides", why: "host-text identity: the Crew header and the Kiro CLI templates on the verb-intercept path (P1, P2)" },
  "harness/kiro-ide/hooks/aidlc-kiro-adapter.ts#messageOrigin": { use: "decides", why: "host-text identity: the Kiro workflow brief template (P1)" },
  [`${LIB}#kiroTurnOrigin`]: { use: "decides", why: "host-text identity: the Kiro templates (P1)" },
  [`${LIB}#kiroChatRecordOrigin`]: { use: "decides", why: "host-text identity: the Kiro chat record's mark for this prompt (P1)" },
  // The `[Answer]:` line read inline from a questions file's text, the person's when they answer in the file.
  [`${ORCH}#questionsCount`]: { use: "decides", why: "the presence shape: how many of a stage's [Answer]: lines hold an answer, for the review line" },
  [`${ORCH}#answeredQuestionsFile`]: { use: "decides", why: "the presence shape: whether a stage's questions file holds its questions (an [Answer]: tag, filled or blank)" },
  "core/tools/aidlc-sensor-claim-sources.ts#parseSourceUniverse": { use: "decides", why: "the claim-sources sensor: duplicate [Answer]: entries and which questions are filled (presence and shape); its Assumption Confirmation read is S2a's R31" },
  "core/tools/aidlc-sensor-claim-sources.ts#answerIsFilled": { use: "decides", why: "the presence shape: an [Answer]: line holds more than blanks or underscores", from: ["core/tools/aidlc-sensor-claim-sources.ts#parseSourceUniverse"] },
};

/** The places that make a record's words PersonsWords: the two records' writers and their own reads of the file. */
export const BRAND_WRITERS: readonly string[] = [
  `${STORE}#saveMessage`, `${STORE}#parseMessage`, `${LIB}#recordGateWords`, `${LIB}#readGateWords`,
];

/** The agent-argument checks (O4): they read the agent's argv or the file it wrote, never the person's words. */
export const AGENT_ARGUMENT_CHECKS: readonly string[] = [
  `${LIB}#summaryConfirmationAnswer`, `${LIB}#summaryAnswerFromFile`, `${LIB}#offeredGuardRemedy`,
  `${LIB}#picksAddANote`,
];

/**
 * Today's readers the reading slices remove (DESIGN.md section 5), each with its slice and row. The slice deletes its
 * lines; a place that stays after it, keeping the words, moves to ALLOWED in the same change.
 */
export const STILL_TO_GO: Record<string, ToGo> = {};

/**
 * The text-blind fuzz's failure groups today's main still has (tests/harness/text-blind-fuzz.ts), each named with the
 * slice that removes it; `group` is the failure's group as the fuzz prints it. A group no row names fails the fuzz.
 */
export interface FuzzRow {
  group: string;
  slice: Slice;
  row: string;
  why: string;
}
export const FUZZ_STILL_TO_GO: readonly FuzzRow[] = [];
