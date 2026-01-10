# AI-DLC Platform Integration Guide

This document provides detailed information about how AI-DLC integrates with various AI coding assistants and development platforms.

## Supported Platforms

AI-DLC supports 12 different AI coding platforms, each with its own integration pattern and usage method.

### Platform Overview

| Platform | Configuration Path | Activation Method | Auto-Execution | Shared Data |
|----------|-------------------|-------------------|-----------------|-------------|
| **Kiro CLI** | `.kiro/steering/` | Manual inclusion | No | ✅ |
| **Amazon Q Developer** | `.amazonq/rules/` | Rules button | No | ✅ |
| **Claude Code** | `.claude/skills/` | Auto-activation | Yes | ✅ |
| **Cursor** | `.cursor/commands/` | `/ai-dlc` command | No | ✅ |
| **Windsurf** | `.windsurf/workflows/` | `/ai-dlc` workflow | Yes (mode 3) | ✅ |
| **Antigravity** | `.agent/workflows/` | `/ai-dlc` workflow | Yes (mode 3) | ✅ |
| **GitHub Copilot** | `.github/prompts/` | `/ai-dlc` in VS Code | No | ✅ |
| **OpenAI Codex** | `.codex/skills/` | `$ai-dlc` skill | No | ❌ |
| **Gemini CLI** | `.gemini/skills/` | Auto-activation | Yes | ✅ |
| **Qoder** | `.qoder/rules/` | Always-on trigger | Yes | ✅ |
| **Roo** | `.roo/commands/` | `/ai-dlc` command | No | ✅ |
| **CodeBuddy** | `.codebuddy/commands/` | `/ai-dlc` command | No | ✅ |

## Platform-Specific Details

### 1. Kiro CLI
```
Configuration: .kiro/steering/aws-aidlc-rules/
Details: .kiro/aws-aidlc-rule-details/
Usage: Manual inclusion with #ai-dlc
Activation: "Using AI-DLC, ..."
```

**Features:**
- Manual control over when rules are loaded
- Full access to detailed rule documentation
- Integration with Kiro's steering system

**Setup:**
```bash
aidlc init --platform kiro
kiro-cli
/context show  # Verify rules are loaded
```

### 2. Amazon Q Developer
```
Configuration: .amazonq/rules/aws-aidlc-rules/
Details: .amazonq/aws-aidlc-rule-details/
Usage: Rules button in Q Chat
Activation: "Using AI-DLC, ..."
```

**Features:**
- IDE integration through VS Code extension
- Project-level rules system
- Automatic context loading

**Setup:**
```bash
aidlc init --platform amazonq
# Check Rules button in Amazon Q Chat window
```

### 3. Claude Code
```
Configuration: .claude/skills/aws-aidlc-rules/
Details: .claude/aws-aidlc-rule-details/
Usage: Auto-activation on keyword
Activation: "Using AI-DLC, ..."
```

**Features:**
- Skills-based architecture
- Automatic activation on keyword detection
- SKILL.md definition file
- Full workflow automation

**Setup:**
```bash
aidlc init --platform claude
# Skill auto-activates when you mention "Using AI-DLC"
```

### 4. Cursor
```
Configuration: .cursor/commands/aws-aidlc-rules.md
Details: .cursor/aws-aidlc-rule-details/
Usage: Slash command
Activation: /ai-dlc <request>
```

**Features:**
- Command-based activation
- AI-first editor integration
- Project context awareness

**Setup:**
```bash
aidlc init --platform cursor
# Use: /ai-dlc I want to build a user authentication system
```

### 5. Windsurf
```
Configuration: .windsurf/workflows/aws-aidlc-rules.md
Details: .windsurf/aws-aidlc-rule-details/
Usage: Workflow with auto-execution
Activation: /ai-dlc <request>
```

**Features:**
- Workflow-based architecture
- Auto-execution mode 3 (streamlined with oversight)
- Advanced AI capabilities
- YAML frontmatter configuration

**Setup:**
```bash
aidlc init --platform windsurf
# Use: /ai-dlc I want to optimize my database queries
```

### 6. Antigravity
```
Configuration: .agent/workflows/aws-aidlc-rules.md
Details: .agent/aws-aidlc-rule-details/
Usage: Agent workflow with auto-execution
Activation: /ai-dlc <request>
```

**Features:**
- Advanced agent-based workflows
- Auto-execution mode 3
- Sophisticated AI reasoning
- Multi-phase execution

**Setup:**
```bash
aidlc init --platform antigravity
# Use: /ai-dlc I need to refactor my microservices architecture
```

