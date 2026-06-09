# Artifact Repository Backends

AI-DLC separates *what* artifacts the methodology produces from *where* and *how* they are stored, using a repository (port/adapter) pattern.

- **Port** — `conventions/repository-interface.md`. The stable, backend-neutral contract: an `ArtifactAddress` (logical artifact **types**, never paths) and a set of operations (`saveArtifact`, `readArtifact`, `copyForwardArtifact`, `registerOutput`, …). Every skill, persona, and stage speaks only this. It never changes when you swap backends.
- **Adapter** — one per backend, under `repository/<backend>/`. The only place that knows about paths, extensions, formats, nodes, edges, etc.

The build (`build/kiro-ide/build.js`) selects one backend via `BACKEND` and wires it into the distribution:

- `repository/<backend>/artifact-repository.md` → `conventions/artifact-repository.md` (the active adapter the orchestrator reads)
- `repository/<backend>/verifier.js` → `tools/process-checker.js` (the active deterministic verifier the process hook runs)

## Backends

| Backend | Folder | Storage |
|---|---|---|
| `markdown-fs` *(default)* | `markdown-fs/` | Markdown/YAML/JSON/HTML files in `org-ai-kb/aidlc-docs/intent-*/` |

## Authoring a new backend

A backend is **one adapter file + one paired verifier**:

1. Create `repository/<backend>/artifact-repository.md`. Implement every operation in `conventions/repository-interface.md` and map every artifact type in the catalog to a representation for your store. State the **mechanism** the agent must use to perform the operations — ordinary file tools, a specific tool, or an MCP server (e.g. for a graph database, name the MCP server and the tools that create/read/update nodes). This is the only steering file that mentions your storage's physical concepts and access mechanism.
2. Create `repository/<backend>/verifier.js`. Implement `verifyStage`: given an intent handle, read state, resolve each declared output's address to your store, and confirm the artifact exists; confirm declared contributions are present once the stage is past the contribution step. It must accept the same CLI contract as the markdown-fs verifier (`node <verifier> <intent-handle>`, exit `0` pass / `1` fail / `2` error) so the process hook is unchanged.
3. Set `BACKEND` in `build/kiro-ide/build.js` (or pass it via env) to your backend name and rebuild.

What you must **not** touch when adding a backend: the port, the skills, the stage definitions, the schemas, the personas. If a change there seems necessary, the concern is leaking out of the adapter — keep it in the adapter.

### Templates are shared, not backend-owned

Content templates live with the stages (`stages/*/templates/`). They describe an artifact's **content shape**, which is backend-neutral. A file backend renders a template into a file; a graph backend renders the same content into a node body (and uses edges for traversal). Your adapter maps `resolveTemplate(type)` to the shared template — it does not fork them.
