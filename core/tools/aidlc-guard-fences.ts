// A fence is a hook that refuses an action nobody directed: no engine
// instruction covers it and no human grant is newer than the engine's last
// directive. The policy word lowers a fixed set; a human can lower a switchable
// fence for one piece of work with `/aidlc config set guard.<fence> off`, which
// writes the `Guards Off` state line and one GUARD_DISABLED row. Human presence
// (a real human turn behind every approval and answer) is the key holder, not a
// fence the policy word touches. It has no in-band switch: only its machine-wide
// environment kill switch lowers it.
export const GUARD_FENCES = [
  "plan-approval",
  "review-freeze",
  "state-transition",
  "reviewer-scope",
  "human-presence",
] as const;
export type GuardFence = (typeof GUARD_FENCES)[number];

export const SWITCHABLE_GUARD_FENCES = [
  "plan-approval",
  "review-freeze",
  "state-transition",
  "reviewer-scope",
] as const;
export type SwitchableGuardFence = (typeof SWITCHABLE_GUARD_FENCES)[number];

export function isSwitchableGuardFence(value: unknown): value is SwitchableGuardFence {
  return typeof value === "string" && (SWITCHABLE_GUARD_FENCES as readonly string[]).includes(value);
}

/** Config keys of the per-run switches: `guard.plan-approval` and so on. */
export const GUARD_FENCE_CONFIG_PREFIX = "guard.";
export function guardFenceConfigKey(fence: SwitchableGuardFence): string {
  return `${GUARD_FENCE_CONFIG_PREFIX}${fence}`;
}
export function guardFenceFromConfigKey(key: string): SwitchableGuardFence | null {
  if (!key.startsWith(GUARD_FENCE_CONFIG_PREFIX)) return null;
  const fence = key.slice(GUARD_FENCE_CONFIG_PREFIX.length);
  return isSwitchableGuardFence(fence) ? fence : null;
}
