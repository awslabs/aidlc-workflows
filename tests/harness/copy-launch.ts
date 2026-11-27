// copy-launch.ts - the copy install's launch with its two Bun options, for the
// cases that check a command reads the same with and without them. The one
// place a test names the launch's config file.

/** The empty Bun config file a copy install starts its own Bun with, in its tools folder. */
export const COPY_LAUNCH_CONFIG = "aidlc-bunfig.toml";

/**
 * A copy launch (`bun <dir>/tools/...`, `bun <dir>/hooks/...`, `bun run
 * <dir>/tools/...`, or Claude Code's rooted `bun "$CLAUDE_PROJECT_DIR/<dir>/..."`)
 * with the two options right after `bun`, the config path spelled the way the
 * script path is.
 */
export function withCopyLaunchOptions(command: string): string {
  const rooted = /^bun "(\$CLAUDE_PROJECT_DIR\/[^/"]+)\/(?:tools|hooks)\//.exec(command);
  if (rooted) return command.replace(/^bun /, `bun "--config=${rooted[1]}/tools/${COPY_LAUNCH_CONFIG}" --no-env-file `);
  const relative = /^bun (?:run )?(\.[A-Za-z0-9_-]+)\/(?:tools|hooks)\//.exec(command);
  if (relative) return command.replace(/^bun /, `bun --config=${relative[1]}/tools/${COPY_LAUNCH_CONFIG} --no-env-file `);
  throw new Error(`not a copy launch: ${command}`);
}
