import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { AidlcService } from '../services/aidlc-service';

export const setupCommand = new Command('setup')
  .description('Interactive setup wizard for AI-DLC')
  .action(async () => {
    try {
      console.log(chalk.cyan.bold('\n🔧 AI-DLC Setup Wizard\n'));
      
      const aidlcService = new AidlcService();
      
      // 检测环境
      console.log(chalk.blue('🔍 Detecting environment...\n'));
      
      const environment = await aidlcService.detectEnvironment();
      
      console.log(chalk.gray('Environment Detection Results:'));
      console.log(chalk.gray(`  • Node.js: ${environment.nodeVersion}`));
      console.log(chalk.gray(`  • Platform: ${environment.platform}`));
      console.log(chalk.gray(`  • Kiro CLI: ${environment.hasKiroCli ? '✅ Available' : '❌ Not found'}`));
      console.log(chalk.gray(`  • Amazon Q: ${environment.hasAmazonQ ? '✅ Detected' : '❌ Not detected'}`));
      console.log(chalk.gray(`  • Claude Code: ${environment.hasClaudeCode ? '✅ Detected' : '❌ Not detected'}`));
      console.log(chalk.gray(`  • Cursor: ${environment.hasCursor ? '✅ Detected' : '❌ Not detected'}`));
      console.log(chalk.gray(`  • Windsurf: ${environment.hasWindsurf ? '✅ Detected' : '❌ Not detected'}`));
      console.log(chalk.gray(`  • Antigravity: ${environment.hasAntigravity ? '✅ Detected' : '❌ Not detected'}`));
      console.log(chalk.gray(`  • GitHub Copilot: ${environment.hasGitHubCopilot ? '✅ Detected' : '❌ Not detected'}`));
      console.log(chalk.gray(`  • Codex: ${environment.hasCodex ? '✅ Detected' : '❌ Not detected'}`));
      console.log(chalk.gray(`  • Gemini CLI: ${environment.hasGeminiCLI ? '✅ Detected' : '❌ Not detected'}`));
      console.log(chalk.gray(`  • Qoder: ${environment.hasQoder ? '✅ Detected' : '❌ Not detected'}`));
      console.log(chalk.gray(`  • Roo: ${environment.hasRoo ? '✅ Detected' : '❌ Not detected'}`));
      console.log(chalk.gray(`  • CodeBuddy: ${environment.hasCodeBuddy ? '✅ Detected' : '❌ Not detected'}`));
      console.log(chalk.gray(`  • Git repository: ${environment.isGitRepo ? '✅ Yes' : '❌ No'}\n`));
      
      // 推荐配置
      const recommendations = aidlcService.getRecommendations(environment);
      
      if (recommendations.length > 0) {
        console.log(chalk.yellow('💡 Recommendations:'));
        recommendations.forEach(rec => {
          console.log(chalk.gray(`  • ${rec}`));
        });
        console.log();
      }
      
      // 交互式配置
      const answers = await inquirer.prompt([
        {
          type: 'checkbox',
          name: 'platforms',
          message: 'Which AI platforms would you like to configure?',
          choices: [
            { 
              name: 'Kiro CLI (Local development)', 
              value: 'kiro',
              checked: environment.hasKiroCli
            },
            { 
              name: 'Amazon Q Developer (IDE integration)', 
              value: 'amazonq',
              checked: environment.hasAmazonQ
            },
            { 
              name: 'Claude Code (Anthropic Skills)', 
              value: 'claude',
              checked: environment.hasClaudeCode
            },
            { 
              name: 'Cursor (AI-first editor)', 
              value: 'cursor',
              checked: environment.hasCursor
            },
            { 
              name: 'Windsurf (Advanced workflows)', 
              value: 'windsurf',
              checked: environment.hasWindsurf
            },
            { 
              name: 'Antigravity (Advanced AI)', 
              value: 'antigravity',
              checked: environment.hasAntigravity
            },
            { 
              name: 'GitHub Copilot (VS Code prompts)', 
              value: 'copilot',
              checked: environment.hasGitHubCopilot
            },
            { 
              name: 'OpenAI Codex (API integration)', 
              value: 'codex',
              checked: environment.hasCodex
            },
            { 
              name: 'Gemini CLI (Google AI)', 
              value: 'gemini',
              checked: environment.hasGeminiCLI
            },
            { 
              name: 'Qoder (Always-on rules)', 
              value: 'qoder',
              checked: environment.hasQoder
            },
            { 
              name: 'Roo (Command system)', 
              value: 'roo',
              checked: environment.hasRoo
            },
            { 
              name: 'CodeBuddy (Collaborative coding)', 
              value: 'codebuddy',
              checked: environment.hasCodeBuddy
            }
          ],
          validate: (input) => {
            return input.length > 0 ? true : 'Please select at least one platform';
          }
        },
        {
          type: 'confirm',
          name: 'createGitignore',
          message: 'Add AI-DLC entries to .gitignore?',
          default: true,
          when: (_answers) => environment.isGitRepo
        },
        {
          type: 'confirm',
          name: 'createReadme',
          message: 'Create AI-DLC usage guide in README?',
          default: true
        },
        {
          type: 'list',
          name: 'projectType',
          message: 'What type of project are you working on?',
          choices: [
            { name: 'Web Application (Frontend/Backend)', value: 'web' },
            { name: 'API/Microservice', value: 'api' },
            { name: 'Library/Package', value: 'library' },
            { name: 'Data Processing/Analytics', value: 'data' },
            { name: 'Infrastructure/DevOps', value: 'infrastructure' },
            { name: 'Other/General', value: 'general' }
          ]
        }
      ]);
      
      // 执行配置
      console.log(chalk.blue('\n⚙️  Applying configuration...\n'));
      
      // 安装选中的平台
      const platformString = answers.platforms.join(',');
      await aidlcService.installRules(platformString, true);
      
      console.log(chalk.green('✅ Setup completed successfully!\n'));
      
      // 显示下一步
      console.log(chalk.cyan('🎯 What\'s Next:'));
      console.log(chalk.gray('  1. Start your AI-DLC workflow with: "Using AI-DLC, ..."'));
      console.log(chalk.gray('  2. Use `aidlc status` to check your setup'));
      console.log(chalk.gray('  3. Use `aidlc validate` to verify installation\n'));
      
    } catch (error) {
      console.error(chalk.red('\n❌ Setup failed:'));
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });