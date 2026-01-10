import * as fs from 'fs-extra';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { FileService } from './file-service';

const execAsync = promisify(exec);

export interface InstallationStatus {
  hasKiro: boolean;
  hasAmazonQ: boolean;
  hasClaudeCode: boolean;
  hasCursor: boolean;
  hasWindsurf: boolean;
  hasAntigravity: boolean;
  hasGitHubCopilot: boolean;
  hasCodex: boolean;
  hasGeminiCLI: boolean;
  hasQoder: boolean;
  hasRoo: boolean;
  hasCodeBuddy: boolean;
  kiroPath?: string;
  amazonqPath?: string;
  claudeCodePath?: string;
  cursorPath?: string;
  windsurfPath?: string;
  antigravityPath?: string;
  githubCopilotPath?: string;
  codexPath?: string;
  geminiCLIPath?: string;
  qoderPath?: string;
  rooPath?: string;
  codeBuddyPath?: string;
}

export interface Environment {
  nodeVersion: string;
  platform: string;
  hasKiroCli: boolean;
  hasAmazonQ: boolean;
  hasClaudeCode: boolean;
  hasCursor: boolean;
  hasWindsurf: boolean;
  hasAntigravity: boolean;
  hasGitHubCopilot: boolean;
  hasCodex: boolean;
  hasGeminiCLI: boolean;
  hasQoder: boolean;
  hasRoo: boolean;
  hasCodeBuddy: boolean;
  isGitRepo: boolean;
}

export interface ValidationResult {
  isValid: boolean;
  issues: string[];
  warnings?: string[];
}

export interface WorkflowPhase {
  name: string;
  completed: boolean;
  inProgress: boolean;
  skipped: boolean;
}

export class AidlcService {
  private fileService: FileService;
  
  constructor() {
    this.fileService = new FileService();
  }
  
  /**
   * 检查现有的 AI-DLC 安装
   */
  async checkExistingInstallation(): Promise<InstallationStatus> {
    const kiroRulesPath = '.kiro/steering/aws-aidlc-rules';
    const amazonqRulesPath = '.amazonq/rules/aws-aidlc-rules';
    const claudeCodeRulesPath = '.claude/skills/aws-aidlc-rules';
    const cursorRulesPath = '.cursor/commands/aws-aidlc-rules.md';
    const windsurfRulesPath = '.windsurf/workflows/aws-aidlc-rules.md';
    const antigravityRulesPath = '.agent/workflows/aws-aidlc-rules.md';
    const githubCopilotRulesPath = '.github/prompts/aws-aidlc-rules.prompt.md';
    const codexRulesPath = '.codex/skills/aws-aidlc-rules';
    const geminiCLIRulesPath = '.gemini/skills/aws-aidlc-rules';
    const qoderRulesPath = '.qoder/rules/aws-aidlc-rules.md';
    const rooRulesPath = '.roo/commands/aws-aidlc-rules.md';
    const codeBuddyRulesPath = '.codebuddy/commands/aws-aidlc-rules.md';
    
    const hasKiro = await this.fileService.exists(kiroRulesPath);
    const hasAmazonQ = await this.fileService.exists(amazonqRulesPath);
    const hasClaudeCode = await this.fileService.exists(claudeCodeRulesPath);
    const hasCursor = await this.fileService.exists(cursorRulesPath);
    const hasWindsurf = await this.fileService.exists(windsurfRulesPath);
    const hasAntigravity = await this.fileService.exists(antigravityRulesPath);
    const hasGitHubCopilot = await this.fileService.exists(githubCopilotRulesPath);
    const hasCodex = await this.fileService.exists(codexRulesPath);
    const hasGeminiCLI = await this.fileService.exists(geminiCLIRulesPath);
    const hasQoder = await this.fileService.exists(qoderRulesPath);
    const hasRoo = await this.fileService.exists(rooRulesPath);
    const hasCodeBuddy = await this.fileService.exists(codeBuddyRulesPath);
    
    return {
      hasKiro,
      hasAmazonQ,
      hasClaudeCode,
      hasCursor,
      hasWindsurf,
      hasAntigravity,
      hasGitHubCopilot,
      hasCodex,
      hasGeminiCLI,
      hasQoder,
      hasRoo,
      hasCodeBuddy,
      kiroPath: hasKiro ? kiroRulesPath : undefined,
      amazonqPath: hasAmazonQ ? amazonqRulesPath : undefined,
      claudeCodePath: hasClaudeCode ? claudeCodeRulesPath : undefined,
      cursorPath: hasCursor ? cursorRulesPath : undefined,
      windsurfPath: hasWindsurf ? windsurfRulesPath : undefined,
      antigravityPath: hasAntigravity ? antigravityRulesPath : undefined,
      githubCopilotPath: hasGitHubCopilot ? githubCopilotRulesPath : undefined,
      codexPath: hasCodex ? codexRulesPath : undefined,
      geminiCLIPath: hasGeminiCLI ? geminiCLIRulesPath : undefined,
      qoderPath: hasQoder ? qoderRulesPath : undefined,
      rooPath: hasRoo ? rooRulesPath : undefined,
      codeBuddyPath: hasCodeBuddy ? codeBuddyRulesPath : undefined
    };
  }
  
