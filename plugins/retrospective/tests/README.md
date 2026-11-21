# Plugin tests

Keep plugin tests and fixtures under this directory. Do not place them under
`tools/`: composition copies `tools/` recursively into every install, so
test payloads there become shipped runtime files (issue #876).

Inside the AIDLC repository, use `tests/harness/plugin-kit.ts` for reusable
validation, build, compose, and optional live-harness helpers. External plugin
repositories can invoke the shipped validate/build/test tools directly from CI.
