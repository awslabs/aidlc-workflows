#!/usr/bin/env bun
// The body of a stable GitHub Release, taken from this version's CHANGELOG
// entry and written to a file for `gh release create --notes-file`.
//
// Why not GitHub's own `--generate-notes`: its "What's Changed" list names every
// contributing account by handle. The release body is a published page, and the
// people in it did not choose to be named there. The CHANGELOG entry is what the
// release-preparation PR wrote for the people who read it, so that is the body.
//
// The heading rule lives in one place, `releaseNotesFromChangelog`, which the
// preview channel already publishes with and `t68` holds the CHANGELOG to. A
// missing heading or an empty section throws, so the release job stops before it
// creates anything.
import { writeFileSync } from "node:fs";
import { releaseNotesFromChangelog } from "./publish-release.ts";

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`missing ${name} <value>`);
  }
  return value;
}

function main(): void {
  const args = process.argv.slice(2);
  const tag = option(args, "--tag");
  const notes = releaseNotesFromChangelog(option(args, "--changelog"), tag);
  writeFileSync(option(args, "--out"), notes.body, "utf-8");
}

try {
  main();
} catch (error) {
  console.error(`release-notes: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