### 7. GitHub Copilot
```
Configuration: .github/prompts/aws-aidlc-rules.prompt.md
Details: .github/aws-aidlc-rule-details/
Usage: VS Code prompt
Activation: /ai-dlc <request>
```

**Features:**
- VS Code integration
- Prompt-based activation
- GitHub ecosystem integration
- Team collaboration features

**Setup:**
```bash
aidlc init --platform copilot
# Use in VS Code: /ai-dlc I want to add CI/CD pipeline
```

### 8. OpenAI Codex
```
Configuration: .codex/skills/aws-aidlc-rules/
Details: .codex/aws-aidlc-rule-details/
Usage: Skill system
Activation: $ai-dlc <request>
```

**Features:**
- Skills-based architecture
- OpenAI API integration
- Custom implementation support
- No shared data dependency

**Setup:**
```bash
aidlc init --platform codex
# Use: $ai-dlc I want to implement machine learning pipeline
```

### 9. Gemini CLI
```
Configuration: .gemini/skills/aws-aidlc-rules/
Details: .gemini/aws-aidlc-rule-details/
Usage: Auto-activation skill
Activation: "Using AI-DLC, ..."
```

**Features:**
- Google AI integration
- Multi-modal understanding
- Auto-activation on keywords
- Advanced reasoning capabilities

**Setup:**
```bash
aidlc init --platform gemini
# Auto-activates: "Using AI-DLC, I want to create a mobile app"
```

### 10. Qoder
```
Configuration: .qoder/rules/aws-aidlc-rules.md
Details: .qoder/aws-aidlc-rule-details/
Usage: Always-on rules
Activation: "Using AI-DLC, ..." (always listening)
```

**Features:**
- Always-on trigger system
- Continuous monitoring
- Intelligent coding environment
- YAML frontmatter with trigger configuration

**Setup:**
```bash
aidlc init --platform qoder
# Always active - just mention "Using AI-DLC" in any context
```

### 11. Roo
```
Configuration: .roo/commands/aws-aidlc-rules.md
Details: .roo/aws-aidlc-rule-details/
Usage: Command system
Activation: /ai-dlc <request>
```

**Features:**
- Command-based architecture
- Coding assistant integration
- Project context awareness
- Structured workflow execution

**Setup:**
```bash
aidlc init --platform roo
# Use: /ai-dlc I want to implement caching layer
```

### 12. CodeBuddy
```
Configuration: .codebuddy/commands/aws-aidlc-rules.md
Details: .codebuddy/aws-aidlc-rule-details/
Usage: Collaborative commands
Activation: /ai-dlc <request>
```

**Features:**
- Collaborative coding environment
- Team-oriented workflows
- Command-based activation
- Educational features

**Setup:**
```bash
aidlc init --platform codebuddy
# Use: /ai-dlc I need help with code review process
```

## Installation Methods

### Single Platform
```bash
# Install for specific platform
aidlc init --platform claude
aidlc init --platform cursor
aidlc init --platform windsurf
```

### Multiple Platforms
```bash
# Install for multiple specific platforms
aidlc init --platform kiro,claude,cursor

# Install for all platforms
aidlc init --platform all

# Legacy: Install for Kiro + Amazon Q
aidlc init --platform both
```

### Interactive Setup
```bash
# Use interactive wizard
aidlc setup
```

## File Structure

Each platform creates its own configuration structure:

```
your-project/
├── .kiro/
│   ├── steering/aws-aidlc-rules/
│   └── aws-aidlc-rule-details/
├── .amazonq/
│   ├── rules/aws-aidlc-rules/
│   └── aws-aidlc-rule-details/
├── .claude/
│   ├── skills/aws-aidlc-rules/
│   │   └── SKILL.md
│   └── aws-aidlc-rule-details/
├── .cursor/
│   ├── commands/aws-aidlc-rules.md
│   └── aws-aidlc-rule-details/
├── .windsurf/
│   ├── workflows/aws-aidlc-rules.md
│   └── aws-aidlc-rule-details/
├── .agent/
│   ├── workflows/aws-aidlc-rules.md
│   └── aws-aidlc-rule-details/
├── .github/
│   ├── prompts/aws-aidlc-rules.prompt.md
│   └── aws-aidlc-rule-details/
├── .codex/
│   ├── skills/aws-aidlc-rules/
│   │   └── SKILL.md
│   └── aws-aidlc-rule-details/
├── .gemini/
│   ├── skills/aws-aidlc-rules/
│   │   └── SKILL.md
│   └── aws-aidlc-rule-details/
├── .qoder/
│   ├── rules/aws-aidlc-rules.md
│   └── aws-aidlc-rule-details/
├── .roo/
│   ├── commands/aws-aidlc-rules.md
│   └── aws-aidlc-rule-details/
├── .codebuddy/
│   ├── commands/aws-aidlc-rules.md
│   └── aws-aidlc-rule-details/
└── aidlc-docs/                    # Generated during workflow
    ├── inception/
    ├── construction/
    ├── operations/
    ├── aidlc-state.md
    └── audit.md
```