  /**
   * 检测环境信息
   */
  async detectEnvironment(): Promise<Environment> {
    const nodeVersion = process.version;
    const platform = process.platform;
    
    // 检查 Kiro CLI
    let hasKiroCli = false;
    try {
      await execAsync('kiro-cli --version');
      hasKiroCli = true;
    } catch {
      // Kiro CLI 不可用
    }
    
    // 检查各种 AI 工具
    let hasAmazonQ = false;
    let hasClaudeCode = false;
    let hasCursor = false;
    let hasWindsurf = false;
    let hasAntigravity = false;
    let hasGitHubCopilot = false;
    let hasCodex = false;
    let hasGeminiCLI = false;
    let hasQoder = false;
    let hasRoo = false;
    let hasCodeBuddy = false;
    
    try {
      const homeDir = require('os').homedir();
      
      // 检查 Amazon Q（通过 VS Code 扩展）
      const vscodeExtensions = path.join(homeDir, '.vscode/extensions');
      if (await this.fileService.exists(vscodeExtensions)) {
        const extensions = await fs.readdir(vscodeExtensions);
        hasAmazonQ = extensions.some(ext => ext.includes('amazonwebservices.amazon-q'));
        hasGitHubCopilot = extensions.some(ext => ext.includes('github.copilot'));
      }
      
      // 检查 Claude Code（通过配置文件或进程）
      const claudeConfigPaths = [
        path.join(homeDir, '.claude'),
        path.join(homeDir, '.config/claude'),
        '/Applications/Claude.app' // macOS
      ];
      for (const configPath of claudeConfigPaths) {
        if (await this.fileService.exists(configPath)) {
          hasClaudeCode = true;
          break;
        }
      }
      
      // 检查 Cursor
      const cursorPaths = [
        '/Applications/Cursor.app', // macOS
        path.join(homeDir, '.cursor'),
        path.join(homeDir, 'AppData/Local/Programs/cursor'), // Windows
        '/usr/bin/cursor' // Linux
      ];
      for (const cursorPath of cursorPaths) {
        if (await this.fileService.exists(cursorPath)) {
          hasCursor = true;
          break;
        }
      }
      
      // 检查 Windsurf
      const windsurfPaths = [
        '/Applications/Windsurf.app', // macOS
        path.join(homeDir, '.windsurf'),
        path.join(homeDir, 'AppData/Local/Programs/windsurf'), // Windows
        '/usr/bin/windsurf' // Linux
      ];
      for (const windsurfPath of windsurfPaths) {
        if (await this.fileService.exists(windsurfPath)) {
          hasWindsurf = true;
          break;
        }
      }
      
      // 检查 Antigravity
      const antigravityPaths = [
        path.join(homeDir, '.antigravity'),
        path.join(homeDir, '.config/antigravity'),
        '/Applications/Antigravity.app' // macOS
      ];
      for (const agPath of antigravityPaths) {
        if (await this.fileService.exists(agPath)) {
          hasAntigravity = true;
          break;
        }
      }
      
      // 检查 Codex（通过 OpenAI CLI 或配置）
      try {
        await execAsync('openai --version');
        hasCodex = true;
      } catch {
        // 检查配置文件
        const codexConfigPaths = [
          path.join(homeDir, '.openai'),
          path.join(homeDir, '.config/openai')
        ];
        for (const configPath of codexConfigPaths) {
          if (await this.fileService.exists(configPath)) {
            hasCodex = true;
            break;
          }
        }
      }
      
      // 检查 Gemini CLI
      try {
        await execAsync('gemini --version');
        hasGeminiCLI = true;
      } catch {
        const geminiConfigPaths = [
          path.join(homeDir, '.gemini'),
          path.join(homeDir, '.config/gemini')
        ];
        for (const configPath of geminiConfigPaths) {
          if (await this.fileService.exists(configPath)) {
            hasGeminiCLI = true;
            break;
          }
        }
      }
      
      // 检查 Qoder
      const qoderPaths = [
        path.join(homeDir, '.qoder'),
        path.join(homeDir, '.config/qoder'),
        '/Applications/Qoder.app' // macOS
      ];
      for (const qoderPath of qoderPaths) {
        if (await this.fileService.exists(qoderPath)) {
          hasQoder = true;
          break;
        }
      }
      
      // 检查 Roo
      const rooPaths = [
        path.join(homeDir, '.roo'),
        path.join(homeDir, '.config/roo')
      ];
      for (const rooPath of rooPaths) {
        if (await this.fileService.exists(rooPath)) {
          hasRoo = true;
          break;
        }
      }
      
      // 检查 CodeBuddy
      const codeBuddyPaths = [
        path.join(homeDir, '.codebuddy'),
        path.join(homeDir, '.config/codebuddy')
      ];
      for (const codeBuddyPath of codeBuddyPaths) {
        if (await this.fileService.exists(codeBuddyPath)) {
          hasCodeBuddy = true;
          break;
        }
      }
      
    } catch {
      // 无法检测某些工具
    }
    
    // 检查 Git 仓库
    const isGitRepo = await this.fileService.exists('.git');
    
    return {
      nodeVersion,
      platform,
      hasKiroCli,
      hasAmazonQ,
      hasClaudeCode,
      hasCursor,
      hasWindsurf,
      hasAntigravity,
      hasGitHubCopilot,
      hasCodex,
      hasGeminiCLI,
      hasQoder,
      hasRoo,
      hasCodeBuddy,
      isGitRepo
    };
  }
  
  /**
   * 安装 AI-DLC 规则
   */
  async installRules(platform: string, force: boolean = false): Promise<void> {
    const sourceRulesPath = path.join(__dirname, '../../aidlc-rules/aws-aidlc-rules');
    const sourceDetailsPath = path.join(__dirname, '../../aidlc-rules/aws-aidlc-rule-details');
    
    const platforms = platform === 'all' ? 
      ['kiro', 'amazonq', 'claude', 'cursor', 'windsurf', 'antigravity', 'copilot', 'codex', 'gemini', 'qoder', 'roo', 'codebuddy'] : 
      platform.split(',');
    
    for (const p of platforms) {
      switch (p.trim()) {
        case 'kiro':
          await this.installKiroRules(sourceRulesPath, sourceDetailsPath, force);
          break;
        case 'amazonq':
          await this.installAmazonQRules(sourceRulesPath, sourceDetailsPath, force);
          break;
        case 'claude':
        case 'claudecode':
          await this.installClaudeCodeRules(sourceRulesPath, sourceDetailsPath, force);
          break;
        case 'cursor':
          await this.installCursorRules(sourceRulesPath, sourceDetailsPath, force);
          break;
        case 'windsurf':
          await this.installWindsurfRules(sourceRulesPath, sourceDetailsPath, force);
          break;
        case 'antigravity':
          await this.installAntigravityRules(sourceRulesPath, sourceDetailsPath, force);
          break;
        case 'copilot':
        case 'github':
          await this.installGitHubCopilotRules(sourceRulesPath, sourceDetailsPath, force);
          break;
        case 'codex':
          await this.installCodexRules(sourceRulesPath, sourceDetailsPath, force);
          break;
        case 'gemini':
          await this.installGeminiCLIRules(sourceRulesPath, sourceDetailsPath, force);
          break;
        case 'qoder':
          await this.installQoderRules(sourceRulesPath, sourceDetailsPath, force);
          break;
        case 'roo':
          await this.installRooRules(sourceRulesPath, sourceDetailsPath, force);
          break;
        case 'codebuddy':
          await this.installCodeBuddyRules(sourceRulesPath, sourceDetailsPath, force);
          break;
        case 'both':
          await this.installKiroRules(sourceRulesPath, sourceDetailsPath, force);
          await this.installAmazonQRules(sourceRulesPath, sourceDetailsPath, force);
          break;
      }
    }
  }
  
