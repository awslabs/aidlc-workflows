# Local Run Patterns

Methodology knowledge for executing mabl tests locally via the CLI.

## Command Shape

```bash
mabl tests run \
  --id <testId> \
  -w <workspaceId> \
  --url <localUrl> \
  --application-id <applicationId> \
  --environment-id <environmentId> \
  --credentials-id <credentialsId> \
  --reporter mabl
```

## Critical Rules

1. **Never pass `--keep-browser-open`.** It prevents the command from returning and
   hangs the execution turn indefinitely.

2. **Do not trust the exit code.** `mabl tests run` can exit 0 even when a test
   failed. Always parse the `Passed:`/`Failed:` counts from the log output.

3. **Run sequentially.** Tests share a single dev server/port — parallel runs cause
   port conflicts and race conditions.

4. **`--reporter mabl` publishes to the cloud.** Each local run gets a shareable app
   link and history entry. Execution remains local (no cloud credits for the run
   itself). Resolve `--application-id` and `--environment-id` so the published run
   associates correctly.

5. **Never grep raw run logs.** They embed base64 screenshot payloads. Always pipe
   through `awk 'length($0) < 300'` before grepping for keywords like `Passed`,
   `Failed`, `Test Passed`, `Test Failed`.

## GenAI/Visual Assertions

Local CLI runs **disable GenAI and visual assertions by default**. Any such step
auto-fails with "AI assertions are not available in CLI runs."

Before running, check the test's steps (`get_mabl_test_steps`) for GenAI/visual
assertions. If present:
- Run with `--allow-billable-features` (consumes mabl credits — confirm with user), OR
- Run without the flag and treat a failure on ONLY those steps as a **harness skip**,
  not a code regression.

When every concrete (DOM) assertion passed and the only red is a GenAI/visual step,
the test is **effectively green** — report it as such.

## Credentials Resolution

The right credentials depend on what the test asserts. The same page renders
differently per persona:
- Admin lands on "Dashboard" with full nav
- Client lands on "My Account" with limited nav

If a test's assertions were authored for admin, run it with the Admin credentials id.
Resolve ids with `list_mabl_credentials` (MCP). A local run without credentials
resolves `app.defaults.username` to nothing — the login flow executes with a
placeholder, and the test fails downstream with misleading "Element not found" errors.

## URL Resolution Priority

1. User-provided `--url` override
2. Detected running dev server (probe ports 3000, 3001, 5173, 8080)
3. Project config (package.json scripts, .env, docker-compose)
4. Ask the user

Only fall back to the mabl environment default URL if the user explicitly says to
test the deployed app (defeats the purpose of pre-PR local verification).

## Long-Running Operations

- **Test runs (1–5 min):** Run in the foreground. The harness blocks and returns
  stdout/stderr directly.
- **Authoring sessions (30–45 min):** Launch detached and poll:
  ```bash
  DIR="$HOME/.kiro/tmp/mabl-authoring"; mkdir -p "$DIR"
  nohup mabl agent authoring initiate ... --mode local --headless --auto-save --verbose \
    > "$DIR/authoring.log" 2>&1 &
  echo "started pid $!"
  ```
  Poll with `awk 'length($0) < 300' "$DIR/authoring.log" | tail -n 40` on later turns.

## Authoring Branch Gotcha

Local authoring saves to an "Agent edit session" branch, **not `master`**. But
`mabl tests run --id` executes the master tip. After authoring:
1. `list_mabl_test_versions` to find the new version
2. `restore_mabl_test(version=<new>)` to promote it to master latest
3. THEN re-run to verify

Without promotion, re-runs still use the old steps.
