// sdk-drive.ts — the SDK harness driver.
//
// One reusable module that collapses the three proven spike probes
// (tools/aidlc-sdk-probe.ts, aidlc-sdk-workflow-probe.ts,
// aidlc-sdk-toolout-probe.ts) into a single `driveAidlc()` call.
//
// This is a MEASURING INSTRUMENT. It will be calibrated by an independent
// agent in the next stage before any test trusts it. Its job is to run a
// prompt through the Claude Agent SDK (SDK 0.3.158, Bedrock) and return a
// fully-structured, deterministic result so tests can assert on tool_result
// content, written files, and audit/result events — NEVER on the assistant's
// prose.
//
// Verified contract this module encodes (read from the probes + sdk.d.ts):
//   - query({ prompt, options }) returns an AsyncGenerator<SDKMessage>.
//     (sdk.d.ts:2391 `query`, :3298 `SDKMessage` union)
//   - canUseTool(toolName, input, opts) => Promise<PermissionResult>.
//     For AskUserQuestion we answer by returning
//     { behavior: 'allow', updatedInput: { ...input, answers } } where
//     `answers` maps each question's `question` text -> chosen option label.
//     (aidlc-sdk-probe.ts:28-44, aidlc-sdk-workflow-probe.ts:27-48,
//      sdk.d.ts:188 CanUseTool, :1997 PermissionResult)
//   - assistant text arrives in msg.type === 'assistant', content blocks of
//     type 'text'. (aidlc-sdk-probe.ts:51-53)
//   - tool_result blocks arrive as a SYNTHETIC msg.type === 'user' message;
//     ToolResult.content is BYTE-IDENTICAL to the tool's stdout before the
//     LLM rewords it (the --doctor md5 was stable x3 in the spike).
//     (aidlc-sdk-toolout-probe.ts:25-44, sdk.d.ts:3742 SDKUserMessage)
//   - the terminal event is msg.type === 'result', subtype 'success' or one
//     of the error subtypes; is_error + permission_denials live there.
//     (sdk.d.ts:3477 SDKResultMessage = SDKResultSuccess | SDKResultError)
//
// Paths the helpers read are the SHIPPED paths from aidlc-lib.ts:
//   - state:  <projectDir>/aidlc-docs/aidlc-state.md   (aidlc-lib.ts:137)
//   - audit:  <projectDir>/aidlc-docs/audit.md         (aidlc-lib.ts:141)

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HARNESS_DIR, "..", "..");
const SHIPPED_SETTINGS = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "settings.json",
);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A captured tool call + its verbatim result. `resultText` is byte-identical
 * to the tool's stdout (verified deterministic in the spike) — assert on THIS,
 * not on assistantText.
 */
export interface CapturedToolResult {
  /** Tool name as the model invoked it (e.g. "Bash", "Write", "Skill"). */
  toolName: string;
  /** The structured tool input the model passed. */
  input: Record<string, unknown>;
  /** The toolUseID linking the tool_use to its tool_result. */
  toolUseId: string;
  /** Verbatim tool_result content (tool stdout, pre-LLM-rewording). */
  resultText: string;
  /** True if the SDK flagged the tool_result as an error. */
  isError: boolean;
}

/**
 * A captured AskUserQuestion menu and the answer the AnswerScript resolved.
 * Lets tests assert WHICH questions were asked and HOW they were answered,
 * without screen-scraping.
 */
export interface CapturedAskUserQuestion {
  /** The questions block, structured exactly as the model emitted it. */
  questions: AskUserQuestionItem[];
  /** question text -> chosen option label, the value handed back to the SDK. */
  answers: Record<string, string | string[]>;
}