## Usage Patterns

### Command-Based Platforms
- **Cursor**: `/ai-dlc <request>`
- **Windsurf**: `/ai-dlc <request>`
- **Antigravity**: `/ai-dlc <request>`
- **GitHub Copilot**: `/ai-dlc <request>`
- **Roo**: `/ai-dlc <request>`
- **CodeBuddy**: `/ai-dlc <request>`

### Skill-Based Platforms
- **Claude Code**: Auto-activates on "Using AI-DLC, ..."
- **Codex**: `$ai-dlc <request>`
- **Gemini CLI**: Auto-activates on "Using AI-DLC, ..."

### Rule-Based Platforms
- **Kiro CLI**: Manual inclusion, then "Using AI-DLC, ..."
- **Amazon Q**: Rules button, then "Using AI-DLC, ..."
- **Qoder**: Always-on, responds to "Using AI-DLC, ..."

## Advanced Features

### Auto-Execution Modes
Some platforms support auto-execution for streamlined workflows:

- **Windsurf**: `auto_execution_mode: 3`
- **Antigravity**: `auto_execution_mode: 3`
- **Qoder**: `trigger: always_on`

### Shared Data Integration
Most platforms (except Codex) share common rule details in `aws-aidlc-rule-details/`:

- Common workflow definitions
- Process overviews
- Question format guides
- Content validation rules
- Session continuity guidelines

### Platform-Specific Configurations

#### YAML Frontmatter Examples

**Windsurf/Antigravity:**
```yaml
---
description: AI-Driven Development Life Cycle workflow
auto_execution_mode: 3
---
```

**Qoder:**
```yaml
---
trigger: always_on
---
```

**Kiro:**
```yaml
---
inclusion: manual
---
```

## Best Practices

### 1. Platform Selection
- **Local Development**: Kiro CLI, Cursor
- **IDE Integration**: Amazon Q, GitHub Copilot
- **Advanced AI**: Claude Code, Windsurf, Antigravity, Gemini CLI
- **Team Collaboration**: CodeBuddy, GitHub Copilot
- **Always-On**: Qoder
- **API Integration**: Codex

### 2. Multi-Platform Setup
```bash
# Recommended combinations
aidlc init --platform kiro,claude,cursor    # Local + AI + Editor
aidlc init --platform amazonq,copilot       # IDE integration
aidlc init --platform windsurf,antigravity  # Advanced AI workflows
```

### 3. Validation
```bash
# Check installation status
aidlc status --verbose

# Validate configuration
aidlc validate --fix
```

### 4. Maintenance
```bash
# Update all platforms
aidlc init --platform all --force

# Update specific platforms
aidlc init --platform claude,cursor --force
```

## Troubleshooting

### Common Issues

1. **Platform Not Detected**
   ```bash
   aidlc status --verbose  # Check detection
   ```

2. **Rules Not Loading**
   ```bash
   aidlc validate --fix    # Repair installation
   ```

3. **Missing Files**
   ```bash
   aidlc init --force      # Reinstall
   ```

### Platform-Specific Issues

- **Kiro**: Check `/context show` output
- **Amazon Q**: Verify Rules button shows loaded rules
- **Claude Code**: Ensure SKILL.md exists
- **Cursor**: Verify command file exists
- **Windsurf/Antigravity**: Check YAML frontmatter
- **Codex**: Verify skill activation syntax

## Integration Examples

### Example 1: Full Stack Development
```bash
# Set up for comprehensive development
aidlc init --platform kiro,claude,cursor,copilot

# Use different platforms for different tasks:
# - Kiro CLI for planning and architecture
# - Claude Code for complex logic implementation  
# - Cursor for rapid prototyping
# - GitHub Copilot for code completion
```

### Example 2: Team Collaboration
```bash
# Set up for team environment
aidlc init --platform amazonq,copilot,codebuddy

# Benefits:
# - Amazon Q for IDE integration
# - GitHub Copilot for version control integration
# - CodeBuddy for collaborative coding sessions
```

### Example 3: AI-First Development
```bash
# Set up for advanced AI workflows
aidlc init --platform claude,windsurf,antigravity,gemini

# Benefits:
# - Multiple AI models and approaches
# - Auto-execution capabilities
# - Advanced reasoning and planning
```

This integration guide provides the foundation for using AI-DLC across multiple AI coding platforms, enabling developers to choose the best tools for their specific needs and workflows.