  /**
   * 安装 Kiro 规则
   */
  private async installKiroRules(sourceRulesPath: string, sourceDetailsPath: string, force: boolean): Promise<void> {
    const targetRulesPath = '.kiro/steering/aws-aidlc-rules';
    const targetDetailsPath = '.kiro/aws-aidlc-rule-details';
    
    // 创建目录
    await fs.ensureDir('.kiro/steering');
    await fs.ensureDir('.kiro');
    
    // 复制规则文件
    if (force || !await this.fileService.exists(targetRulesPath)) {
      await fs.copy(sourceRulesPath, targetRulesPath);
    }
    
    if (force || !await this.fileService.exists(targetDetailsPath)) {
      await fs.copy(sourceDetailsPath, targetDetailsPath);
    }
  }
  
  /**
   * 安装 Amazon Q 规则
   */
  private async installAmazonQRules(sourceRulesPath: string, sourceDetailsPath: string, force: boolean): Promise<void> {
    const targetRulesPath = '.amazonq/rules/aws-aidlc-rules';
    const targetDetailsPath = '.amazonq/aws-aidlc-rule-details';
    
    // 创建目录
    await fs.ensureDir('.amazonq/rules');
    await fs.ensureDir('.amazonq');
    
    // 复制规则文件
    if (force || !await this.fileService.exists(targetRulesPath)) {
      await fs.copy(sourceRulesPath, targetRulesPath);
    }
    
    if (force || !await this.fileService.exists(targetDetailsPath)) {
      await fs.copy(sourceDetailsPath, targetDetailsPath);
    }
  }

  /**
   * 安装 Claude Code 规则
   */
  private async installClaudeCodeRules(sourceRulesPath: string, sourceDetailsPath: string, force: boolean): Promise<void> {
    const targetRulesPath = '.claude/skills/aws-aidlc-rules';
    const targetDetailsPath = '.claude/aws-aidlc-rule-details';
    
    // 创建目录
    await fs.ensureDir('.claude/skills');
    await fs.ensureDir('.claude');
    
    // 复制规则文件
    if (force || !await this.fileService.exists(targetRulesPath)) {
      await fs.copy(sourceRulesPath, targetRulesPath);
    }
    
    if (force || !await this.fileService.exists(targetDetailsPath)) {
      await fs.copy(sourceDetailsPath, targetDetailsPath);
    }
    
    // 创建 Claude 特定的 SKILL.md 文件
    const skillContent = `# AI-DLC Skill

This skill provides AI-Driven Development Life Cycle capabilities for Claude Code.

## Usage

This skill is automatically activated when you mention "Using AI-DLC" in your conversation.

## Features

- Adaptive three-phase workflow (Inception, Construction, Operations)
- Intelligent stage selection based on project complexity
- Structured requirements gathering and analysis
- Code generation with best practices
- Quality assurance and validation

## Getting Started

Simply start your request with: "Using AI-DLC, I want to..."

The system will guide you through the appropriate workflow phases.
`;
    
    await this.fileService.writeFile('.claude/skills/aws-aidlc-rules/SKILL.md', skillContent);
  }

  /**
   * 安装 Cursor 规则
   */
  private async installCursorRules(sourceRulesPath: string, sourceDetailsPath: string, force: boolean): Promise<void> {
    const targetRulesPath = '.cursor/commands/aws-aidlc-rules.md';
    const targetDetailsPath = '.cursor/aws-aidlc-rule-details';
    
    // 创建目录
    await fs.ensureDir('.cursor/commands');
    await fs.ensureDir('.cursor');
    
    // 复制详细规则
    if (force || !await this.fileService.exists(targetDetailsPath)) {
      await fs.copy(sourceDetailsPath, targetDetailsPath);
    }
    
    // 创建 Cursor 命令文件
    const commandContent = `# /ai-dlc Command

AI-Driven Development Life Cycle workflow for intelligent software development.

## Usage

Type \`/ai-dlc\` followed by your development request.

## Example

\`\`\`
/ai-dlc I want to build a user authentication system
\`\`\`

## Workflow

The system follows a three-phase adaptive approach:

1. **Inception Phase**: Requirements analysis and planning
2. **Construction Phase**: Design and implementation
3. **Operations Phase**: Deployment and monitoring

## Features

- Adaptive execution based on project complexity
- Structured question-driven requirements gathering
- Quality-focused code generation
- User-controlled approval process

## Getting Started

Simply use the command: \`/ai-dlc <your request>\`

The system will automatically determine the appropriate workflow phases and guide you through the process.
`;
    
    await this.fileService.writeFile(targetRulesPath, commandContent);
  }

  /**
   * 安装 Antigravity 规则
   */
  private async installAntigravityRules(sourceRulesPath: string, sourceDetailsPath: string, force: boolean): Promise<void> {
    const targetRulesPath = '.agent/workflows/aws-aidlc-rules.md';
    const targetDetailsPath = '.agent/aws-aidlc-rule-details';
    
    // 创建目录
    await fs.ensureDir('.agent/workflows');
    await fs.ensureDir('.agent');
    
    // 复制详细规则
    if (force || !await this.fileService.exists(targetDetailsPath)) {
      await fs.copy(sourceDetailsPath, targetDetailsPath);
    }
    
    // 创建 Antigravity 工作流文件
    const workflowContent = `---
description: AI-Driven Development Life Cycle workflow for advanced software development
auto_execution_mode: 3
---

# AI-DLC Advanced Workflow

AI-Driven Development Life Cycle optimized for Antigravity's advanced capabilities.

## Usage

Type \`/ai-dlc\` to activate this workflow.

## Advanced Features

- **Intelligent Adaptation**: Workflow adapts to project complexity and requirements
- **Multi-Phase Execution**: Inception → Construction → Operations
- **Quality Assurance**: Built-in validation and best practices
- **Context Awareness**: Analyzes existing codebase and dependencies

## Workflow Overview

### Inception Phase
- **Workspace Detection**: Analyze project structure and dependencies
- **Reverse Engineering**: Document existing systems (brownfield projects)
- **Requirements Analysis**: Gather and validate functional/non-functional requirements
- **User Stories**: Create detailed user stories with acceptance criteria
- **Application Design**: Design system architecture and components
- **Units Generation**: Break down work into manageable units

### Construction Phase
- **Functional Design**: Design data models and business logic
- **NFR Design**: Implement non-functional requirements
- **Infrastructure Design**: Plan deployment and infrastructure
- **Code Generation**: Generate high-quality, tested code
- **Build & Test**: Configure build systems and test suites

### Operations Phase
- **Deployment**: Automated deployment strategies
- **Monitoring**: Observability and performance monitoring
- **Maintenance**: Long-term maintenance and support planning

## Getting Started

1. Activate with \`/ai-dlc\`
2. State your development objective starting with "Using AI-DLC, ..."
3. Follow the guided workflow
4. Review and approve each phase
5. Monitor progress in \`aidlc-docs/\` directory

## Auto Execution Mode

This workflow uses auto_execution_mode: 3 for optimal balance between automation and control.
`;
    
    await this.fileService.writeFile(targetRulesPath, workflowContent);
  }

  /**
   * 安装 Codex 规则
   */
  private async installCodexRules(sourceRulesPath: string, sourceDetailsPath: string, force: boolean): Promise<void> {
    const targetRulesPath = '.codex/skills/aws-aidlc-rules';
    const targetDetailsPath = '.codex/aws-aidlc-rule-details';
    
    // 创建目录
    await fs.ensureDir('.codex/skills');
    await fs.ensureDir('.codex');
    
    // 复制规则文件
    if (force || !await this.fileService.exists(targetRulesPath)) {
      await fs.copy(sourceRulesPath, targetRulesPath);
    }
    
    if (force || !await this.fileService.exists(targetDetailsPath)) {
      await fs.copy(sourceDetailsPath, targetDetailsPath);
    }
    
    // 创建 Codex 技能文件
    const skillContent = `# AI-DLC Skill for OpenAI Codex

## Activation

Use: \`$ai-dlc\` to activate this skill

## Description

AI-Driven Development Life Cycle workflow for intelligent software development using OpenAI Codex.

## Usage

\`\`\`
$ai-dlc I want to build a REST API for user management
\`\`\`

## Features

- Three-phase adaptive workflow
- Intelligent code generation
- Best practices integration
- Quality assurance

## Workflow Phases

1. **Inception**: Requirements and planning
2. **Construction**: Design and implementation  
3. **Operations**: Deployment and monitoring

The skill automatically determines which phases are needed based on your request complexity.
`;
    
    await this.fileService.writeFile('.codex/skills/aws-aidlc-rules/SKILL.md', skillContent);
  }

  /**
   * 安装 Windsurf 规则
   */
  private async installWindsurfRules(sourceRulesPath: string, sourceDetailsPath: string, force: boolean): Promise<void> {
    const targetRulesPath = '.windsurf/workflows/aws-aidlc-rules.md';
    const targetDetailsPath = '.windsurf/aws-aidlc-rule-details';
    
    // 创建目录
    await fs.ensureDir('.windsurf/workflows');
    await fs.ensureDir('.windsurf');
    
    // 复制详细规则
    if (force || !await this.fileService.exists(targetDetailsPath)) {
      await fs.copy(sourceDetailsPath, targetDetailsPath);
    }
    
    // 创建 Windsurf 工作流文件
    const workflowContent = `---
description: AI-Driven Development Life Cycle workflow
auto_execution_mode: 3
---

# AI-DLC Workflow

AI-Driven Development Life Cycle for intelligent software development.

## Usage

Type \`/ai-dlc\` to activate this workflow.

## Workflow Phases

### 1. Inception Phase
- Workspace detection and analysis
- Requirements gathering and validation
- User story creation (when applicable)
- Application design and architecture
- Work unit decomposition

### 2. Construction Phase
- Functional design and data modeling
- Non-functional requirements analysis
- Infrastructure design
- Code generation and implementation
- Build and test configuration

### 3. Operations Phase
- Deployment planning
- Monitoring and observability
- Production readiness validation

## Features

- **Adaptive Intelligence**: Only executes stages that add value
- **User Control**: Review and approve each phase
- **Quality Focus**: Complex changes get comprehensive treatment
- **Context Aware**: Analyzes existing codebase complexity

## Getting Started

1. Type \`/ai-dlc\` to start
2. Describe your development goal
3. Follow the structured workflow
4. Review and approve each phase
5. Check generated artifacts in \`aidlc-docs/\`

## Auto Execution

This workflow has auto_execution_mode: 3 enabled for streamlined execution while maintaining user oversight.
`;
    
    await this.fileService.writeFile(targetRulesPath, workflowContent);
  }

  /**
   * 安装 GitHub Copilot 规则
   */
  private async installGitHubCopilotRules(sourceRulesPath: string, sourceDetailsPath: string, force: boolean): Promise<void> {
    const targetRulesPath = '.github/prompts/aws-aidlc-rules.prompt.md';
    const targetDetailsPath = '.github/aws-aidlc-rule-details';
    
    // 创建目录
    await fs.ensureDir('.github/prompts');
    await fs.ensureDir('.github');
    
    // 复制详细规则
    if (force || !await this.fileService.exists(targetDetailsPath)) {
      await fs.copy(sourceDetailsPath, targetDetailsPath);
    }
    
    // 创建 GitHub Copilot 提示文件
    const promptContent = `# AI-DLC Prompt for GitHub Copilot

## Usage

Type \`/ai-dlc\` in VS Code with GitHub Copilot to activate AI-Driven Development Life Cycle workflow.

## Workflow

When user requests software development assistance starting with "Using AI-DLC", follow this structured approach:

### Phase 1: Inception
1. **Analyze Request**: Understand what needs to be built and why
2. **Assess Complexity**: Determine appropriate workflow depth
3. **Gather Requirements**: Ask clarifying questions if needed
4. **Plan Approach**: Outline the development strategy

### Phase 2: Construction
1. **Design System**: Create architecture and component design
2. **Generate Code**: Implement with best practices and patterns
3. **Add Tests**: Include appropriate test coverage
4. **Document**: Provide clear documentation

### Phase 3: Operations
1. **Deployment**: Suggest deployment strategies
2. **Monitoring**: Recommend monitoring approaches
3. **Maintenance**: Provide maintenance guidelines

## Key Principles

- **Adaptive**: Only execute phases that add value
- **Quality-Focused**: Prioritize code quality and best practices
- **User-Controlled**: Always explain what you're doing and why
- **Context-Aware**: Consider existing codebase and project structure

## Example

User: "Using AI-DLC, I want to add user authentication to my React app"

Response: Follow the three-phase workflow to analyze requirements, design the authentication system, implement with best practices, and provide deployment guidance.
`;
    
    await this.fileService.writeFile(targetRulesPath, promptContent);
  }

  /**
   * 安装 Gemini CLI 规则
   */
  private async installGeminiCLIRules(sourceRulesPath: string, sourceDetailsPath: string, force: boolean): Promise<void> {
    const targetRulesPath = '.gemini/skills/aws-aidlc-rules';
    const targetDetailsPath = '.gemini/aws-aidlc-rule-details';
    
    // 创建目录
    await fs.ensureDir('.gemini/skills');
    await fs.ensureDir('.gemini');
    
    // 复制规则文件
    if (force || !await this.fileService.exists(targetRulesPath)) {
      await fs.copy(sourceRulesPath, targetRulesPath);
    }
    
    if (force || !await this.fileService.exists(targetDetailsPath)) {
      await fs.copy(sourceDetailsPath, targetDetailsPath);
    }
    
    // 创建 Gemini 技能文件
    const skillContent = `# AI-DLC Skill for Gemini CLI

## Description

AI-Driven Development Life Cycle workflow optimized for Google's Gemini AI.

## Activation

This skill is automatically activated when you mention "Using AI-DLC" in your request.

## Features

- **Multi-Modal Understanding**: Leverages Gemini's advanced reasoning
- **Adaptive Workflow**: Three-phase approach (Inception, Construction, Operations)
- **Context Awareness**: Analyzes project structure and requirements
- **Quality Assurance**: Built-in best practices and validation

## Usage

Start your request with: "Using AI-DLC, I want to..."

## Example

\`\`\`
Using AI-DLC, I want to create a microservice for order processing
\`\`\`

## Workflow Overview

1. **Inception**: Requirements analysis and system design
2. **Construction**: Implementation with best practices
3. **Operations**: Deployment and monitoring setup

The system intelligently determines which phases are needed based on your request complexity and existing codebase.
`;
    
    await this.fileService.writeFile('.gemini/skills/aws-aidlc-rules/SKILL.md', skillContent);
  }

  /**
   * 安装 Qoder 规则
   */
  private async installQoderRules(sourceRulesPath: string, sourceDetailsPath: string, force: boolean): Promise<void> {
    const targetRulesPath = '.qoder/rules/aws-aidlc-rules.md';
    const targetDetailsPath = '.qoder/aws-aidlc-rule-details';
    
    // 创建目录
    await fs.ensureDir('.qoder/rules');
    await fs.ensureDir('.qoder');
    
    // 复制详细规则
    if (force || !await this.fileService.exists(targetDetailsPath)) {
      await fs.copy(sourceDetailsPath, targetDetailsPath);
    }
    
    // 创建 Qoder 规则文件
    const ruleContent = `---
trigger: always_on
---

# AI-DLC Rules for Qoder

## Description

AI-Driven Development Life Cycle workflow integrated with Qoder's intelligent coding environment.

## Activation

This rule is always active (trigger: always_on). When user mentions "Using AI-DLC", activate the workflow.

## Workflow

### Inception Phase
- Analyze user requirements and project context
- Determine appropriate workflow depth
- Gather additional requirements if needed
- Plan development approach

### Construction Phase  
- Design system architecture and components
- Generate high-quality code with best practices
- Implement comprehensive testing
- Create documentation

### Operations Phase
- Plan deployment strategies
- Set up monitoring and observability
- Provide maintenance guidelines

## Features

- **Always Available**: Rule is always active for immediate response
- **Context Aware**: Analyzes existing codebase and project structure
- **Quality Focused**: Emphasizes best practices and code quality
- **Adaptive**: Adjusts workflow based on complexity and requirements

## Usage

Simply mention "Using AI-DLC" followed by your development request, and the workflow will automatically activate.

## Example

"Using AI-DLC, I need to implement a caching layer for my API"

The system will guide you through the appropriate phases to analyze requirements, design the caching solution, implement it with best practices, and provide deployment guidance.
`;
    
    await this.fileService.writeFile(targetRulesPath, ruleContent);
  }

