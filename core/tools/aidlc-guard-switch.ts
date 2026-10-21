import { existsSync } from "node:fs";
import { appendAuditEntryUnlocked, type AuditEntryInput } from "./aidlc-audit.ts";
import { firstFrontQuestionSince, latestFrontQuestionId, readQuestion } from "./aidlc-question-store.ts";
import {
  assertChangeControlLedgerWritable,
  auditBlockField,
  type GuardPolicy,
  guardPolicyAtLeast,
  keepActiveDirectiveOverSettingWrite,
  maximalAttemptEvents,
  personSpokeSinceGate,
  scopeGuardPolicyDefault,
  readAuditShardEvents,
  type AuditShardEvent,
  CEREMONY_ENV,
  GUARD_FENCE_ENV,
  type GuardSwitchKey,
  CEREMONY_FIELDS,
  CEREMONY_FLAGS,
  CEREMONY_KEYS,
  CHANGE_CONTROL_FIELD,
  type CeremonyKey,
  type CeremonyPolicy,
  type CeremonySetting,
  errorMessage,
  fenceKeyBypassed,
  type FenceSetting,
  fencesLoweredByPolicy,
  formatCeremony,
  formatGuardPolicy,
  getField,
  GUARD_POLICY_FIELD,
  GUARD_POLICY_VALUES,
  GUARDS_OFF_FIELD,
  GUARDS_ON_FIELD,
  guardFenceConfigKey,
  type GuardPolicyMemoryDeclaration,
  guardPolicyMemoryStrictRefusal,
  type GuardSwitch,
  guardSwitchRefusal,
  isKillSwitchSource,
  isoTimestamp,
  loadScopeMetadata,
  memoryGuardPolicyDeclarations,
  parseCeremonySetting,
  parseCeremonyStateLine,
  parseGuardPolicy,
  parseGuardsOffLine,
  parseGuardsOnLine,
  planApprovalMachineSwitchTrusted,
  planApprovalRuntimeFile,
  readPlanApprovalRuntimeRecord,
  readStateFile,
  removePlanApprovalRuntimeRecord,
  resolveInvokingSessionId,
  resolveProjectFlag,
  resolveCeremony,
  resolveFences,
  resolveGuardPolicy,
  resolveWorkflowSelection,
  setField,
  setGuardPolicyLine,
  guardsLineSource,
  setGuardsOffLine,
  setGuardsOnLine,
  stateFilePath,
  SWITCHABLE_GUARD_FENCES,
  type SwitchableGuardFence,
  withAuditLock,
  writePlanApprovalRuntimeRecord,
  writeStateFile,
  parseGuardPolicyStateLine,
  commandAtPersonsTerminal,
  splitKiroCommandArgs,
} from "./aidlc-lib.ts";
import { entrySkillInvocation } from "./aidlc-runtime-paths.ts";
import { chatsSince, latestMessage, latestSpendingTimestamp, listMessages, replyOfTheirs } from "./aidlc-message-store.ts";
import { backOnLine, quoted, widerPlaceOffer } from "./aidlc-recorded-switches.ts";
import { settingPurpose } from "./aidlc-settings.ts";

function throwSettingsError(message: string): never {
  throw new Error(message);
}
export const VALID_DEPTHS: Record<string, string> = {
  minimal: "Minimal",
  standard: "Standard",
  comprehensive: "Comprehensive",
};

export const VALID_TEST_STRATEGIES: Record<string, string> = {
  minimal: "Minimal",
  standard: "Standard",
  comprehensive: "Comprehensive",
};

const GUARD_FENCE_CONFIG_KEYS = SWITCHABLE_GUARD_FENCES.map((fence) => guardFenceConfigKey(fence)) as
  ["guard.plan-approval", "guard.review-freeze", "guard.state-transition", "guard.reviewer-scope"];
export const CONFIG_KEYS = [
  "depth",
  "test-strategy",
  "review",
  "guard-policy",
  "sensors",
  "learnings",
  "summary-confirmation",
  "plan-approval",
  "collaborators",
  ...GUARD_FENCE_CONFIG_KEYS,
] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];
export type IntentSettingsRequest = Partial<Record<ConfigKey, { value: string; source: string }>>;
export type ReviewOverride = "adversarial" | "advisory" | "none";

export interface GuardPolicyFieldMigration {
  normalized: boolean;
  value: "relaxed" | "off" | null;
}

/**
 * Rename an active intent's valid retired policy field without changing its
 * stored value, source label, effective policy, or audit history.
 */
export function normalizeRetiredGuardPolicyField(
  projectDir: string,
  sessionId: string,
): GuardPolicyFieldMigration {
  const selection = resolveWorkflowSelection(projectDir, { sessionId });
  if (selection.intent === null) return { normalized: false, value: null };
  const intent = selection.intent;
  const space = selection.space;
  if (!existsSync(stateFilePath(projectDir, intent, space))) {
    return { normalized: false, value: null };
  }
  return withAuditLock(projectDir, () => {
    const content = readStateFile(projectDir, intent, space);
    if (getField(content, GUARD_POLICY_FIELD) !== null) {
      return { normalized: false, value: null };
    }
    const retired = getField(content, CHANGE_CONTROL_FIELD);
    const parsed = parseGuardPolicyStateLine(retired);
    if (retired === null || (parsed?.value !== "relaxed" && parsed?.value !== "off")) {
      return { normalized: false, value: null };
    }
    const before = resolveGuardPolicy(projectDir, content, {
      selection: { intent, space },
      tolerateInvalidState: true,
    }).value;
    const updated = setGuardPolicyLine(content, retired);
    const after = resolveGuardPolicy(projectDir, updated, {
      selection: { intent, space },
      tolerateInvalidState: true,
    }).value;
    if (before !== after) {
      throw new Error("Guard Policy field migration changed the effective policy.");
    }
    writeStateFile(projectDir, updated, intent, space);
    return { normalized: true, value: parsed.value };
  }, intent, space);
}

/** What settling two disagreeing policy lines kept, and the line said when AI-DLC chose. */
export interface GuardPolicyConflictSettled {
  kept: string;
  line: string | null;
}

// What each value does, in the words the conflict lines use.
const POLICY_DOES: Record<GuardPolicy, string> = {
  strict: "checks everything",
  relaxed: "carries on with a note when something you approved changes",
  off: "carries on when something you approved changes and also skips some of its own checks",
};

type KeptBy = "set last" | "set by you" | "readable" | "scope default" | "stricter";

// Which of the two stored lines is the person's last recorded choice. Read
// from recorded facts only: the setting rows, the lines' own labels, the scope.
function keptPolicyLine(
  content: string,
  lines: ReadonlyArray<{ raw: string; parsed: { value: GuardPolicy; source: string } | null }>,
  rows: readonly AuditShardEvent[],
): { raw: string; value: GuardPolicy; by: KeptBy } | null {
  const readable = lines.filter((line) => line.parsed !== null);
  const keep = (line: (typeof lines)[number], by: KeptBy) => ({ raw: line.raw, value: line.parsed!.value, by });
  if (readable.length === 0) return null;
  if (readable.length === 1) return keep(readable[0], "readable");
  // The newer line: the newest setting row naming one line's value and source.
  // A row a governed check wrote meanwhile names the conflict as its source, so
  // it matches neither line. Shards are read in filename order, so "newest" is
  // the shared causal order (maximalAttemptEvents); rows for both lines it
  // cannot order tell nothing.
  const lineOf = new Map<AuditShardEvent, (typeof lines)[number]>();
  for (const row of rows) {
    if (row.event !== "GUARD_POLICY_SET" && row.event !== "CHANGE_CONTROL_SET") continue;
    const value = parseGuardPolicy(auditBlockField(row.block, "New Value"));
    const source = auditBlockField(row.block, "Source");
    const matched = readable.filter((line) => line.parsed!.value === value && line.parsed!.source === source);
    if (matched.length === 1) lineOf.set(row, matched[0]);
  }
  const newest = new Set(maximalAttemptEvents([...lineOf.keys()]).map((row) => lineOf.get(row)!));
  if (newest.size === 1) return keep([...newest][0], "set last");
  const theirs = readable.filter((line) => line.parsed!.source === "you");
  if (theirs.length === 1) return keep(theirs[0], "set by you");
  const scopeDefault = scopeGuardPolicyDefault(getField(content, "Scope"));
  const scoped = readable.filter((line) => line.parsed!.value === scopeDefault);
  if (scoped.length === 1) return keep(scoped[0], "scope default");
  const [first, second] = readable;
  return keep(guardPolicyAtLeast(first.parsed!.value, second.parsed!.value) ? first : second, "stricter");
}

/**
 * Settle a state carrying both the Guard Policy line and the retired Change
 * Control line with different values. That is AI-DLC's own bookkeeping: a
 * release before the rename writes the retired line beside the new one (a
 * teammate on it, or a move between releases, since the state travels by git).
 * The line kept is the person's last recorded choice (keptPolicyLine), written
 * as the one policy line with a GUARD_POLICY_SET row saying it was settled
 * (Source `command`: nobody decided anything now), keeping the step in hand as
 * a setting write does. Only when AI-DLC chose (the record could not tell) is
 * there a line to say. A team's locked strict decides the value anyway, so
 * nothing is written then. Null when there is nothing to settle or it could
 * not be recorded; the caller's notice then says the conflict instead.
 */
export function settleGuardPolicyConflict(
  projectDir: string,
  selection: { intent?: string; space?: string },
): GuardPolicyConflictSettled | null {
  const { intent, space } = selection;
  if (intent === undefined || !existsSync(stateFilePath(projectDir, intent, space))) return null;
  try {
    return withAuditLock(projectDir, () => {
      const content = readStateFile(projectDir, intent, space);
      const policy = resolveGuardPolicy(projectDir, content, { selection: { intent, space }, tolerateInvalidState: true });
      if (policy.conflict === undefined || policy.memoryStrict !== null) return null;
      const lines = [policy.conflict.guardPolicy, policy.conflict.changeControl]
        .map((raw) => ({ raw, parsed: parseGuardPolicyStateLine(raw) }));
      const kept = keptPolicyLine(content, lines, readAuditShardEvents(projectDir, intent, space));
      if (kept === null) return null;
      assertChangeControlLedgerWritable();
      appendAuditEntryUnlocked("GUARD_POLICY_SET", {
        "Old Value": policy.value,
        "New Value": kept.value,
        Source: "command",
        Settled: lines.map((line) => line.raw).join("; "),
        "Kept By": kept.by,
      }, projectDir, intent, space);
      const written = setField(setGuardPolicyLine(content, kept.raw), "Last Updated", isoTimestamp());
      writeStateFile(projectDir, written, intent, space);
      try {
        keepActiveDirectiveOverSettingWrite(projectDir, content, written);
      } catch {
        // The settled line stands; a step set aside is issued again by `next`.
      }
      const why = kept.by === "scope default"
        ? "The record does not say which was set last, so AI-DLC keeps the one this work's scope starts with"
        : kept.by === "stricter"
          ? "The record does not say which was set last, so AI-DLC keeps the stricter one"
          : kept.by === "readable" ? "One of them could not be read, so AI-DLC keeps the other" : null;
      return {
        kept: kept.raw,
        line: why === null
          ? null
          : "This work had two settings for how closely AI-DLC checks changes, and they disagreed. " +
            `${why}: it ${POLICY_DOES[kept.value]}. You can change it any time.`,
      };
    }, intent, space);
  } catch {
    return null;
  }
}

