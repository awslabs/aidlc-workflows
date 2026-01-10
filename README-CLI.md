# AIDLC CLI Tool

AI-Driven Development Life Cycle (AI-DLC) CLI tool for intelligent software development workflows.

## Installation

Install globally via npm:

```bash
npm install -g aidlc
```

Or use with npx:

```bash
npx aidlc --help
```

## Quick Start

1. **Initialize AI-DLC in your project:**
   ```bash
   cd your-project
   aidlc init
   ```

2. **Check installation status:**
   ```bash
   aidlc status
   ```

3. **Validate configuration:**
   ```bash
   aidlc validate
   ```

4. **Start development with AI-DLC:**
   - Open your preferred AI coding assistant (Kiro CLI or Amazon Q Developer)
   - Begin any request with: `"Using AI-DLC, ..."`
   - Follow the structured workflow

## Commands

### `aidlc init`

Initialize AI-DLC in your current project.

```bash
aidlc init [options]

Options:
  -p, --platform <platform>  Target platform (kiro|amazonq|claude|cursor|windsurf|antigravity|copilot|codex|gemini|qoder|roo|codebuddy|both|all) (default: "all")
  -f, --force                Force initialization even if files exist
  --no-interactive          Skip interactive prompts
  -h, --help                Display help for command
```

**Examples:**
```bash
# Initialize for all platforms (default)
aidlc init

# Initialize only for Kiro CLI
aidlc init --platform kiro

# Initialize for multiple specific platforms
aidlc init --platform kiro,claude,cursor

# Initialize for all platforms explicitly
aidlc init --platform all

# Force overwrite existing files
aidlc init --force

# Non-interactive mode
aidlc init --no-interactive --platform all
```

### `aidlc setup`

Interactive setup wizard for comprehensive AI-DLC configuration.

```bash
aidlc setup
```

This command will:
- Detect your development environment
- Provide platform-specific recommendations
- Configure AI-DLC for your project type
- Set up .gitignore entries
- Create usage documentation

### `aidlc status`

Show AI-DLC installation and project status.

```bash
aidlc status [options]

Options:
  -v, --verbose  Show detailed information
  -h, --help     Display help for command
```

**Example output:**
```
📊 AI-DLC Status Report
┌─────────────────────────────────────┐
│                                     │
│   📊 AI-DLC Status Report           │
│                                     │
└─────────────────────────────────────┘

📁 Project Directory:
   /Users/developer/my-project

🔧 Installation Status:
   Kiro CLI Rules: ✅ Installed
   Amazon Q Rules: ✅ Installed
   Claude Code Rules: ✅ Installed
   Cursor Rules: ❌ Not installed
   Codex Rules: ❌ Not installed
   Antigravity Rules: ❌ Not installed

🌍 Environment:
   Node.js: v18.17.0
   Platform: darwin
   Kiro CLI: ✅ Available
   Amazon Q: ✅ Available
   Claude Code: ✅ Available
   Cursor: ❌ Not found
   Codex: ❌ Not found
   Antigravity: ❌ Not found
   Git Repository: ✅ Yes

📋 Project Status:
   AI-DLC Docs: ✅ Found
   State File: ✅ Found
   Audit Log: ✅ Found

✅ Validation:
   ✅ Installation is valid and ready to use
```

### `aidlc validate`

Validate AI-DLC installation and configuration.

```bash
aidlc validate [options]

Options:
  --fix      Attempt to fix common issues automatically
  -h, --help Display help for command
```

This command checks:
- Installation completeness
- File integrity
- Environment compatibility
- Project configuration
- Workflow state (if exists)

### `aidlc version`

Show version information.

```bash
aidlc version [options]

Options:
  --json     Output version information as JSON
  -h, --help Display help for command
```

## Platform Support

AI-DLC integrates with 12 different AI coding assistants and development platforms:

### Kiro CLI

