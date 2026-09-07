import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  loadStageGraph,
  PHASES,
  parseStageFrontmatter,
} from "./aidlc-lib.ts";
import { resolveHarnessPath } from "./aidlc-runtime-paths.ts";

// --- Types ---

interface StageResult {
  slug: string;
  outputs: number;
  missing: string[];
  pass: boolean;
}

interface PhaseResult {
  phase: string;
  stages: StageResult[];
  pass: boolean;
}

// --- Stage file resolution ---

function findStageFile(slug: string, phase: string): string | null {
  const path = join(resolveHarnessPath(["aidlc-common", "stages"]), phase, `${slug}.md`);
  return existsSync(path) ? path : null;
}

// --- Outputs field parsing ---

/**
 * Extract .md filenames from the Outputs header field.
 *
 * Handles three patterns:
 * 1. Simple CSV paths: `aidlc-docs/.../file.md, aidlc-docs/.../file2.md`
 * 2. Directory + parens: `aidlc-docs/dir/ (file.md, file2.md, ...)`
 * 3. Prose (no .md files): returns empty array
 *
 * Also strips "CONDITIONAL:" prefix and handles "{unit-name}" template vars.
 */
function parseOutputs(outputsLine: string): string[] {
  if (!outputsLine) return [];

  const filenames: string[] = [];

  // Pattern 2: directory + parenthesized list
  // e.g., "aidlc-docs/dir/ (file.md, file2.md)" or "(9 artifacts: file.md, ...)"
  const parenRegex = /\(([^)]+)\)/g;
  let parenMatch: RegExpExecArray | null = parenRegex.exec(outputsLine);
  let hasParenFiles = false;

  while (parenMatch !== null) {
    const inner = parenMatch[1];
    // Extract .md filenames from inside parens
    const mdFiles = inner.match(/(?:CONDITIONAL:\s*)?[\w-]+\.md/g);
    if (mdFiles) {
      hasParenFiles = true;
      for (const f of mdFiles) {
        // Strip CONDITIONAL: prefix
        const clean = f.replace(/^CONDITIONAL:\s*/, "");
        filenames.push(clean);
      }
    }
    parenMatch = parenRegex.exec(outputsLine);
  }

  if (hasParenFiles) return filenames;

  // Pattern 1: simple CSV paths — extract basename .md files
  // Split on comma, look for .md paths
  const parts = outputsLine.split(",");
  for (const part of parts) {
    const trimmed = part.trim();
    // Strip CONDITIONAL: prefix
    const cleaned = trimmed.replace(/^CONDITIONAL:\s*/, "");
    // Match paths ending in .md (but not parenthesized descriptions)
    const mdMatch = cleaned.match(/([\w{}.-]+\.md)/);
    if (mdMatch) {
      filenames.push(basename(mdMatch[1]));
    }
  }

  return filenames;
}

// --- Body section extraction ---

/**
 * Extract the instruction body — everything after the header metadata block.
 * Handles both `## Steps` and `## PART 1:` section styles.
 */
function extractBodySection(content: string): string {
  // Try ## Steps first, then ## PART, then first ### Step
  for (const marker of ["## Steps", "## PART"]) {
    const idx = content.indexOf(marker);
    if (idx !== -1) return content.slice(idx);
  }
  // Fallback: find first ### heading
  const stepIdx = content.indexOf("### Step");
  if (stepIdx !== -1) return content.slice(stepIdx);
  // Last resort: everything after the MANDATORY line
  const mandIdx = content.indexOf("MANDATORY:");
  if (mandIdx !== -1) {
    const nextLine = content.indexOf("\n", mandIdx);
    return nextLine !== -1 ? content.slice(nextLine) : "";
  }
  return "";
}

// --- Keyword matching ---

/**
 * Check if an output filename is referenced in the body text.
 * Uses multiple strategies:
 * 1. Exact filename match (e.g., "scope-document.md")
 * 2. Filename stem match (e.g., "scope-document")
 * 3. Keyword matching: all significant words from the filename appear in the text
 */
