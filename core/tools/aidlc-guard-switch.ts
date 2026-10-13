import { existsSync } from "node:fs";
import type { AuditEntryInput } from "./aidlc-audit.ts";
import { firstFrontQuestionSince, latestFrontQuestionId, readQuestion } from "./aidlc-question-store.ts";
import {
  guardPolicyAtLeast,
  latestPersonTurn,
  isReplyTurn,
  personSpokeSinceGate,
  readAuditShardEvents,
  type AuditShardEvent,
  auditBlockField,
  CEREMONY_ENV,
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
import { latestMessage } from "./aidlc-message-store.ts";
import { quoted } from "./aidlc-recorded-switches.ts";
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

// The per-run fence switches read as config keys: `guard.plan-approval` and so on.
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

// Pure state transformation plus audit/output preparation. CLI setters call this
// under the intent lock and commit audit before state.
// The person's latest turn is a reply (words of theirs, not a typed switch or a
// command to AIDLC, which the hook carries out itself) and came after this setting
// last changed. Their words stand behind a setter run that follows them, not
// behind the setter's own later reversal (the way back after an off they asked
// for), which no turn of theirs asked for. Rows in one shard order by position;
// across shards by second, and an equal second is not read as after.
function personTurnSinceSetting(projectDir: string, key: CeremonyKey, selection: { intent?: string; space?: string }): boolean {
  let rows: AuditShardEvent[];
  try {
    rows = readAuditShardEvents(projectDir, selection.intent, selection.space);
  } catch {
    return false;
  }
  const after = (row: AuditShardEvent, other: AuditShardEvent): boolean =>
    row.timestamp > other.timestamp ||
    (row.timestamp === other.timestamp && row.shardIndex === other.shardIndex && row.pos > other.pos);
  const latest = (pick: (row: AuditShardEvent) => boolean): AuditShardEvent | null =>
    rows.filter(pick).reduce<AuditShardEvent | null>((last, row) => (last === null || after(row, last) ? row : last), null);
  const turn = latest((row) => row.event === "HUMAN_TURN");
  if (turn === null || !isReplyTurn(turn)) return false;
  const setting = latest((row) => row.event === "CEREMONY_SET" && auditBlockField(row.block, "Key") === key);
  return setting === null || after(turn, setting);
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

export function applyIntentSettings(
  projectDir: string,
  content: string,
  requested: IntentSettingsRequest,
  { sessionId = null, typedByPerson = false, fail: die = throwSettingsError, reviewScope, ...selection }: {
    intent?: string; space?: string; sessionId?: string | null; typedByPerson?: boolean;
    fail?: (message: string) => never;
    /** The scope a review level is compared with; defaults to the state's own. */
    reviewScope?: string;
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
  // with pipes and no chat identity on it, and is refused exactly as before, and
  // so is one run in a terminal a host opened for its agent (Copilot in VS Code,
  // Kiro IDE, Cursor), where the line says which chat to ask in.
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
  // The setter carries out what the person asked: their words go on the record.
  // A command they ran themselves, at their own terminal, is their own act and
  // belongs to no chat, so no message of theirs is quoted for it. Everything else
  // is the agent carrying out what they asked in the chat, and their words stand
  // behind it. Which session is RUNNING the command decides nothing: a chat records
  // its whole ancestor chain, so a terminal beside it resolves the same session
  // anyway, and the walk that resolves it fails closed under load, which would
  // drop the person's own words from their record for no reason they could see.
  const turn = personsRequest && !typedByPerson && !atTheirTerminal
    ? latestPersonTurn(projectDir)
    : null;
  const askedIn = turn?.words ?? null;
  // Asked for in the chat (not typed): each check it turns off is said in one
  // line, in their words, with the way back, instead of the setter's own line.
  const askedInChat = personsRequest && !typedByPerson && process.env.AIDLC_UNATTENDED !== "1" &&
    personSpokeSinceGate(projectDir, { requests: true, outlivesApproval: true });
  // Theirs either way: asked for in their chat, or run by them at their terminal.
  // Both get the one line that names the check, where it applies and the way
  // back, and both record the person as the one who set it.
  const personsOwn = askedInChat || atTheirTerminal;
  const saidAsAsked = (key: string): boolean =>
    personsOwn && key !== "plan-approval" && lowering.some((item) => item.key === key);
  // A check the person asked in the chat to turn off is theirs, whoever runs the
  // setter: turning one off needs their turn, so it is on record behind it. Any
  // other setting requested as theirs is theirs at their own terminal, or when
  // their latest turn stands behind the setter run, newer than the setting's own
  // last row (so the way back the agent runs after an off they asked for is the
  // command's, not theirs).
  // A setting the person typed as a flag on their own line in this chat is
  // theirs, whoever runs the setter: the hook recorded the line whole and the
  // engine's own parse of it is on the record (aidlc-message-store.ts), the
  // same proof creation reads. Their settings-only line is a command turn, so
  // the words rule below never sees it, and the work would otherwise say a
  // command set what they typed with their own hands.
  const typedOnTheirLine = (key: string, value: string | undefined): boolean => {
    if (value === undefined) return false;
    const message = latestMessage(projectDir, sessionId);
    if (message === null) return false;
    return message.settings.some((setting) => setting.key === key && setting.value === value) ||
      setterCommandNames(message.text, key, value);
  };
  const personAsked = (key: string): boolean => {
    if (typedByPerson) return true;
    if (lowering.some((item) => item.key === key)) return personsOwn;
    const ceremony = theirCeremonies.find((candidate) => CEREMONY_FLAGS[candidate].slice(2) === key);
    if (ceremony === undefined) return false;
    return atTheirTerminal || typedOnTheirLine(key, ceremonies[ceremony]) ||
      (askedInChat && personTurnSinceSetting(projectDir, ceremony, selection));
  };

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
    // force was the scope's own (a first "none" printed "none -> none" in two
    // live runs; three more printed "Review override changed: advisory (scope
    // default) -> none" to the person as it stood). An empty stored override is
    // the scope's own level again.
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
    const line = formatGuardPolicy(changeControl, ccRequest.source);
    if (previous === line && cc.stateField === GUARD_POLICY_FIELD && getField(content, CHANGE_CONTROL_FIELD) === null) {
      if (!scopeDefault("guard-policy")) lines.push(`Guard Policy is already ${line}`);
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
              "Old Value": oldValue, "New Value": changeControl, Source: ccRequest.source,
              ...(askedIn && lowering.some((item) => item.key === "guard-policy") ? { "Person Reply": askedIn } : {}),
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
        const fenceFields = {
          Guard: fence, Scope: getField(content, "Scope") ?? "", Source: ccRequest.source,
          ...(askedIn && after[fence].value === "off" ? { "Person Reply": askedIn } : {}),
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
      let updated = content;
      if (nextOff.length !== lowered.length) updated = setGuardsOffLine(updated, nextOff);
      if (nextOn.length !== raised.length) updated = setGuardsOnLine(updated, nextOn);
      const after = resolveFences(policy, updated)[request.fence];
      if (before.value === after.value) {
        // The plan this work runs already leaves the check where the person
        // asked for it. An off they set themselves is still recorded as theirs,
        // so the work says whose decision it was (status reads "(set by you)"
        // instead of crediting the plan, and the audit carries the row) rather
        // than leaving their own switch with nothing behind it. A later Guard
        // Policy word still clears per-check entries, as it always has, and
        // nothing the person reads here changes.
        if (typedByPerson && request.value === "off" && updated !== content) {
          content = updated;
          audit.push({
            eventType: "GUARD_DISABLED",
            fields: {
              Guard: request.fence, Scope: scopeName, Source: request.source,
              ...(askedIn ? { "Person Reply": askedIn } : {}),
            },
          });
        }
        lines.push(`The ${checkLabel(request.fence)} is already ${after.value}`);
        continue;
      }
      content = updated;
      // Each event named literally at its own call, not through a ternary on
      // eventType: the emitter drift guard reads these call sites as text, and a
      // computed event name is invisible to it.
      const fenceFields = {
        Guard: request.fence, Scope: scopeName, Source: request.source,
        ...(askedIn && after.value === "off" ? { "Person Reply": askedIn } : {}),
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
    const source = requestedSource === "you" && !personAsked(flag) ? "command" : requestedSource;
    const field = CEREMONY_FIELDS[key];
    const previous = getField(content, field);
    const line = formatCeremony(value, source);
    if (previous === line || (source === "command" && previous === formatCeremony(value, "you"))) {
      if (!scopeDefault(flag)) lines.push(`${field} is already ${previous}`);
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
    const oldDisplay = resolution.intent === null && resolution.rawStateValue !== null
      ? resolution.rawStateValue : formatCeremony(resolution.value, resolution.source);
    if (!saidAsAsked(flag)) lines.push(`${field} changed: ${oldDisplay} to ${line}`);
    if (key === "plan_approval") {
      lines.push(value === "off"
        ? "Each code plan is now built without asking you first. You can ask to see one before it is built any time."
        : "Each code plan is now shown for approval before it is built.");
    }
  }
  for (const item of lowering) {
    if (saidAsAsked(item.key)) lines.push(askedSwitchLine(item, askedIn, cc.value, !atTheirTerminal));
  }
  return { content, audit, lines };
}

/**
 * Guard Policy as the person reads it, with what it does for them. One owner, so
 * the setting reads the same wherever it is said (here and the routed note in
 * `aidlc-orchestrate.ts`).
 */
export function guardPolicyNamed(): string {
  return `Guard Policy${settingPurpose("Guard Policy")}`;
}

// A check as the person knows it: "review freeze check", "reviewer read scope check".
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
): TypedGuardSwitchOutcome {
  try {
    const memoryStrict = memoryGuardPolicyDeclarations(projectDir, { ...(space === null ? {} : { space }), sessionId })
      .find((declaration) => declaration.value === "strict");
    if (memoryStrict !== undefined) {
      return { applied: false, lines: [planApprovalMemoryLockRefusal(memoryStrict.path)] };
    }
    recordPlanApprovalCreationGrant(projectDir, sessionId, withDescription);
  } catch (error) {
    return { applied: false, lines: [errorMessage(error)] };
  }
  return {
    applied: true,
    lines: [
      `Plan approval${settingPurpose("plan approval")} will be off ${forNext} ` +
        "(set by you). You can ask to see a plan before it is built any time.",
    ],
  };
}

export function recordPlanApprovalCreationGrant(projectDir: string, sessionId: string, withDescription = false): void {
  const grant: PlanApprovalCreationGrant = {
    version: 1,
    session: sessionId,
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

/** The recorded words still apply: no memory lock and no unattended driver since. */
export function planApprovalOffAtCreation(
  projectDir: string,
  sessionId: string | null,
  request: string | null = null,
): boolean {
  if (process.env.AIDLC_UNATTENDED === "1" || !planApprovalCreationGranted(projectDir, sessionId, request)) return false;
  try {
    return !memoryGuardPolicyDeclarations(projectDir, { sessionId: sessionId ?? undefined })
      .some((declaration) => declaration.value === "strict");
  } catch {
    return false;
  }
}

/** For the creation preview: the words apply to the request open now, or to any when none was. */
export function planApprovalOffForOpenRequest(projectDir: string, sessionId: string | null): boolean {
  return planApprovalOffAtCreation(projectDir, sessionId, latestFrontQuestionId(projectDir, OPEN_QUESTION_WINDOW_MS));
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
): TypedGuardSwitchOutcome {
  try {
    const memoryStrict = memoryGuardPolicyDeclarations(projectDir, { ...(space === null ? {} : { space }), sessionId })
      .find((declaration) => declaration.value === "strict");
    if (memoryStrict !== undefined) return { applied: false, lines: [guardPolicyMemoryStrictRefusal(memoryStrict)] };
    const grant: GuardPolicyCreationGrant = {
      version: 1,
      session: sessionId,
      value,
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
      ? `${guardPolicyNamed()} is ${value} for the work you are asking for (set by you).`
      : `${guardPolicyNamed()} is ${value} ${forNext} (set by you).`],
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
): void {
  try {
    // A later word on one setting replaces the earlier one; the others stay.
    let earlier: Record<string, string> = {};
    try {
      earlier = readCeremoniesCreationGrant(projectDir, sessionId)?.settings ?? {};
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
    const grant: CeremoniesCreationGrant = {
      version: 1,
      session: sessionId,
      settings: { ...earlier, ...settings },
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

// "review freeze check", "review freeze and state transition checks".
export function checksNamed(fences: readonly SwitchableGuardFence[]): string {
  if (fences.length === 1) return checkLabel(fences[0]);
  const names = fences.map((fence) => checkLabel(fence).replace(/ check$/, ""));
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} checks`;
}

// "The review freeze check is", "The review freeze and state transition checks are".
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
): TypedGuardSwitchOutcome {
  try {
    const memoryStrict = memoryGuardPolicyDeclarations(projectDir, { ...(space === null ? {} : { space }), sessionId })
      .find((declaration) => declaration.value === "strict");
    if (memoryStrict !== undefined) return { applied: false, lines: [guardPolicyMemoryStrictRefusal(memoryStrict)] };
    // Each check said off before the work stays off with the next one said.
    let earlier: SwitchableGuardFence[] = [];
    try {
      earlier = readFencesOffCreationGrant(projectDir, sessionId)?.fences ?? [];
    } catch {
      // An unreadable earlier record is replaced by this one.
    }
    const grant: FencesOffCreationGrant = {
      version: 1,
      session: sessionId,
      fences: SWITCHABLE_GUARD_FENCES.filter((fence) => earlier.includes(fence) || fences.includes(fence)),
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
      ? `${checksAre(fences)} off for the work you are asking for (set by you).`
      : `${checksAre(fences)} off ${forNext} (set by you).`],
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
): string[] {
  const forNext = workToPick && latestFrontQuestionId(projectDir, OPEN_QUESTION_WINDOW_MS) === null
    ? FOR_WORK_PICKED_OR_STARTED
    : FOR_WORK_STARTED;
  const value = (key: string): string | undefined => requested[key as ConfigKey]?.value.trim().toLowerCase();
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
  if (planApproval === "off") {
    keep(grantPlanApprovalOffAtCreation(projectDir, sessionId, space, false, forNext));
  } else if (planApproval === "on") {
    consumePlanApprovalCreationGrant(projectDir, sessionId);
    lines.push(`Plan approval will be on ${forNext} (set by you).`);
  }
  if (policy === "relaxed" || policy === "off") {
    keep(grantGuardPolicyAtCreation(projectDir, sessionId, space, policy, false, forNext));
  } else if (policy === "strict") {
    consumeGuardPolicyCreationGrant(projectDir, sessionId);
    withdrawFencesOffAtCreation(projectDir, sessionId, SWITCHABLE_GUARD_FENCES);
    lines.push(`${guardPolicyNamed()} will be strict ${forNext} (set by you).`);
  }
  if (fencesOff.length > 0) keep(grantFencesOffAtCreation(projectDir, sessionId, space, fencesOff, false, forNext));
  if (fencesOn.length > 0) {
    withdrawFencesOffAtCreation(projectDir, sessionId, fencesOn);
    lines.push(`${checksAre(fencesOn)} on ${forNext} (set by you).`);
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
  recordCeremoniesAtCreation(projectDir, sessionId, kept, false);
  for (const key of [...CREATION_CEREMONY_FLAGS, "collaborators", ...KEPT_LEVEL_KEYS]) {
    const typed = kept[key];
    if (typed !== undefined) {
      lines.push(`${KEPT_SETTING_LABELS[key]} will be ${typed} ${forNext} (set by you).`);
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
