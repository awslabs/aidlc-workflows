import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { resolveProjectDir } from "../aidlc-lib.ts";

const factory: CustomToolFactory = (pi) => ({
  name: "aidlc_orchestrate",
  label: "AIDLC Orchestrator",
  description:
    "Orchestrates the AIDLC workflow. Subcommands: next (determine next stage), report (commit stage transition), status (print workflow status), init (scaffold workspace), doctor (validate setup), version (print version).",
  parameters: pi.zod.object({
    subcommand: pi.zod.enum(["next", "report", "status", "init", "doctor", "version", "help"]),
    args: pi.zod.record(pi.zod.unknown()).optional(),
    user_input: pi.zod.string().optional(),
    skeleton_stance: pi.zod.enum(["on", "off", "scope-dependent"]).optional(),
    result: pi.zod.enum(["completed", "approved", "rejected", "failed"]).optional(),
  }),
  async execute(_toolCallId, params, onUpdate, _ctx, signal) {
    const projectDir = await resolveProjectDir(pi.cwd);

    // Build CLI args from params
    const cliArgs = [params.subcommand];

    if (params.args) {
      for (const [key, value] of Object.entries(params.args)) {
        cliArgs.push(`--${key}`);
        if (typeof value === "string") {
          cliArgs.push(value);
        } else if (typeof value === "boolean" && value) {
          // flag only, no value
        } else if (value !== undefined && value !== null && typeof value !== "boolean") {
          cliArgs.push(String(value));
        }
      }
    }

    if (params.user_input) cliArgs.push("--user-input", params.user_input);
    if (params.skeleton_stance) cliArgs.push("--skeleton-stance", params.skeleton_stance);
    if (params.result) cliArgs.push("--result", params.result);

    // Run the CLI tool
    const result = await pi.exec("bun", [".omp/tools/aidlc-orchestrate.ts", ...cliArgs], {
      cwd: projectDir,
      signal,
    });

    if (result.code !== 0) {
      return {
        content: [{ type: "text", text: `Error: ${result.stderr || result.stdout}` }],
        details: { exitCode: result.code, stderr: result.stderr, stdout: result.stdout },
        isError: true,
      };
    }

    // The CLI outputs a directive JSON to stdout
    let directive: unknown;
    try {
      directive = JSON.parse(result.stdout.trim());
    } catch {
      directive = { raw: result.stdout.trim() };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(directive, null, 2) }],
      details: { directive, exitCode: result.code },
      isError: false,
    };
  },
});

export default factory;