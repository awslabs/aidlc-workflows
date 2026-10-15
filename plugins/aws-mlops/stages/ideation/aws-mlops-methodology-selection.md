---
slug: aws-mlops-methodology-selection
number: 1.80
name: ML Methodology Selection
plugin: aws-mlops
phase: ideation
execution: ALWAYS
condition: Execute at the start of an AWS MLOps profile
lead_agent: aws-mlops-ml-engineer-agent
support_agents: []
mode: inline
produces: [aws-mlops-methodology-selection]
consumes: []
requires_stage: [state-init]
sensors: [required-sections, aws-mlops-evidence]
scopes: [aws-mlops-platform, aws-mlops-crisp-mlq]
ars:
  targets: [iae, ua]
  cost: 1
inputs: The person's request, chosen profile and the shipped methodology catalog
outputs: aws-mlops-methodology-selection.md in the engine-resolved record directory
---

# Choose the methodology

Follow the active stage protocol for questions, recorded decisions and completion.

## Steps

### Step 1: Read the person's existing choices

Use the initiating request and recorded answers. Explicitly choosing
`aws-mlops-crisp-mlq` is a CRISP-ML(Q) choice only if the person chose that
profile; an agent's default is not. Keep full AWS and SageMaker as supplied.
Determine whether this intent builds the shared platform or a specific model.

### Step 2: Present actual availability

Read the installed catalog at
`{{HARNESS_DIR}}/tools/aws-mlops-methodologies.ts`.
In a source/development install with Bun, its read-only CLI can also print the
catalog. Reading the file works in native installs without adding a runtime.
Explain available versus planned methods in the conversation language. If a
method was already chosen, record it without re-asking. Otherwise ask once which
method the person wants, recommending CRISP-ML(Q) and explaining its consequence.
Display planned profiles as future work, not as executable routes.

If the person chooses a planned method, preserve that answer and explain what
would need implementation. Let the person choose building that profile, choosing
another, or stopping, using the engine's normal mechanisms. Do not substitute an
available method or claim this CRISP-ML(Q) route implements their chosen method.

### Step 3: Record the choice

Write `aws-mlops-methodology-selection.md` with `## Choice`, `## Availability`
and `## Next Work`, including the person's words and which scope matches them.
Write the adjacent sensor side input `aws-mlops-methodology-selection.json`:

```json
{
  "methodology": "crisp-mlq",
  "availability": "available",
  "selection_source": "human",
  "user_request": "<the person's actual request choosing the method>",
  "profile": "platform",
  "stack": "aws-sagemaker"
}
```

Use `profile: model` for a model intent. This is a choice record, not proof of
identity and not permission to execute AWS changes. A planned choice uses its
catalog ID/status and requires an appropriate new route before continuing.

### Step 4: Hand completion to the engine

Use `{{INVOKE}} engine orchestrate report --stage aws-mlops-methodology-selection --result <outcome>`.
The stage protocol owns the human gate and any requested revision or stop.

## Sensors

`required-sections` checks the document. `aws-mlops-evidence` checks the adjacent
choice JSON against the shared catalog and reports an absent explicit choice.

## Learn

When `directive.protocol_modules` lists `learnings`, follow
`stage-protocol-learnings.md` using `directive.memory_path`; otherwise skip it.