function isOutputReferenced(filename: string, bodyText: string): boolean {
  const lower = bodyText.toLowerCase();

  // Strategy 1: exact filename
  if (lower.includes(filename.toLowerCase())) return true;

  // Strategy 2: filename stem (without .md)
  const stem = filename.replace(/\.md$/, "");
  if (lower.includes(stem.toLowerCase())) return true;

  // Strategy 3: keyword matching — split stem on hyphens, check each word
  const keywords = stem
    .split("-")
    .filter((w) => w.length > 2); // filter out short words like "of"

  if (keywords.length === 0) return true; // too short to validate

  // All significant keywords must appear as substrings (case-insensitive).
  // Handle singular/plural: try both "keyword" and "keyword" without trailing "s".
  return keywords.every((kw) => {
    const kwLower = kw.toLowerCase();
    if (lower.includes(kwLower)) return true;
    // Try singular form (strip trailing 's')
    if (kwLower.endsWith("s") && lower.includes(kwLower.slice(0, -1)))
      return true;
    // Try plural form (add trailing 's')
    if (lower.includes(`${kwLower}s`)) return true;
    return false;
  });
}

// --- Header field parsing ---

// Reads YAML frontmatter via parseStageFrontmatter. Field names
// are title-case in callers (e.g. "Display Order", "Lead Agent") and get
// normalised to the YAML key ("display_order", "lead_agent") here.
// Returns null if file has no frontmatter or field is absent / non-string.
function getHeaderField(content: string, field: string): string | null {
  try {
    const fm = parseStageFrontmatter(content) as Record<string, unknown>;
    const key = field.toLowerCase().replace(/ /g, "_");
    const v = fm[key];
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

// --- Subcommand: outputs ---

function isPhase(s: string): s is (typeof PHASES)[number] {
  return (PHASES as readonly string[]).includes(s);
}

function handleOutputs(phaseArg: string): void {
  const phases: (typeof PHASES)[number][] | null =
    phaseArg === "all"
      ? [...PHASES]
      : isPhase(phaseArg)
      ? [phaseArg]
      : null;

  if (!phases) {
    jsonError(`Unknown phase: ${phaseArg}. Valid: ${PHASES.join(", ")}, all`);
  }

  const graph = loadStageGraph();
  const results: PhaseResult[] = [];

  for (const phase of phases) {
    const stagesInPhase = graph.filter((s) => s.phase === phase);
    const stageResults: StageResult[] = [];

    for (const stage of stagesInPhase) {
      const filePath = findStageFile(stage.slug, phase);
      if (!filePath) {
        // Defensive: initialization stage files shouldn't be missing today,
        // but if one is absent, treat as pass with no outputs to validate
        // rather than failing the doctor check.
        const isMissingOk = phase === "initialization";
        stageResults.push({
          slug: stage.slug,
          outputs: 0,
          missing: isMissingOk ? [] : ["STAGE_FILE_NOT_FOUND"],
          pass: isMissingOk,
        });
        continue;
      }

      const content = readFileSync(filePath, "utf-8");
      const outputsLine = getHeaderField(content, "Outputs");
      const outputFiles = parseOutputs(outputsLine || "");

      if (outputFiles.length === 0) {
        // No .md outputs declared — pass (prose-only output like workspace detection)
        stageResults.push({
          slug: stage.slug,
          outputs: 0,
          missing: [],
          pass: true,
        });
        continue;
      }

      const bodyText = extractBodySection(content);
      const missing: string[] = [];

      for (const filename of outputFiles) {
        if (!isOutputReferenced(filename, bodyText)) {
          missing.push(filename);
        }
      }

      stageResults.push({
        slug: stage.slug,
        outputs: outputFiles.length,
        missing,
        pass: missing.length === 0,
      });
    }

    results.push({
      phase,
      stages: stageResults,
      pass: stageResults.every((s) => s.pass),
    });
  }

  // If single phase, output single result; if "all", output array
  if (phaseArg === "all") {
    const allPass = results.every((r) => r.pass);
    jsonSuccess({ phases: results, pass: allPass });
  } else {
    // PhaseResult is structurally compatible with Record<string, unknown>;
    // wrap in spread to pass without an `as` cast.
    jsonSuccess({ ...results[0] });
  }
}

// --- JSON output helpers ---

function jsonSuccess(data: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function jsonError(message: string): never {
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(1);
}

// --- CLI entry point ---

export function main(argv: string[]): void {
  const args = argv;
  const subcommand = args[0];
  const target = args[1];

  if (!subcommand) {
    jsonError("Usage: aidlc-validate outputs <phase|all>");
  }

  if (!target) {
    jsonError(`Usage: aidlc-validate ${subcommand} <phase|all>`);
  }

  switch (subcommand) {
    case "outputs":
      handleOutputs(target);
      break;
    default:
      jsonError(
        `Unknown subcommand: ${subcommand}. Valid: outputs`
      );
  }
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