export function parseReviewOverride(
  raw: string | undefined,
  die: (message: string) => never = throwSettingsError,
): ReviewOverride | undefined {
  if (!raw) return undefined;
  const value = raw.toLowerCase();
  if (value !== "adversarial" && value !== "advisory" && value !== "none") {
    die(`Unknown review class: "${raw}". Valid: adversarial, advisory, none.`);
  }
  return value;
}

/** The review level a scope runs with no override: its review_cap, else adversarial. */
export function scopeReviewLevel(scope: string | null | undefined): ReviewOverride {
  const cap = scope ? loadScopeMetadata()[scope.trim().toLowerCase()]?.reviewCap : undefined;
  return cap ?? "adversarial";
}

export function storedReviewOverride(value: ReviewOverride, scope?: string | null): string {
  // A level equal to the scope's own clears the override, so the scope's
  // review_cap applies again and follows later scope changes. Any other level
  // is stored and replaces that cap as this work's ceiling, so "adversarial"
  // lifts a capped scope to each stage's own class.
  return scope !== undefined && value === scopeReviewLevel(scope) ? "" : value;
}

export function applyReviewOverride(
  content: string,
  value: ReviewOverride | undefined,
  scope: string | null = getField(content, "Scope"),
): {
  content: string;
  oldReview: string | null;
  storedReview: string | undefined;
  changed: boolean;
} {
  const oldReview = getField(content, "Review Override");
  if (value === undefined) {
    return { content, oldReview, storedReview: undefined, changed: false };
  }
  const storedReview = storedReviewOverride(value, scope);
  const changed = storedReview !== (oldReview ?? "");
  if (!changed) return { content, oldReview, storedReview, changed };
  if (oldReview === null) {
    const beforeInsert = content;
    content = content.replace(
      /^(- \*\*Test Strategy\*\*:[^\n]*)$/m,
      "$1\n- **Review Override**:",
    );
    if (content === beforeInsert) {
      content = content.replace(
        /^(- \*\*Scope\*\*:[^\n]*)$/m,
        "$1\n- **Review Override**:",
      );
    }
    if (content === beforeInsert) {
      content = `${content.trimEnd()}\n- **Review Override**:\n`;
    }
  }
  content = setField(content, "Review Override", storedReview);
  return { content, oldReview, storedReview, changed };
}
function setCeremonyField(content: string, key: CeremonyKey, value: CeremonySetting, source: string): string {
  const field = CEREMONY_FIELDS[key];
  if (getField(content, field) === null) {
    const beforeInsert = content;
    const previousFields = CEREMONY_KEYS.slice(0, CEREMONY_KEYS.indexOf(key))
      .reverse().map((previous) => CEREMONY_FIELDS[previous]);
    for (const anchor of [...previousFields, GUARDS_OFF_FIELD, GUARD_POLICY_FIELD, CHANGE_CONTROL_FIELD, "Review Override", "Test Strategy", "Scope"]) {
      content = content.replace(
        new RegExp(`^(- \\*\\*${anchor}\\*\\*:[^\\n]*)$`, "m"),
        `$1\n- **${field}**:`,
      );
      if (content !== beforeInsert) break;
    }
    if (content === beforeInsert) content = `${content.trimEnd()}\n- **${field}**:\n`;
  }
  return setField(content, field, formatCeremony(value, source));
}

// The same setting typed as this engine's own setter command carries none of
// `next`'s flags for the message record to hold, so the dispatcher that owns
// the command's shape is asked what their line named: `config set <key> <value>
// [--key value]` is the setter's own `--key value` arguments. Any other line,
// and any line the dispatcher will not resolve, names nothing.
function setterCommandNames(text: string, key: string, value: string): boolean {
  try {
    const { aidlcEntryWords } = require("./aidlc-reply-reader.ts") as typeof import("./aidlc-reply-reader.ts");
    const words = aidlcEntryWords(text);
    if (words === null || words === "") return false;
    const { resolveAction } = require("./aidlc.ts") as typeof import("./aidlc.ts");
    const action = resolveAction(splitKiroCommandArgs(words));
    if (action.type !== "delegate" || action.tool !== "aidlc-utility.ts" || action.args[0] !== "config-change") {
      return false;
    }
    return action.args.some((arg, index) =>
      arg.toLowerCase() === `--${key}` && action.args[index + 1]?.toLowerCase() === value);
  } catch {
    // The dispatcher is not readable from here: the label falls back to the
    // rules below, which never costs the person a setting.
    return false;
  }
}

/**
 * Whether a setting is the person's, with their words, from recorded facts
 * only: the one rule behind every "set by you" the setter, the kept settings,
 * creation and the routed line say. Theirs when they typed it on their own line
 * in this chat (the message record's settings, or the setter command typed
 * whole), on their latest line or one no decision has spent since; when they
 * ran the command at their own terminal; or when the agent, which read the
 * chat, passed their words (--person-words) and a reply of theirs in this chat
 * since the last decision is exactly those words. A routing answer is no
 * decision here: it sends the words and the settings before it to the work it
 * names, where this setter runs. Null otherwise: the setting is still carried
 * out, and recorded as the command's. Who may lower a check is not decided here.
 */
export function settingTheirs(
  projectDir: string,
  sessionId: string | null,
  key: string,
  value: string | undefined,
  personWords?: string,
  selection: { intent?: string; space?: string } = {},
): { words: string | null } | null {
  if (commandAtPersonsTerminal()) return { words: null };
  return saidInChat(projectDir, sessionId, key, value, personWords, selection);
}

/**
 * The chat half of settingTheirs: their typed line or their whole reply in this
 * chat, never their own terminal. What the folder is (`project-type`) is read
 * this way too: the line keeps it as the route's project type, not a setting.
 */
export function saidInChat(
  projectDir: string,
  sessionId: string | null,
  key: string,
  value: string | undefined,
  personWords?: string,
  selection: { intent?: string; space?: string } = {},
): { words: string | null } | null {
  let rows: AuditShardEvent[] = [];
  try {
    rows = readAuditShardEvents(projectDir, selection.intent, selection.space);
  } catch {
    rows = [];
  }
  // A command whose chat the engine cannot name is this work's one chat: the
  // only one that has spoken since the last decision (as proveMessage reads it).
  // A decision their newest message led to itself (the plan answer typed
  // beside the setting) leaves none spoken since; that message's chat is it.
  let chat = sessionId;
  if (chat === null) {
    const chats = chatsSince(rows, projectDir, latestSpendingTimestamp(rows));
    const newest = chats.size === 0 ? listMessages(projectDir).at(-1) : undefined;
    if (newest?.session) chats.add(newest.session);
    chat = chats.size === 1 && !chats.has("terminal") ? [...chats][0] : null;
  }
  if (chat === null) return null;
  // Their lines and replies count from the last decision; a routing answer is
  // none here (see above).
  const decisions = rows.filter((row) => row.event !== "REQUEST_ROUTED");
  if (value !== undefined) {
    const latest = latestMessage(projectDir, chat);
    const spentAt = latestSpendingTimestamp(decisions);
    const lines = listMessages(projectDir).filter((message) =>
      message.session === chat && (spentAt === null || message.at >= spentAt));
    if (latest !== null && !lines.some((message) => message.id === latest.id)) lines.push(latest);
    const names = key === "plan-approval" || key === "guard.plan-approval" ? ["plan-approval", "guard.plan-approval"] : [key];
    if (lines.some((message) => message.settings.some((setting) => names.includes(setting.key) && setting.value === value) ||
      (key === "project-type" && message.route.projectType === value) ||
      names.some((name) => setterCommandNames(message.text, name, value)))) {
      return { words: null };
    }
  }
  if (personWords === undefined) return null;
  const reply = replyOfTheirs(projectDir, chat, personWords, decisions);
  return reply === null ? null : { words: reply.words ?? reply.text };
}