/** One question within an AskUserQuestion tool input. */
export interface AskUserQuestionItem {
  /** Some menus carry a short header/title; used by the `byHeader` script. */
  header?: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

/** The SDK's terminal `result` event, captured verbatim. */
export interface ResultEvent {
  type: "result";
  subtype: string;
  is_error: boolean;
  num_turns: number;
  /** Present on success; absent on error subtypes. */
  result?: string;
  /** Present on error subtypes; absent on success. */
  errors?: string[];
  permissionDenialsCount: number;
  /** Raw event for callers that need fields this struct doesn't surface. */
  raw: Record<string, unknown>;
}

/**
 * The structured result of one `driveAidlc()` run. Tests assert on
 * toolResults / stateFile / auditEvents / resultEvent — NOT assistantText.
 */
export interface DriveResult {
  /** Every tool call + its verbatim result, in stream order. */
  toolResults: CapturedToolResult[];
  /**
   * The assistant's concatenated prose. DANGER: this is the LLM's reworded
   * rendering, non-deterministic. Provided for debugging only — do not assert.
   */
  assistantText: string;
  /** The SDK's terminal result event, or undefined if the stream never ended. */
  resultEvent: ResultEvent | undefined;
  /** Contents of aidlc-docs/aidlc-state.md after the run, if it exists. */
  stateFile?: string;
  /** Audit event-type strings parsed from aidlc-docs/audit.md, in file order. */
  auditEvents?: string[];
  /** Every AskUserQuestion menu seen + how it was answered. */
  askedQuestions: CapturedAskUserQuestion[];
  /** True only when the wall-clock timeout aborted the SDK stream. */
  timedOut: boolean;
  /** True when an intentional AskUserQuestion boundary aborted the stream. */
  stoppedAfterAskUserQuestion: boolean;
  /** True when an intentional matching tool_result boundary aborted the stream. */
  stoppedAfterToolResult: boolean;
}

// ---------------------------------------------------------------------------
// AnswerScript — declarative, structure-based question answering.
//
// Resolved against the STRUCTURED AskUserQuestion input (questions[].options),
// never by screen-scraping rendered text. The default policy mirrors the tmux
// "take the default" loop: pick option 1 for every question.
// ---------------------------------------------------------------------------

/** How a single question's answer is chosen. */
export type AnswerSpec =
  /** Pick the option at this 0-based index (default 0 / option 1). */
  | { optionIndex: number }
  /** Pick the option whose label === this string exactly. */
  | { label: string }
  /** Pick the first option whose label CONTAINS this substring. */
  | { labelContains: string }
  /** Multi-select: each entry resolves like a single spec; results combine. */
  | { multi: Array<{ optionIndex: number } | { label: string } | { labelContains: string }> };

/**
 * A declarative answer policy:
 *   - 'default'    — every question takes option 1 (index 0).
 *   - byHeader     — map a question's `header` (or `question` text) to a spec;
 *                    questions not matched fall back to option 1.
 *   - sequence     — answer the Nth AskUserQuestion menu (across the whole run)
 *                    with the Nth spec; menus past the array fall back to default.
 *
 * `sequence` indexes per-MENU (one AskUserQuestion tool call), and within a
 * menu each question uses the same spec; for fine per-question control inside
 * a single menu, use `byHeader`.
 */
export type AnswerScript =
  | "default"
  | { kind: "default" }
  | { kind: "byHeader"; map: Record<string, AnswerSpec>; fallback?: AnswerSpec }
  | { kind: "sequence"; specs: AnswerSpec[]; fallback?: AnswerSpec };

const DEFAULT_SPEC: AnswerSpec = { optionIndex: 0 };

/**
 * Resolve one AnswerSpec against a single question's options into the chosen
 * label (or label[] for multi). Falls back to option 1 if a spec can't match,
 * so the driver never stalls a run — a calibrator can detect the fallback by
 * comparing askedQuestions to the script.
 */
function resolveSpec(item: AskUserQuestionItem, spec: AnswerSpec): string | string[] {
  const labels = item.options.map((o) => o.label);
  const pickIndex = (i: number): string => labels[i] ?? labels[0] ?? "";
  const pickLabel = (l: string): string =>
    labels.includes(l) ? l : (labels[0] ?? "");
  const pickContains = (sub: string): string =>
    labels.find((l) => l.includes(sub)) ?? labels[0] ?? "";

  if ("optionIndex" in spec) return pickIndex(spec.optionIndex);
  if ("label" in spec) return pickLabel(spec.label);
  if ("labelContains" in spec) return pickContains(spec.labelContains);
  if ("multi" in spec) {
    return spec.multi.map((s) => {
      if ("optionIndex" in s) return pickIndex(s.optionIndex);
      if ("label" in s) return pickLabel(s.label);
      return pickContains(s.labelContains);
    });
  }
  return pickIndex(0);
}

/**
 * Given one AskUserQuestion menu (its `questions` array), the script, and the
 * 0-based index of this menu within the whole run, produce the `answers`
 * object: question-text -> chosen label (or label[] for multi-select).
 */
function buildAnswers(
  questions: AskUserQuestionItem[],
  script: AnswerScript,
  menuIndex: number,
): Record<string, string | string[]> {
  const norm: Exclude<AnswerScript, "default"> =
    script === "default" ? { kind: "default" } : script;

  const answers: Record<string, string | string[]> = {};
  for (const q of questions) {
    let spec: AnswerSpec = DEFAULT_SPEC;
    if (norm.kind === "byHeader") {
      const key = q.header ?? q.question;
      spec = norm.map[key] ?? norm.map[q.question] ?? norm.fallback ?? DEFAULT_SPEC;
    } else if (norm.kind === "sequence") {
      spec = norm.specs[menuIndex] ?? norm.fallback ?? DEFAULT_SPEC;
    }
    answers[q.question] = resolveSpec(q, spec);
  }
  return answers;
}

// ---------------------------------------------------------------------------
// Driver options + main entry point
// ---------------------------------------------------------------------------

export interface DriveOptions {
  /** Declarative answer policy for AskUserQuestion gates. Default: 'default'. */
  answerScript?: AnswerScript;
  /**
   * Project directory the SDK runs in. Sets Options.cwd so the SDK picks up
   * .claude/ + aidlc-docs/ from there (per the workflow probe's cwd note).
   * Also where the state/audit helpers read from. Default: process.cwd().
   */
  projectDir?: string;
  /**
   * Wall-clock cap in milliseconds. On timeout the run is aborted via the
   * SDK AbortController and the partial result is returned with resultEvent
   * left as whatever (if anything) the stream produced.
   */
  timeoutMs?: number;
  /**
   * Permission mode. Default 'bypassPermissions' — matches all three spikes,
   * so non-interactive tools (Bash/Write/Edit/Skill) run without prompts while
   * canUseTool still fires for AskUserQuestion.
   */
  permissionMode?:
    | "default"
    | "acceptEdits"
    | "bypassPermissions"
    | "plan"
    | "dontAsk"
    | "auto";
  /**
   * Explicit SDK model override. Defaults to the shipped dist/claude settings
   * model so live harness runs exercise the same model pin users receive.
   */
  model?: string;
  /**
   * settingSources for the SDK. Default ['project'] so live harness runs load
   * the copied shipped .claude/settings.json/CLAUDE.md but do not inherit the
   * developer's user-level hooks or settings. Pass [] for SDK isolation, or
   * opt into ['project','local','user'] from focused calibration tests.
   * (sdk.d.ts:1802)
   */
  settingSources?: Array<"user" | "project" | "local">;
  /** Extra env to layer onto the SDK subprocess (e.g. Bedrock overrides). */
  env?: Record<string, string>;
  /**
   * Optional sink for each AskUserQuestion as it is answered — handy when a
   * calibrator wants a live trace. Receives the same struct stored in
   * result.askedQuestions.
   */
  onAskUserQuestion?: (q: CapturedAskUserQuestion) => void;
  /**
   * Calibration/debug escape hatch: return as soon as the first
   * AskUserQuestion has been captured and answered. This proves the SDK
   * canUseTool boundary without continuing into whatever live workflow the
   * chosen answer would normally drive.
   */
  stopAfterAskUserQuestion?: boolean;
  /**
   * Return after the Nth AskUserQuestion has been answered and its tool_result
   * has crossed the SDK boundary. One-based; unlike stopAfterAskUserQuestion,
   * this can skip preparatory/orientation menus.
   */
  stopAfterAskUserQuestionAt?: number;
  /**
   * Calibration/debug escape hatch: return as soon as a tool_result matching
   * the requested tool name/text arrives. Useful when the deterministic proof
   * is the tool output itself and continuing would spend tokens on an unrelated
   * live workflow.
   */
  stopAfterToolResult?: { toolName?: string; resultIncludes: string };
}

interface ClaudeSettings {
  model?: unknown;
  env?: unknown;
}

interface DriveSdkSettings {
  model?: string;
  env: Record<string, string>;
  modelSource?: string;
}

function readClaudeSettings(path: string): ClaudeSettings | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as ClaudeSettings;
}

