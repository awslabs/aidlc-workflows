# Command Center (shipped part)

The server behind `aidlc dashboard`: a read-only, loopback-only local view of
the AI-DLC workspaces on this machine. `server/` is imported in-process by
`tools/aidlc-dashboard.ts`; `ui/` is the prebuilt web bundle it serves.

`ui/` is generated. Its React sources, the app's tests, and its dev
dependencies live in the repository's `command-center/` dev package; rebuild
with `cd command-center && bun run build:ui` and commit the result.