export function applyIntentSettings(
  projectDir: string,
  content: string,
  requested: IntentSettingsRequest,
  {
    sessionId = null, typedByPerson = false, fail: die = throwSettingsError, reviewScope, personWords, notTheirs,
    ...selection
  }: {
    intent?: string; space?: string; sessionId?: string | null; typedByPerson?: boolean;
    fail?: (message: string) => never;
    /** The scope a review level is compared with; defaults to the state's own. */
    reviewScope?: string;
    /** The person's words the agent says asked for this (--person-words), proven against their replies. */
    personWords?: string;
    /** Settings carried with `typedByPerson` that were kept as a command's, not theirs. */
    notTheirs?: ReadonlySet<string>;
  },
): { content: string; audit: AuditEntryInput[]; lines: string[] } {
  // `guard.plan-approval` is another way to say `plan-approval`: one switch that
  // removes the plan stop. Whether an edited plan asks again is Guard Policy's.
  if (requested["guard.plan-approval"] !== undefined) {
    requested = { ...requested };
    requested["plan-approval"] ??= requested["guard.plan-approval"];
    delete requested["guard.plan-approval"];
  }
  const rawDepth = requested.depth?.value;
  const rawStrategy = requested["test-strategy"]?.value;
  const rawReview = requested.review?.value;
  const rawChangeControl = requested["guard-policy"]?.value;
  let depth: string | undefined;
  if (rawDepth !== undefined) {
    const key = rawDepth.toLowerCase();
    if (!Object.hasOwn(VALID_DEPTHS, key)) die(`Unknown depth: "${rawDepth}". Valid depths: minimal, standard, comprehensive.`);
    depth = VALID_DEPTHS[key];
  }
  let strategy: string | undefined;
  if (rawStrategy !== undefined) {
    const key = rawStrategy.toLowerCase();
    if (!Object.hasOwn(VALID_TEST_STRATEGIES, key)) die(`Unknown test strategy: "${rawStrategy}". Valid: minimal, standard, comprehensive.`);
    strategy = VALID_TEST_STRATEGIES[key];
  }
  const review = parseReviewOverride(rawReview, die);
  if (rawReview !== undefined && review === undefined) {
    die(`Unknown review class: "${rawReview}". Valid: adversarial, advisory, none.`);
  }
  const changeControl = parseGuardPolicy(rawChangeControl);
  if (rawChangeControl !== undefined && changeControl === null) {
    die(`Unknown Guard Policy value: "${rawChangeControl}". Valid: ${GUARD_POLICY_VALUES.join(", ")}.`);
  }
  const fenceRequests: Array<{ fence: SwitchableGuardFence; value: FenceSetting; source: string }> = [];
  for (const fence of SWITCHABLE_GUARD_FENCES) {
    const request = requested[guardFenceConfigKey(fence) as ConfigKey];
    if (request === undefined) continue;
    const word = request.value.toLowerCase().trim();
    if (word !== "on" && word !== "off") {
      die(`--${guardFenceConfigKey(fence)} requires <on|off>; received "${request.value}".`);
    } else {
      fenceRequests.push({ fence, value: word, source: request.source });
    }
  }
  const ceremonies: Partial<CeremonyPolicy> = {};
  for (const key of CEREMONY_KEYS) {
    const raw = requested[CEREMONY_FLAGS[key].slice(2) as ConfigKey]?.value;
    if (raw === undefined) continue;
    const value = parseCeremonySetting(raw);
    if (value === null) {
      die(`${CEREMONY_FLAGS[key]} requires <on|off>; received "${raw}".`);
    } else {
      ceremonies[key] = value;
    }
  }

  // Validate every requested value before policy can reject the transaction.
  // Explicit CC requests can repair a malformed saved line; other updates may
  // not quietly carry an invalid line into a new scope or configuration.
  const ccRequest = requested["guard-policy"];
  const cc = resolveGuardPolicy(projectDir, content, {
    tolerateInvalidState: ccRequest?.source === "you",
    selection,
  });
  const guardLowering = (changeControl !== null && changeControl !== "strict") ||
    fenceRequests.some((request) => request.value === "off");
  if (typedByPerson && guardLowering && cc.memoryStrict !== null) {
    // A memory edit may land after the hook's preflight. Report it without
    // taking the CLI refusal path, which terminates the process.
    throw new Error(guardPolicyMemoryStrictRefusal(cc.memoryStrict));
  }
  if (ccRequest?.source === "you" && changeControl !== null && changeControl !== "strict" && cc.memoryStrict !== null) {
    die(guardPolicyMemoryStrictRefusal(cc.memoryStrict));
  }
  if (cc.memoryStrict !== null) {
    const loweredFence = fenceRequests.find((request) => request.value === "off");
    if (loweredFence !== undefined) die(fenceMemoryLockRefusal(cc.memoryStrict, loweredFence.fence));
  }

  const lowering: GuardSwitch[] = [];
  if (fenceRequests.length > 0) {
    // Evaluate fence no-ops after this command's policy change, just as the
    // fence update loop does. Raising the policy cannot smuggle a fence off.
    const fenceContent = ccRequest !== undefined && changeControl !== null
      ? setGuardPolicyLine(content, formatGuardPolicy(changeControl, ccRequest.source))
      : content;
    const fencePolicy = fenceContent === content
      ? cc : resolveGuardPolicy(projectDir, fenceContent, { selection });
    const currentFences = resolveFences(fencePolicy, fenceContent);
    for (const request of fenceRequests) {
      if (request.source === "you" && request.value === "off" && currentFences[request.fence].value !== "off") {
        lowering.push({ key: `guard.${request.fence}`, value: "off" });
      }
    }
  }
  // The person's Guard Policy word covers every check in its own direction:
  // off clears this work's checks kept on, strict its checks turned off, and
  // relaxed neither, so relaxed never turns a check back on or off. A check
  // this command names keeps its own setting. A check they had kept on that
  // the word turns off is a lowering too.
  const wholePolicy = ccRequest?.source === "you" && changeControl !== null;
  const namedFences = new Set(fenceRequests.map((request) => request.fence));
  const withoutPerCheckEntries = (text: string): string => {
    const off = parseGuardsOffLine(getField(text, GUARDS_OFF_FIELD));
    const on = parseGuardsOnLine(getField(text, GUARDS_ON_FIELD));
    const cleared = perCheckSettingClearedBy(changeControl);
    const keepOff = cleared === "off" ? off.filter((fence) => namedFences.has(fence)) : off;
    const keepOn = cleared === "on" ? on.filter((fence) => namedFences.has(fence)) : on;
    let updated = text;
    if (keepOff.length !== off.length) updated = setGuardsOffLine(updated, keepOff);
    if (keepOn.length !== on.length) updated = setGuardsOnLine(updated, keepOn);
    return updated;
  };
  if (wholePolicy) {
    const policyContent = setGuardPolicyLine(content, formatGuardPolicy(changeControl, ccRequest.source));
    const cleared = withoutPerCheckEntries(policyContent);
    if (cleared !== policyContent) {
      const now = resolveFences(cc, content);
      const after = resolveFences(resolveGuardPolicy(projectDir, cleared, { selection }), cleared);
      for (const fence of SWITCHABLE_GUARD_FENCES) {
        if (!namedFences.has(fence) && now[fence].value === "on" && after[fence].value === "off") {
          lowering.push({ key: `guard.${fence}`, value: "off" });
        }
      }
    }
  }
  // Only a value below the one in force lowers anything: off to relaxed raises
  // the checks, and needs no one's word.
  if (ccRequest?.source === "you" && (changeControl === "relaxed" || changeControl === "off") &&
    !guardPolicyAtLeast(changeControl, cc.value)) {
    lowering.push({ key: "guard-policy", value: changeControl });
  }
  // Summary confirmation off removes the person's `Looks correct` checkpoint,
  // so it is a lowering too. Sensors are deterministic checks and learnings is
  // the agent's own ritual: neither takes a decision away from the person.
  // Only an explicit saved off makes the request a no-op. A scope-owned off
  // would become explicit and outlive a scope change, and an environment kill
  // switch is machine-wide and temporary, so neither counts.
  if (ceremonies.summary_confirmation === "off" && requested["summary-confirmation"]?.source === "you") {
    const saved = parseCeremonyStateLine(getField(content, CEREMONY_FIELDS.summary_confirmation));
    if (saved?.value !== "off" || (saved.source !== "you" && saved.source !== "command")) {
      lowering.push({ key: "summary-confirmation", value: "off" });
    }
  }
  // Plan approval off removes the person's approval of the code plan, so it is
  // a lowering too, and a memory-held strict Guard Policy keeps it on for everyone.
  if (ceremonies.plan_approval === "off") {
    // A scope change carries the new scope's value as `scope <name>`: that is
    // stored, and the lock keeps the effective value on. Only an explicit
    // request is refused.
    const explicit = requested["plan-approval"]?.source === "you";
    if (explicit && cc.memoryStrict !== null) die(planApprovalMemoryLockRefusal(cc.memoryStrict.path));
    if (explicit) {
      const saved = parseCeremonyStateLine(getField(content, CEREMONY_FIELDS.plan_approval));
      if (saved?.value !== "off" || (saved.source !== "you" && saved.source !== "command")) {
        lowering.push({ key: "plan-approval", value: "off" });
      }
    }
  }
  // An unattended driver never lowers fences, including a recorded presence bypass.
  if (lowering.length > 0 && process.env.AIDLC_UNATTENDED === "1") {
    die(guardSwitchRefusal(lowering[0]));
  }
  // Lowering a fence is the person's call. Their typed switch carries it out,
  // and so does this setter when a person has spoken since the last decision
  // (the approval they gave in the same message leaves the rest of it standing):
  // the conductor runs what they asked for, in their own words.
  // A command the person ran at their own terminal carries itself: this rule
  // protects them from a worker lowering a check on their behalf, and it has no
  // business standing in front of what they typed. An agent's tool call arrives
  // with pipes and no chat identity on it, and is refused, and so is one run in
  // a terminal a host opened for its agent (Copilot in VS Code, Kiro IDE,
  // Cursor), where the line says which chat to ask in.
  // `commandAtPersonsTerminal` owns that test for the refusal and the record alike.
  // The person's own settings here are the checks this command lowers and every
  // other setting requested as theirs: a ceremony the agent sets from their
  // words (collaborators, sensors, learnings) or turns back on. Whose it is
  // follows the one rule below, so none of them is left to read "set by a
  // command" when the person asked for it.
  const theirCeremonies = CEREMONY_KEYS.filter((key) =>
    ceremonies[key] !== undefined && requested[CEREMONY_FLAGS[key].slice(2) as ConfigKey]?.source === "you");
  const personsRequest = lowering.length > 0 || theirCeremonies.length > 0;
  const atTheirTerminal = personsRequest && !typedByPerson && commandAtPersonsTerminal();
  if (
    lowering.length > 0 && !typedByPerson && !atTheirTerminal && !fenceKeyBypassed(projectDir, sessionId) &&
    !personSpokeSinceGate(projectDir, { requests: true, outlivesApproval: true })
  ) {
    die(guardSwitchRefusal(lowering[0], projectDir));
  }
  // The setter carries out what the person asked, and records it as theirs only
  // when a fact on record says so (settingTheirs): they typed it on their own
  // line, ran it at their own terminal, or the agent passed their words and a
  // reply of theirs in this chat is exactly those words. Their words go on the
  // record then; anything else is recorded as the command's, with no words, so
  // the work never says they decided what they did not. A setting carried with
  // typedByPerson is theirs unless it was kept as a command's (notTheirs).
  const proofs = new Map<string, { words: string | null } | null>();
  const theirs = (key: string): { words: string | null } | null => {
    if (typedByPerson) return notTheirs?.has(key) ? null : { words: null };
    if (requested[key as ConfigKey]?.source !== "you") return null;
    if (!proofs.has(key)) {
      const value = requested[key as ConfigKey]?.value.trim().toLowerCase();
      proofs.set(key, settingTheirs(projectDir, sessionId, key, value, personWords, selection));
    }
    return proofs.get(key) ?? null;
  };
  const askedKeys = Object.keys(requested).filter((key) => requested[key as ConfigKey]?.source === "you");
  const askedIn = typedByPerson || atTheirTerminal
    ? null
    : askedKeys.map((key) => theirs(key)?.words ?? null).find((words) => words !== null) ?? null;
  // Theirs, asked in the chat or run at their terminal: each check it turns off
  // is said in one line, with their words where the record has them, and the way
  // back, instead of the setter's own line.
  const saidAsAsked = (key: string): boolean =>
    !typedByPerson && key !== "plan-approval" && lowering.some((item) => item.key === key) && theirs(key) !== null;
  const personAsked = (key: string): boolean => theirs(key) !== null;
  // The source a setting is written with: the request's own, except that a
  // person's request nothing on record stands behind is the command's.
  const writtenSource = (key: string, source: string): string => source === "you" && !personAsked(key) ? "command" : source;

  const audit: AuditEntryInput[] = [];
  const lines: string[] = [];
  // A default a scope change brings is said only when its value changes.
  const scopeDefault = (key: ConfigKey): boolean => requested[key]?.source.startsWith("scope ") === true;
  if (depth !== undefined) {
    const previous = getField(content, "Depth");
    const updated = previous === depth ? content : setField(content, "Depth", depth);
    const changed = updated !== content;
    if (changed) {
      content = updated;
      audit.push({ eventType: "DEPTH_CHANGED", fields: { "Old Depth": previous || "unknown", "New Depth": depth } });
    }
    if (changed || !scopeDefault("depth")) {
      lines.push(changed ? `Depth changed: ${previous} -> ${depth}` : `Depth is already ${depth}`);
    }
  }
  if (strategy !== undefined) {
    const previous = getField(content, "Test Strategy");
    const updated = previous === strategy ? content : setField(content, "Test Strategy", strategy);
    const changed = updated !== content;
    if (changed) {
      content = updated;
      audit.push({ eventType: "TEST_STRATEGY_CHANGED", fields: { "Old Strategy": previous || "unknown", "New Strategy": strategy } });
    }
    if (changed || !scopeDefault("test-strategy")) {
      lines.push(changed ? `Test strategy changed: ${previous} -> ${strategy}` : `Test strategy is already ${strategy}`);
    }
  }
  if (review !== undefined) {
    const target = reviewScope ?? getField(content, "Scope");
    const update = applyReviewOverride(content, review, target);
    content = update.content;
    if (update.changed) {
      audit.push({
        eventType: "REVIEW_CLASS_CHANGED",
        fields: {
          "Old Override": update.oldReview || "none set",
          "New Override": update.storedReview || "cleared (scope default applies)",
        },
      });
    }
    // The person's line: what the reviews are now, what they were, and the way
    // back, in the harness's own entry word. With no override set, the level in
    // force was the scope's own. An empty stored override is the scope's own
    // level again.
    const level = update.storedReview === "" ? scopeReviewLevel(target) : (update.storedReview ?? review);
    const was = update.oldReview || scopeReviewLevel(target);
    const word = (value: string): string => (value === "none" ? "off" : value);
    const back = `say so or type ${entrySkillInvocation()} --review ${was}`;
    lines.push(!update.changed
      ? `Specialist reviews are already ${word(level)} for this work.`
      : level === "none"
        ? `Specialist reviews are off for the rest of this work. To turn them back on, ${back}.`
        : `Specialist reviews are ${level} for the rest of this work (they were ${word(was)}). To change it back, ${back}.`);
  }
  // Persist scope-owned updates even while memory controls the effective value.
  // Explicit strict is also recordable; explicit relaxed was refused above.
  if (ccRequest !== undefined && changeControl !== null) {
    const previous = cc.rawStateValue;
    const policySource = writtenSource("guard-policy", ccRequest.source);
    const line = formatGuardPolicy(changeControl, policySource);
    // A command's run of the person's own value never relabels their choice.
    const sameAsTheirs = policySource === "command" && previous === formatGuardPolicy(changeControl, "you");
    if ((previous === line || sameAsTheirs) && cc.stateField === GUARD_POLICY_FIELD && getField(content, CHANGE_CONTROL_FIELD) === null) {
      // It says whose it already is, as the ceremony lines do.
      if (!scopeDefault("guard-policy")) lines.push(`Guard Policy is already ${previous ?? line}`);
    } else {
      // Every write keeps only the Guard Policy line, even when its stored text is unchanged.
      // Resolving a conflict records one GUARD_POLICY_SET from the prior effective policy, not a name-only rename.
      content = setGuardPolicyLine(content, line);
      if (previous !== line || cc.conflict !== undefined) {
        const oldValue = cc.conflict !== undefined ? cc.value : cc.intent?.value ?? cc.rawStateValue ?? cc.stateValue;
        // A scope's default that keeps the value only renames where it came
        // from: the scope change's own row records that, not a setting row.
        if (oldValue !== changeControl || cc.conflict !== undefined || !scopeDefault("guard-policy")) {
          audit.push({
            eventType: "GUARD_POLICY_SET",
            fields: {
              "Old Value": oldValue, "New Value": changeControl, Source: policySource,
              ...(askedIn && policySource === "you" && lowering.some((item) => item.key === "guard-policy")
                ? { "Person Reply": askedIn } : {}),
            },
          });
        }
        const oldDisplay = cc.conflict === undefined && cc.intent === null && cc.rawStateValue !== null
          ? cc.rawStateValue : formatGuardPolicy(cc.value, cc.source);
        if ((oldValue !== changeControl || !scopeDefault("guard-policy")) && !saidAsAsked("guard-policy")) {
          lines.push(`Guard Policy changed: ${oldDisplay} to ${line}`);
        }
      } else if (!scopeDefault("guard-policy")) {
        lines.push(`Guard Policy is already ${line}`);
      }
    }
  }
  if (wholePolicy) {
    const cleared = withoutPerCheckEntries(content);
    if (cleared !== content) {
      const policy = resolveGuardPolicy(projectDir, content, { selection });
      const before = resolveFences(policy, content);
      const after = resolveFences(policy, cleared);
      content = cleared;
      for (const fence of SWITCHABLE_GUARD_FENCES) {
        if (before[fence].value === after[fence].value) continue;
        const source = writtenSource("guard-policy", ccRequest.source);
        const fenceFields = {
          Guard: fence, Scope: getField(content, "Scope") ?? "", Source: source,
          ...(askedIn && source === "you" && after[fence].value === "off" ? { "Person Reply": askedIn } : {}),
        };
        audit.push(
          after[fence].value === "off"
            ? { eventType: "GUARD_DISABLED", fields: fenceFields }
            : { eventType: "GUARD_RESTORED", fields: fenceFields },
        );
        if (!saidAsAsked(`guard.${fence}`)) {
          lines.push(
            after[fence].value === "off"
              ? `The ${checkLabel(fence)} is off for this piece of work (logged; back on for the next one)`
              : `The ${checkLabel(fence)} is back on for this piece of work`,
          );
        }
      }
    }
  }
  // Per-work switches can lower a fence or raise it above the policy word.
  // Record only an effective change: environment kill switches still win.
  if (fenceRequests.length > 0) {
    const scopeName = getField(content, "Scope") ?? "";
    const policy = resolveGuardPolicy(projectDir, content, { selection });
    const byPolicy = fencesLoweredByPolicy(policy.value);
    for (const request of fenceRequests) {
      const before = resolveFences(policy, content)[request.fence];
      const lowered = parseGuardsOffLine(getField(content, GUARDS_OFF_FIELD));
      const raised = parseGuardsOnLine(getField(content, GUARDS_ON_FIELD));
      const nextOff = lowered.filter((fence) => fence !== request.fence);
      const nextOn = raised.filter((fence) => fence !== request.fence);
      if (request.value === "off") nextOff.push(request.fence);
      else if (byPolicy.includes(request.fence)) nextOn.push(request.fence);
      const source = writtenSource(guardFenceConfigKey(request.fence), request.source);
      // One label for each line of checks: theirs while every check on it is.
      const lineSource = (field: string, had: readonly SwitchableGuardFence[]): string =>
        source === "you" && (had.length === 0 || guardsLineSource(getField(content, field)) === "you") ? "you" : "command";
      let updated = content;
      if (nextOff.length !== lowered.length) {
        updated = setGuardsOffLine(updated, nextOff, request.value === "off" ? lineSource(GUARDS_OFF_FIELD, lowered) : undefined);
      }
      if (nextOn.length !== raised.length) {
        updated = setGuardsOnLine(updated, nextOn, nextOn.length > raised.length ? lineSource(GUARDS_ON_FIELD, raised) : undefined);
      }
      const after = resolveFences(policy, updated)[request.fence];
      if (before.value === after.value) {
        // The plan this work runs already leaves the check where the person
        // asked for it. An off they set themselves is still recorded as theirs,
        // so the work says whose decision it was (status reads "(set by you)"
        // instead of crediting the plan, and the audit carries the row) rather
        // than leaving their own switch with nothing behind it. A later Guard
        // Policy word still clears per-check entries, and nothing the person reads
        // here changes.
        if (typedByPerson && request.value === "off" && updated !== content) {
          content = updated;
          audit.push({
            eventType: "GUARD_DISABLED",
            fields: {
              Guard: request.fence, Scope: scopeName, Source: source,
              ...(askedIn && source === "you" ? { "Person Reply": askedIn } : {}),
            },
          });
        }
        // Turned on, but a switch outside this piece of work keeps it off: their
        // own local entry is cleared, otherwise what keeps it and the way to it.
        const held = request.value === "on"
          ? backOnLine(projectDir, projectSwitchOf(`guard.${request.fence}`), source === "you")
          : null;
        if (held !== null) {
          // Their on is recorded too, so once that switch is cleared the check
          // is on for this work as they asked and nothing asks them again. An
          // on of theirs this work already keeps stays kept.
          if (updated !== content && nextOn.length >= raised.length) {
            content = updated;
            audit.push({ eventType: "GUARD_RESTORED", fields: { Guard: request.fence, Scope: scopeName, Source: source } });
          }
          lines.push(held);
          continue;
        }
        const already = `The ${checkLabel(request.fence)} is already ${after.value}`;
        const offer = request.value === "off" && after.value === "off" && !atTheirTerminal
          ? widerPlaceOffer(projectDir, projectSwitchOf(`guard.${request.fence}`), "work")
          : null;
        lines.push(offer ? `${already}. ${offer}` : already);
        continue;
      }
      content = updated;
      // Each event named literally at its own call, not through a ternary on
      // eventType: the emitter drift guard reads these call sites as text, and a
      // computed event name is invisible to it.
      const fenceFields = {
        Guard: request.fence, Scope: scopeName, Source: source,
        ...(askedIn && source === "you" && after.value === "off" ? { "Person Reply": askedIn } : {}),
      };
      audit.push(
        after.value === "off"
          ? { eventType: "GUARD_DISABLED", fields: fenceFields }
          : { eventType: "GUARD_RESTORED", fields: fenceFields },
      );
      if (!saidAsAsked(`guard.${request.fence}`)) {
        lines.push(
          after.value === "off"
            ? `The ${checkLabel(request.fence)} is off for this piece of work (logged; back on for the next one)`
            : `The ${checkLabel(request.fence)} is back on for this piece of work`,
        );
      }
    }
  }
  for (const key of CEREMONY_KEYS) {
    const value = ceremonies[key];
    if (value === undefined) continue;
    // The person's own setting is `you`; an explicit setter run from a shell,
    // with no word of theirs behind it, records that a command set it, and
    // never relabels the person's own identical choice.
    const flag = CEREMONY_FLAGS[key].slice(2) as ConfigKey;
    const requestedSource = requested[flag]!.source;
    const source = writtenSource(flag, requestedSource);
    const field = CEREMONY_FIELDS[key];
    const previous = getField(content, field);
    const line = formatCeremony(value, source);
    // Turned on, but a switch outside this piece of work keeps it off: that is
    // said in place of the setting's own line, which would read as on (their
    // own local entry is cleared first). Plan approval reads its environment
    // switch only where it is trusted.
    const held = value === "on" && !scopeDefault(flag)
      ? backOnLine(projectDir, CEREMONY_ENV[key], source === "you",
        key === "plan_approval" ? planApprovalEnv(projectDir, sessionId) : process.env)
      : null;
    if (previous === line || (source === "command" && previous === formatCeremony(value, "you"))) {
      if (held !== null) {
        lines.push(held);
      } else if (!scopeDefault(flag)) {
        const already = `${field} is already ${previous}`;
        const offer = value === "off" && !atTheirTerminal ? widerPlaceOffer(projectDir, CEREMONY_ENV[key], "work") : null;
        lines.push(offer ? `${already}. ${offer}` : already);
      }
      continue;
    }
    const resolution = resolveCeremony(key, getField(content, "Scope"), content);
    content = setCeremonyField(content, key, value, source);
    const oldValue = resolution.intent?.value ?? resolution.rawStateValue ?? resolution.scopeDefault;
    // Same as Guard Policy: a scope's default that keeps the value writes no row.
    if (oldValue === value && scopeDefault(flag)) continue;
    audit.push({
      eventType: "CEREMONY_SET",
      fields: {
        Key: key, Old: oldValue, New: value, Source: source,
        ...(askedIn && value === "off" && source === "you" ? { "Person Reply": askedIn } : {}),
      },
    });
    if (held !== null) {
      lines.push(held);
      continue;
    }
    const oldDisplay = resolution.intent === null && resolution.rawStateValue !== null
      ? resolution.rawStateValue : formatCeremony(resolution.value, resolution.source);
    if (!saidAsAsked(flag)) lines.push(`${field} changed: ${oldDisplay} to ${line}`);
    if (key === "plan_approval") {
      lines.push(value === "off"
        ? "Each code plan is now built without asking you first. You can ask to see one before it is built any time."
        : "Each code plan is now shown for approval before it is built.");
    }
    // The line said for it ends with the one wider place (the line said as
    // they asked carries it below instead). A value the scope set is nobody's
    // request to turn the check off, so it offers nothing.
    if (value === "off" && !scopeDefault(flag) && !saidAsAsked(flag) && !atTheirTerminal && lines.length > 0) {
      const offer = widerPlaceOffer(projectDir, CEREMONY_ENV[key], "work");
      if (offer) lines[lines.length - 1] = `${lines[lines.length - 1]} ${offer}`;
    }
  }
  for (const item of lowering) {
    if (!saidAsAsked(item.key)) continue;
    const line = askedSwitchLine(item, askedIn, cc.value, !atTheirTerminal);
    const offer = atTheirTerminal ? null : widerPlaceOffer(projectDir, projectSwitchOf(item.key), "work");
    lines.push(offer ? `${line} ${offer}` : line);
  }
  return { content, audit, lines };
}