function stringEnv(settings: ClaudeSettings | undefined): Record<string, string> {
  if (!settings?.env || typeof settings.env !== "object" || Array.isArray(settings.env)) {
    return {};
  }

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(settings.env)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function settingsModel(settings: ClaudeSettings | undefined): string | undefined {
  return typeof settings?.model === "string" && settings.model.trim()
    ? settings.model
    : undefined;
}

function processEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/**
 * Resolve the SDK model/env the harness should pass explicitly. The shipped
 * dist settings are the default authority so tests exercise what users copy
 * from dist/claude/.claude; project settings are only a fallback for non-repo
 * harness reuse, and per-call options remain the escape hatch for adversarial
 * calibration.
 */
export function resolveDriveSdkSettings(
  projectDir: string,
  opts: Pick<DriveOptions, "model" | "env"> = {},
): DriveSdkSettings {
  const shipped = readClaudeSettings(SHIPPED_SETTINGS);
  const projectSettingsPath = join(projectDir, ".claude", "settings.json");
  const project = projectSettingsPath === SHIPPED_SETTINGS
    ? shipped
    : readClaudeSettings(projectSettingsPath);

  const explicitModel = opts.model?.trim();
  const shippedModel = settingsModel(shipped);
  const projectModel = settingsModel(project);
  const model = explicitModel || shippedModel || projectModel;
  const modelSource = explicitModel
    ? "option"
    : shippedModel
      ? SHIPPED_SETTINGS
      : projectModel
        ? projectSettingsPath
        : undefined;

  return {
    model,
    modelSource,
    // Keep the normal shell environment (PATH, AWS creds, etc.) intact. Project
    // settings provide fallbacks, shipped dist settings win by default, and
    // explicit per-call env remains the final override for focused tests.
    env: {
      ...processEnv(),
      ...stringEnv(project),
      ...stringEnv(shipped),
      ...(opts.env ?? {}),
    },
  };
}

function sdkTracePath(): string | undefined {
  if (process.env.AIDLC_SDK_TRACE_FILE) return process.env.AIDLC_SDK_TRACE_FILE;
  if (process.env.AIDLC_TEST_DEBUG === "true" && process.env.AIDLC_TEST_LOG_DIR) {
    return join(process.env.AIDLC_TEST_LOG_DIR, `sdk-drive-${process.pid}.ndjson`);
  }
  return undefined;
}

function writeSdkTrace(
  tracePath: string | undefined,
  event: string,
  data: Record<string, unknown>,
): void {
  if (!tracePath) return;
  mkdirSync(dirname(tracePath), { recursive: true });
  appendFileSync(tracePath, `${JSON.stringify({ ts: new Date().toISOString(), event, ...data })}\n`);
}

/**
 * Drive a single AIDLC prompt through the Claude Agent SDK and return a fully
 * structured result. This is the one entry point tests use instead of the old
 * run_claude shell fixture.
 *
 * @example
 *   const r = await driveAidlc("/aidlc --doctor", { projectDir: proj });
 *   assertResultOk(r);
 *   assertToolResultContains(r, "Bash", "AI-DLC Health Check");
 *
 * @example  scripted gates
 *   const r = await driveAidlc("/aidlc workshop Build a todo app", {
 *     projectDir: proj,
 *     answerScript: { kind: "sequence", specs: [{ label: "Greenfield" }] },
 *   });
 */
export async function driveAidlc(
  prompt: string,
  opts: DriveOptions = {},
): Promise<DriveResult> {
  const answerScript: AnswerScript = opts.answerScript ?? "default";
  const projectDir = opts.projectDir ?? process.cwd();
  const permissionMode = opts.permissionMode ?? "bypassPermissions";
  const settingSources = opts.settingSources ?? ["project"];
  const sdkSettings = resolveDriveSdkSettings(projectDir, opts);

  const toolResults: CapturedToolResult[] = [];
  const askedQuestions: CapturedAskUserQuestion[] = [];
  // toolUseID -> { toolName, input } so we can join tool_use to its later
  // synthetic-user tool_result block.
  const pendingTools = new Map<
    string,
    { toolName: string; input: Record<string, unknown> }
  >();
  let assistantText = "";
  let resultEvent: ResultEvent | undefined;
  let askMenuIndex = 0;
  let askUserQuestionToolUseIndex = 0;
  const tracePath = sdkTracePath();
  let stopAfterAskUserQuestionToolUseId: string | undefined;
  const stopAfterAskUserQuestionAt =
    opts.stopAfterAskUserQuestionAt ??
    (opts.stopAfterAskUserQuestion ? 1 : undefined);
  if (
    stopAfterAskUserQuestionAt !== undefined &&
    (!Number.isInteger(stopAfterAskUserQuestionAt) ||
      stopAfterAskUserQuestionAt < 1)
  ) {
    throw new Error(
      `stopAfterAskUserQuestionAt must be a positive integer, got ${stopAfterAskUserQuestionAt}`,
    );
  }
  writeSdkTrace(tracePath, "start", {
    prompt,
    projectDir,
    permissionMode,
    settingSources,
    model: sdkSettings.model,
    modelSource: sdkSettings.modelSource,
    timeoutMs: opts.timeoutMs,
    stopAfterAskUserQuestionAt,
  });

  const abortController = new AbortController();
  let timedOut = false;
  let stoppedAfterAskUserQuestion = false;
  let stoppedAfterToolResult = false;
  const timer =
    opts.timeoutMs && opts.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          writeSdkTrace(tracePath, "timeout", { timeoutMs: opts.timeoutMs });
          abortController.abort();
        }, opts.timeoutMs)
      : undefined;

  const run = query({
    prompt,
    options: {
      cwd: projectDir,
      permissionMode,
      settingSources,
      abortController,
      ...(sdkSettings.model ? { model: sdkSettings.model } : {}),
      ...(Object.keys(sdkSettings.env).length > 0 ? { env: sdkSettings.env } : {}),
      canUseTool: async (toolName, input) => {
        if (toolName === "AskUserQuestion") {
          const questions =
            (input as { questions?: AskUserQuestionItem[] }).questions ?? [];
          const answers = buildAnswers(questions, answerScript, askMenuIndex);
          askMenuIndex++;
          const captured: CapturedAskUserQuestion = { questions, answers };
          askedQuestions.push(captured);
          writeSdkTrace(tracePath, "ask_user_question", {
            questions: questions.map((q) => ({
              header: q.header,
              question: q.question,
              options: q.options.map((o) => o.label),
            })),
            answers,
          });
          opts.onAskUserQuestion?.(captured);
          if (askMenuIndex === stopAfterAskUserQuestionAt) {
            // Record the INTENT to stop, but do NOT abort here. Aborting inside
            // canUseTool tears down the SDK permission transport before this
            // `{ behavior: "allow" }` response can be delivered, so the gate's
            // tool_result comes back as "Tool permission stream closed before
            // response received" (isError) instead of carrying the scripted
            // answer's bytes. The actual stop happens in the tool_result handler
            // below, keyed on stopAfterAskUserQuestionToolUseId — that fires
            // AFTER the answer has crossed the boundary and been captured in the
            // AskUserQuestion tool_result, which is the deterministic surface the
            // calibration asserts on. (MR10's Windows wave introduced an eager
            // abort here; the original design stopped only post-tool_result.)
            writeSdkTrace(tracePath, "will_stop_after_ask_user_question", {
              menuIndex: askMenuIndex,
            });
          }
          return {
            behavior: "allow",
            updatedInput: { ...(input as object), answers },
          };
        }
        // Everything else passes through unchanged (Bash/Write/Edit/Skill/...).
        return { behavior: "allow", updatedInput: input };
      },
    },
  });

  try {
    for await (const msg of run) {
      writeSdkTrace(tracePath, "message", { type: msg.type });
      if (msg.type === "assistant") {
        // Capture assistant text AND register any tool_use blocks so we can
        // join them to their tool_result by toolUseID.
        const content = (msg as { message?: { content?: unknown } }).message
          ?.content;
        if (Array.isArray(content)) {
          for (const block of content as Array<Record<string, unknown>>) {
            if (block.type === "text" && typeof block.text === "string") {
              assistantText += block.text;
            } else if (
              block.type === "tool_use" &&
              typeof block.id === "string"
            ) {
              writeSdkTrace(tracePath, "tool_use", {
                id: block.id,
                name: typeof block.name === "string" ? block.name : "",
                input: block.input && typeof block.input === "object" ? block.input : {},
              });
              if (
                block.name === "AskUserQuestion"
              ) {
                askUserQuestionToolUseIndex++;
                if (
                  askUserQuestionToolUseIndex ===
                    stopAfterAskUserQuestionAt &&
                  stopAfterAskUserQuestionToolUseId === undefined
                ) {
                  stopAfterAskUserQuestionToolUseId = block.id;
                }
              }
              pendingTools.set(block.id, {
                toolName: typeof block.name === "string" ? block.name : "",
                input:
                  block.input && typeof block.input === "object"
                    ? (block.input as Record<string, unknown>)
                    : {},
              });
            }
          }
        }
      } else if (msg.type === "user") {
        // tool_result blocks arrive as a synthetic 'user' message. The
        // content is byte-identical to the tool's stdout (verified in the
        // toolout spike) before the LLM rewords it.
        const content = (msg as { message?: { content?: unknown } }).message
          ?.content;
        if (Array.isArray(content)) {
          for (const block of content as Array<Record<string, unknown>>) {
            if (block.type === "tool_result") {
              const resultText = extractToolResultText(block.content);
              const toolUseId =
                typeof block.tool_use_id === "string" ? block.tool_use_id : "";
              const pending = pendingTools.get(toolUseId);
              toolResults.push({
                toolName: pending?.toolName ?? "",
                input: pending?.input ?? {},
                toolUseId,
                resultText,
                isError: block.is_error === true,
              });
              writeSdkTrace(tracePath, "tool_result", {
                toolUseId,
                toolName: pending?.toolName ?? "",
                isError: block.is_error === true,
                byteLength: resultText.length,
                preview: resultText.slice(0, 240),
              });
              if (
                toolUseId === stopAfterAskUserQuestionToolUseId
              ) {
                stoppedAfterAskUserQuestion = true;
                writeSdkTrace(tracePath, "stop_after_ask_user_question", {
                  toolUseId,
                });
                abortController.abort();
              }
              if (
                opts.stopAfterToolResult &&
                (opts.stopAfterToolResult.toolName === undefined ||
                  pending?.toolName === opts.stopAfterToolResult.toolName) &&
                resultText.includes(opts.stopAfterToolResult.resultIncludes)
              ) {
                stoppedAfterToolResult = true;
                writeSdkTrace(tracePath, "stop_after_tool_result", {
                  toolUseId,
                  toolName: pending?.toolName ?? "",
                  matched: opts.stopAfterToolResult.resultIncludes,
                });
                abortController.abort();
              }
            }
          }
        }
      } else if (msg.type === "result") {
        const m = msg as Record<string, unknown>;
        resultEvent = {
          type: "result",
          subtype: typeof m.subtype === "string" ? m.subtype : "",
          is_error: m.is_error === true,
          num_turns: typeof m.num_turns === "number" ? m.num_turns : 0,
          result: typeof m.result === "string" ? m.result : undefined,
          errors: Array.isArray(m.errors) ? (m.errors as string[]) : undefined,
          permissionDenialsCount: Array.isArray(m.permission_denials)
            ? (m.permission_denials as unknown[]).length
            : 0,
          raw: m,
        };
        writeSdkTrace(tracePath, "result", {
          subtype: resultEvent.subtype,
          is_error: resultEvent.is_error,
          num_turns: resultEvent.num_turns,
          permissionDenialsCount: resultEvent.permissionDenialsCount,
        });
      }
    }
  } catch (err) {
    // An abort (timeout) surfaces as a thrown error from the generator. Swallow
    // it only when WE aborted; rethrow genuine SDK failures so they're visible.
    if (
      !(
        (timedOut || stoppedAfterAskUserQuestion || stoppedAfterToolResult) &&
        abortController.signal.aborted
      )
    ) {
      if (timer) clearTimeout(timer);
      writeSdkTrace(tracePath, "error", {
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  } finally {
    if (timer) clearTimeout(timer);
    writeSdkTrace(tracePath, "end", {
      timedOut,
      stoppedAfterAskUserQuestion,
      stoppedAfterToolResult,
      toolResultCount: toolResults.length,
      askedQuestionCount: askedQuestions.length,
      hasResultEvent: resultEvent !== undefined,
    });
  }

  const result: DriveResult = {
    toolResults,
    assistantText,
    resultEvent,
    askedQuestions,
    timedOut,
    stoppedAfterAskUserQuestion,
    stoppedAfterToolResult,
  };

  // Attach post-run file reads when they exist (read straight off disk so the
  // assertions are deterministic, not paraphrased).
  const state = readStateFile(projectDir);
  if (state !== undefined) result.stateFile = state;
  const audit = readAuditEvents(projectDir);
  if (audit !== undefined) result.auditEvents = audit;

  return result;
}

// ---------------------------------------------------------------------------
// tool_result content extraction (byte-identical to tool stdout).
//
// Mirrors aidlc-sdk-toolout-probe.ts:32-40: content is either a plain string
// or an array of { type, text } blocks. We join text blocks in order. No
// trimming or normalization — the bytes must survive intact.
// ---------------------------------------------------------------------------

export function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<Record<string, unknown>>)
      .map((b) => (typeof b.text === "string" ? b.text : ""))
      .join("");
  }
  return "";
}

