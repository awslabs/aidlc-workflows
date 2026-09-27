import { existsSync } from "node:fs";
import { appendAuditEntries, type AuditEntryInput } from "./aidlc-audit.ts";
import {
  assertChangeControlLedgerWritable,
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
  isoTimestamp,
  listIntentDirs,
  memoryGuardPolicyDeclarations,
  parseCeremonySetting,
  parseGuardPolicy,
  parseGuardsOffLine,
  parseGuardsOnLine,
  parseTypedGuardSwitchRequest,
  readStateFile,
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
  writeStateFile,
  parseGuardPolicyStateLine,
} from "./aidlc-lib.ts";

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

export function storedReviewOverride(value: ReviewOverride): string {
  // "adversarial" means no per-run ceiling; stage declarations and scope caps
  // still apply, so represent it with the same empty field as config-change.
  return value === "adversarial" ? "" : value;
}

export function applyReviewOverride(
  content: string,
  value: ReviewOverride | undefined,
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
  const storedReview = storedReviewOverride(value);
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
export function applyIntentSettings(
  projectDir: string,
  content: string,
  requested: IntentSettingsRequest,
  { sessionId = null, typedByPerson = false, fail: die = throwSettingsError, ...selection }: {
    intent?: string; space?: string; sessionId?: string | null; typedByPerson?: boolean;
    fail?: (message: string) => never;
  },
): { content: string; audit: AuditEntryInput[]; lines: string[] } {
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
  if (typedByPerson && cc.memoryStrict !== null) {
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
        `Guard Policy is set to strict in ${cc.memoryStrict.path} (section: ${section}), ` +
          `so ${loweredFence.fence} cannot be turned off from chat. Edit that line to change it for everyone on this repo.`,
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
  if (ccRequest?.source === "you" && (changeControl === "relaxed" || changeControl === "off") &&
    (cc.rawStateValue !== formatGuardPolicy(changeControl, ccRequest.source) || cc.conflict !== undefined)) {
    lowering.push({ key: "guard-policy", value: changeControl });
  }
  // An unattended driver never lowers fences, including a recorded presence bypass.
  if (lowering.length > 0 && process.env.AIDLC_UNATTENDED === "1") {
    die(guardSwitchRefusal(lowering[0], "config"));
  }
  if (lowering.length > 0 && !typedByPerson && !fenceKeyBypassed(projectDir, sessionId)) {
    die(guardSwitchRefusal(lowering[0], "config"));
  }

  const audit: AuditEntryInput[] = [];
  const lines: string[] = [];
  if (depth !== undefined) {
    const previous = getField(content, "Depth");
    const updated = previous === depth ? content : setField(content, "Depth", depth);
    const changed = updated !== content;
    if (changed) {
      content = updated;
      audit.push({ eventType: "DEPTH_CHANGED", fields: { "Old Depth": previous || "unknown", "New Depth": depth } });
    }
    lines.push(changed ? `Depth changed: ${previous} -> ${depth}` : `Depth is already ${depth}`);
  }
  if (strategy !== undefined) {
    const previous = getField(content, "Test Strategy");
    const updated = previous === strategy ? content : setField(content, "Test Strategy", strategy);
    const changed = updated !== content;
    if (changed) {
      content = updated;
      audit.push({ eventType: "TEST_STRATEGY_CHANGED", fields: { "Old Strategy": previous || "unknown", "New Strategy": strategy } });
    }
    lines.push(changed ? `Test strategy changed: ${previous} -> ${strategy}` : `Test strategy is already ${strategy}`);
  }
  if (review !== undefined) {
    const update = applyReviewOverride(content, review);
    content = update.content;
    if (update.changed) {
      audit.push({
        eventType: "REVIEW_CLASS_CHANGED",
        fields: {
          "Old Override": update.oldReview || "none set",
          "New Override": update.storedReview || "cleared (stage defaults apply)",
        },
      });
    }
    const display = update.storedReview === "" ? "adversarial (stage defaults)" : update.storedReview;
    lines.push(update.changed
      ? `Review override changed: ${update.oldReview || "none"} -> ${display}`
      : `Review override is already ${display}`);
  }
  // Persist scope-owned updates even while memory controls the effective value.
  // Explicit strict is also recordable; explicit relaxed was refused above.
  if (ccRequest !== undefined && changeControl !== null) {
    const previous = cc.rawStateValue;
    const line = formatGuardPolicy(changeControl, ccRequest.source);
    if (previous === line && cc.stateField === GUARD_POLICY_FIELD && getField(content, CHANGE_CONTROL_FIELD) === null) {
      lines.push(`Guard Policy is already ${line}`);
    } else {
      // Every write keeps only the Guard Policy line, even when its stored text is unchanged.
      // Resolving a conflict records one GUARD_POLICY_SET from the prior effective policy, not a name-only rename.
      content = setGuardPolicyLine(content, line);
      if (previous !== line || cc.conflict !== undefined) {
        const oldValue = cc.conflict !== undefined ? cc.value : cc.intent?.value ?? cc.rawStateValue ?? cc.stateValue;
        audit.push({
          eventType: "GUARD_POLICY_SET",
          fields: { "Old Value": oldValue, "New Value": changeControl, Source: ccRequest.source },
        });
        const oldDisplay = cc.conflict === undefined && cc.intent === null && cc.rawStateValue !== null
          ? cc.rawStateValue : formatGuardPolicy(cc.value, cc.source);
        lines.push(`Guard Policy changed: ${oldDisplay} to ${line}`);
      } else {
        lines.push(`Guard Policy is already ${line}`);
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
        lines.push(`Fence ${request.fence} is already ${after.value}`);
        continue;
      }
      content = updated;
      // Each event named literally at its own call, not through a ternary on
      // eventType: the emitter drift guard reads these call sites as text, and a
      // computed event name is invisible to it.
      const fenceFields = { Guard: request.fence, Scope: scopeName, Source: request.source };
      audit.push(
        after.value === "off"
          ? { eventType: "GUARD_DISABLED", fields: fenceFields }
          : { eventType: "GUARD_RESTORED", fields: fenceFields },
      );
      lines.push(
        after.value === "off"
          ? `Fence ${request.fence} is off for this piece of work (logged; back on for the next one)`
          : `Fence ${request.fence} is back on for this piece of work`,
      );
    }
  }
  for (const key of CEREMONY_KEYS) {
    const value = ceremonies[key];
    if (value === undefined) continue;
    const source = requested[CEREMONY_FLAGS[key].slice(2) as ConfigKey]!.source;
    const field = CEREMONY_FIELDS[key];
    const previous = getField(content, field);
    const line = formatCeremony(value, source);
    if (previous === line) {
      lines.push(`${field} is already ${line}`);
      continue;
    }
    const resolution = resolveCeremony(key, getField(content, "Scope"), content);
    content = setCeremonyField(content, key, value, source);
    const oldValue = resolution.intent?.value ?? resolution.rawStateValue ?? resolution.scopeDefault;
    audit.push({ eventType: "CEREMONY_SET", fields: { Key: key, Old: oldValue, New: value, Source: source } });
    const oldDisplay = resolution.intent === null && resolution.rawStateValue !== null
      ? resolution.rawStateValue : formatCeremony(resolution.value, resolution.source);
    lines.push(`${field} changed: ${oldDisplay} to ${line}`);
  }
  return { content, audit, lines };
}

export interface TypedGuardSwitchOutcome {
  applied: boolean;
  lines: string[];
}

export function isTypedGuardSwitchPrompt(prompt: string): boolean {
  return parseTypedGuardSwitchRequest(prompt).switches.length > 0;
}

export function applyTypedGuardSwitchPrompt(
  projectDir: string,
  sessionId: string,
  prompt: string,
): TypedGuardSwitchOutcome | null {
  const parsed = parseTypedGuardSwitchRequest(prompt);
  if (parsed.switches.length === 0 || process.env.AIDLC_UNATTENDED === "1") return null;
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
    if (selection.intent === null || !existsSync(stateFilePath(projectDir, intent, space))) {
      const wanted = parsed.switches[0];
      const label = wanted.key === "guard-policy"
        ? `Guard Policy ${wanted.value} and fence switches`
        : `${wanted.key} off switches`;
      return {
        applied: false,
        lines: [`${label} apply to a piece of work: create it, then type this again.`],
      };
    }
    const requested: IntentSettingsRequest = {};
    for (const setting of parsed.settings) {
      requested[setting.key as ConfigKey] = { value: setting.value, source: "you" };
    }
    return withAuditLock(projectDir, (): TypedGuardSwitchOutcome => {
      const content = readStateFile(projectDir, intent, space);
      const memoryStrict = memoryGuardPolicyDeclarations(projectDir, { intent, space, sessionId })
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
