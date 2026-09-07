#!/usr/bin/env bun
// PreToolUse hook: make required active-stage rules deterministic across the
// conductor-to-subagent boundary.
//
// Claude, Codex, and Copilot consume the emitted updatedInput directly.
// OpenCode's adapter consumes the same output and mutates output.args. Kiro CLI
// has no input-rewrite channel, so its adapter observes the proposed rewrite
// and relies on native agent resource preload. Kiro IDE does not register this
// hook because tool-argument delivery is not uniform across supported
// generations; it instead preloads active memory through always-included
// workspace steering with live file references.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  agentsDir,
  getField,
  markSubagentInflight,
  resolveWorkflowSelection,
  stateFilePath,
  stateFilePathForSelection,
  validSessionId,
} from "../tools/aidlc-lib.ts";
import {
  type GraphStage,
  loadGraph,
} from "../tools/aidlc-graph.ts";
import {
  type RuleContent,
  resolvedRuleBundle,
} from "../tools/aidlc-steering.ts";

type HookInput = {
  cwd?: string;
  session_id?: unknown;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
};

export type DispatchRuleResult = {
  changed: boolean;
  updatedInput?: Record<string, unknown>;
  error?: string;
};

const DISPATCH_TOOLS = new Set(["task", "agent", "spawn_agent", "subagent"]);
const EXEMPT_AGENTS = new Set(["aidlc-composer-agent"]);
// Keep hook stdout comfortably below the smallest observed subprocess capture
// ceiling. Oversized bundles fail before writing so callers receive complete
// repair guidance instead of a truncated, invalid JSON response.
const DISPATCH_HOOK_OUTPUT_MAX_BYTES = 512 * 1024;
const PRELOAD_FALLBACK_ENV = "AIDLC_DISPATCH_RULES_PRELOAD_FALLBACK";

function isAidlcAgent(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-z0-9][a-z0-9-]*-agent$/.test(value) &&
    existsSync(join(agentsDir(), `${value}.md`)) &&
    !EXEMPT_AGENTS.has(value)
  );
}

function currentStage(projectDir: string): string | null {
  const path = stateFilePath(projectDir);
  if (!existsSync(path)) return null;
  try {
    return getField(readFileSync(path, "utf-8"), "Current Stage")?.trim() || null;
  } catch {
    return null;
  }
}

// Resolve which stage a brief belongs to, most-authoritative signal first:
// 1. An explicit stage-file path in the brief (the protocol tells dispatched
//    briefs to name it) - unambiguous.
// 2. The state file's Current Stage - dispatches happen DURING a stage, so
//    when a workflow is live this is the stage whose rules apply. It outranks
//    prose mentions: a brief that happens to name one OTHER stage's slug in
//    passing ("after scope-definition completes...") must not bind that
//    stage's bundle.
// 3. A unique slug mention in the brief - last resort for stateless contexts
//    (single-stage runner before state exists). Ambiguous mentions bind
//    nothing.
function promptStage(prompt: string, fallback: string | null): GraphStage | null {
  const graph = loadGraph();
  const bySlug = new Map(graph.map((node) => [node.slug, node]));
  const stagePath = prompt.match(
    /(?:^|[/\\])stages[/\\](?:initialization|ideation|inception|construction|operation)[/\\]([a-z0-9][a-z0-9-]*)\.md\b/i,
  );
  if (stagePath) {
    const explicit = bySlug.get(stagePath[1]);
    if (explicit) return explicit;
  }

  if (fallback) return bySlug.get(fallback) ?? null;

  const named = graph.filter((node) => {
    const escaped = node.slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^a-z0-9-])${escaped}(?:$|[^a-z0-9-])`, "i").test(
      prompt,
    );
  });
  if (named.length === 1) return named[0];
  return null;
}

function bundleBlock(stage: string, content: RuleContent[]): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(content), "utf-8")
    .digest("hex");
  const body = content
    .map(({ path, text }) => `\n### ${path}\n${text}`)
    .join("");
  return (
    `\n\n<!-- AIDLC_DISPATCH_RULES_BEGIN sha256:${digest} stage:${stage} -->\n` +
    "## Active AI-DLC Rule Bundle\n" +
    // Framing only. The heading above is pinned (t248) and the rule text below is
    // delivered verbatim; this sentence is the part a reader sees, so it says what
    // the rules ARE rather than which component resolved them. A recipient that
    // quotes its context back into chat then quotes nothing about the machinery.
    "These are the required rules for this stage. Apply the content verbatim; later prose summaries do not replace it.\n" +
    body +
    `\n<!-- AIDLC_DISPATCH_RULES_END sha256:${digest} -->`
  );
}

