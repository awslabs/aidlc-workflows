#!/usr/bin/env bun
// Serve a staged release directory over loopback HTTP with the GitHub release
// URL layout the installers download from:
//   <base>/latest/download/<asset>      (metadata + installer for "latest")
//   <base>/download/v<version>/<asset>  (versioned binaries and runtime)
// CI points AIDLC_RELEASE_BASE_URL at it so the documented
// `irm <base>/latest/download/install.ps1 | iex` one-liner installs the
// candidate built from the same commit, without publishing anything.
// Loopback only, flat asset names only, no directory listing.
//
// Usage: bun .github/scripts/serve-release-directory.ts <release-dir> [port]
// Prints one JSON line {"baseUrl": "http://127.0.0.1:<port>"} once listening.

import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const [rootArg, portArg] = process.argv.slice(2);
if (!rootArg || (portArg !== undefined && !/^\d{1,5}$/.test(portArg))) {
  console.error("usage: bun .github/scripts/serve-release-directory.ts <release-dir> [port]");
  process.exit(2);
}
const root = resolve(rootArg);
if (!existsSync(root) || !statSync(root).isDirectory()) {
  console.error(`release directory not found: ${root}`);
  process.exit(2);
}

const ASSET_PATH = /^\/(?:latest\/download|download\/v[0-9][0-9A-Za-z.-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: portArg === undefined ? 0 : Number(portArg),
  fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405 });
    }
    const name = ASSET_PATH.exec(new URL(request.url).pathname)?.[1];
    if (!name) return new Response("not found", { status: 404 });
    const path = join(root, name);
    if (!existsSync(path) || !statSync(path).isFile()) return new Response("not found", { status: 404 });
    return new Response(Bun.file(path), { headers: { "content-type": "application/octet-stream" } });
  },
});

console.log(JSON.stringify({ baseUrl: `http://127.0.0.1:${server.port}` }));
