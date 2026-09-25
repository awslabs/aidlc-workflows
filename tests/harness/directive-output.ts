// Parse an engine tool result at its authoritative record boundary.
//
// aidlc-orchestrate emits exactly one compact directive JSON object followed by
// a newline. Shell/SDK layers may append diagnostic lines to the same tool
// result (for example, Claude Code on Windows reports a cwd reset). Treat each
// complete line as a transport record instead of slicing around braces, because
// directive string fields can legitimately contain braces.

import { isDeepStrictEqual } from "node:util";
import {
  type Directive,
  validateDirective,
} from "../../core/tools/aidlc-directive.ts";

export interface ParsedDirectiveOutput {
  directive: Directive;
  diagnostics: string[];
}

export class DirectiveOutputError extends Error {
  constructor(
    message: string,
    readonly diagnostics: string[],
  ) {
    super(message);
    this.name = "DirectiveOutputError";
  }
}

interface DirectiveRecord {
  directive: Directive;
  lineNumber: number;
}

interface MalformedRecord {
  lineNumber: number;
  reason: string;
}

export function parseDirectiveOutput(output: string): ParsedDirectiveOutput {
  const diagnostics: string[] = [];
  const records: DirectiveRecord[] = [];
  const malformed: MalformedRecord[] = [];

  for (const [index, line] of output.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Engine records are compact JSON objects. Everything else remains
    // available to the caller as shell/SDK diagnostics.
    if (!trimmed.startsWith("{")) {
      diagnostics.push(line);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      malformed.push({
        lineNumber: index + 1,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const validation = validateDirective(parsed);
    if (!validation.valid) {
      malformed.push({
        lineNumber: index + 1,
        reason: validation.errors.join("; "),
      });
      continue;
    }
    records.push({ directive: validation.data, lineNumber: index + 1 });
  }

  if (malformed.length > 0) {
    const details = malformed
      .map((record) => `line ${record.lineNumber}: ${record.reason}`)
      .join(" | ");
    throw new DirectiveOutputError(
      `Malformed directive JSON record${malformed.length === 1 ? "" : "s"}: ${details}`,
      diagnostics,
    );
  }

  if (records.length === 0) {
    throw new DirectiveOutputError(
      "Expected exactly one directive JSON record; found none",
      diagnostics,
    );
  }

  if (records.length > 1) {
    const duplicate = records
      .slice(1)
      .every((record) => isDeepStrictEqual(record.directive, records[0].directive));
    throw new DirectiveOutputError(
      `Expected exactly one directive JSON record; found ${records.length} ${
        duplicate ? "duplicate" : "conflicting"
      } records on lines ${records.map((record) => record.lineNumber).join(", ")}`,
      diagnostics,
    );
  }

  return {
    directive: records[0].directive,
    diagnostics,
  };
}