  /**
   * 安装 Roo 规则
   */
  private async installRooRules(sourceRulesPath: string, sourceDetailsPath: string, force: boolean): Promise<void> {
    const targetRulesPath = '.roo/commands/aws-aidlc-rules.md';
    const targetDetailsPath = '.roo/aws-aidlc-rule-details';
    
    // 创建目录
    await fs.ensureDir('.roo/commands');
    await fs.ensureDir('.roo');
    
    // 复制详细规则
    if (force || !await this.fileService.exists(targetDetailsPath)) {
      await fs.copy(sourceDetailsPath, targetDetailsPath);
    }
    
    // 创建 Roo 命令文件
    const commandContent = `# /ai-dlc Command for Roo

## Description

AI-Driven Development Life Cycle workflow command for Roo coding assistant.

## Usage

Type \`/ai-dlc\` followed by your development request.

## Command Format

\`\`\`
/ai-dlc <your development request>
\`\`\`

## Examples

\`\`\`
/ai-dlc I want to build a GraphQL API for my blog
/ai-dlc Help me implement real-time notifications
/ai-dlc Create a data processing pipeline
\`\`\`

## Workflow

The command activates a three-phase workflow:

1. **Inception**: Requirements analysis and planning
2. **Construction**: Design and implementation
3. **Operations**: Deployment and monitoring

## Features

- **Intelligent Adaptation**: Workflow adapts to request complexity
- **Best Practices**: Implements industry standards and patterns
- **Quality Assurance**: Built-in validation and testing
- **User Control**: Review and approve each phase

## Getting Started

1. Type \`/ai-dlc\` followed by your request
2. Follow the guided workflow
3. Review and approve each phase
4. Check generated artifacts in \`aidlc-docs/\`

The system will automatically determine which workflow phases are needed based on your request and existing project context.
`;
    
    await this.fileService.writeFile(targetRulesPath, commandContent);
  }

  /**
   * 安装 CodeBuddy 规则
   */
  private async installCodeBuddyRules(sourceRulesPath: string, sourceDetailsPath: string, force: boolean): Promise<void> {
    const targetRulesPath = '.codebuddy/commands/aws-aidlc-rules.md';
    const targetDetailsPath = '.codebuddy/aws-aidlc-rule-details';
    
    // 创建目录
    await fs.ensureDir('.codebuddy/commands');
    await fs.ensureDir('.codebuddy');
    
    // 复制详细规则
    if (force || !await this.fileService.exists(targetDetailsPath)) {
      await fs.copy(sourceDetailsPath, targetDetailsPath);
    }
    
    // 创建 CodeBuddy 命令文件
    const commandContent = `# /ai-dlc Command for CodeBuddy

## Description

AI-Driven Development Life Cycle workflow integrated with CodeBuddy's collaborative coding environment.

## Usage

Type \`/ai-dlc\` to activate the AI-DLC workflow.

## Command Syntax

\`\`\`
/ai-dlc <development request>
\`\`\`

## Examples

\`\`\`
/ai-dlc I need to refactor my authentication module
/ai-dlc Build a REST API for inventory management  
/ai-dlc Add logging and monitoring to my service
\`\`\`

## Workflow Overview

### Phase 1: Inception
- Analyze requirements and project context
- Assess complexity and determine workflow depth
- Gather additional requirements through structured questions
- Plan development approach and architecture

### Phase 2: Construction
- Design system components and data models
- Generate high-quality, tested code
- Implement best practices and patterns
- Create comprehensive documentation

### Phase 3: Operations
- Plan deployment and infrastructure
- Set up monitoring and observability
- Provide maintenance and support guidelines

## Features

- **Collaborative**: Works seamlessly with CodeBuddy's team features
- **Adaptive**: Adjusts workflow based on project needs
- **Quality-Focused**: Emphasizes best practices and code quality
- **Educational**: Explains decisions and provides learning opportunities

## Getting Started

1. Use \`/ai-dlc\` command with your request
2. Follow the interactive workflow
3. Collaborate with team members on reviews
4. Approve each phase before proceeding
5. Access generated artifacts in \`aidlc-docs/\`

The workflow is designed to enhance team collaboration while maintaining high code quality and development standards.
`;
    
    await this.fileService.writeFile(targetRulesPath, commandContent);
  }
  
  /**
   * 获取环境推荐
   */
  getRecommendations(environment: Environment): string[] {
    const recommendations: string[] = [];
    
    const hasAnyAI = environment.hasKiroCli || environment.hasAmazonQ || environment.hasClaudeCode || 
                     environment.hasCursor || environment.hasWindsurf || environment.hasAntigravity ||
                     environment.hasGitHubCopilot || environment.hasCodex || environment.hasGeminiCLI ||
                     environment.hasQoder || environment.hasRoo || environment.hasCodeBuddy;
    
    if (!hasAnyAI) {
      recommendations.push('Install at least one AI coding assistant (Kiro CLI, Amazon Q, Claude Code, Cursor, Windsurf, Antigravity, GitHub Copilot, Codex, Gemini CLI, Qoder, Roo, or CodeBuddy)');
    }
    
    if (!environment.isGitRepo) {
      recommendations.push('Initialize Git repository for better project tracking');
    }
    
    if (environment.nodeVersion < 'v16.0.0') {
      recommendations.push('Update Node.js to version 16 or higher');
    }
    
    return recommendations;
  }
  
  /**
   * 应用设置配置
   */
  async applySetup(config: any, environment: Environment): Promise<void> {
    // 安装规则
    await this.installRules(config.platform, true);
    
    // 创建 .gitignore 条目
    if (config.createGitignore && environment.isGitRepo) {
      await this.updateGitignore();
    }
    
    // 创建 README 指南
    if (config.createReadme) {
      await this.createReadmeGuide(config.projectType);
    }
  }
  
  /**
   * 更新 .gitignore
   */
  private async updateGitignore(): Promise<void> {
    const gitignoreEntries = [
      '# AI-DLC generated files',
      'aidlc-docs/',
      '.aidlc-temp/',
      ''
    ];
    
    let gitignoreContent = '';
    if (await this.fileService.exists('.gitignore')) {
      gitignoreContent = await this.fileService.readFile('.gitignore');
    }
    
    // 检查是否已经包含 AI-DLC 条目
    if (!gitignoreContent.includes('# AI-DLC generated files')) {
      gitignoreContent += '\n' + gitignoreEntries.join('\n');
      await this.fileService.writeFile('.gitignore', gitignoreContent);
    }
  }
  