// ---------------------------------------------------------------------------
// File readers — follow the workspace layout the engine writes.
//
// P4 — birth writes per-intent: state lands at
// aidlc/spaces/<space>/intents/<slug>-<id8>/aidlc-state.md and audit at
// <record>/audit/<host>-<pid>.md (per-clone shards), NOT the flat aidlc-docs/.
// These readers resolve the active intent's record from the active-space +
// active-intent cursors, falling back to the flat layout for a not-yet-born
// (pre-migration) project so the readers stay correct in both worlds.
// ---------------------------------------------------------------------------

/** The active intent's record dir, or the flat aidlc-docs/ when none resolves. */
export function recordDirFor(projectDir: string): string {
  const spaceCursor = join(projectDir, "aidlc", "active-space");
  const space = existsSync(spaceCursor)
    ? readFileSync(spaceCursor, "utf8").trim() || "default"
    : "default";
  const intentsDir = join(projectDir, "aidlc", "spaces", space, "intents");
  const intentCursor = join(intentsDir, "active-intent");
  if (existsSync(intentCursor)) {
    const rec = readFileSync(intentCursor, "utf8").trim();
    if (rec && existsSync(join(intentsDir, rec, "aidlc-state.md"))) {
      return join(intentsDir, rec);
    }
  }
  return join(projectDir, "aidlc-docs");
}

