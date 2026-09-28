import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/** Remove command-bearing PATH entries without leaving a Windows Path alias. */
export function envWithoutCommandOnPath(command: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const windows = process.platform === "win32";
  const pathKey = windows
    ? Object.keys(env).find((key) => key.toUpperCase() === "PATH")
    : "PATH";
  const entries = (env[pathKey ?? "PATH"] ?? "").split(delimiter).filter(Boolean);
  const candidates = windows
    ? [
        command,
        ...new Set(
          [".EXE", ".COM", ".CMD", ".BAT", ...(env.PATHEXT ?? "").split(";")]
            .filter(Boolean)
            .map((extension) => `${command}${extension.toLowerCase()}`),
        ),
      ]
    : [command];
  const strippedPath = entries.filter((entry) => {
    const dir = windows ? entry.replace(/^"(.*)"$/, "$1") : entry;
    return !candidates.some((name) => existsSync(join(dir, name)));
  }).join(delimiter);
  if (windows) {
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === "PATH") delete env[key];
    }
  }
  env.PATH = strippedPath;
  return env;
}
