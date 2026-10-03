// VS Code's terminal tool trims a command's output before the chat agent sees
// it: it drops every line up to and including the first line that holds the
// command line it ran (matched with newlines removed, so a wrapped echo still
// counts), and does that once more when the rest still holds it. An output
// that starts with a mid-word tail of the command is trimmed the same way.
// So a message that repeats the command that printed it reaches the agent
// partly or entirely missing (#1411). This is an independent implementation
// of that rule, as VS Code applies it in
// src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/executeStrategy/strategyHelpers.ts
// (stripCommandEchoAndPrompt / findCommandEcho, release/1.131); its separate
// trailing-prompt trim only drops shell prompt lines and is not modeled.

function echoEndLine(output: string, commandLine: string, allowSuffix: boolean): number | null {
  const typed = commandLine.trim();
  if (typed.length === 0) return null;
  const positions: number[] = [];
  let flat = "";
  for (let index = 0; index < output.length; index++) {
    if (output[index] === "\n") continue;
    flat += output[index];
    positions.push(index);
  }
  let matchEnd: number;
  const at = flat.indexOf(typed);
  if (at >= 0) {
    matchEnd = at + typed.length - 1;
  } else if (allowSuffix) {
    let length = 0;
    for (let candidate = typed.length - 1; candidate >= 1; candidate--) {
      if (!flat.startsWith(typed.slice(typed.length - candidate))) continue;
      const before = typed[typed.length - candidate - 1];
      if (before !== undefined && before !== " " && before !== "\t") length = candidate;
      break;
    }
    if (length === 0) return null;
    matchEnd = length - 1;
  } else {
    return null;
  }
  const end = positions[matchEnd];
  const lines = output.split("\n");
  let offset = 0;
  for (let line = 0; line < lines.length; line++) {
    const lineEnd = offset + lines[line].length;
    if (offset <= end && end <= lineEnd) return line + 1;
    offset = lineEnd + 1;
  }
  return 0;
}

function trimOnce(output: string, commandLine: string): string {
  const cut = echoEndLine(output, commandLine, true);
  return cut === null ? output : output.split("\n").slice(cut).join("\n");
}

/** What the agent sees of `output` after VS Code ran `commandLine`. */
export function vscodeVisibleOutput(output: string, commandLine: string): string {
  const first = trimOnce(output, commandLine);
  return first.trim().length > 0 && echoEndLine(first, commandLine, false) !== null
    ? trimOnce(first, commandLine)
    : first;
}

/** The command lines an agent types to run doctor, in each spelling. */
export function doctorCommandLines(harnessDir = ".aidlc"): string[] {
  return ["aidlc", `bun ${harnessDir}/tools/aidlc.ts`].flatMap((invoke) => [
    `${invoke} doctor`,
    `${invoke} doctor --verbose`,
  ]);
}
