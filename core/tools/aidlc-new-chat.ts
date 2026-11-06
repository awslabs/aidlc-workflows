// The person's own step to a clean chat in the host they are in, from the
// tree's tools/data/harness.json `newChatStep` (each harness's manifest). The
// host this tree runs in is told apart as the hook lines are, by the agent
// shell's environment (inHostShell); `<entry>` is filled in as there.

import { readFileSync } from "node:fs";
import { fillHookActivationText, harnessDataPath, hostLine, inHostShell } from "./aidlc-lib.ts";
import { compiledExecutable, discoverProjectHarnesses } from "./aidlc-runtime-paths.ts";

type NewChatStep = { text: string; inHost?: { env: string[]; text: string } };

// A line for the person, so a step that is not well formed is none.
function shippedNewChatStep(): NewChatStep | null {
  try {
    const parsed = JSON.parse(readFileSync(harnessDataPath(), "utf-8")) as {
      newChatStep?: { text?: unknown; inHost?: unknown } | null;
    };
    const step = parsed.newChatStep;
    if (typeof step?.text !== "string" || step.text.trim() === "") return null;
    return { text: step.text, ...hostLine("inHost", step.inHost) };
  } catch {
    return null;
  }
}

// Whether this engine's tree is the tool the person is in. The copy channel
// runs from the tree of the tool that called it. A native engine in a project
// with more than one harness runs on the first one installed for every host but
// Codex (runtimeHarnessDir), so its step can be another tool's: a wrong line,
// where the offer is only an offer.
function treeIsTheHost(projectDir: string): boolean {
  if (compiledExecutable() === null) return true;
  try {
    return discoverProjectHarnesses(projectDir).length <= 1;
  } catch {
    return false;
  }
}

/**
 * The person's step to a clean chat in the host the agent's shell is in,
 * filled in, or null when this tree names none or cannot tell it is theirs.
 * Never throws.
 */
export function newChatStep(projectDir: string): string | null {
  if (!treeIsTheHost(projectDir)) return null;
  const step = shippedNewChatStep();
  if (step === null) return null;
  try {
    return fillHookActivationText(step.inHost && inHostShell(step.inHost.env) ? step.inHost.text : step.text);
  } catch {
    return null;
  }
}