function hasExactBundle(
  prompt: string,
  stage: string,
  content: RuleContent[],
): boolean {
  return prompt.includes(bundleBlock(stage, content));
}

function augmentText(
  prompt: string,
  projectDir: string,
  fallbackStage: string | null,
): { prompt: string; changed: boolean; error?: string } {
  const node = promptStage(prompt, fallbackStage);
  if (!node) return { prompt, changed: false };
  const bundle = resolvedRuleBundle(node, projectDir);
  if (bundle.error) return { prompt, changed: false, error: bundle.error };
  if (
    bundle.content.length === 0 ||
    hasExactBundle(prompt, node.slug, bundle.content)
  ) {
    return { prompt, changed: false };
  }
  return {
    prompt: prompt + bundleBlock(node.slug, bundle.content),
    changed: true,
  };
}

function promptText(input: Record<string, unknown>): string {
  for (const field of ["prompt", "message", "description", "task"]) {
    if (typeof input[field] === "string") return input[field] as string;
  }
  if (Array.isArray(input.items)) {
    return input.items
      .map((item) =>
        item &&
        typeof item === "object" &&
        "text" in item &&
        typeof item.text === "string"
          ? item.text
          : ""
      )
      .join("\n");
  }
  return "";
}

function withPrompt(
  input: Record<string, unknown>,
  original: string,
  prompt: string,
): Record<string, unknown> {
  for (const field of ["prompt", "message", "description", "task"]) {
    if (typeof input[field] === "string") return { ...input, [field]: prompt };
  }
  if (Array.isArray(input.items)) {
    return {
      ...input,
      items: [
        ...input.items,
        { type: "text", text: prompt.slice(original.length) },
      ],
    };
  }
  return input;
}

function augmentSingleDispatch(
  input: Record<string, unknown>,
  projectDir: string,
  fallbackStage: string | null,
): DispatchRuleResult {
  const agent =
    input.subagent_type ??
    input.agent_type ??
    input.agent ??
    input.role;
  if (!isAidlcAgent(agent)) return { changed: false };
  const original = promptText(input);
  if (!original) return { changed: false };
  const augmented = augmentText(original, projectDir, fallbackStage);
  if (augmented.error) return { changed: false, error: augmented.error };
  if (!augmented.changed) return { changed: false };
  return {
    changed: true,
    updatedInput: withPrompt(input, original, augmented.prompt),
  };
}

export function augmentDispatchRules(
  toolName: string,
  input: Record<string, unknown>,
  projectDir: string,
): DispatchRuleResult {
  if (!DISPATCH_TOOLS.has(toolName.toLowerCase())) return { changed: false };
  const fallbackStage = currentStage(projectDir);
  if (toolName.toLowerCase() !== "subagent") {
    return augmentSingleDispatch(input, projectDir, fallbackStage);
  }

  const stages = Array.isArray(input.stages) ? input.stages : [];
  let changed = false;
  const updatedStages: unknown[] = [];
  for (const stage of stages) {
    if (!stage || typeof stage !== "object") {
      updatedStages.push(stage);
      continue;
    }
    const entry = stage as Record<string, unknown>;
    if (!isAidlcAgent(entry.role) || typeof entry.prompt_template !== "string") {
      updatedStages.push(stage);
      continue;
    }
    const augmented = augmentText(
      entry.prompt_template,
      projectDir,
      fallbackStage,
    );
    if (augmented.error) return { changed: false, error: augmented.error };
    changed ||= augmented.changed;
    updatedStages.push(
      augmented.changed
        ? { ...entry, prompt_template: augmented.prompt }
        : entry,
    );
  }
  return changed
    ? { changed: true, updatedInput: { ...input, stages: updatedStages } }
    : { changed: false };
}