  /**
   * 创建 README 指南
   */
  private async createReadmeGuide(projectType: string): Promise<void> {
    const guideContent = this.generateReadmeGuide(projectType);
    
    let readmeContent = '';
    if (await this.fileService.exists('README.md')) {
      readmeContent = await this.fileService.readFile('README.md');
    }
    
    // 检查是否已经包含 AI-DLC 部分
    if (!readmeContent.includes('## AI-DLC Workflow')) {
      readmeContent += '\n\n' + guideContent;
      await this.fileService.writeFile('README.md', readmeContent);
    }
  }
  
  /**
   * 生成 README 指南内容
   */
  private generateReadmeGuide(projectType: string): string {
    return `## AI-DLC Workflow

This project uses AI-Driven Development Life Cycle (AI-DLC) for intelligent software development workflows.

### Getting Started

1. Start any development task with: \`"Using AI-DLC, ..."\`
2. Follow the structured workflow questions
3. Review and approve each phase
4. Check \`aidlc-docs/\` for generated artifacts

### Project Type: ${projectType}

${this.getProjectTypeGuidance(projectType)}

### Commands

- \`aidlc status\` - Check AI-DLC setup and project status
- \`aidlc validate\` - Validate installation and configuration
- \`aidlc init\` - Reinitialize AI-DLC if needed

### Learn More

- [AI-DLC Blog Post](https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/)
- [Method Definition Paper](https://prod.d13rzhkk8cj2z0.amplifyapp.com/)`;
  }
  
  /**
   * 获取项目类型指导
   */
  private getProjectTypeGuidance(projectType: string): string {
    const guidance: Record<string, string> = {
      web: 'AI-DLC will help with frontend/backend architecture, API design, and component structure.',
      api: 'AI-DLC will focus on API design, data models, and service architecture.',
      library: 'AI-DLC will assist with public API design, documentation, and testing strategies.',
      data: 'AI-DLC will help with data pipeline design, processing workflows, and analytics architecture.',
      infrastructure: 'AI-DLC will focus on infrastructure design, deployment strategies, and operational concerns.',
      general: 'AI-DLC will adapt to your specific project needs and requirements.'
    };
    
    return guidance[projectType] || guidance.general;
  }
  
  /**
   * 验证安装
   */
  async validateInstallation(): Promise<ValidationResult> {
    const issues: string[] = [];
    const installation = await this.checkExistingInstallation();
    
    const hasAnyInstallation = installation.hasKiro || installation.hasAmazonQ || installation.hasClaudeCode || 
                              installation.hasCursor || installation.hasCodex || installation.hasAntigravity;
    
    if (!hasAnyInstallation) {
      issues.push('No AI-DLC rules installed for any platform');
    }
    
    // 检查核心文件
    const coreFiles = [
      'aidlc-rules/aws-aidlc-rules/core-workflow.md',
      'aidlc-rules/aws-aidlc-rule-details/common/process-overview.md'
    ];
    
    for (const file of coreFiles) {
      if (!await this.fileService.exists(file)) {
        issues.push(`Missing core file: ${file}`);
      }
    }
    
    return {
      isValid: issues.length === 0,
      issues
    };
  }
  
  /**
   * 验证规则文件
   */
  async validateRuleFiles(): Promise<{ missingFiles: string[] }> {
    const missingFiles: string[] = [];
    const installation = await this.checkExistingInstallation();
    
    if (installation.hasKiro) {
      const kiroFiles = await this.getRequiredKiroFiles();
      for (const file of kiroFiles) {
        if (!await this.fileService.exists(file)) {
          missingFiles.push(file);
        }
      }
    }
    
    if (installation.hasAmazonQ) {
      const amazonqFiles = await this.getRequiredAmazonQFiles();
      for (const file of amazonqFiles) {
        if (!await this.fileService.exists(file)) {
          missingFiles.push(file);
        }
      }
    }
    
    if (installation.hasClaudeCode) {
      const claudeFiles = await this.getRequiredClaudeCodeFiles();
      for (const file of claudeFiles) {
        if (!await this.fileService.exists(file)) {
          missingFiles.push(file);
        }
      }
    }
    
    if (installation.hasCursor) {
      const cursorFiles = await this.getRequiredCursorFiles();
      for (const file of cursorFiles) {
        if (!await this.fileService.exists(file)) {
          missingFiles.push(file);
        }
      }
    }
    
    if (installation.hasCodex) {
      const codexFiles = await this.getRequiredCodexFiles();
      for (const file of codexFiles) {
        if (!await this.fileService.exists(file)) {
          missingFiles.push(file);
        }
      }
    }
    
    if (installation.hasAntigravity) {
      const antigravityFiles = await this.getRequiredAntigravityFiles();
      for (const file of antigravityFiles) {
        if (!await this.fileService.exists(file)) {
          missingFiles.push(file);
        }
      }
    }
    
    return { missingFiles };
  }
  
  /**
   * 获取必需的 Kiro 文件列表
   */
  private async getRequiredKiroFiles(): Promise<string[]> {
    return [
      '.kiro/steering/aws-aidlc-rules/core-workflow.md',
      '.kiro/aws-aidlc-rule-details/common/process-overview.md',
      '.kiro/aws-aidlc-rule-details/common/welcome-message.md'
    ];
  }
  
  /**
   * 获取必需的 Amazon Q 文件列表
   */
  private async getRequiredAmazonQFiles(): Promise<string[]> {
    return [
      '.amazonq/rules/aws-aidlc-rules/core-workflow.md',
      '.amazonq/aws-aidlc-rule-details/common/process-overview.md',
      '.amazonq/aws-aidlc-rule-details/common/welcome-message.md'
    ];
  }

  /**
   * 获取必需的 Claude Code 文件列表
   */
  private async getRequiredClaudeCodeFiles(): Promise<string[]> {
    return [
      '.claude/rules/aws-aidlc-rules/core-workflow.md',
      '.claude/aws-aidlc-rule-details/common/process-overview.md',
      '.claude/aws-aidlc-rule-details/common/welcome-message.md'
    ];
  }

