// test-pro dropped into a Kiro project as earlier Kiro IDE builds wrote it, for
// the checks that tell a dropped plugin's own session-start registration from a
// hook file a person added (doctor's trust row, the Kiro switch). The
// registrations and 2.11.0's marker are each release's own bytes, from its copy
// runtime (plugins/test-pro/kiro-ide), written out here so a change to today's
// template cannot change them; the preview's plugin folder is copied from
// today's dist.

import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");

function registrationText(command: string): string {
  return [
    "{",
    '  "version": "v1",',
    '  "hooks": [',
    "    {",
    '      "name": "aidlc-test-pro-compose",',
    '      "trigger": "SessionStart",',
    '      "description": "Composes the test-pro AIDLC plugin at session start.",',
    '      "action": {',
    '        "type": "command",',
    `        "command": "${command}"`,
    "      }",
    "    }",
    "  ]",
    "}",
    "",
  ].join("\n");
}

function writeRegistration(project: string, command: string): string {
  const path = join(project, ".kiro", "hooks", "aidlc-test-pro-compose.json");
  mkdirSync(join(project, ".kiro", "hooks"), { recursive: true });
  writeFileSync(path, registrationText(command));
  return path;
}

// Each drop returns the files it wrote that the checks read, its registration first.
export const EARLIER_KIRO_IDE_DROPS: ReadonlyArray<{ build: string; drop(project: string): string[] }> = [
  {
    // The projection copied whole into the workspace: its marker at the root,
    // and a registration that runs the launcher from the root's hooks folder.
    // The 2.11.1 previews up to 2.11.1-preview.20261017.1 wrote the same.
    build: "2.11.0",
    drop(project) {
      const marker = join(project, ".aidlc-plugin-projection.json");
      writeFileSync(
        marker,
        '{\n  "schema": 1,\n  "producer": "aidlc-plugin-build",\n  "plugin": "test-pro",\n  "harness": "kiro-ide"\n}\n',
      );
      return [writeRegistration(project, "bun ./hooks/aidlc-plugin-compose.ts .kiro kiro-ide"), marker];
    },
  },
  {
    // The plugin in its own folder, as builds put it from this preview on,
    // with a registration that runs the launcher alone.
    build: "2.11.1-preview.20261018.1",
    drop(project) {
      cpSync(join(REPO_ROOT, "dist", "plugins", "test-pro", "kiro-ide", ".kiro"), join(project, ".kiro"), {
        recursive: true,
      });
      return [
        writeRegistration(
          project,
          "bun ./.kiro/aidlc-plugins/aidlc-test-pro/hooks/aidlc-plugin-compose.ts .kiro kiro-ide",
        ),
        join(project, ".kiro", "aidlc-plugins", "aidlc-test-pro", ".aidlc-plugin", "plugin.json"),
      ];
    },
  },
];