// The project's switch for a check set for this piece of work, which is where
// a wider place for it would be set; none for the Guard Policy, which is for a
// piece of work only.
function projectSwitchOf(key: GuardSwitchKey): string | undefined {
  if (key === "summary-confirmation") return CEREMONY_ENV.summary_confirmation;
  if (key === "plan-approval") return CEREMONY_ENV.plan_approval;
  if (key.startsWith("guard.")) return GUARD_FENCE_ENV[key.slice("guard.".length) as SwitchableGuardFence];
  return undefined;
}

/**
 * Guard Policy as the person reads it, with what it does for them. One owner, so
 * the setting reads the same wherever it is said (here and the routed note in
 * `aidlc-orchestrate.ts`).
 */
export function guardPolicyNamed(): string {
  return `Guard Policy${settingPurpose("Guard Policy")}`;
}

function checkLabel(fence: string): string {
  return `${fence.replace("reviewer-scope", "reviewer read scope").replaceAll("-", " ")} check`;
}

// What the person hears when one of their checks went off: what it is for, what
// is off, for this piece of work, and that the way back is there. Why it went
// off is said as far as it is known: their own words, the chat they asked in,
// or, for a command they ran themselves, that they set it.
// This line follows something they just did, so it tells them where they are and
// nothing more: no question putting their own decision back to them, and no
// command to type, because they say what they want next in their own words.
function askedSwitchLine(
  item: GuardSwitch,
  words: string | null,
  previousPolicy: string,
  inThisChat: boolean,
): string {
  const why = words ? `because you said: "${quoted(words)}"` : inThisChat ? "as you asked in the chat" : "set by you";
  if (item.key === "guard-policy") {
    return `${guardPolicyNamed()} is ${item.value} for this piece of work, ${why}. ` +
      `You can put it back to ${previousPolicy} any time.`;
  }
  const label = item.key === "summary-confirmation" ? "summary confirmation" : checkLabel(item.key.slice("guard.".length));
  return `The ${label}${settingPurpose(label)} is off for this piece of work, ${why}. ` +
    "You can turn it back on any time.";
}

