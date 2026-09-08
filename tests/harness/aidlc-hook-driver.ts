#!/usr/bin/env bun
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
if (args[0] !== "hook" || !/^[a-z0-9-]+$/.test(args[1] ?? "")) {
  process.stderr.write("test hook driver expects: hook <name> --project-dir <dir>\n");
  process.exit(2);
}
const projectIndex = args.indexOf("--project-dir");
const projectDir = projectIndex >= 0 ? args[projectIndex + 1] : undefined;
if (!projectDir) {
  process.stderr.write("test hook driver requires --project-dir\n");
  process.exit(2);
}

const hookPath = join(projectDir, ".aidlc", "hooks", `aidlc-${args[1]}.ts`);
const module = await import(`${pathToFileURL(hookPath).href}?test=${Date.now()}`);
if (typeof module.run === "function") {
  process.exit(await module.run(await Bun.stdin.text()));
}
