# Developer Agent

> **Agent deep dive** · [User Guide](../00-introduction.md) › [Agents](../06-agents.md) › [deep dives](README.md) · Technical reference: [developer-agent](../../reference/agents/developer-agent.md)

The aidlc-developer-agent is your senior software developer. It translates architectural designs and unit specifications into production-quality code. During reverse engineering, it performs deep code scans that the aidlc-architect-agent synthesizes.

The aidlc-developer-agent leads the Reverse Engineering code scan and Code Generation, and is a dispatched collaborator in both Inception ensembles: it examines code-pattern evidence in the Practices Discovery hub-and-spoke and provides the implementability voice in the User Stories mob. Code Generation runs as a focused subagent. It has Bash access for running build tools, package managers, and test commands.

Workspace Detection (0.2) used to be led by the aidlc-developer-agent as a subagent; it now runs deterministically inside `aidlc-utility intent-birth` as a rule-based scanner. The aidlc-developer-agent is no longer involved in Initialization.

## Stages Led

| Stage | Phase | Description |
|-------|-------|-------------|
| 2.1 Reverse Engineering (code scan) | Inception | Deep code scan producing structured analysis for architect synthesis |
| 3.5 Code Generation | Construction | Implements units of work from design specifications (per unit) |

## Stages Supported

| Stage | Phase | Contribution |
|-------|-------|-------------|
| 2.2 Practices Discovery | Inception | Mutually blind code-pattern spoke; writes its own contribution file |
| 2.4 User Stories | Inception | Implementability voice in the mob ensemble; writes its own contribution file |
| 3.1 Functional Design | Construction | API contracts and data model input |
| 4.3 Deployment Execution | Operation | Database migrations |

## What to Expect

During Code Generation, the aidlc-developer-agent runs as a subagent — you will not interact with it directly. You see a progress indicator and then the results when it completes. The orchestrator first presents a code generation plan for your approval, then the subagent implements each step.

Application code is written directly to the workspace root (not into the intent's record dir). The `code-summary.md` artifact in the intent's record dir documents what was created or modified.

## How It Collaborates

The aidlc-developer-agent receives unit specifications and design patterns from the aidlc-architect-agent, and test requirements from the aidlc-quality-agent. It works with the aidlc-aws-platform-agent on CDK/infrastructure alignment and the aidlc-devsecops-agent on secure coding. Its code scan results feed the aidlc-architect-agent for synthesis, and its implemented code is handed off to the aidlc-quality-agent for testing.

## Key Principles

- Deliver functional, tested implementations — refactor in subsequent iterations
- Follow the project's existing patterns and conventions
- Write code that is easy to read and debug — avoid clever abstractions
- Validate inputs early, throw meaningful errors, never swallow exceptions
- Every generated unit includes at least a happy-path test
- In reverse engineering, thoroughness of the scan determines quality of the synthesis