export interface TypedGuardSwitchOutcome {
  applied: boolean;
  lines: string[];
}

// --- Plan Approval as a setting ----------------------------------------------
//
// `plan_approval` is a ceremony, so the scope, the intent line, and the machine
// switch resolve it like the others. Two things are its own: a memory-held
// strict Guard Policy keeps it on for everyone on the repo, and only the person
// can turn it off (see applyIntentSettings). The machine switch
// AIDLC_DISABLE_PLAN_APPROVAL_GUARD still wins, as it does for every fence.

const KNOWN_PLAN_APPROVAL_SOURCE = /^(?:you|command|default|scope [a-z][a-z0-9-]{0,63})$/;

export interface PlanApprovalSetting {
  value: CeremonySetting;
  /** Human-worded: env AIDLC_DISABLE_PLAN_APPROVAL_GUARD, you, scope express, guard policy strict (from project.md). */
  source: string;
  /** The memory file holding Guard Policy strict, when that is what keeps it on. */
  lockedBy?: string;
}

export function resolvePlanApprovalSetting(
  projectDir: string,
  stateContent: string | null | undefined,
  selection: { intent?: string; space?: string; sessionId?: string } = {},
): PlanApprovalSetting {
  const env = planApprovalEnv(projectDir, selection.sessionId ?? null);
  const resolution = resolveCeremony("plan_approval", getField(stateContent ?? "", "Scope"), stateContent, env, projectDir);
  // The machine switch is read from the environment or the settings files
  // themselves, never from saved state text.
  if (isKillSwitchSource(resolution.source) && resolveProjectFlag(CEREMONY_ENV.plan_approval, env, projectDir) === "1") {
    return { value: "off", source: resolution.source };
  }
  // The source is repeated to the person word for word, so only the forms the
  // engine writes pass; anything else a hand-edited state line carries does not.
  const source = KNOWN_PLAN_APPROVAL_SOURCE.test(resolution.source)
    ? resolution.source
    : "this piece of work's settings";
  if (resolution.value === "off") {
    try {
      const strict = memoryGuardPolicyDeclarations(projectDir, selection)
        .find((declaration) => declaration.value === "strict");
      if (strict !== undefined) {
        return { value: "on", source: `guard policy strict (from ${strict.layer}.md)`, lockedBy: strict.path };
      }
    } catch {
      // An unreadable memory policy never lowers anything: keep the plan stop.
      return { value: "on", source: "guard policy could not be read" };
    }
  }
  return { value: resolution.value, source };
}

/**
 * The environment plan approval resolves against. The machine switch counts
 * when the harness launched with it; a command that sets it for itself is read
 * as unset. A switch recorded in settings is read from its file by the
 * resolver, which names that file.
 */
export function planApprovalEnv(projectDir: string, sessionId: string | null): NodeJS.ProcessEnv {
  let session = sessionId;
  if (session === null) {
    try {
      session = resolveInvokingSessionId(projectDir);
    } catch {
      session = null;
    }
  }
  const name = CEREMONY_ENV.plan_approval;
  const env: NodeJS.ProcessEnv = { ...process.env };
  // A value other than 1 can only keep the stop, so it stands as given.
  if (env[name] === "1" && !planApprovalMachineSwitchTrusted(projectDir, session)) delete env[name];
  return env;
}

export function formatPlanApprovalSetting(setting: PlanApprovalSetting): string {
  // A memory lock reads the way the fences print it: `on (guard policy strict (from project.md))`.
  return setting.source.startsWith("guard policy")
    ? `${setting.value} (${setting.source})`
    : formatCeremony(setting.value, setting.source);
}

