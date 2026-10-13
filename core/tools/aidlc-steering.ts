// Shared resolution for required stage-rule content.
//
// The orchestration engine uses this module to transport rules through bounded
// load-steering directives. Dispatch hooks use the same resolver when they
// attach the exact bundle to a subagent brief, so the conductor-to-worker hop
// cannot drift from the engine-to-conductor hop.

import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  DEFAULT_SPACE,
  errorMessage,
  resolveWorkflowSelection,
  toPosix,
} from "./aidlc-lib.ts";
import {
  copyFrameworkPhaseRules,
  frameworkMemorySeedDir,
  type GraphStage,
  memoryDirFor,
} from "./aidlc-graph.ts";

// `seed`: the framework's copy of a phase rule file, for a space that may lack
// its own (see restoreSpacePhaseRules).
export type RuleEntry = { rel: string; abs: string; seed?: string };
export type RuleContent = { path: string; text: string };

// These are explanatory preambles in the shipped empty team/project templates,
// not policy. Match exact lines so any authored blockquote remains substantive.
const TEMPLATE_PREAMBLE_LINES = new Set([
  "> This team's affirmed practices and corrections. Loaded after `org.md` as",
  "> strict-additive guidance; contradictions with broader policy are rejected.",
  "> Populated by the practices-discovery affirmation gate. Edit at the gate,",
  "> not directly.",
  "> Project-specific specialisation and corrections. Loaded after `org.md` and",
  "> `team.md` as strict-additive guidance; contradictions with broader policy",
  "> are rejected. Populated by practices-discovery and the self-learning loop.",
  ">",
  "> Use sparingly: most teams don't need a project layer. Reach for it",
  "> only when this specific project needs stable, durable guidance beyond the",
  "> team practice (for example, package-specific release checks or an additional",
  "> regression suite for a legacy component).",
]);

// A rule template is substantive once it contains a non-comment body line.
// Blockquotes are policy-capable Markdown and count unless they are one of the
// exact shipped template preamble lines above.
export function isSubstantiveRuleText(text: string): boolean {
  const stripped = text.replace(/<!--[\s\S]*?-->/g, "");
  return stripped.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (trimmed === "") return false;
    if (trimmed.startsWith("#")) return false;
    if (TEMPLATE_PREAMBLE_LINES.has(trimmed)) return false;
    if (/^-{3,}$/.test(trimmed)) return false;
    return true;
  });
}

// Resolve graph display paths against the active space. AIDLC_RULES_DIR keeps
// its existing precedence for fixture-driven callers.
export function rulesContentEntries(
  node: GraphStage,
  projectDir: string,
  space: string = resolveWorkflowSelection(projectDir).space,
): RuleEntry[] {
  const configuredMemoryDir = process.env.AIDLC_RULES_DIR;
  const memoryDir = configuredMemoryDir
    ? isAbsolute(configuredMemoryDir)
      ? configuredMemoryDir
      : resolve(projectDir, configuredMemoryDir)
    : memoryDirFor(projectDir, space);
  const seedPhases = configuredMemoryDir || space === DEFAULT_SPACE
    ? null
    : join(frameworkMemorySeedDir(), "phases");
  return (node.rules_in_context ?? []).map((rule) => {
    const marker = "/memory/";
    const index = rule.path.indexOf(marker);
    if (index < 0) {
      return {
        rel: rule.path,
        abs: join(projectDir, rule.path),
      };
    }
    const subpath = rule.path.slice(index + marker.length);
    const entry: RuleEntry = {
      rel: toPosix(join("aidlc", "spaces", space, "memory", subpath)),
      abs: join(memoryDir, subpath),
    };
    if (seedPhases && subpath.startsWith("phases/")) {
      entry.seed = join(seedPhases, subpath.slice("phases/".length));
    }
    return entry;
  });
}

function missingFile(path: string): boolean {
  try {
    return lstatSync(path, { throwIfNoEntry: false }) === undefined;
  } catch {
    return false;
  }
}

function readRuleText(path: string): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
}

// A space made by `space create` before #2419 got an empty memory/phases/, and
// a clone of it has no phases/ folder at all, so a stage that reads one of its
// phase rule files would stop. When this stage needs one the space lacks, the
// space gets the framework's copies, as a new space does, never over a file
// the team wrote. Until they are written (an observer writes nothing) the
// stage reads the framework's copy in its place. The default space ships its
// own files, so one missing there is the team's to put back. Returns the names
// written.
export function restoreSpacePhaseRules(entries: RuleEntry[], memoryDir: string): string[] {
  if (!entries.some((entry) => entry.seed && missingFile(entry.abs))) return [];
  try {
    return copyFrameworkPhaseRules(memoryDir);
  } catch {
    return [];
  }
}

export function readRuleBundle(
  entries: RuleEntry[],
): { content: RuleContent[]; error: string | null } {
  const content: RuleContent[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.rel)) continue;
    seen.add(entry.rel);
    let text: string;
    try {
      text = readRuleText(entry.abs);
    } catch (error) {
      // Only a missing file is put back from version control: one that is
      // there holds the team's edits, so it is repaired in place.
      const missing = missingFile(entry.abs);
      let seeded: string | null = null;
      if (missing && entry.seed) {
        try {
          seeded = readRuleText(entry.seed);
        } catch {
          seeded = null;
        }
      }
      if (seeded === null) {
        return {
          content: [],
          error:
            `Cannot load required stage rule "${entry.rel}" (${errorMessage(error)}). The stage has not started. ` +
            (missing
              ? `Put the file back (for example \`git checkout -- ${entry.rel}\` when the project tracks it), `
              : "Keep a copy of the file, then fix its permissions or save it as UTF-8, ") +
            "then run `next` again.",
        };
      }
      text = seeded;
    }
    if (isSubstantiveRuleText(text)) content.push({ path: entry.rel, text });
  }
  return { content, error: null };
}

export function resolvedRuleBundle(
  node: GraphStage,
  projectDir: string,
  space: string = resolveWorkflowSelection(projectDir).space,
): { content: RuleContent[]; error: string | null } {
  return readRuleBundle(rulesContentEntries(node, projectDir, space));
}
