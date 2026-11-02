// covers: dir:command-center, tool:aidlc-dashboard, policy:no-ai-no-network
//
// The Command Center must cost the person running it nothing and send nothing
// anywhere: no model calls, no outbound requests, no telemetry, and a server
// that binds loopback only. Scans the shipped server, the committed UI bundle
// and the launcher.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO = join(import.meta.dir, "../..");
const ROOT = join(REPO, "core", "command-center");
const LAUNCHER = join(REPO, "core", "tools", "aidlc-dashboard.ts");

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

// Outbound-network and model-SDK markers. Serving with Bun.serve on loopback is
// allowed; the UI talks to its own origin through relative /api URLs only.
const BANNED: readonly RegExp[] = [
  /\bfetch\(\s*["'`]https?:\/\//,
  /new WebSocket\(\s*["'`]wss?:\/\//,
  /new EventSource\(\s*["'`]https?:\/\//,
  /navigator\.sendBeacon/,
  /@anthropic-ai\//,
  /\bopenai\b/i,
  /bedrock-runtime/,
  /generativelanguage\.googleapis/,
  /from ["']node:https["']/,
  /from ["']https["']/,
  /from ["']node:net["']/,
  /from ["']node:dgram["']/,
];

const sources = [LAUNCHER, ...walk(ROOT).filter((p) => /\.(ts|js|html)$/.test(p))];

describe("the Command Center makes no AI or outbound network calls", () => {
  for (const file of sources) {
    test(relative(REPO, file), () => {
      const src = readFileSync(file, "utf8");
      const hits = BANNED.filter((re) => re.test(src)).map((re) => re.source);
      expect(hits).toEqual([]);
    });
  }
});

describe("the Command Center binds loopback only", () => {
  test("Bun.serve is called once, on 127.0.0.1", () => {
    const serves = walk(join(ROOT, "server"))
      .map((p) => readFileSync(p, "utf8"))
      .flatMap((src) => src.match(/Bun\.serve\(\{[^}]*\}/g) ?? []);
    expect(serves.length).toBe(1);
    expect(serves[0]).toContain('hostname: "127.0.0.1"');
  });

  test("no wildcard bind appears anywhere in the server or the launcher", () => {
    for (const file of [LAUNCHER, ...walk(join(ROOT, "server"))]) {
      expect({ file: relative(REPO, file), wildcard: /0\.0\.0\.0|\[::\]|hostname:\s*["']::["']/.test(readFileSync(file, "utf8")) })
        .toEqual({ file: relative(REPO, file), wildcard: false });
    }
  });
});
