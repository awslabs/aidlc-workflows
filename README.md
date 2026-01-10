# AI-DLC (AI-Driven Development Life Cycle)

AI-DLC is an intelligent software development workflow that adapts to your needs, maintains quality standards, and keeps you in control of the process. For learning more about AI-DLC Methodology, read this [blog](https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/) and the [Method Definition Paper](https://prod.d13rzhkk8cj2z0.amplifyapp.com/) referred in it.

## Quick Start

Set up the AI-DLC rules/steering files as part of your [supported platform](#prerequisites).

Clone this repo:
```bash
git clone <this-repo>
```

Create a new project folder with a name of your choosing if you're working on a greenfield application:
```
mkdir <my-project>
```

Assuming your project is located under the same parent folder as the cloned `aidlc-workflows`
repo, change directory to your project folder:
```bash
cd <my-project>
```

### Amazon Q Developer IDE Plugin/Extension

AI-DLC uses [Amazon Q Rules](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/context-project-rules.html) to implement its intelligent workflow. To activate AI-DLC in your project, copy the rules to your project's workspace under the `<project-root>/.amazonq` folder.

Copy the AI-DLC workflow to your project's workspace under the `<project-root>/.amazonq` folder:
```
mkdir -p .amazonq/rules 
cp -R ../aidlc-workflows/aidlc-rules/aws-aidlc-rules .amazonq/rules/ 
cp -R ../aidlc-workflows/aidlc-rules/aws-aidlc-rule-details .amazonq/
```

To confirm that the Amazon Q Rules are correctly loaded in your IDE, follow these steps:

1. In the Amazon Q Chat window, locate the `Rules` button in the lower right corner and click on it.
2. Verify that you see entries for `.amazonq/rules/aws-aidlc-rules` in the displayed list of rules.

If you do not see the `aws-aidlc-rules` rules loaded, please check the directory where you previously issued the `mkdir` and `cp` commands.  

![AI-DLC Rules in Q Developer IDE](./assets/images/q-ide-aidlc-rules-loaded.png?raw=true "AI-DLC Rules in Q Developer")

### Kiro CLI

AI-DLC uses [Kiro Steering Files](https://kiro.dev/docs/cli/steering/) within your project workspace to implement its intelligent workflow. To activate AI-DLC in your project, copy the rules to your project's workspace under the `<your-project-root>/.kiro/steering` folder.

Copy the AI-DLC workflow to your project's workspace under the `<project-root>/.kiro` folder:

```bash
mkdir -p .kiro/steering
cp -R ../aidlc-workflows/aidlc-rules/aws-aidlc-rules .kiro/steering/
cp -R ../aidlc-workflows/aidlc-rules/aws-aidlc-rule-details .kiro/
```

To confirm that the AI-DLC rules are correctly loaded in your Kiro CLI, follow these steps:

1. Start Kiro CLI: `kiro-cli`
2. Check your context contents: `/context show`
3. Verify that you see all entries for `.kiro/steering/aws-aidlc-rules` in the displayed list of rules.

If you do not see the `aws-aidlc-rules` rules loaded, please check the directory where you previously issued the `mkdir` and `cp` commands.  

![AI-DLC Rules in Kiro CLI](./assets/images/kiro-cli-aidlc-rules-loaded.png?raw=true "AI-DLC Rules in Kiro CLI")

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
- **Multi-User Parallel Development**: Multiple developers can work on different units simultaneously with automatic branch management and audit isolation

## Project Configuration

### AGENTS.md (Optional)

Customize multi-user behavior and folder structure by creating an `AGENTS.md` file in your project root:

```bash
cp $AIDLC_WORKFLOWS/AGENTS.md.example ./AGENTS.md
```

This file allows you to configure:
- Generated code folder structure per unit
- Audit file locations
- Branch naming conventions
- Custom paths for your project

See [AGENTS.md.example](AGENTS.md.example) for details.

## Multi-User Parallel Development

AI-DLC includes built-in team collaboration with automatic workflow management:

- 🔀 **Automatic Branch Creation**: Each developer works in isolated branches
- 📝 **User-Scoped Audits**: No audit file conflicts between team members
- 🎯 **Unit Assignment Tracking**: Clear visibility of who's working on what
- 🔄 **Dependency-Aware Consolidation**: Automatic merging in correct order
- 📊 **Consolidated Views**: Project-wide visibility with automatic indexing

**Quick Start**:
```bash
# Lead completes inception
kiro-cli chat "Create microservices architecture"
# → Choose "Enable team collaboration"

# Team members claim units
kiro-cli chat "claim unit user-service"

# Integrator consolidates
kiro-cli chat "consolidate units"
```

Multi-user functionality is automatically available when using AI-DLC - no additional setup required.

**Learn More**: See [Quick Reference](QUICK-REFERENCE.md) for commands and workflows

## Prerequisites

Have one of our supported platforms/tools for Assisted AI Coding installed:

- [Kiro CLI](https://kiro.dev/cli/)
- [Amazon Q Developer IDE plugin](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/q-in-IDE.html)
- [Kiro IDE](https://kiro.dev/) (coming soon)

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This library is licensed under the MIT-0 License. See the LICENSE file.