  /**
   * 获取必需的 Cursor 文件列表
   */
  private async getRequiredCursorFiles(): Promise<string[]> {
    return [
      '.cursor/rules/aws-aidlc-rules/core-workflow.md',
      '.cursor/aws-aidlc-rule-details/common/process-overview.md',
      '.cursor/aws-aidlc-rule-details/common/welcome-message.md'
    ];
  }

  /**
   * 获取必需的 Codex 文件列表
   */
  private async getRequiredCodexFiles(): Promise<string[]> {
    return [
      '.codex/rules/aws-aidlc-rules/core-workflow.md',
      '.codex/aws-aidlc-rule-details/common/process-overview.md',
      '.codex/aws-aidlc-rule-details/common/welcome-message.md'
    ];
  }

  /**
   * 获取必需的 Antigravity 文件列表
   */
  private async getRequiredAntigravityFiles(): Promise<string[]> {
    return [
      '.antigravity/rules/aws-aidlc-rules/core-workflow.md',
      '.antigravity/aws-aidlc-rule-details/common/process-overview.md',
      '.antigravity/aws-aidlc-rule-details/common/welcome-message.md'
    ];
  }
  
  /**
   * 验证文件内容
   */
  async validateFileContent(): Promise<{ corruptedFiles: string[] }> {
    const corruptedFiles: string[] = [];
    
    // 这里可以添加更复杂的内容验证逻辑
    // 例如检查 Markdown 格式、必需的标题等
    
    return { corruptedFiles };
  }
  
  /**
   * 检查兼容性
   */
  checkCompatibility(environment: Environment): { issues: string[] } {
    const issues: string[] = [];
    
    if (environment.nodeVersion < 'v16.0.0') {
      issues.push('Node.js version should be 16.0.0 or higher');
    }
    
    return { issues };
  }
  
  /**
   * 验证项目配置
   */
  async validateProjectConfiguration(): Promise<{ warnings: string[] }> {
    const warnings: string[] = [];
    
    if (!await this.fileService.exists('package.json')) {
      warnings.push('No package.json found - consider initializing npm project');
    }
    
    if (!await this.fileService.exists('.gitignore')) {
      warnings.push('No .gitignore found - consider adding one');
    }
    
    return { warnings };
  }
  
  /**
   * 验证工作流状态
   */
  async validateWorkflowState(): Promise<{ isValid: boolean; issues: string[]; activePhase?: string }> {
    const issues: string[] = [];
    let activePhase: string | undefined;
    
    if (await this.fileService.exists('aidlc-docs/aidlc-state.md')) {
      try {
        const stateContent = await this.fileService.readFile('aidlc-docs/aidlc-state.md');
        const phases = this.parseWorkflowState(stateContent);
        
        // 查找活跃阶段
        const inProgressPhase = phases.find(p => p.inProgress);
        if (inProgressPhase) {
          activePhase = inProgressPhase.name;
        }
        
        // 验证状态一致性
        // const completedPhases = phases.filter(p => p.completed); // 暂时不需要
        const inProgressPhases = phases.filter(p => p.inProgress);
        
        if (inProgressPhases.length > 1) {
          issues.push('Multiple phases marked as in progress');
        }
        
      } catch (error) {
        issues.push('Unable to parse workflow state file');
      }
    }
    
    return {
      isValid: issues.length === 0,
      issues,
      activePhase
    };
  }
  
  /**
   * 解析工作流状态
   */
  parseWorkflowState(content: string): WorkflowPhase[] {
    const phases: WorkflowPhase[] = [];
    const lines = content.split('\n');
    
    for (const line of lines) {
      if (line.includes('✅') || line.includes('🔄') || line.includes('⏳') || line.includes('⏭️')) {
        // 移除表情符号和破折号，保留空格
        const name = line.replace(/[✅🔄⏳⏭️-]/gu, '').trim();
        const completed = line.includes('✅');
        const inProgress = line.includes('🔄');
        const skipped = line.includes('⏭️');
        
        if (name) {
          phases.push({ name, completed, inProgress, skipped });
        }
      }
    }
    
    return phases;
  }
  
  /**
   * 获取状态推荐
   */
  getStatusRecommendations(installation: InstallationStatus, environment: Environment): string[] {
    const recommendations: string[] = [];
    
    const hasAnyInstallation = installation.hasKiro || installation.hasAmazonQ || installation.hasClaudeCode || 
                              installation.hasCursor || installation.hasCodex || installation.hasAntigravity;
    
    if (!hasAnyInstallation) {
      recommendations.push('Run `aidlc init` to set up AI-DLC for your preferred platforms');
    }
    
    if (!environment.hasKiroCli && installation.hasKiro) {
      recommendations.push('Install Kiro CLI for better local development experience');
    }
    
    if (!environment.isGitRepo) {
      recommendations.push('Initialize Git repository for better project tracking');
    }
    
    // 推荐安装检测到但未配置的平台
    if (environment.hasClaudeCode && !installation.hasClaudeCode) {
      recommendations.push('Configure AI-DLC for Claude Code: `aidlc init --platform claude`');
    }
    
    if (environment.hasCursor && !installation.hasCursor) {
      recommendations.push('Configure AI-DLC for Cursor: `aidlc init --platform cursor`');
    }
    
    return recommendations;
  }
  
  /**
   * 修复安装
   */
  async repairInstallation(): Promise<void> {
    const installation = await this.checkExistingInstallation();
    
    const platforms: string[] = [];
    if (installation.hasKiro) platforms.push('kiro');
    if (installation.hasAmazonQ) platforms.push('amazonq');
    if (installation.hasClaudeCode) platforms.push('claude');
    if (installation.hasCursor) platforms.push('cursor');
    if (installation.hasCodex) platforms.push('codex');
    if (installation.hasAntigravity) platforms.push('antigravity');
    
    if (platforms.length > 0) {
      await this.installRules(platforms.join(','), true);
    }
  }
}