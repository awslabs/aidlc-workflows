# Build & Test Execution — Opt-In

**Extension**: Build & Test Execution

**Recommended when**: You want the AI to actually execute your test suites during the Build & Test phase rather than only generating test instruction documentation. Ideal for projects where the AI has access to the build toolchain in the workspace.

## Opt-In Prompt

The following question is automatically included in the Requirements Analysis clarifying questions when this extension is loaded:

```markdown
## Question: Build & Test Execution Extension

Should the AI-DLC actually execute tests during the Build & Test phase?

A) Yes — enable BUILD & TEST EXECUTION. The AI will validate the build
   environment, verify test-to-source contracts, run the actual test
   suites, and iterate on failures until all tests pass. Build & Test
   will not complete until tests are green.

B) No — generate test instruction documentation only (default AI-DLC
   behavior). You will run the tests manually.

X) Other (please describe)

[Answer]:
```