/** The SPACE-level domain-knowledge dir: aidlc/spaces/<space>/knowledge —
 *  a sibling of intents/ (NOT per-intent). The knowledge relocation (b29ced6)
 *  moved this out of each intent's record so domain knowledge accumulates
 *  across the whole space; the engine ensures it at birth (aidlc-utility.ts
 *  ensureWorkspaceDirs → knowledgeDir, lib.ts). Resolves the active space from
 *  the same cursor recordDirFor reads, defaulting to "default". */
export function spaceKnowledgeDirFor(projectDir: string): string {
  const spaceCursor = join(projectDir, "aidlc", "active-space");
  const space = existsSync(spaceCursor)
    ? readFileSync(spaceCursor, "utf8").trim() || "default"
    : "default";
  return join(projectDir, "aidlc", "spaces", space, "knowledge");
}

/** Absolute path to the state file the framework writes (per-intent record). */
export function stateFilePathFor(projectDir: string): string {
  return join(recordDirFor(projectDir), "aidlc-state.md");
}

/** Absolute path to the audit SHARD DIR the framework writes (per-clone shards). */
export function auditDirFor(projectDir: string): string {
  return join(recordDirFor(projectDir), "audit");
}

/**
 * Back-compat single-file audit path for live tests that `readFileSync` the
 * audit log directly. P4 shards audit per clone under <record>/audit/; a
 * single-process live test produces exactly ONE shard, so return its path (or
 * the flat aidlc-docs/audit.md when present — a pre-migration project). Prefer
 * readAuditEvents()/readAuditText() for multi-shard correctness.
 */
