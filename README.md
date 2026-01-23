# AI-DLC (AI-Driven Development Life Cycle)

AI-DLC is an intelligent software development workflow that adapts to your needs, maintains quality standards, and keeps you in control of the process. For learning more about AI-DLC Methodology, read this [blog](https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/) and the [Method Definition Paper](https://prod.d13rzhkk8cj2z0.amplifyapp.com/) referred in it.

## Quick Start

### Automatic Installation (Recommended)

The easiest way to install AI-DLC is using npx:

```bash
cd <your-project>
npx aidlc install
```

This will prompt you to select your platform (Amazon Q Developer IDE, Kiro CLI, or Kiro IDE) and automatically install the rules to the correct location.

**Options:**
- `--path <directory>` - Install to a specific directory
- `--force` - Skip confirmation prompts

**Uninstall:**
```bash
npx aidlc uninstall
```

### Manual Installation

If you prefer to install manually, clone this repo and copy the files:

```bash
git clone <this-repo>
cd <your-project>
```

### Amazon Q Developer IDE Plugin/Extension

```bash
mkdir -p .amazonq/rules
cp -R ../aidlc-workflows/aidlc-rules/aws-aidlc-rules .amazonq/rules/
cp -R ../aidlc-workflows/aidlc-rules/aws-aidlc-rule-details .amazonq/
```

#### Kiro CLI / Kiro IDE

```bash
mkdir -p .kiro/steering
cp -R ../aidlc-workflows/aidlc-rules/aws-aidlc-rules .kiro/steering/
cp -R ../aidlc-workflows/aidlc-rules/aws-aidlc-rule-details .kiro/
```

## Verification

### Amazon Q Developer IDE Plugin/Extension

1. In the Amazon Q Chat window, locate the `Rules` button in the lower right corner and click on it.
2. Verify that you see entries for `.amazonq/rules/aws-aidlc-rules` in the displayed list of rules.

![AI-DLC Rules in Q Developer](./assets/images/q-ide-aidlc-rules-loaded.png?raw=true "AI-DLC Rules in Q Developer")

### Kiro CLI

1. Start Kiro CLI: `kiro-cli`
2. Check your context contents: `/context show`
3. Verify that you see all entries for `.kiro/steering/aws-aidlc-rules` in the displayed list of rules.

![AI-DLC Rules in Kiro CLI](./assets/images/kiro-cli-aidlc-rules-loaded.png?raw=true "AI-DLC Rules in Kiro CLI")

### Kiro IDE

1. Open Kiro IDE
2. In the left sidebar, expand the "AGENT STEERING" section
3. Verify that you see `core-workflow` under the Workspace steering files
4. You can open it and see the content of the steering document

![AI-DLC Rules in Kiro IDE](./assets/images/kiro-ide-aidlc-rules-loaded.png?raw=true "AI-DLC Rules in Kiro IDE")

### Usage

1. Start any software development project by stating your intent starting with the phrase "Using AI-DLC, ..." in the chat.
2. AI-DLC workflow automatically activates and guides you from there.
3. Answer structured questions that AI-DLC asks you
4. Carefully review every plan that AI generates. Provide your oversight and validation.
5. Review the execution plan to see which stages will run
6. Carefully review the artifacts and approve each stage to maintain control
7. All the artifacts will be generated in the `aidlc-docs/` directory

## Three-Phase Adaptive Workflow

AI-DLC follows a structured three-phase approach that adapts to your project's complexity:

- **🔵 INCEPTION PHASE**: Determines **WHAT** to build and **WHY**
  - Requirements analysis and validation
  - User story creation (when applicable)
  - Application Design and creating units of work for parallel development
  - Risk assessment and complexity evaluation

- **🟢 CONSTRUCTION PHASE**: Determines **HOW** to build it
  - Detailed component design
  - Code generation and implementation
  - Build configuration and testing strategies
  - Quality assurance and validation

- **🟡 OPERATIONS PHASE**: Deployment and monitoring (future)
  - Deployment automation and infrastructure
  - Monitoring and observability setup
  - Production readiness validation

## Key Features

- **Adaptive Intelligence**: Only executes stages that add value to your specific request
- **Context-Aware**: Analyzes existing codebase and complexity requirements
- **Risk-Based**: Complex changes get comprehensive treatment, simple changes stay efficient
- **Question-Driven**: Structured multiple-choice questions in files, not chat
- **Always in Control**: Review execution plans and approve each phase

## Prerequisites

Have one of our supported platforms/tools for Assisted AI Coding installed:

- [Kiro CLI](https://kiro.dev/cli/)
- [Kiro IDE](https://kiro.dev/)
- [Amazon Q Developer IDE plugin](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/q-in-IDE.html)

## Tenets

These are our core principles to guide our decision making.

- **No duplication**. The source of truth lives in one place. If we add support for new tools or formats that require specific files, we generate them from the source rather than maintaining separate copies.

- **Methodology first**. AI-DLC is fundamentally a methodology, not a tool. Users shouldn't need to install anything to get started. That said, we're open to convenience tooling (scripts, CLIs) down the road if it helps users adopt or extend the methodology.

- **Reproducible**. Rules should be clear enough that different models produce similar outcomes. We know models behave differently, but the methodology should minimize variance through explicit guidance.

- **Agnostic**. The methodology works with any IDE, agent, or model. We don't tie ourselves to specific tools or vendors.

- **Human in the loop**. Critical decisions require explicit user confirmation. The agent proposes, the human approves.

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This library is licensed under the MIT-0 License. See the LICENSE file.
