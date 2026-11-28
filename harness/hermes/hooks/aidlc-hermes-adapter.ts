import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The configured command names a particular installed adapter, not a project
// discovered from the caller's cwd or from an untrusted environment variable.
const hookDir = dirname(fileURLToPath(import.meta.url));
const root = dirname(dirname(hookDir));

async function run(): Promise<number> {
  let input: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(await Bun.stdin.text());
    if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
    input = value as Record<string, unknown>;
    if (input.hook_event_name !== "pre_tool_call" || typeof input.cwd !== "string") return 0;
    if (realpathSync(input.cwd) !== realpathSync(root) || realpathSync(process.cwd()) !== realpathSync(root)) return 0;
  } catch {
    return 0;
  }
  const name = input.tool_name;
  const args = input.tool_input;
  if (!args || typeof args !== "object" || Array.isArray(args)) return 0;
  const native = args as Record<string, unknown>;
  let tool: string;
  let toolInput: Record<string, unknown>;
  if (name === "terminal" && typeof native.command === "string") {
    tool = "Bash";
    toolInput = { command: native.command };
  } else if (name === "patch" && native.mode === "patch" && typeof native.patch === "string") {
    const paths = Array.from(native.patch.matchAll(/^\*\*\* (?:Update File|Add File|Delete File|Move to): (.+)\r?$/gm), (match) => match[1]);
    if (!paths.length) return 0;
    tool = "Edit";
    // Supply added and context lines to the content-based guard as well as all
    // paths. Patch metadata and removed lines are not part of the resulting text.
    const content = native.patch.split(/\r?\n/)
      .filter((line) => line.startsWith("+") || line.startsWith(" "))
      .map((line) => line.slice(1)).join("\n");
    toolInput = { file_path: paths[0], paths, content };
  } else if ((name === "write_file" || name === "patch") && typeof native.path === "string") {
    tool = name === "write_file" ? "Write" : "Edit";
    toolInput = { ...native, file_path: native.path };
  } else {
    return 0;
  }
  const payload = JSON.stringify({
    hook_event_name: "PreToolUse", tool_name: tool, tool_input: toolInput,
    cwd: root, ...(typeof input.session_id === "string" ? { session_id: input.session_id } : {}),
  });
  // Project-selection and trace overrides can otherwise redirect guard I/O.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("AIDLC_")));
  env.AIDLC_PROJECT_DIR = root;
  env.AIDLC_RUNTIME_PROJECT_DIR = root;
  env.AIDLC_HARNESS_DIR = ".hermes";
  env.CLAUDE_PROJECT_DIR = root;
  const guards = tool === "Bash"
    ? ["state-transition-guard", "review-freeze", "plan-approval-guard"]
    : ["review-freeze", "plan-approval-guard"];
  for (const guard of guards) {
    try {
      const result = Bun.spawnSync([process.execPath, join(hookDir, `aidlc-${guard}.ts`)], {
        cwd: root, env, stdin: Buffer.from(payload), stdout: "pipe", stderr: "pipe",
      });
      if (result.exitCode === 2) {
        process.stderr.write(result.stderr.toString() || "AI-DLC blocked this action.\n");
        return 2;
      }
      if (result.exitCode !== 0) throw new Error("guard failed");
    } catch {
      process.stderr.write("AI-DLC could not check this action; retry after checking the installation.\n");
      return 2;
    }
  }
  return 0;
}

if (import.meta.main) process.exit(await run());
