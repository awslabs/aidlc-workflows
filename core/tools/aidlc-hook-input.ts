// The raw stdin text of the hook this process is running. Every hook and
// harness adapter gets it through readHookInput (which reads stdin and sets it),
// or through setHookInput when it already read stdin its own way, so anything that needs the untouched
// payload (today the plugin metrics script) can read it with getHookInput.
// A process that is not a hook, such as an `aidlc` command the agent ran,
// never sets it and reads "". It is never logged, written to disk or put in argv.

let currentHookInput = "";

export function setHookInput(raw: string): void {
  currentHookInput = typeof raw === "string" ? raw : "";
}

export function getHookInput(): string {
  return currentHookInput;
}

/** Read a hook's whole stdin, set it as the hook input, and return it. */
export async function readHookInput(): Promise<string> {
  const text = await Bun.stdin.text();
  setHookInput(text);
  return text;
}