export function dispatchHookOutput(
  parsed: HookInput,
  projectDir: string,
): DispatchRuleResult {
  return augmentDispatchRules(
    parsed.tool_name ?? "",
    parsed.tool_input ?? {},
    projectDir,
  );
}

function recordAcceptedBackgroundDispatch(
  parsed: HookInput,
  projectDir: string,
): void {
  try {
    const toolName = (parsed.tool_name ?? "").toLowerCase();
    if (
      !DISPATCH_TOOLS.has(toolName) ||
      parsed.tool_input?.run_in_background !== true
    ) {
      return;
    }
    const rawSessionId = parsed.session_id;
    if (
      rawSessionId !== undefined &&
      rawSessionId !== "" &&
      (typeof rawSessionId !== "string" ||
        validSessionId(rawSessionId) === null)
    ) {
      return;
    }
    const sessionId =
      typeof rawSessionId === "string" && rawSessionId.length > 0
        ? rawSessionId
        : undefined;
    const selection = resolveWorkflowSelection(projectDir, { sessionId });
    if (!existsSync(stateFilePathForSelection(projectDir, selection))) return;
    markSubagentInflight(projectDir, rawSessionId);
  } catch {
    // In-flight evidence is advisory. Its write must never alter dispatch
    // acceptance, rule-delivery output, or the hook's established exit codes.
  }
}

export async function run(input: string): Promise<number> {
  let parsed: HookInput;
  try {
    parsed = JSON.parse(input) as HookInput;
  } catch {
    return 0;
  }
  const rawProjectDir =
    process.env.AIDLC_PROJECT_DIR ??
    process.env.CLAUDE_PROJECT_DIR ??
    parsed.cwd ??
    process.cwd();
  const projectDir = isAbsolute(rawProjectDir)
    ? rawProjectDir
    : resolve(process.cwd(), rawProjectDir);
  const result = dispatchHookOutput(parsed, projectDir);
  if (result.error) {
    process.stderr.write(`${result.error}\n`);
    return 2;
  }
  if (!result.changed || !result.updatedInput) {
    recordAcceptedBackgroundDispatch(parsed, projectDir);
    return 0;
  }
  const output = `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: result.updatedInput,
      },
    })}\n`;
  const outputBytes = Buffer.byteLength(output, "utf-8");
  if (outputBytes > DISPATCH_HOOK_OUTPUT_MAX_BYTES) {
    if (process.env[PRELOAD_FALLBACK_ENV] === "1") {
      process.stderr.write(
        `[aidlc] Advisory: this stage's rule files add up to ${outputBytes} bytes, which exceeds the safe ` +
          `${DISPATCH_HOOK_OUTPUT_MAX_BYTES}-byte limit for attaching them to a subagent brief. ` +
          "Nothing partial was written. This harness loads the same rule files itself, through " +
          "its own active-memory preload fallback, so the work continues without them attached.\n",
      );
      recordAcceptedBackgroundDispatch(parsed, projectDir);
      return 3;
    }
    process.stderr.write(
      `[aidlc] This stage's rule files add up to ${outputBytes} bytes, exceeding the safe ` +
        `${DISPATCH_HOOK_OUTPUT_MAX_BYTES}-byte output limit for attaching them to a subagent ` +
        "brief. The subagent was not started, and nothing partial was written. Shorten or split " +
        "the rule files for the active stage, then start the subagent again.\n",
    );
    return 2;
  }
  recordAcceptedBackgroundDispatch(parsed, projectDir);
  process.stdout.write(output);
  return 0;
}

if (import.meta.main) process.exit(await run(await Bun.stdin.text()));
