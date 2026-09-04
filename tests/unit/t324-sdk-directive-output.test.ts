import { describe, expect, test } from "bun:test";
import {
  DirectiveOutputError,
  parseDirectiveOutput,
} from "../harness/directive-output.ts";
import type { RunStageDirective } from "../../core/tools/aidlc-directive.ts";

const WINDOWS_ANNOTATION =
  String.raw`Shell cwd was reset to C:\Users\ADMINI~1\AppData\Local\Temp\aidlc-tui-34DDiM`;

const DIRECTIVE: RunStageDirective = {
  kind: "run-stage",
  stage: "schema-snapshot",
  phase: "inception",
  lead_agent: "aidlc-data-migration-agent",
  support_agents: [],
  mode: "inline",
  inline_context_paths: [],
  gate: true,
  memory_path:
    "aidlc/spaces/default/intents/260823-data-migration/inception/schema-snapshot/memory.md",
  consumes: [],
  produces: [
    "aidlc/spaces/default/intents/260823-data-migration/inception/schema-snapshot/source-schema.md",
  ],
  rules_in_context: [],
  sensors_applicable: ["schema-validator"],
  stage_file: ".claude/aidlc-common/stages/inception/schema-snapshot.md",
  narration: "Literal braces inside a JSON string stay structural: {keep these}.",
};

function captureError(output: string): DirectiveOutputError {
  try {
    parseDirectiveOutput(output);
  } catch (error) {
    expect(error).toBeInstanceOf(DirectiveOutputError);
    return error as DirectiveOutputError;
  }
  throw new Error("parseDirectiveOutput unexpectedly succeeded");
}

describe("SDK directive output parsing", () => {
  test("parses the directive record and preserves the exact Windows cwd annotation separately", () => {
    const parsed = parseDirectiveOutput(
      `${JSON.stringify(DIRECTIVE)}\n${WINDOWS_ANNOTATION}`,
    );

    expect(parsed.directive).toEqual(DIRECTIVE);
    expect(parsed.diagnostics).toEqual([WINDOWS_ANNOTATION]);
  });

  test("rejects malformed JSON records without consuming their braces as delimiters", () => {
    const error = captureError(
      `{"kind":"print","message":"unterminated { brace}"\n${WINDOWS_ANNOTATION}`,
    );

    expect(error.message).toContain("Malformed directive JSON record");
    expect(error.message).toContain("line 1");
    expect(error.diagnostics).toEqual([WINDOWS_ANNOTATION]);
  });

  test("rejects structurally invalid directive objects", () => {
    const error = captureError(
      `${JSON.stringify({ kind: "run-stage", stage: "schema-snapshot" })}\n${WINDOWS_ANNOTATION}`,
    );

    expect(error.message).toContain("Malformed directive JSON record");
    expect(error.message).toContain("run-stage:");
    expect(error.diagnostics).toEqual([WINDOWS_ANNOTATION]);
  });

  test("rejects output with no directive record", () => {
    const error = captureError(WINDOWS_ANNOTATION);

    expect(error.message).toBe(
      "Expected exactly one directive JSON record; found none",
    );
    expect(error.diagnostics).toEqual([WINDOWS_ANNOTATION]);
  });

  test("rejects duplicate directive records", () => {
    const line = JSON.stringify(DIRECTIVE);
    const error = captureError(`${line}\n${line}\n${WINDOWS_ANNOTATION}`);

    expect(error.message).toContain("found 2 duplicate records");
    expect(error.diagnostics).toEqual([WINDOWS_ANNOTATION]);
  });

  test("rejects conflicting directive records", () => {
    const error = captureError(
      `${JSON.stringify(DIRECTIVE)}\n${JSON.stringify({
        kind: "print",
        message: "different directive",
      })}\n${WINDOWS_ANNOTATION}`,
    );

    expect(error.message).toContain("found 2 conflicting records");
    expect(error.diagnostics).toEqual([WINDOWS_ANNOTATION]);
  });
});