/** A check a team's strict Guard Policy keeps on, said with the file that holds it. */
export function fenceMemoryLockRefusal(declaration: GuardPolicyMemoryDeclaration, fence: string): string {
  const section = declaration.heading.replace(/^## /, "");
  return `Your team set Guard Policy to strict in ${declaration.path} (section: ${section}), ` +
    `so ${fence} stays on for everyone on this repo. Changing that line there changes it.`;
}

export function planApprovalMemoryLockRefusal(path: string): string {
  return `Your team set Guard Policy to strict in ${path}, so plan approval stays on for everyone on this ` +
    "repo. Changing that line there changes it.";
}

// --- Plan approval off, asked before the piece of work exists ----------------
//
// At the compose gate or the scope confirmation there is no state file for the
// person's words to change yet. The setter the agent runs for them
// (keepSettingsForNextWork) records it for this chat, and intent creation turns
// plan approval off, set by them, for the piece of work it creates next. Nothing
// else writes this record: a model tool cannot write the protected runtime
// directory, and a creation flag alone is refused.

interface PlanApprovalCreationGrant {
  version: 1;
  session: string;
  /**
   * The settings this record holds that were kept as a command's, not the
   * person's (settingTheirs found nothing on record behind them). Absent: all
   * theirs, as every record written before this field was.
   */
  notTheirs?: string[];
  /**
   * The new-work question the words answered. Said before any was open, it is
   * the first one this chat asks next (bound when creation reads the record).
   */
  request: string | null;
  recordedAt: string;
  /**
   * Typed together with the description of the new work: the words answer the
   * question that description becomes, whichever kind it is (the routing
   * question beside open work included), never an older one.
   */
  withDescription?: true;
}

// A reply belongs to the question asked in this sitting, not to one left open for days.
const OPEN_QUESTION_WINDOW_MS = 60 * 60 * 1000;

/**
 * Which of a piece of work's own per-check settings a whole Guard Policy word
 * takes back: off clears the checks kept on, strict the checks turned off, and
 * relaxed neither. A check the same command names keeps its own setting.
 */
export function perCheckSettingClearedBy(policy: string | null | undefined): "on" | "off" | null {
  return policy === "strict" ? "off" : policy === "off" ? "on" : null;
}

// Where a setting kept before any work is selected goes: the piece of work the
// chat starts next or, with work here to pick up, whichever it picks or starts.
const FOR_WORK_STARTED = "for the piece of work you start now";
const byYou = (theirs: boolean): string => (theirs ? " (set by you)" : "");
const FOR_WORK_PICKED_OR_STARTED = "for the work you pick up or start next";

/**
 * Whether the words behind `grant` are the ones `request` carries: the question
 * they answered, or any question derived from the same request, however many
 * asks the engine made on the way (the plan proposal step, the plan question it
 * builds, the same question brought back after a switch: one root, the words
 * the person typed). Binding to a request is what keeps a plan the person
 * rejected from leaving its switch on the work they describe instead. A
 * creation naming no request carries nobody's words.
 */
function grantCovers(
  projectDir: string,
  grant: PlanApprovalCreationGrant,
  request: string | null,
): boolean {
  if (request === null) return false;
  const answered = grant.request ??
    firstFrontQuestionSince(projectDir, grant.recordedAt, OPEN_QUESTION_WINDOW_MS, { routing: grant.withDescription === true });
  if (answered === null) return false;
  const rootOf = (id: string): string => readQuestion(projectDir, id)?.composedFrom ?? id;
  return answered === request || rootOf(request) === rootOf(answered);
}

function planApprovalCreationGrantPath(projectDir: string, sessionId: string): string {
  const segment = sessionId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
  return planApprovalRuntimeFile(projectDir, `plan-approval-off-at-creation-${segment}.json`);
}

export function grantPlanApprovalOffAtCreation(
  projectDir: string,
  sessionId: string,
  space: string | null,
  withDescription = false,
  forNext = FOR_WORK_STARTED,
  theirs = true,
): TypedGuardSwitchOutcome {
  try {
    const memoryStrict = memoryGuardPolicyDeclarations(projectDir, { ...(space === null ? {} : { space }), sessionId })
      .find((declaration) => declaration.value === "strict");
    if (memoryStrict !== undefined) {
      return { applied: false, lines: [planApprovalMemoryLockRefusal(memoryStrict.path)] };
    }
    recordPlanApprovalCreationGrant(projectDir, sessionId, withDescription, theirs);
  } catch (error) {
    return { applied: false, lines: [errorMessage(error)] };
  }
  return {
    applied: true,
    lines: [
      `Plan approval${settingPurpose("plan approval")} will be off ${forNext}${byYou(theirs)}. ` +
        "You can ask to see a plan before it is built any time.",
    ],
  };
}

export function recordPlanApprovalCreationGrant(
  projectDir: string,
  sessionId: string,
  withDescription = false,
  theirs = true,
): void {
  const grant: PlanApprovalCreationGrant = {
    version: 1,
    session: sessionId,
    ...(theirs ? {} : { notTheirs: ["plan-approval"] }),
    request: withDescription ? null : latestFrontQuestionId(projectDir, OPEN_QUESTION_WINDOW_MS),
    recordedAt: isoTimestamp(),
    ...(withDescription ? { withDescription: true as const } : {}),
  };
  writePlanApprovalRuntimeRecord(projectDir, planApprovalCreationGrantPath(projectDir, sessionId), `${JSON.stringify(grant)}\n`);
}

/**
 * Whether the person, in this chat, asked for plan approval off before this
 * work existed: for the request their words answered, or with none open then.
 */
export function planApprovalCreationGranted(
  projectDir: string,
  sessionId: string | null,
  request: string | null = null,
): boolean {
  if (!sessionId) return false;
  try {
    const grant = readPlanApprovalRuntimeRecord<PlanApprovalCreationGrant>(
      planApprovalCreationGrantPath(projectDir, sessionId),
      "plan approval creation grant",
    );
    if (grant?.version !== 1 || grant.session !== sessionId || request === null) return false;
    // Words said at a report-only or task-less composition's gate answer that
    // composition, so they reach the request its approval described, and no other.
    return grantCovers(projectDir, grant, request);
  } catch {
    return false;
  }
}

/** Spent by the next piece of work this chat creates, whether or not it was the one asked for. */
export function consumePlanApprovalCreationGrant(projectDir: string, sessionId: string | null): void {
  if (!sessionId) return;
  removePlanApprovalRuntimeRecord(planApprovalCreationGrantPath(projectDir, sessionId));
}

// Guard Policy relaxed or off, typed by the person with the new work or before
// any work exists, is theirs for the piece of work this chat creates next, the
// same way as plan approval off: their words, kept by the human-turn hook, and
// bound to the request they answered.
interface GuardPolicyCreationGrant extends PlanApprovalCreationGrant {
  value: "relaxed" | "off";
}

function guardPolicyCreationGrantPath(projectDir: string, sessionId: string): string {
  const segment = sessionId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
  return planApprovalRuntimeFile(projectDir, `guard-policy-at-creation-${segment}.json`);
}

export function grantGuardPolicyAtCreation(
  projectDir: string,
  sessionId: string,
  space: string | null,
  value: "relaxed" | "off",
  withDescription = false,
  forNext = FOR_WORK_STARTED,
  theirs = true,
): TypedGuardSwitchOutcome {
  try {
    const memoryStrict = memoryGuardPolicyDeclarations(projectDir, { ...(space === null ? {} : { space }), sessionId })
      .find((declaration) => declaration.value === "strict");
    if (memoryStrict !== undefined) return { applied: false, lines: [guardPolicyMemoryStrictRefusal(memoryStrict)] };
    const grant: GuardPolicyCreationGrant = {
      version: 1,
      session: sessionId,
      value,
      ...(theirs ? {} : { notTheirs: ["guard-policy"] }),
      request: withDescription ? null : latestFrontQuestionId(projectDir, OPEN_QUESTION_WINDOW_MS),
      recordedAt: isoTimestamp(),
      ...(withDescription ? { withDescription: true as const } : {}),
    };
    writePlanApprovalRuntimeRecord(projectDir, guardPolicyCreationGrantPath(projectDir, sessionId), `${JSON.stringify(grant)}\n`);
  } catch (error) {
    return { applied: false, lines: [errorMessage(error)] };
  }
  return {
    applied: true,
    // What the setting is for comes with its name: the person reading this may
    // never have met it, and the fence lines beside it say the same.
    lines: [withDescription
      ? `${guardPolicyNamed()} is ${value} for the work you are asking for${byYou(theirs)}.`
      : `${guardPolicyNamed()} is ${value} ${forNext}${byYou(theirs)}.`],
  };
}

/** The Guard Policy the person asked for in this chat before this work existed, for the request it answered. */
export function guardPolicyCreationGranted(
  projectDir: string,
  sessionId: string | null,
  request: string | null = null,
): "relaxed" | "off" | null {
  if (!sessionId || request === null || process.env.AIDLC_UNATTENDED === "1") return null;
  try {
    const grant = readPlanApprovalRuntimeRecord<GuardPolicyCreationGrant>(
      guardPolicyCreationGrantPath(projectDir, sessionId),
      "Guard Policy creation grant",
    );
    if (grant?.version !== 1 || grant.session !== sessionId || (grant.value !== "relaxed" && grant.value !== "off")) {
      return null;
    }
    return grantCovers(projectDir, grant, request) ? grant.value : null;
  } catch {
    return null;
  }
}

/** Spent by the next piece of work this chat creates, as plan approval off is. */
export function consumeGuardPolicyCreationGrant(projectDir: string, sessionId: string | null): void {
  if (!sessionId) return;
  removePlanApprovalRuntimeRecord(guardPolicyCreationGrantPath(projectDir, sessionId));
}

// Sensors, learnings and summary confirmation the person typed with the new
// work, or before any work existed: their words, kept by the human-turn hook,
// so the work this chat creates for that request says they set them.
const CREATION_CEREMONY_FLAGS = ["sensors", "learnings", "summary-confirmation"];

interface CeremoniesCreationGrant extends PlanApprovalCreationGrant {
  settings: Record<string, string>;
}

function ceremoniesCreationGrantPath(projectDir: string, sessionId: string): string {
  const segment = sessionId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
  return planApprovalRuntimeFile(projectDir, `ceremonies-at-creation-${segment}.json`);
}

function readCeremoniesCreationGrant(projectDir: string, sessionId: string): CeremoniesCreationGrant | null {
  const grant = readPlanApprovalRuntimeRecord<CeremoniesCreationGrant>(
    ceremoniesCreationGrantPath(projectDir, sessionId),
    "ceremony creation grant",
  );
  return grant?.version === 1 && grant.session === sessionId && typeof grant.settings === "object" && grant.settings !== null
    ? grant : null;
}

export function recordCeremoniesAtCreation(
  projectDir: string,
  sessionId: string,
  settings: Record<string, string>,
  withDescription: boolean,
  notTheirs: readonly string[] = [],
): void {
  try {
    // A later word on one setting replaces the earlier one; the others stay,
    // with whose each one is.
    let earlier: Record<string, string> = {};
    let earlierNotTheirs: string[] = [];
    try {
      const record = readCeremoniesCreationGrant(projectDir, sessionId);
      earlier = record?.settings ?? {};
      earlierNotTheirs = record?.notTheirs ?? [];
    } catch {
      // An unreadable earlier record is replaced by this one.
    }
    // A later whole-policy word takes back the checks typed before it that it
    // would clear on selected work (perCheckSettingClearedBy), as strict does in
    // the checks' own record (withdrawFencesOffAtCreation), so work picked later
    // never gets a check the person's later word took back.
    const cleared = perCheckSettingClearedBy(settings["guard-policy"]);
    if (cleared !== null) {
      for (const fence of SWITCHABLE_GUARD_FENCES) {
        const key = guardFenceConfigKey(fence);
        if (fence !== "plan-approval" && earlier[key] === cleared) delete earlier[key];
      }
    }
    const merged = { ...earlier, ...settings };
    const commandsOwn = [
      ...earlierNotTheirs.filter((key) => settings[key] === undefined),
      ...notTheirs.filter((key) => settings[key] !== undefined),
    ].filter((key) => merged[key] !== undefined);
    const grant: CeremoniesCreationGrant = {
      version: 1,
      session: sessionId,
      settings: merged,
      ...(commandsOwn.length > 0 ? { notTheirs: commandsOwn } : {}),
      request: withDescription ? null : latestFrontQuestionId(projectDir, OPEN_QUESTION_WINDOW_MS),
      recordedAt: isoTimestamp(),
      ...(withDescription ? { withDescription: true as const } : {}),
    };
    writePlanApprovalRuntimeRecord(projectDir, ceremoniesCreationGrantPath(projectDir, sessionId), `${JSON.stringify(grant)}\n`);
  } catch {
    // The label is the only thing at stake: a record that cannot be written leaves "set by a command".
  }
}

/** The ceremonies the person typed in this chat for the request it answered, by ceremony key. */
export function ceremoniesCreationGranted(
  projectDir: string,
  sessionId: string | null,
  request: string | null = null,
): Partial<Record<CeremonyKey, "on" | "off">> {
  if (!sessionId || request === null || process.env.AIDLC_UNATTENDED === "1") return {};
  try {
    const grant = readCeremoniesCreationGrant(projectDir, sessionId);
    if (grant === null) return {};
    if (!grantCovers(projectDir, grant, request)) return {};
    const out: Partial<Record<CeremonyKey, "on" | "off">> = {};
    for (const [flag, value] of Object.entries(grant.settings)) {
      const key = CEREMONY_KEYS.find((candidate) => CEREMONY_FLAGS[candidate] === `--${flag}`);
      if (key !== undefined && key !== "plan_approval" && (value === "on" || value === "off")) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** Spent by the next piece of work this chat creates, as Guard Policy is. */
export function consumeCeremoniesCreationGrant(projectDir: string, sessionId: string | null): void {
  if (!sessionId) return;
  removePlanApprovalRuntimeRecord(ceremoniesCreationGrantPath(projectDir, sessionId));
}

// A check (review freeze, state transition, reviewer read scope) turned off by
// the person with the new work or before any work exists is theirs for the
// piece of work this chat creates next, the same way as Guard Policy.
interface FencesOffCreationGrant extends PlanApprovalCreationGrant {
  fences: SwitchableGuardFence[];
}

function fencesOffCreationGrantPath(projectDir: string, sessionId: string): string {
  const segment = sessionId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
  return planApprovalRuntimeFile(projectDir, `fences-off-at-creation-${segment}.json`);
}

function readFencesOffCreationGrant(projectDir: string, sessionId: string): FencesOffCreationGrant | null {
  const grant = readPlanApprovalRuntimeRecord<FencesOffCreationGrant>(
    fencesOffCreationGrantPath(projectDir, sessionId),
    "check creation grant",
  );
  return grant?.version === 1 && grant.session === sessionId && Array.isArray(grant.fences) ? grant : null;
}

export function checksNamed(fences: readonly SwitchableGuardFence[]): string {
  if (fences.length === 1) return checkLabel(fences[0]);
  const names = fences.map((fence) => checkLabel(fence).replace(/ check$/, ""));
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} checks`;
}

export function checksAre(fences: readonly SwitchableGuardFence[]): string {
  // One check named says what it does for them; several would bury the sentence.
  const named = checksNamed(fences);
  const purpose = fences.length === 1 ? settingPurpose(named) : "";
  return `The ${named}${purpose} ${fences.length === 1 ? "is" : "are"}`;
}

export function grantFencesOffAtCreation(
  projectDir: string,
  sessionId: string,
  space: string | null,
  fences: readonly SwitchableGuardFence[],
  withDescription = false,
  forNext = FOR_WORK_STARTED,
  theirs = true,
): TypedGuardSwitchOutcome {
  try {
    const memoryStrict = memoryGuardPolicyDeclarations(projectDir, { ...(space === null ? {} : { space }), sessionId })
      .find((declaration) => declaration.value === "strict");
    if (memoryStrict !== undefined) return { applied: false, lines: [guardPolicyMemoryStrictRefusal(memoryStrict)] };
    // Each check said off before the work stays off with the next one said,
    // with whose each one is.
    let earlier: SwitchableGuardFence[] = [];
    let earlierNotTheirs: string[] = [];
    try {
      const record = readFencesOffCreationGrant(projectDir, sessionId);
      earlier = record?.fences ?? [];
      earlierNotTheirs = record?.notTheirs ?? [];
    } catch {
      // An unreadable earlier record is replaced by this one.
    }
    const named = fences.map((fence) => guardFenceConfigKey(fence));
    const commandsOwn = [
      ...earlierNotTheirs.filter((key) => !named.includes(key)),
      ...(theirs ? [] : named),
    ];
    const grant: FencesOffCreationGrant = {
      version: 1,
      session: sessionId,
      fences: SWITCHABLE_GUARD_FENCES.filter((fence) => earlier.includes(fence) || fences.includes(fence)),
      ...(commandsOwn.length > 0 ? { notTheirs: commandsOwn } : {}),
      request: withDescription ? null : latestFrontQuestionId(projectDir, OPEN_QUESTION_WINDOW_MS),
      recordedAt: isoTimestamp(),
      ...(withDescription ? { withDescription: true as const } : {}),
    };
    writePlanApprovalRuntimeRecord(projectDir, fencesOffCreationGrantPath(projectDir, sessionId), `${JSON.stringify(grant)}\n`);
  } catch (error) {
    return { applied: false, lines: [errorMessage(error)] };
  }
  return {
    applied: true,
    lines: [withDescription
      ? `${checksAre(fences)} off for the work you are asking for${byYou(theirs)}.`
      : `${checksAre(fences)} off ${forNext}${byYou(theirs)}.`],
  };
}

/** The checks the person turned off in this chat before this work existed, for the request it answered. */
export function fencesOffCreationGranted(
  projectDir: string,
  sessionId: string | null,
  request: string | null = null,
): SwitchableGuardFence[] {
  if (!sessionId || request === null || process.env.AIDLC_UNATTENDED === "1") return [];
  try {
    const grant = readFencesOffCreationGrant(projectDir, sessionId);
    if (grant === null) return [];
    return grantCovers(projectDir, grant, request)
      ? SWITCHABLE_GUARD_FENCES.filter((fence) => grant.fences.includes(fence)) : [];
  } catch {
    return [];
  }
}

/**
 * What this chat holds for the piece of work the person starts next: a check
 * off, a Guard Policy, a ceremony, or plan approval off. Null when it holds
 * nothing. Read without a request, so a step before any work exists can say
 * their words are kept rather than reporting that nothing is in progress.
 *
 * `request` is the question those words answered, when it is one this project
 * still has: the step can put that question back instead of asking the person
 * to describe the work they have already described, and the work that question
 * creates is the one their words were for. Null when the words were said with
 * no question open, or the question is gone (a compose entry among them reads as
 * gone here: re-offering one is a composer dispatch, not a question).
 */
export function switchKeptForNextWork(
  projectDir: string,
  sessionId: string | null,
): { request: string | null } | null {
  if (!sessionId || process.env.AIDLC_UNATTENDED === "1") return null;
  const fresh = (grant: PlanApprovalCreationGrant | null): boolean => {
    if (grant?.version !== 1 || grant.session !== sessionId) return false;
    const said = Date.parse(grant.recordedAt);
    return !Number.isNaN(said) && Date.now() - said <= OPEN_QUESTION_WINDOW_MS;
  };
  try {
    const held = [
      readFencesOffCreationGrant(projectDir, sessionId),
      readCeremoniesCreationGrant(projectDir, sessionId),
      readPlanApprovalRuntimeRecord<GuardPolicyCreationGrant>(
        guardPolicyCreationGrantPath(projectDir, sessionId),
        "Guard Policy creation grant",
      ),
      readPlanApprovalRuntimeRecord<PlanApprovalCreationGrant>(
        planApprovalCreationGrantPath(projectDir, sessionId),
        "plan approval creation grant",
      ),
    ].filter((grant): grant is PlanApprovalCreationGrant => fresh(grant));
    if (held.length === 0) return null;
    for (const grant of held) {
      const asked = grant.request;
      if (asked !== null && readQuestion(projectDir, asked) !== null) return { request: asked };
    }
    return { request: null };
  } catch {
    return null;
  }
}

/** Spent by the next piece of work this chat creates, as Guard Policy is. */
export function consumeFencesOffCreationGrant(projectDir: string, sessionId: string | null): void {
  if (!sessionId) return;
  removePlanApprovalRuntimeRecord(fencesOffCreationGrantPath(projectDir, sessionId));
}

export function withdrawFencesOffAtCreation(
  projectDir: string,
  sessionId: string,
  fences: readonly SwitchableGuardFence[],
): void {
  if (fences.length === 0) return;
  try {
    const grant = readFencesOffCreationGrant(projectDir, sessionId);
    if (grant === null) return;
    const kept = grant.fences.filter((fence) => !fences.includes(fence));
    if (kept.length === 0) consumeFencesOffCreationGrant(projectDir, sessionId);
    else {
      writePlanApprovalRuntimeRecord(
        projectDir,
        fencesOffCreationGrantPath(projectDir, sessionId),
        `${JSON.stringify({ ...grant, fences: kept })}\n`,
      );
    }
  } catch {
    // An unreadable record grants nothing at creation.
  }
}

// --- A setting typed before any work exists -----------------------------------
//
// The setter, run by the agent for a chat with no work selected, keeps what the
// person asked for in the records creation reads (the grant family above) and
// says it once; the agent says that line. Lowering a check is the person's call,
// and before any work exists their message in this chat is the proof, as it is
// for creation (handleIntentCreate in aidlc-utility.ts). An `on` withdraws an
// earlier off. Every setting kept lands in the ceremonies record as typed, so a
// later step can tell that the setter ran since the person's message; depth,
// test strategy and review are read back from it at creation when the command
// carries none (levelsKeptForNextWork).

const KEPT_LEVEL_KEYS = ["depth", "test-strategy", "review"] as const;
type KeptLevelKey = (typeof KEPT_LEVEL_KEYS)[number];

const KEPT_SETTING_LABELS: Record<string, string> = {
  depth: "Depth",
  "test-strategy": "Test strategy",
  review: "Review",
  sensors: "Sensors",
  learnings: "Learnings",
  "summary-confirmation": "Summary confirmation",
  collaborators: "Collaborators",
};

export function keepSettingsForNextWork(
  projectDir: string,
  sessionId: string,
  requested: IntentSettingsRequest,
  space: string | null,
  fail: (message: string) => never,
  // Work is here for the chat to pick up (workToPickUp): with no new-work
  // question open to bind it to, the setting goes to whichever work the chat
  // picks or starts next (keptForPickedWork), and its line says so.
  workToPick = false,
  // The person's words the agent says asked for this (--person-words).
  personWords?: string,
): string[] {
  const forNext = workToPick && latestFrontQuestionId(projectDir, OPEN_QUESTION_WINDOW_MS) === null
    ? FOR_WORK_PICKED_OR_STARTED
    : FOR_WORK_STARTED;
  const value = (key: string): string | undefined => requested[key as ConfigKey]?.value.trim().toLowerCase();
  // Kept as theirs only when a fact on record says so (settingTheirs), as on
  // open work; otherwise kept as the command's, and the line says nothing of them.
  const theirs = (key: string): boolean =>
    settingTheirs(projectDir, sessionId, key, value(key), personWords) !== null;
  const planApproval = value("plan-approval") ?? value("guard.plan-approval");
  const policy = value("guard-policy");
  const fences = SWITCHABLE_GUARD_FENCES.filter((fence) => fence !== "plan-approval");
  const fencesOff = fences.filter((fence) => value(guardFenceConfigKey(fence)) === "off");
  const fencesOn = fences.filter((fence) => value(guardFenceConfigKey(fence)) === "on");
  // The same words the setter would refuse on open work are refused here.
  const depth = value("depth");
  if (depth !== undefined && !Object.hasOwn(VALID_DEPTHS, depth)) {
    fail(`Unknown depth: "${depth}". Valid depths: minimal, standard, comprehensive.`);
  }
  const strategy = value("test-strategy");
  if (strategy !== undefined && !Object.hasOwn(VALID_TEST_STRATEGIES, strategy)) {
    fail(`Unknown test strategy: "${strategy}". Valid: minimal, standard, comprehensive.`);
  }
  parseReviewOverride(value("review"), fail);
  if (policy !== undefined && parseGuardPolicy(policy) === null) {
    fail(`Unknown Guard Policy value: "${policy}". Valid: ${GUARD_POLICY_VALUES.join(", ")}.`);
  }
  for (const key of [...CREATION_CEREMONY_FLAGS, "collaborators", "plan-approval"]) {
    const typed = key === "plan-approval" ? planApproval : value(key);
    if (typed !== undefined && parseCeremonySetting(typed) === null) fail(`--${key} requires <on|off>; received "${typed}".`);
  }
  for (const fence of fences) {
    const typed = value(guardFenceConfigKey(fence));
    if (typed !== undefined && parseCeremonySetting(typed) === null) {
      fail(`--${guardFenceConfigKey(fence)} requires <on|off>; received "${typed}".`);
    }
  }
  // Lowering a check is the person's call: their message in this chat stands
  // behind the setter the agent runs; an unattended driver never lowers one.
  const lowering: GuardSwitch[] = [];
  if (planApproval === "off") lowering.push({ key: "plan-approval", value: "off" });
  if (policy === "relaxed" || policy === "off") lowering.push({ key: "guard-policy", value: policy });
  if (value("summary-confirmation") === "off") lowering.push({ key: "summary-confirmation", value: "off" });
  for (const fence of fencesOff) lowering.push({ key: `guard.${fence}`, value: "off" });
  if (lowering.length > 0) {
    if (process.env.AIDLC_UNATTENDED === "1") fail(guardSwitchRefusal(lowering[0]));
    if (!commandAtPersonsTerminal() && !fenceKeyBypassed(projectDir, sessionId) && latestMessage(projectDir, sessionId) === null) {
      fail(guardSwitchRefusal(lowering[0], projectDir));
    }
  }
  const lines: string[] = [];
  const keep = (outcome: TypedGuardSwitchOutcome): void => {
    if (!outcome.applied) fail(outcome.lines.join(" "));
    lines.push(...outcome.lines);
  };
  const planApprovalKey = requested["plan-approval"] !== undefined ? "plan-approval" : "guard.plan-approval";
  if (planApproval === "off") {
    keep(grantPlanApprovalOffAtCreation(projectDir, sessionId, space, false, forNext, theirs(planApprovalKey)));
  } else if (planApproval === "on") {
    consumePlanApprovalCreationGrant(projectDir, sessionId);
    lines.push(`Plan approval will be on ${forNext}${byYou(theirs(planApprovalKey))}.`);
  }
  if (policy === "relaxed" || policy === "off") {
    keep(grantGuardPolicyAtCreation(projectDir, sessionId, space, policy, false, forNext, theirs("guard-policy")));
  } else if (policy === "strict") {
    consumeGuardPolicyCreationGrant(projectDir, sessionId);
    withdrawFencesOffAtCreation(projectDir, sessionId, SWITCHABLE_GUARD_FENCES);
    lines.push(`${guardPolicyNamed()} will be strict ${forNext}${byYou(theirs("guard-policy"))}.`);
  }
  if (fencesOff.length > 0) {
    const allTheirs = fencesOff.every((fence) => theirs(guardFenceConfigKey(fence)));
    keep(grantFencesOffAtCreation(projectDir, sessionId, space, fencesOff, false, forNext, allTheirs));
  }
  if (fencesOn.length > 0) {
    withdrawFencesOffAtCreation(projectDir, sessionId, fencesOn);
    lines.push(`${checksAre(fencesOn)} on ${forNext}${byYou(fencesOn.every((fence) => theirs(guardFenceConfigKey(fence))))}.`);
  }
  // Everything kept, as typed: the ceremonies and levels creation reads back,
  // and the rest as the mark that the setter ran since the person's message.
  const kept: Record<string, string> = {};
  for (const key of Object.keys(requested)) {
    const typed = value(key);
    if (typed === undefined) continue;
    // One name for one setting, read as the setter reads it: the other name
    // for plan approval counts when the line does not name plan-approval too.
    if (key === "guard.plan-approval") {
      if (requested["plan-approval"] === undefined) kept["plan-approval"] = typed;
    } else {
      kept[key] = typed;
    }
  }
  const keptNotTheirs = Object.keys(kept).filter((key) =>
    !theirs(key === "plan-approval" ? planApprovalKey : key));
  recordCeremoniesAtCreation(projectDir, sessionId, kept, false, keptNotTheirs);
  for (const key of [...CREATION_CEREMONY_FLAGS, "collaborators", ...KEPT_LEVEL_KEYS]) {
    const typed = kept[key];
    if (typed !== undefined) {
      lines.push(`${KEPT_SETTING_LABELS[key]} will be ${typed} ${forNext}${byYou(!keptNotTheirs.includes(key))}.`);
    }
  }
  return lines;
}

/** Depth, test strategy and review the person set in this chat before this work existed, for the request it answered. */
export function levelsKeptForNextWork(
  projectDir: string,
  sessionId: string | null,
  request: string | null = null,
): Partial<Record<KeptLevelKey, string>> {
  if (!sessionId || request === null || process.env.AIDLC_UNATTENDED === "1") return {};
  try {
    const grant = readCeremoniesCreationGrant(projectDir, sessionId);
    if (grant === null || !grantCovers(projectDir, grant, request)) return {};
    const out: Partial<Record<KeptLevelKey, string>> = {};
    for (const key of KEPT_LEVEL_KEYS) {
      const typed = grant.settings[key];
      if (typeof typed === "string") out[key] = typed;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * What this chat kept for the work it picks up or starts next, for work it
 * picks: everything its line typed (the ceremonies record holds it all), as
 * the person's, when it was typed with no new-work question open, in this
 * sitting, and the run is attended. Kept while a new-work question was open,
 * it is that work's; older than the sitting, it is gone, as at creation.
 */
export function keptForPickedWork(projectDir: string, sessionId: string | null): IntentSettingsRequest | null {
  if (!sessionId || process.env.AIDLC_UNATTENDED === "1") return null;
  try {
    const grant = readCeremoniesCreationGrant(projectDir, sessionId);
    if (grant === null || grant.request !== null || grant.withDescription === true) return null;
    const at = Date.parse(grant.recordedAt);
    if (Number.isNaN(at) || Date.now() - at > OPEN_QUESTION_WINDOW_MS) return null;
    const kept: IntentSettingsRequest = {};
    for (const [key, value] of Object.entries(grant.settings)) {
      if ((CONFIG_KEYS as readonly string[]).includes(key)) kept[key as ConfigKey] = { value, source: "you" };
    }
    return Object.keys(kept).length > 0 ? kept : null;
  } catch {
    return null;
  }
}

/**
 * The settings this chat kept for its next work that were kept as a command's,
 * not the person's (each record's notTheirs): creation and the picked work write
 * those as the command's. Setting keys as the setter names them.
 */
export function keptSettingsNotTheirs(projectDir: string, sessionId: string | null): Set<string> {
  const out = new Set<string>();
  if (!sessionId) return out;
  const records: Array<PlanApprovalCreationGrant | null> = [];
  for (const read of [
    () => readFencesOffCreationGrant(projectDir, sessionId),
    () => readCeremoniesCreationGrant(projectDir, sessionId),
    () => readPlanApprovalRuntimeRecord<GuardPolicyCreationGrant>(
      guardPolicyCreationGrantPath(projectDir, sessionId), "Guard Policy creation grant"),
    () => readPlanApprovalRuntimeRecord<PlanApprovalCreationGrant>(
      planApprovalCreationGrantPath(projectDir, sessionId), "plan approval creation grant"),
  ]) {
    try {
      records.push(read());
    } catch {
      // An unreadable record keeps nothing, so nothing of it is relabelled.
    }
  }
  for (const record of records) {
    if (record?.version !== 1 || record.session !== sessionId || !Array.isArray(record.notTheirs)) continue;
    for (const key of record.notTheirs) if (typeof key === "string") out.add(key);
  }
  if (out.has("plan-approval") || out.has("guard.plan-approval")) {
    out.add("plan-approval");
    out.add("guard.plan-approval");
  }
  return out;
}

/** Spent by the work the chat picks, as by the work it creates. */
export function consumeKeptSettings(projectDir: string, sessionId: string): void {
  consumePlanApprovalCreationGrant(projectDir, sessionId);
  consumeGuardPolicyCreationGrant(projectDir, sessionId);
  consumeFencesOffCreationGrant(projectDir, sessionId);
  consumeCeremoniesCreationGrant(projectDir, sessionId);
}

/** Whether the setter kept something for this chat's next work at or after `at`: it ran since that message. */
export function settingsKeptSince(projectDir: string, sessionId: string, at: string): boolean {
  const since = Date.parse(at);
  if (Number.isNaN(since)) return false;
  try {
    return [
      readFencesOffCreationGrant(projectDir, sessionId),
      readCeremoniesCreationGrant(projectDir, sessionId),
      readPlanApprovalRuntimeRecord<GuardPolicyCreationGrant>(
        guardPolicyCreationGrantPath(projectDir, sessionId),
        "Guard Policy creation grant",
      ),
      readPlanApprovalRuntimeRecord<PlanApprovalCreationGrant>(
        planApprovalCreationGrantPath(projectDir, sessionId),
        "plan approval creation grant",
      ),
    ].some((grant) => grant?.version === 1 && grant.session === sessionId && Date.parse(grant.recordedAt) >= since);
  } catch {
    return false;
  }
}
