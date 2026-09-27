import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { claudeDependenciesOf, codeView } from "../gen-coverage-registry.ts";
import type { E2eResource, E2eTask } from "./e2e-scheduler.ts";

export interface PlannedE2eTask extends E2eTask {
  requiresClaude: boolean;
  tui: boolean;
  liveGates: string[];
}

/** Historical runner summaries are scheduling hints, never a test selection list. */
export function readE2eTimings(text: string): Record<string, number> {
  const weights: Record<string, number> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\S+)\s+(?:PASS|FAIL|SKIP)\s+\d+\s+\d+\s+(\S+)s\s*$/.exec(line);
    if (!match) continue;
    const seconds = Number(match[2]);
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new Error(`--e2e-timings has an invalid duration for ${match[1]}: ${match[2]}`);
    }
    if (Number.isFinite(seconds) && seconds > 0) {
      weights[`${match[1]}.test.ts`] = seconds;
    }
  }
  if (Object.keys(weights).length === 0) {
    throw new Error("--e2e-timings requires a runner summary containing positive per-file durations");
  }
  return weights;
}

/** Derive resource demand without importing or executing the test files. */
export function planE2eFile(
  file: string,
  weights: Record<string, number> = {},
  platform: NodeJS.Platform = process.platform,
): PlannedE2eTask {
  const name = basename(file);
  const source = readFileSync(file, "utf8");
  const code = codeView(source);
  const requiresClaude = claudeDependenciesOf(name, source).length > 0;
  const tui = /tui-drive\.ts/.test(code) || name.startsWith("t-tui");
  const kiroIde = /\blaunchKiroIde\s*\(/.test(code) || name.startsWith("t-ide-kiro-");
  const kiro = kiroIde || /\bdriveKiroAcp\s*\(/.test(code) ||
    /^t-(?:acp|tui)-kiro-/.test(name);
  const codex = /\bexecCodex\s*\(/.test(code) || name.startsWith("t-exec-codex-");
  const opencode = /\bexecOpencode\s*\(|\brunOpencode\s*\(/.test(code) ||
    name.startsWith("t-run-opencode-");
  const resources: E2eResource[] = [];
  if (requiresClaude || codex || opencode) resources.push("bedrock");
  if (kiro) resources.push("kiro");
  if (kiroIde) resources.push("ide");
  // Preserve unknown serial constraints. Known driver families have worker-owned
  // projects/profiles/transports; a new serial family needs an explicit audit.
  const knownSerialFamily = /^t-(?:tui-|acp-kiro-|exec-codex-|ide-kiro-|run-opencode-)/.test(name);
  const timeout = /AIDLC_TEST_TIMEOUT\s*\?\?\s*["'](\d+)["']/.exec(code);
  const estimate = weights[name] ?? (timeout ? Number(timeout[1]) : 30);
  return {
    file,
    resources,
    estimatedSeconds: Number.isFinite(estimate) && estimate > 0 ? estimate : 30,
    exclusive: name.includes(".serial.") && !knownSerialFamily,
    // Fresh native homes still initialize host sandbox accounts. Their concurrent
    // initialization is not yet verified; keep other harness lanes available.
    ...(platform === "win32" && codex ? { serialGroup: "windows-codex" } : {}),
    requiresClaude,
    tui,
    liveGates: [...new Set(code.match(/\bAIDLC_[A-Z_]+_LIVE\b/g) ?? [])].sort(),
  };
}

export interface E2eCaseCounts {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

/** Preserve skipped cases, which the legacy file-level PASS label cannot express. */
export function e2eCaseCounts(xml: string): E2eCaseCounts {
  const root = /<testsuites\b[^>]*>/.exec(xml)?.[0] ?? "";
  const attribute = (name: string): number | undefined => {
    const match = new RegExp(`\\b${name}="(\\d+)"`).exec(root);
    return match ? Number(match[1]) : undefined;
  };
  const total = attribute("tests") ?? (xml.match(/<testcase\b/g) ?? []).length;
  const failed = attribute("failures") ?? (xml.match(/<failure\b/g) ?? []).length;
  const skipped = attribute("skipped") ?? (xml.match(/<skipped\b/g) ?? []).length;
  return { total, failed, skipped, passed: Math.max(0, total - failed - skipped) };
}

export type JUnitEvidence =
  | { complete: true; cases: E2eCaseCounts }
  | { complete: false; error: string };

export interface JUnitTestCase {
  classname: string;
  name: string;
  outcome: "PASS" | "FAIL" | "SKIP";
  file?: string;
}

export type DetailedJUnitEvidence =
  | { complete: true; cases: E2eCaseCounts; testcases: JUnitTestCase[] }
  | { complete: false; error: string };

/** Preserve the existing count-only API; identity validation is opt-in. */
export function validateJUnitEvidence(xml: string): JUnitEvidence {
  const parsed = parseJUnitEvidence(xml);
  return parsed.complete ? { complete: true, cases: parsed.cases } : parsed;
}

/** Exact decoded identities from the same strict parser, never a second regex reader. */
export function readJUnitEvidence(xml: string): DetailedJUnitEvidence {
  const parsed = parseJUnitEvidence(xml);
  if (!parsed.complete) return parsed;
  const seen = new Set<string>();
  for (const testcase of parsed.testcases) {
    if (!testcase.name) return { complete: false, error: "Invalid JUnit evidence: empty testcase name" };
    const key = JSON.stringify([testcase.classname, testcase.name]);
    if (seen.has(key)) return { complete: false, error: "Invalid JUnit evidence: duplicate testcase identity" };
    seen.add(key);
  }
  return parsed;
}

/**
 * Validate Bun's JUnit evidence, independently of the child's exit status.
 * Complete means one closed XML document with cases and reconciled counts;
 * failed/skipped cases remain valid evidence, not successful required coverage.
 * The legacy e2eCaseCounts intentionally remains a permissive diagnostic reader.
 */
function parseJUnitEvidence(xml: string): DetailedJUnitEvidence {
  type Counts = { tests: number; failures: number; errors: number; skipped: number };
  type Element = {
    name: string; attributes: Map<string, string>; counts: Counts;
    outcome?: "failures" | "errors" | "skipped";
  };
  const countNames = ["tests", "failures", "errors", "skipped"] as const;
  const textElements = new Set(["failure", "error", "skipped", "system-out", "system-err", "property"]);
  const children: Record<string, readonly string[]> = {
    testsuites: ["testsuite", "properties", "system-out", "system-err"],
    testsuite: ["testsuite", "testcase", "properties", "system-out", "system-err"],
    testcase: ["failure", "error", "skipped", "properties", "system-out", "system-err"],
    properties: ["property"],
  };
  const stack: Element[] = [];
  const testcases: JUnitTestCase[] = [];
  let root: Element | undefined;
  let closedRoot = false;
  let at = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  const declarationAt = at;
  const namePattern = /[A-Za-z_][A-Za-z0-9_.:-]*/y;
  const whitespace = /[ \t\r\n]*/y;
  const invalid = (message: string): never => {
    throw new Error(`${message} (offset ${at})`);
  };
  const space = (): number => {
    whitespace.lastIndex = at;
    const size = whitespace.exec(xml)![0].length;
    at += size;
    return size;
  };
  const name = (): string => {
    namePattern.lastIndex = at;
    const match = namePattern.exec(xml);
    if (!match) return invalid("expected XML name");
    at += match[0].length;
    return match[0];
  };
  const xmlCharacter = (code: number): boolean =>
    code === 9 || code === 10 || code === 13 ||
    (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff);
  const entities = (value: string): string => {
    const entity = /&(?:#([0-9]+)|#x([0-9a-fA-F]+)|(amp|lt|gt|apos|quot));/y;
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", apos: "'", quot: '"' };
    let result = "";
    let from = 0;
    for (let amp = value.indexOf("&"); amp !== -1; amp = value.indexOf("&", from)) {
      result += value.slice(from, amp);
      entity.lastIndex = amp;
      const match = entity.exec(value);
      if (!match) return invalid("invalid XML entity");
      if (match[3]) result += named[match[3]];
      else {
        const code = match[1] ? Number(match[1]) : Number.parseInt(match[2], 16);
        if (!Number.isSafeInteger(code) || !xmlCharacter(code)) return invalid("invalid XML character reference");
        result += String.fromCodePoint(code);
      }
      from = entity.lastIndex;
    }
    return result + value.slice(from);
  };
  const close = (): void => {
    const element = stack.pop()!;
    if (element.name === "testcase") {
      element.counts.tests = 1;
      if (element.outcome) element.counts[element.outcome] = 1;
      const file = element.attributes.get("file") ??
        [...stack].reverse().find((parent) => parent.name === "testsuite" && parent.attributes.has("file"))?.attributes.get("file");
      testcases.push({
        classname: element.attributes.get("classname") ?? "",
        name: element.attributes.get("name") ?? "",
        outcome: element.outcome === "skipped" ? "SKIP" : element.outcome ? "FAIL" : "PASS",
        ...(file !== undefined ? { file } : {}),
      });
    }
    if (element.name === "testsuite" || element.name === "testsuites") {
      for (const key of countNames) {
        const value = element.attributes.get(key);
        // Bun declares tests/failures/skipped at the root. errors is optional
        // and defaults to zero; nested suite totals, when present, must agree.
        if (element === root && value === undefined && key !== "errors") {
          invalid(`root is missing ${key} total`);
        }
        if (value !== undefined) {
          if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) {
            invalid(`invalid ${key} count on ${element.name}`);
          }
          if (Number(value) !== element.counts[key]) invalid(`${key} total disagrees with testcase evidence`);
        } else if (element === root && key === "errors" && element.counts.errors !== 0) {
          invalid("root is missing errors total");
        }
      }
    }
    const parent = stack.at(-1);
    if (parent) {
      for (const key of countNames) parent.counts[key] += element.counts[key];
    } else closedRoot = true;
  };
  try {
    // XML 1.0 characters, including paired supplementary code points only.
    if (/[^\t\n\r\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u.test(xml)) {
      invalid("invalid XML character");
    }
    while (at < xml.length) {
      const parent = stack.at(-1);
      if (xml[at] !== "<") {
        const end = xml.indexOf("<", at);
        const text = xml.slice(at, end < 0 ? xml.length : end);
        if (text.includes("]]>")) invalid("CDATA terminator outside CDATA");
        const decoded = entities(text);
        if ((!parent || !textElements.has(parent.name)) && !/^[ \t\r\n]*$/.test(parent ? decoded : text)) {
          invalid("text outside a JUnit diagnostic element");
        }
        at = end < 0 ? xml.length : end;
        continue;
      }
      if (xml.startsWith("<!--", at)) {
        const end = xml.indexOf("-->", at + 4);
        if (end < 0) invalid("unterminated XML comment");
        const comment = xml.slice(at + 4, end);
        if (comment.includes("--") || comment.endsWith("-")) invalid("invalid XML comment");
        at = end + 3;
        continue;
      }
      if (xml.startsWith("<![CDATA[", at)) {
        if (!parent || !textElements.has(parent.name)) invalid("CDATA outside a JUnit diagnostic element");
        const end = xml.indexOf("]]>", at + 9);
        if (end < 0) invalid("unterminated CDATA");
        at = end + 3;
        continue;
      }
      if (xml.startsWith("<?", at)) {
        const start = at;
        at += 2;
        const target = name();
        const end = xml.indexOf("?>", at);
        if (end < 0) invalid("unterminated processing instruction");
        if (at !== end && !/[ \t\r\n]/.test(xml[at])) invalid("invalid processing instruction");
        if (target.toLowerCase() === "xml") {
          const declaration = xml.slice(start, end + 2);
          if (start !== declarationAt ||
            !/^<\?xml[ \t\r\n]+version[ \t\r\n]*=[ \t\r\n]*(["'])1\.0\1(?:[ \t\r\n]+encoding[ \t\r\n]*=[ \t\r\n]*(["'])[A-Za-z][A-Za-z0-9._-]*\2)?(?:[ \t\r\n]+standalone[ \t\r\n]*=[ \t\r\n]*(["'])(?:yes|no)\3)?[ \t\r\n]*\?>$/.test(declaration)) {
            invalid("invalid or misplaced XML declaration");
          }
        }
        at = end + 2;
        continue;
      }
      if (xml.startsWith("</", at)) {
        at += 2;
        const closing = name();
        space();
        if (xml[at++] !== ">" || !parent || parent.name !== closing) invalid("mismatched XML closing tag");
        close();
        continue;
      }
      if (xml.startsWith("<!", at)) invalid("DTD and other XML declarations are not supported in JUnit evidence");
      at++;
      const tag = name();
      const attributes = new Map<string, string>();
      let selfClosing = false;
      while (true) {
        const separated = space() > 0;
        if (xml.startsWith("/>", at)) { at += 2; selfClosing = true; break; }
        if (xml[at] === ">") { at++; break; }
        if (!separated) invalid("invalid or unterminated XML opening tag");
        const key = name();
        if (attributes.has(key)) invalid(`duplicate XML attribute ${key}`);
        if (key.includes(":") || key === "xmlns") invalid("XML namespaces are not supported in JUnit evidence");
        space();
        if (xml[at++] !== "=") invalid("expected XML attribute value");
        space();
        const quote = xml[at++];
        if (quote !== '"' && quote !== "'") invalid("XML attribute must be quoted");
        const end = xml.indexOf(quote, at);
        if (end < 0) invalid("unterminated XML attribute");
        const value = xml.slice(at, end);
        if (value.includes("<")) invalid("unescaped XML attribute content");
        attributes.set(key, entities(value.replace(/\r\n|[\r\n\t]/g, " ")));
        at = end + 1;
      }
      if (!parent) {
        if (root || closedRoot) invalid("multiple XML roots");
        if (tag !== "testsuites" && tag !== "testsuite") invalid("expected JUnit root");
      } else if (!Object.hasOwn(children, parent.name) || !children[parent.name].includes(tag)) {
        invalid(`unexpected ${tag} inside ${parent.name}`);
      }
      if (tag === "testcase" && !attributes.has("name")) invalid("testcase is missing its name");
      if (tag !== "testsuite" && tag !== "testsuites" && countNames.some((key) => attributes.has(key))) {
        invalid("case totals must be declared on suites");
      }
      if (tag === "failure" || tag === "error" || tag === "skipped") {
        if (parent!.outcome) invalid("testcase has multiple outcomes");
        parent!.outcome = tag === "failure" ? "failures" : tag === "error" ? "errors" : "skipped";
      }
      const element: Element = {
        name: tag, attributes, counts: { tests: 0, failures: 0, errors: 0, skipped: 0 },
      };
      root ??= element;
      stack.push(element);
      if (selfClosing) close();
    }
    if (!root || !closedRoot || stack.length) return invalid("missing or incomplete JUnit document");
    if (root.counts.tests === 0) invalid("JUnit document contains no testcase evidence");
    const { tests: total, failures, errors, skipped } = root.counts;
    return {
      complete: true,
      cases: { total, failed: failures + errors, skipped, passed: total - failures - errors - skipped },
      testcases,
    };
  } catch (error) {
    return { complete: false, error: `Invalid JUnit evidence: ${error instanceof Error ? error.message : String(error)}` };
  }
}