export function auditFilePathFor(projectDir: string): string {
  const dir = auditDirFor(projectDir);
  if (existsSync(dir)) {
    const shards = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    if (shards.length > 0) return join(dir, shards[0]);
  }
  // Pre-migration flat layout, or no shard yet — the flat audit.md path.
  return join(projectDir, "aidlc-docs", "audit.md");
}

/** Concatenated text of every audit shard (or "" when none). */
export function readAuditText(projectDir: string): string {
  const dir = auditDirFor(projectDir);
  if (existsSync(dir)) {
    const shards = readdirSync(dir).filter((f) => f.endsWith(".md"));
    if (shards.length > 0) {
      return shards.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    }
  }
  const flat = join(projectDir, "aidlc-docs", "audit.md");
  return existsSync(flat) ? readFileSync(flat, "utf8") : "";
}

/** Read aidlc-state.md verbatim, or undefined if absent. */
export function readStateFile(projectDir: string): string | undefined {
  const p = stateFilePathFor(projectDir);
  return existsSync(p) ? readFileSync(p, "utf8") : undefined;
}

/**
 * Parse the audit log into an ordered list of event-type strings. Each audit
 * block carries a `**Event**: <TYPE>` line (aidlc-audit.ts:246); we extract
 * those across every per-clone shard under <record>/audit/, OR the flat
 * aidlc-docs/audit.md for a not-yet-born (pre-migration) project. Returns
 * undefined when no audit exists at all. (P4: audit is sharded per clone, but a
 * flat legacy/seeded project keeps one audit.md until migration — readAuditText
 * handles both.)
 */
export function readAuditEvents(projectDir: string): string[] | undefined {
  const text = readAuditText(projectDir);
  if (text.length === 0) return undefined;
  const events: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\*\*Event\*\*:\s*(\S+)/);
    if (m) events.push(m[1]);
  }
  return events;
}

/**
 * Read a single `- **Field**: value` from a state-file string. State files use
 * the `- **<Field>**: <value>` line shape (see fixtures/state-*.md). Returns the
 * trimmed value, or undefined if the field is absent. Exported for assert.ts.
 */
export function readStateField(
  stateText: string,
  field: string,
): string | undefined {
  // Escape regex metacharacters in the field name.
  const esc = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^-\\s*\\*\\*${esc}\\*\\*:\\s*(.*)$`, "m");
  const m = stateText.match(re);
  return m ? m[1].trim() : undefined;
}