AI-DLC integrates with [Kiro CLI](https://kiro.dev/cli/) using steering files:

- **Rules location:** `.kiro/steering/aws-aidlc-rules/`
- **Details location:** `.kiro/aws-aidlc-rule-details/`
- **Usage:** Start Kiro CLI and use `/context show` to verify rules are loaded
- **Activation:** Manual inclusion, then "Using AI-DLC, ..."

### Amazon Q Developer

AI-DLC integrates with [Amazon Q Developer](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/) using project rules:

- **Rules location:** `.amazonq/rules/aws-aidlc-rules/`
- **Details location:** `.amazonq/aws-aidlc-rule-details/`
- **Usage:** Check the Rules button in Amazon Q Chat window
- **Activation:** "Using AI-DLC, ..."

### Claude Code

AI-DLC integrates with Claude Code (Anthropic's coding assistant):

- **Rules location:** `.claude/skills/aws-aidlc-rules/`
- **Details location:** `.claude/aws-aidlc-rule-details/`
- **Usage:** Auto-activated skill system
- **Activation:** "Using AI-DLC, ..." (automatic)

### Cursor

AI-DLC integrates with [Cursor](https://cursor.sh/) (AI-first code editor):

- **Rules location:** `.cursor/commands/aws-aidlc-rules.md`
- **Details location:** `.cursor/aws-aidlc-rule-details/`
- **Usage:** Slash command system
- **Activation:** `/ai-dlc <your request>`

### Windsurf

AI-DLC integrates with Windsurf (Advanced AI workflows):

- **Rules location:** `.windsurf/workflows/aws-aidlc-rules.md`
- **Details location:** `.windsurf/aws-aidlc-rule-details/`
- **Usage:** Workflow system with auto-execution mode 3
- **Activation:** `/ai-dlc <your request>`

### Antigravity

AI-DLC integrates with Antigravity (Advanced AI coding assistant):

- **Rules location:** `.agent/workflows/aws-aidlc-rules.md`
- **Details location:** `.agent/aws-aidlc-rule-details/`
- **Usage:** Agent workflow with auto-execution mode 3
- **Activation:** `/ai-dlc <your request>`

### GitHub Copilot

AI-DLC integrates with GitHub Copilot through VS Code prompts:

- **Rules location:** `.github/prompts/aws-aidlc-rules.prompt.md`
- **Details location:** `.github/aws-aidlc-rule-details/`
- **Usage:** VS Code prompt system
- **Activation:** `/ai-dlc <your request>`

### OpenAI Codex

AI-DLC integrates with OpenAI Codex through API integration:

- **Rules location:** `.codex/skills/aws-aidlc-rules/`
- **Details location:** `.codex/aws-aidlc-rule-details/`
- **Usage:** Skill system
- **Activation:** `$ai-dlc <your request>`

### Gemini CLI

AI-DLC integrates with Google's Gemini CLI:

- **Rules location:** `.gemini/skills/aws-aidlc-rules/`
- **Details location:** `.gemini/aws-aidlc-rule-details/`
- **Usage:** Auto-activated skill system
- **Activation:** "Using AI-DLC, ..." (automatic)

### Qoder

AI-DLC integrates with Qoder (Always-on AI assistant):

- **Rules location:** `.qoder/rules/aws-aidlc-rules.md`
- **Details location:** `.qoder/aws-aidlc-rule-details/`
- **Usage:** Always-on rule system
- **Activation:** "Using AI-DLC, ..." (always listening)

### Roo

AI-DLC integrates with Roo coding assistant:

- **Rules location:** `.roo/commands/aws-aidlc-rules.md`
- **Details location:** `.roo/aws-aidlc-rule-details/`
- **Usage:** Command system
- **Activation:** `/ai-dlc <your request>`

### CodeBuddy

AI-DLC integrates with CodeBuddy (Collaborative coding):

- **Rules location:** `.codebuddy/commands/aws-aidlc-rules.md`
- **Details location:** `.codebuddy/aws-aidlc-rule-details/`
- **Usage:** Collaborative command system
- **Activation:** `/ai-dlc <your request>`

## AI-DLC Workflow

### Three-Phase Adaptive Workflow

AI-DLC follows a structured approach that adapts to your project's complexity:

#### 🔵 INCEPTION PHASE
**Purpose:** Determines **WHAT** to build and **WHY**

- Workspace Detection (always)
- Reverse Engineering (brownfield only)
- Requirements Analysis (adaptive depth)
- User Stories (conditional)
- Workflow Planning (always)
- Application Design (conditional)
- Units Generation (conditional)

#### 🟢 CONSTRUCTION PHASE
**Purpose:** Determines **HOW** to build it

Per-unit execution:
- Functional Design (conditional)
- NFR Requirements (conditional)
- NFR Design (conditional)
- Infrastructure Design (conditional)
- Code Generation (always)

Final step:
- Build and Test (always)

#### 🟡 OPERATIONS PHASE
**Purpose:** Deployment and monitoring (future)

- Operations (placeholder for future expansion)

### Key Principles

- **Adaptive Execution:** Only execute stages that add value
- **User Control:** Review and approve each phase
- **Quality Focus:** Complex changes get comprehensive treatment
- **Transparent Planning:** Always show execution plan before starting

## Project Structure

After initialization, your project will have:

```
your-project/
├── .kiro/                          # Kiro CLI integration
│   ├── steering/
│   │   └── aws-aidlc-rules/
│   └── aws-aidlc-rule-details/
├── .amazonq/                       # Amazon Q integration
│   ├── rules/
│   │   └── aws-aidlc-rules/
│   └── aws-aidlc-rule-details/
└── aidlc-docs/                     # Generated during workflow
    ├── inception/
    ├── construction/
    ├── operations/
    ├── aidlc-state.md
    └── audit.md
```

## Usage Examples

### Starting a New Feature

```bash
# Initialize AI-DLC
aidlc init

# Check status
aidlc status

# In your AI assistant (Kiro CLI or Amazon Q):
# "Using AI-DLC, I want to add user authentication to my web application"
```

### Working on Existing Project

```bash
# Check current status
aidlc status --verbose

# Validate configuration
aidlc validate

# Continue with AI assistant:
# "Using AI-DLC, I need to optimize the database queries in the user service"
```

### Troubleshooting

```bash
# Validate and fix issues
aidlc validate --fix

# Reinitialize if needed
aidlc init --force

# Check detailed status
aidlc status --verbose
```

## Environment Requirements

- **Node.js:** Version 16.0.0 or higher
- **Platform:** macOS, Linux, or Windows
- **AI Assistant:** Kiro CLI or Amazon Q Developer IDE plugin

## Configuration

### .gitignore Integration

AI-DLC automatically adds these entries to your `.gitignore`:

```gitignore
# AI-DLC generated files
aidlc-docs/
.aidlc-temp/
```

### Project Types

AI-DLC adapts to different project types:

- **Web Application:** Frontend/Backend architecture focus
- **API/Microservice:** API design and service architecture
- **Library/Package:** Public API design and documentation
- **Data Processing:** Pipeline design and analytics architecture
- **Infrastructure:** Infrastructure design and operational concerns
- **General:** Adapts to specific project needs

## Troubleshooting

### Common Issues

1. **"No AI-DLC installation found"**
   ```bash
   aidlc init
   ```

2. **"Missing rule files"**
   ```bash
   aidlc validate --fix
   ```

3. **"Kiro CLI not found"**
   - Install Kiro CLI: Follow [installation guide](https://kiro.dev/cli/)
   - Or use Amazon Q Developer instead

4. **"Rules not loading in IDE"**
   - Check file paths with `aidlc status --verbose`
   - Restart your IDE/AI assistant
   - Verify rules location matches platform requirements

### Getting Help

- **Documentation:** [AI-DLC Blog Post](https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/)
- **Method Paper:** [AI-DLC Method Definition](https://prod.d13rzhkk8cj2z0.amplifyapp.com/)
- **Kiro CLI:** [Kiro Documentation](https://kiro.dev/docs/)
- **Amazon Q:** [Amazon Q Developer Guide](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/)

## Contributing

This project follows the AI-DLC methodology. To contribute:

1. Fork the repository
2. Initialize AI-DLC: `aidlc init`
3. Start development: "Using AI-DLC, I want to contribute..."
4. Follow the structured workflow
5. Submit pull request with generated documentation

## License

This project is licensed under the MIT-0 License. See the [LICENSE](LICENSE) file for details.