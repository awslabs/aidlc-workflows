#!/usr/bin/env bun
// PreToolUse hook: make required active-stage rules deterministic across the
// conductor-to-subagent boundary.
//
// Claude and Codex consume the emitted updatedInput directly. OpenCode's
// adapter consumes the same output and mutates output.args. Kiro CLI has no
// input-rewrite channel, so its adapter treats a proposed rewrite as a retry
// guard; the next attempt must contain the exact bundle. Kiro IDE cannot expose
// tool arguments and instead preloads active memory through agent resources.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  getField,
  stateFilePath,
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

function isAidlcAgent(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("aidlc-") &&
    value.endsWith("-agent") &&
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

function promptStage(prompt: string, fallback: string | null): GraphStage | null {
  const graph = loadGraph();
  const bySlug = new Map(graph.map((node) => [node.slug, node]));
  const stagePath = prompt.match(
    /(?:^|[/\\])stages[/\\](?:initialization|ideation|inception|construction|operation)[/\\]([a-z0-9][a-z0-9-]*)\.md\b/i,
  );
  if (stagePath) return bySlug.get(stagePath[1]) ?? null;

  const named = graph.filter((node) => {
    const escaped = node.slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^a-z0-9-])${escaped}(?:$|[^a-z0-9-])`, "i").test(
      prompt,
    );
  });
  if (named.length === 1) return named[0];
  if (fallback) return bySlug.get(fallback) ?? null;
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
    "The engine resolved the following required rules for this stage. Apply the content verbatim; later prose summaries do not replace it.\n" +
    body +
    `\n<!-- AIDLC_DISPATCH_RULES_END sha256:${digest} -->`
  );
}

function hasExactBundle(prompt: string, content: RuleContent[]): boolean {
  return content.every(({ text }) => prompt.includes(text));
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
    hasExactBundle(prompt, bundle.content)
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
  if (!result.changed || !result.updatedInput) return 0;
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: result.updatedInput,
      },
    })}\n`,
  );
  return 0;
}

if (import.meta.main) process.exit(await run(await Bun.stdin.text()));
