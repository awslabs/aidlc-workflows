import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import boxen from 'boxen';
import { AidlcService } from '../services/aidlc-service';
// import { FileService } from '../services/file-service'; // 暂时不需要

export const initCommand = new Command('init')
  .description('Initialize AI-DLC in your project')
  .option('-p, --platform <platform>', 'Target platform (kiro|amazonq|claude|cursor|windsurf|antigravity|copilot|codex|gemini|qoder|roo|codebuddy|both|all)', 'all')
  .option('-f, --force', 'Force initialization even if files exist')
  .option('--no-interactive', 'Skip interactive prompts')
  .action(async (options) => {
    try {
      console.log(boxen(
        chalk.cyan.bold('🚀 AI-DLC Initialization\n') +
        chalk.gray('Setting up intelligent development workflows'),
        {
          padding: 1,
          margin: 1,
          borderStyle: 'round',
          borderColor: 'cyan'
        }
      ));

      const aidlcService = new AidlcService();
      // const fileService = new FileService(); // 暂时不需要

      // 检查当前目录
      const currentDir = process.cwd();
      console.log(chalk.blue(`📁 Working directory: ${currentDir}\n`));

      // 交互式配置
      let config = {
        platform: options.platform,
        force: options.force
      };

      if (options.interactive) {
        const answers = await inquirer.prompt([
          {
            type: 'list',
            name: 'platform',
            message: 'Which platform(s) do you want to set up?',
            choices: [
              { name: 'Kiro CLI (.kiro/steering)', value: 'kiro' },
              { name: 'Amazon Q Developer (.amazonq)', value: 'amazonq' },
              { name: 'Claude Code (.claude/skills)', value: 'claude' },
              { name: 'Cursor (.cursor/commands)', value: 'cursor' },
              { name: 'Windsurf (.windsurf/workflows)', value: 'windsurf' },
              { name: 'Antigravity (.agent/workflows)', value: 'antigravity' },
              { name: 'GitHub Copilot (.github/prompts)', value: 'copilot' },
              { name: 'OpenAI Codex (.codex/skills)', value: 'codex' },
              { name: 'Gemini CLI (.gemini/skills)', value: 'gemini' },
              { name: 'Qoder (.qoder/rules)', value: 'qoder' },
              { name: 'Roo (.roo/commands)', value: 'roo' },
              { name: 'CodeBuddy (.codebuddy/commands)', value: 'codebuddy' },
              { name: 'Kiro + Amazon Q (Legacy)', value: 'both' },
              { name: 'All platforms', value: 'all' }
            ],
            default: 'all'
          },
          {
            type: 'confirm',
            name: 'force',
            message: 'Overwrite existing files if they exist?',
            default: false,
            when: () => !options.force
          }
        ]);
        
        config = { ...config, ...answers };
      }

      // 检查现有安装
      const spinner = ora('Checking existing installation...').start();
      const existingInstallation = await aidlcService.checkExistingInstallation();
      
      const hasAnyInstallation = existingInstallation.hasKiro || existingInstallation.hasAmazonQ || 
                                existingInstallation.hasClaudeCode || existingInstallation.hasCursor || 
                                existingInstallation.hasWindsurf || existingInstallation.hasAntigravity ||
                                existingInstallation.hasGitHubCopilot || existingInstallation.hasCodex ||
                                existingInstallation.hasGeminiCLI || existingInstallation.hasQoder ||
                                existingInstallation.hasRoo || existingInstallation.hasCodeBuddy;
      
      if (hasAnyInstallation) {
        spinner.stop();
        console.log(chalk.yellow('⚠️  Existing AI-DLC installation detected:'));
        if (existingInstallation.hasKiro) {
          console.log(chalk.gray('  • Kiro steering files found'));
        }
        if (existingInstallation.hasAmazonQ) {
          console.log(chalk.gray('  • Amazon Q rules found'));
        }
        if (existingInstallation.hasClaudeCode) {
          console.log(chalk.gray('  • Claude Code skills found'));
        }
        if (existingInstallation.hasCursor) {
          console.log(chalk.gray('  • Cursor commands found'));
        }
        if (existingInstallation.hasWindsurf) {
          console.log(chalk.gray('  • Windsurf workflows found'));
        }
        if (existingInstallation.hasAntigravity) {
          console.log(chalk.gray('  • Antigravity workflows found'));
        }
        if (existingInstallation.hasGitHubCopilot) {
          console.log(chalk.gray('  • GitHub Copilot prompts found'));
        }
        if (existingInstallation.hasCodex) {
          console.log(chalk.gray('  • Codex skills found'));
        }
        if (existingInstallation.hasGeminiCLI) {
          console.log(chalk.gray('  • Gemini CLI skills found'));
        }
        if (existingInstallation.hasQoder) {
          console.log(chalk.gray('  • Qoder rules found'));
        }
        if (existingInstallation.hasRoo) {
          console.log(chalk.gray('  • Roo commands found'));
        }
        if (existingInstallation.hasCodeBuddy) {
          console.log(chalk.gray('  • CodeBuddy commands found'));
        }
        
        if (!config.force) {
          const { proceed } = await inquirer.prompt([{
            type: 'confirm',
            name: 'proceed',
            message: 'Continue with installation?',
            default: true
          }]);
          
          if (!proceed) {
            console.log(chalk.yellow('Installation cancelled.'));
            return;
          }
        }
      } else {
        spinner.succeed('No existing installation found');
      }

      // 执行安装
      const installSpinner = ora('Installing AI-DLC rules...').start();
      
      try {
        await aidlcService.installRules(config.platform, config.force);
        installSpinner.succeed('AI-DLC rules installed successfully');
        
        // 显示成功信息
        console.log(chalk.green('\n✅ AI-DLC initialization complete!\n'));
        
        const platforms = config.platform === 'all' ? 
          ['kiro', 'amazonq', 'claude', 'cursor', 'windsurf', 'antigravity', 'copilot', 'codex', 'gemini', 'qoder', 'roo', 'codebuddy'] : 
          config.platform === 'both' ? ['kiro', 'amazonq'] : [config.platform];
        
        platforms.forEach(platform => {
          switch (platform) {
            case 'kiro':
              console.log(chalk.blue('📋 Kiro CLI Setup:'));
              console.log(chalk.gray('  • Rules installed in .kiro/steering/'));
              console.log(chalk.gray('  • Rule details in .kiro/aws-aidlc-rule-details/'));
              console.log(chalk.gray('  • Start with: kiro-cli'));
              console.log(chalk.gray('  • Check context: /context show\n'));
              break;
            case 'amazonq':
              console.log(chalk.blue('📋 Amazon Q Developer Setup:'));
              console.log(chalk.gray('  • Rules installed in .amazonq/rules/'));
              console.log(chalk.gray('  • Rule details in .amazonq/aws-aidlc-rule-details/'));
              console.log(chalk.gray('  • Check Rules button in Q Chat window\n'));
              break;
            case 'claude':
              console.log(chalk.blue('📋 Claude Code Setup:'));
              console.log(chalk.gray('  • Skills installed in .claude/skills/'));
              console.log(chalk.gray('  • Rule details in .claude/aws-aidlc-rule-details/'));
              console.log(chalk.gray('  • Auto-activated on "Using AI-DLC"\n'));
              break;
            case 'cursor':
              console.log(chalk.blue('📋 Cursor Setup:'));
              console.log(chalk.gray('  • Commands installed in .cursor/commands/'));
              console.log(chalk.gray('  • Rule details in .cursor/aws-aidlc-rule-details/'));
              console.log(chalk.gray('  • Use command: /ai-dlc\n'));
              break;
            case 'windsurf':
              console.log(chalk.blue('📋 Windsurf Setup:'));
              console.log(chalk.gray('  • Workflows installed in .windsurf/workflows/'));
              console.log(chalk.gray('  • Rule details in .windsurf/aws-aidlc-rule-details/'));
              console.log(chalk.gray('  • Use command: /ai-dlc (auto_execution_mode: 3)\n'));
              break;
            case 'antigravity':
              console.log(chalk.blue('📋 Antigravity Setup:'));
              console.log(chalk.gray('  • Workflows installed in .agent/workflows/'));
              console.log(chalk.gray('  • Rule details in .agent/aws-aidlc-rule-details/'));
              console.log(chalk.gray('  • Use command: /ai-dlc (auto_execution_mode: 3)\n'));
              break;
            case 'copilot':
              console.log(chalk.blue('📋 GitHub Copilot Setup:'));
              console.log(chalk.gray('  • Prompts installed in .github/prompts/'));
              console.log(chalk.gray('  • Rule details in .github/aws-aidlc-rule-details/'));
              console.log(chalk.gray('  • Use command: /ai-dlc in VS Code\n'));
              break;
            case 'codex':
              console.log(chalk.blue('📋 OpenAI Codex Setup:'));
              console.log(chalk.gray('  • Skills installed in .codex/skills/'));
              console.log(chalk.gray('  • Rule details in .codex/aws-aidlc-rule-details/'));
              console.log(chalk.gray('  • Use skill: $ai-dlc\n'));
              break;
            case 'gemini':
              console.log(chalk.blue('📋 Gemini CLI Setup:'));
              console.log(chalk.gray('  • Skills installed in .gemini/skills/'));
              console.log(chalk.gray('  • Rule details in .gemini/aws-aidlc-rule-details/'));
              console.log(chalk.gray('  • Auto-activated on "Using AI-DLC"\n'));
              break;
            case 'qoder':
              console.log(chalk.blue('📋 Qoder Setup:'));
              console.log(chalk.gray('  • Rules installed in .qoder/rules/'));
              console.log(chalk.gray('  • Rule details in .qoder/aws-aidlc-rule-details/'));
              console.log(chalk.gray('  • Always active (trigger: always_on)\n'));
              break;
            case 'roo':
              console.log(chalk.blue('📋 Roo Setup:'));
              console.log(chalk.gray('  • Commands installed in .roo/commands/'));
              console.log(chalk.gray('  • Rule details in .roo/aws-aidlc-rule-details/'));
              console.log(chalk.gray('  • Use command: /ai-dlc\n'));
              break;
            case 'codebuddy':
              console.log(chalk.blue('📋 CodeBuddy Setup:'));
              console.log(chalk.gray('  • Commands installed in .codebuddy/commands/'));
              console.log(chalk.gray('  • Rule details in .codebuddy/aws-aidlc-rule-details/'));
              console.log(chalk.gray('  • Use command: /ai-dlc\n'));
              break;
          }
        });
        
        console.log(chalk.cyan('🎯 Next Steps:'));
        console.log(chalk.gray('  1. Start any development project with: "Using AI-DLC, ..."'));
        console.log(chalk.gray('  2. Follow the structured workflow questions'));
        console.log(chalk.gray('  3. Review and approve each phase'));
        console.log(chalk.gray('  4. Check aidlc-docs/ for generated artifacts\n'));
        
        console.log(chalk.magenta('📚 Learn more: https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/'));
        
      } catch (error) {
        installSpinner.fail('Installation failed');
        throw error;
      }
      
    } catch (error) {
      console.error(chalk.red('\n❌ Error during initialization:'));
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });