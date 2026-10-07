import { existsSync, readFileSync } from "node:fs";
import { appendAuditEntries, type AuditEntryInput } from "./aidlc-audit.ts";
import { firstFrontQuestionSince, latestFrontQuestionId, readQuestion } from "./aidlc-question-store.ts";
import {
  guardPolicyAtLeast,
  latestPersonTurn,
  personSpokeSinceGate,
  assertChangeControlLedgerWritable,
  auditBlockField,
  auditFilePath,
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
  guardPolicyMemoryStrictRefusal,
  type GuardSwitch,
  guardSwitchRefusal,
  isKillSwitchSource,
  isoTimestamp,
  listIntentDirs,
  loadScopeMetadata,
  memoryGuardPolicyDeclarations,
  parseCeremonySetting,
  parseCeremonyStateLine,
  parseGuardPolicy,
  parseGuardsOffLine,
  parseGuardsOnLine,
  parseTypedGuardSwitchRequest,
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
  validScopes,
  withAuditLock,
  writePlanApprovalRuntimeRecord,
  writeStateFile,
  parseGuardPolicyStateLine,
  commandAtPersonsTerminal,
} from "./aidlc-lib.ts";
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

// Pure state transformation plus audit/output preparation. CLI setters and the
// human-turn hook call this under the intent lock and commit audit before state.
// The old value of the Guard Policy row the human-turn hook wrote for `value`
// as this turn's message arrived: it applies a typed `--guard-policy` before
// recording the turn, so the row sits just before the latest HUMAN_TURN. A
// setter run for the same value then says what changed, not that it was
// "already" so. A row after that turn is the agent's own earlier run.
function guardPolicyTypedThisTurn(projectDir: string, value: string, intent?: string, space?: string): string | null {
  let blocks: string[];
  try {
    blocks = readFileSync(auditFilePath(projectDir, intent, space), "utf-8").replace(/\r\n/g, "\n").split("\n---\n");
  } catch {
    return null;
  }
  let turns = 0;
  for (let index = blocks.length - 1; index >= 0; index--) {
    const event = auditBlockField(blocks[index], "Event");
    if (event === "HUMAN_TURN" && ++turns === 2) return null;
    if (event === "GUARD_POLICY_SET") {
      return turns === 1 && auditBlockField(blocks[index], "New Value") === value &&
          auditBlockField(blocks[index], "Source") === "you"
        ? auditBlockField(blocks[index], "Old Value")
        : null;
    }
  }
  return null;
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
    if (loweredFence !== undefined) {
      const section = cc.memoryStrict.heading.replace(/^## /, "");
      die(
        `Your team set Guard Policy to strict in ${cc.memoryStrict.path} (section: ${section}), ` +
          `so ${loweredFence.fence} stays on for everyone on this repo. Changing that line there changes it.`,
      );
    }
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
    const keepOff = changeControl === "strict" ? off.filter((fence) => namedFences.has(fence)) : off;
    const keepOn = changeControl === "off" ? on.filter((fence) => namedFences.has(fence)) : on;
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
    die(guardSwitchRefusal(lowering[0], "config"));
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
  const atTheirTerminal = lowering.length > 0 && !typedByPerson && commandAtPersonsTerminal();
  if (
    lowering.length > 0 && !typedByPerson && !atTheirTerminal && !fenceKeyBypassed(projectDir, sessionId) &&
    !personSpokeSinceGate(projectDir, { requests: true, outlivesApproval: true })
  ) {
    // A question about the switch ("skip plan approval?") asks for nothing.
    die(guardSwitchRefusal(lowering[0], "config", personSpokeSinceGate(projectDir), projectDir));
  }
  // The setter carries out what the person asked: their words go on the record.
  // A command they ran themselves, at their own terminal, is their own act and
  // belongs to no chat, so no message of theirs is quoted for it. Everything else
  // is the agent carrying out what they asked in the chat, and their words stand
  // behind it. Which session is RUNNING the command decides nothing: a chat records
  // its whole ancestor chain, so a terminal beside it resolves the same session
  // anyway, and the walk that resolves it fails closed under load, which would
  // drop the person's own words from their record for no reason they could see.
  const turn = lowering.length > 0 && !typedByPerson && !atTheirTerminal
    ? latestPersonTurn(projectDir)
    : null;
  const askedIn = turn?.words ?? null;
  // Asked for in the chat (not typed): each check it turns off is said in one
  // line, in their words, with the way back, instead of the setter's own line.
  const askedInChat = lowering.length > 0 && !typedByPerson &&
    personSpokeSinceGate(projectDir, { requests: true, outlivesApproval: true });
  // Theirs either way: asked for in their chat, or run by them at their terminal.
  // Both get the one line that names the check, where it applies and the way
  // back, and both record the person as the one who set it.
  const personsOwn = askedInChat || atTheirTerminal;
  const saidAsAsked = (key: string): boolean =>
    personsOwn && key !== "plan-approval" && lowering.some((item) => item.key === key);
  // A check the person asked in the chat to turn off is theirs, whoever runs the
  // setter: turning one off needs their turn, so it is on record behind it.
  const personAsked = (key: string): boolean =>
    typedByPerson || (personsOwn && lowering.some((item) => item.key === key));

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
    const display = update.storedReview === "" ? `${scopeReviewLevel(target)} (scope default)` : update.storedReview;
    lines.push(update.changed
      ? `Review override changed: ${update.oldReview || "none"} -> ${display}`
      : `Review override is already ${display}`);
  }
  // Persist scope-owned updates even while memory controls the effective value.
  // Explicit strict is also recordable; explicit relaxed was refused above.
  if (ccRequest !== undefined && changeControl !== null) {
    const previous = cc.rawStateValue;
    const line = formatGuardPolicy(changeControl, ccRequest.source);
    const alreadyLine = (): string => {
      const appliedFrom = guardPolicyTypedThisTurn(projectDir, changeControl, selection.intent, selection.space);
      if (appliedFrom === null) return `Guard Policy is already ${line}`;
      return appliedFrom === changeControl ? `Guard Policy is ${line}` : `Guard Policy changed: ${appliedFrom} to ${line}`;
    };
    if (previous === line && cc.stateField === GUARD_POLICY_FIELD && getField(content, CHANGE_CONTROL_FIELD) === null) {
      if (!scopeDefault("guard-policy")) lines.push(alreadyLine());
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
        lines.push(alreadyLine());
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
        ...(askedIn && value === "off" ? { "Person Reply": askedIn } : {}),
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

export function isTypedGuardSwitchPrompt(prompt: string): boolean {
  return parseTypedGuardSwitchRequest(prompt).switches.length > 0;
}

export function isTypedGuardSwitchQuestion(prompt: string): boolean {
  return parseTypedGuardSwitchRequest(prompt).asked === true;
}

export function applyTypedGuardSwitchPrompt(
  projectDir: string,
  sessionId: string,
  prompt: string,
  options: { wordsAnswer?: boolean } = {},
): TypedGuardSwitchOutcome | null {
  const outcome = applyReadTypedGuardSwitches(projectDir, sessionId, prompt, options);
  // A flag-shaped token this parser could not read never costs them the switches
  // it could: those are carried out and said as usual, and the part that was not
  // read is named after, once. AI-DLC is the one that could not read it, so that
  // part is a question of its own rather than an instruction to type anything.
  const unread = parseTypedGuardSwitchRequest(prompt, options).unread;
  if (outcome === null || unread === undefined) return outcome;
  // The lines reach the person as one sentence after another, so the one this
  // follows ends in a stop: a line that stands alone needs none, and read live
  // the two ran together ("... is already off I could not read ...").
  const said = outcome.lines.map((line, index) =>
    index === outcome.lines.length - 1 && !/[.?!]$/.test(line.trimEnd()) ? `${line.trimEnd()}.` : line
  );
  return {
    ...outcome,
    lines: [...said, `I could not read "${unread}". Was that a setting you wanted?`],
  };
}

function applyReadTypedGuardSwitches(
  projectDir: string,
  sessionId: string,
  prompt: string,
  options: { wordsAnswer?: boolean } = {},
): TypedGuardSwitchOutcome | null {
  const parsed = parseTypedGuardSwitchRequest(prompt, options);
  if (process.env.AIDLC_UNATTENDED === "1") return null;
  // Read as a switch, but not readable as a whole: the person hears why, rather
  // than having typed a switch that quietly does nothing.
  if (parsed.error !== null) return { applied: false, lines: [parsed.error] };
  // Plan approval back on, typed before the work exists, withdraws an earlier off.
  if (parsed.settings.some((setting) => setting.key === "plan-approval" && setting.value === "on")) {
    consumePlanApprovalCreationGrant(projectDir, sessionId);
  }
  // So does Guard Policy strict for an earlier relaxed or off: the latest word stands.
  // Strict also turns back on each check turned off before it, as it does on open work.
  if (parsed.settings.some((setting) => setting.key === "guard-policy" && setting.value === "strict")) {
    consumeGuardPolicyCreationGrant(projectDir, sessionId);
    withdrawFencesOffAtCreation(projectDir, sessionId, SWITCHABLE_GUARD_FENCES);
  }
  // A check turned back on withdraws an earlier off for the work not started yet.
  withdrawFencesOffAtCreation(projectDir, sessionId, SWITCHABLE_GUARD_FENCES.filter((fence) =>
    parsed.settings.some((setting) => setting.key === guardFenceConfigKey(fence) && setting.value === "on")));
  const forNewWork: TypedGuardSwitchOutcome[] = [];
  if (parsed.newWorkPlanApprovalOff === true && parsed.error === null) {
    forNewWork.push(grantPlanApprovalOffAtCreation(projectDir, sessionId, parsed.space, true));
  }
  if (parsed.newWorkGuardPolicy !== undefined && parsed.error === null) {
    forNewWork.push(grantGuardPolicyAtCreation(projectDir, sessionId, parsed.space, parsed.newWorkGuardPolicy, true));
  }
  if (parsed.newWorkFencesOff !== undefined && parsed.error === null) {
    forNewWork.push(grantFencesOffAtCreation(projectDir, sessionId, parsed.space, parsed.newWorkFencesOff, true));
  }
  // Sensors, learnings or summary confirmation typed with the new work, or
  // before any work exists, are the person's: the work this chat creates next
  // says they were set by them.
  if (parsed.error === null) {
    if (parsed.newWorkCeremonies !== undefined) {
      recordCeremoniesAtCreation(projectDir, sessionId, parsed.newWorkCeremonies, true);
    } else if (parsed.words === undefined) {
      const typed = Object.fromEntries(parsed.settings
        .filter((setting) => CREATION_CEREMONY_FLAGS.includes(setting.key) && (setting.value === "on" || setting.value === "off"))
        .map((setting) => [setting.key, setting.value as "on" | "off"]));
      if (Object.keys(typed).length > 0 && noWorkSelected(projectDir, sessionId, parsed)) {
        recordCeremoniesAtCreation(projectDir, sessionId, typed, false);
      }
    }
  }
  if (forNewWork.length > 0 && parsed.switches.length === 0) {
    return { applied: forNewWork.every((outcome) => outcome.applied), lines: forNewWork.flatMap((outcome) => outcome.lines) };
  }
  // A raise typed with the answer to the open code plan question is for this
  // work too ("/aidlc --guard-policy strict Approve Plan").
  if (parsed.switches.length === 0 && !(options.wordsAnswer === true && parsed.settings.length > 0)) return null;
  if (parsed.error !== null) return { applied: false, lines: [parsed.error] };
  if (parsed.scope !== null && !validScopes().has(parsed.scope)) {
    return { applied: false, lines: [`Unknown scope "${parsed.scope}".`] };
  }
  try {
    const selection = resolveWorkflowSelection(projectDir, {
      sessionId,
      ...(parsed.space === null ? {} : { space: parsed.space }),
      ...(parsed.intent === null ? {} : { intent: parsed.intent }),
    });
    const intent = selection.intent ?? undefined;
    const space = selection.space;
    if (parsed.intent !== null && !listIntentDirs(projectDir, space).includes(parsed.intent)) {
      return { applied: false, lines: [`${parsed.intent} is not a piece of work in space ${space}.`] };
    }
    // Summary confirmation is a creation flag too, so on first use the new
    // piece of work records it; only the guard switches wait for a state file.
    const guardSwitches = parsed.switches.filter((wanted) =>
      wanted.key !== "summary-confirmation" && wanted.key !== "plan-approval");
    if (selection.intent === null || !existsSync(stateFilePath(projectDir, intent, space))) {
      // Asked before the piece of work exists (the compose gate, the scope
      // confirmation): the work this chat creates next starts with them.
      const outcomes: TypedGuardSwitchOutcome[] = [];
      if (parsed.switches.some((wanted) => wanted.key === "plan-approval")) {
        outcomes.push(grantPlanApprovalOffAtCreation(projectDir, sessionId, space));
      }
      const policy = guardSwitches.find((wanted) => wanted.key === "guard-policy");
      if (policy !== undefined) outcomes.push(grantGuardPolicyAtCreation(projectDir, sessionId, space, policy.value));
      const fences = SWITCHABLE_GUARD_FENCES.filter((fence) =>
        guardSwitches.some((wanted) => wanted.key === guardFenceConfigKey(fence)));
      if (fences.length > 0) outcomes.push(grantFencesOffAtCreation(projectDir, sessionId, space, fences));
      if (outcomes.length === 0) return null;
      return {
        applied: outcomes.every((outcome) => outcome.applied),
        lines: [...new Set(outcomes.flatMap((outcome) => outcome.lines))],
      };
    }
    const requested: IntentSettingsRequest = {};
    for (const setting of parsed.settings) {
      requested[setting.key as ConfigKey] = { value: setting.value, source: "you" };
    }
    return withAuditLock(projectDir, (): TypedGuardSwitchOutcome => {
      const content = readStateFile(projectDir, intent, space);
      const memoryStrict = guardSwitches.length === 0 ? undefined
        : memoryGuardPolicyDeclarations(projectDir, { intent, space, sessionId })
          .find((declaration) => declaration.value === "strict");
      if (memoryStrict !== undefined) {
        return { applied: false, lines: [guardPolicyMemoryStrictRefusal(memoryStrict)] };
      }
      // The parser supplies only valid lowering values. Memory is checked before
      // the shared setter so its CLI-only refusal cannot terminate this hook.
      const update = applyIntentSettings(projectDir, content, requested, {
        intent, space, sessionId, typedByPerson: true,
      });
      if (update.content !== content) {
        if (update.audit.some((entry) => entry.eventType === "GUARD_POLICY_SET")) assertChangeControlLedgerWritable();
        if (update.audit.length > 0) appendAuditEntries(update.audit, projectDir, intent, space);
        writeStateFile(projectDir, setField(update.content, "Last Updated", isoTimestamp()), intent, space);
      }
      return { applied: true, lines: update.lines };
    }, intent, space);
  } catch (error) {
    return { applied: false, lines: [errorMessage(error)] };
  }
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

export function planApprovalMemoryLockRefusal(path: string): string {
  return `Your team set Guard Policy to strict in ${path}, so plan approval stays on for everyone on this ` +
    "repo. Changing that line there changes it.";
}

// --- Plan approval off, asked before the piece of work exists ----------------
//
// At the compose gate or the scope confirmation there is no state file for the
// person's words to change yet. The human-turn hook records them for this chat,
// and intent creation turns plan approval off, set by them, for the piece of
// work it creates next. Nothing else writes this record: a model tool cannot
// write the protected runtime directory, and a creation flag alone is refused.

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
 * Whether the words behind `grant` are the ones `request` carries: the question
 * they answered, or the request that question was derived from, however many
 * asks the engine made on the way. Binding to a request is what keeps a plan the
 * person rejected from leaving its switch on the work they describe instead. A
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
  return answered !== null &&
    (answered === request || readQuestion(projectDir, request)?.composedFrom === answered);
}

function planApprovalCreationGrantPath(projectDir: string, sessionId: string): string {
  const segment = sessionId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
  return planApprovalRuntimeFile(projectDir, `plan-approval-off-at-creation-${segment}.json`);
}

function grantPlanApprovalOffAtCreation(
  projectDir: string,
  sessionId: string,
  space: string | null,
  withDescription = false,
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
      `Plan approval${settingPurpose("plan approval")} will be off for the piece of work you start now ` +
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

function grantGuardPolicyAtCreation(
  projectDir: string,
  sessionId: string,
  space: string | null,
  value: "relaxed" | "off",
  withDescription = false,
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
      : `${guardPolicyNamed()} is ${value} for the piece of work you start now (set by you).`],
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
  settings: Record<string, "on" | "off">;
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

// No piece of work is selected for this chat, or it has no state yet.
function noWorkSelected(
  projectDir: string,
  sessionId: string,
  parsed: { space: string | null; intent: string | null },
): boolean {
  try {
    const selection = resolveWorkflowSelection(projectDir, {
      sessionId,
      ...(parsed.space === null ? {} : { space: parsed.space }),
      ...(parsed.intent === null ? {} : { intent: parsed.intent }),
    });
    return selection.intent === null || !existsSync(stateFilePath(projectDir, selection.intent, selection.space));
  } catch {
    return false;
  }
}

function recordCeremoniesAtCreation(
  projectDir: string,
  sessionId: string,
  settings: Record<string, "on" | "off">,
  withDescription: boolean,
): void {
  try {
    // A later word on one setting replaces the earlier one; the others stay.
    let earlier: Record<string, "on" | "off"> = {};
    try {
      earlier = readCeremoniesCreationGrant(projectDir, sessionId)?.settings ?? {};
    } catch {
      // An unreadable earlier record is replaced by this one.
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

function grantFencesOffAtCreation(
  projectDir: string,
  sessionId: string,
  space: string | null,
  fences: readonly SwitchableGuardFence[],
  withDescription = false,
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
      : `${checksAre(fences)} off for the piece of work you start now (set by you).`],
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

function withdrawFencesOffAtCreation(
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
