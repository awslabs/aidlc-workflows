import { Command } from 'commander';
import chalk from 'chalk';
import boxen from 'boxen';
import { AidlcService } from '../services/aidlc-service';
import { FileService } from '../services/file-service';

export const statusCommand = new Command('status')
  .description('Show AI-DLC installation and project status')
  .option('-v, --verbose', 'Show detailed information')
  .action(async (options) => {
    try {
      const aidlcService = new AidlcService();
      const fileService = new FileService();
      
      console.log(boxen(
        chalk.cyan.bold('📊 AI-DLC Status Report'),
        {
          padding: 1,
          margin: 1,
          borderStyle: 'round',
          borderColor: 'cyan'
        }
      ));
      
      // 基本信息
      const currentDir = process.cwd();
      console.log(chalk.blue('📁 Project Directory:'));
      console.log(chalk.gray(`   ${currentDir}\n`));
      
      // 检查安装状态
      const installation = await aidlcService.checkExistingInstallation();
      const environment = await aidlcService.detectEnvironment();
      
      console.log(chalk.blue('🔧 Installation Status:'));
      
      // 各平台状态
      const kiroStatus = installation.hasKiro ? '✅ Installed' : '❌ Not installed';
      console.log(chalk.gray(`   Kiro CLI Rules: ${kiroStatus}`));
      if (installation.hasKiro && options.verbose) {
        console.log(chalk.gray(`     • Rules: .kiro/steering/aws-aidlc-rules/`));
        console.log(chalk.gray(`     • Details: .kiro/aws-aidlc-rule-details/`));
      }
      
      const amazonqStatus = installation.hasAmazonQ ? '✅ Installed' : '❌ Not installed';
      console.log(chalk.gray(`   Amazon Q Rules: ${amazonqStatus}`));
      if (installation.hasAmazonQ && options.verbose) {
        console.log(chalk.gray(`     • Rules: .amazonq/rules/aws-aidlc-rules/`));
        console.log(chalk.gray(`     • Details: .amazonq/aws-aidlc-rule-details/`));
      }
      
      const claudeStatus = installation.hasClaudeCode ? '✅ Installed' : '❌ Not installed';
      console.log(chalk.gray(`   Claude Code Rules: ${claudeStatus}`));
      if (installation.hasClaudeCode && options.verbose) {
        console.log(chalk.gray(`     • Rules: .claude/rules/aws-aidlc-rules/`));
        console.log(chalk.gray(`     • Details: .claude/aws-aidlc-rule-details/`));
      }
      
      const cursorStatus = installation.hasCursor ? '✅ Installed' : '❌ Not installed';
      console.log(chalk.gray(`   Cursor Rules: ${cursorStatus}`));
      if (installation.hasCursor && options.verbose) {
        console.log(chalk.gray(`     • Rules: .cursor/rules/aws-aidlc-rules/`));
        console.log(chalk.gray(`     • Details: .cursor/aws-aidlc-rule-details/`));
      }
      
      const codexStatus = installation.hasCodex ? '✅ Installed' : '❌ Not installed';
      console.log(chalk.gray(`   Codex Rules: ${codexStatus}`));
      if (installation.hasCodex && options.verbose) {
        console.log(chalk.gray(`     • Rules: .codex/rules/aws-aidlc-rules/`));
        console.log(chalk.gray(`     • Details: .codex/aws-aidlc-rule-details/`));
      }
      
      const antigravityStatus = installation.hasAntigravity ? '✅ Installed' : '❌ Not installed';
      console.log(chalk.gray(`   Antigravity Rules: ${antigravityStatus}`));
      if (installation.hasAntigravity && options.verbose) {
        console.log(chalk.gray(`     • Rules: .antigravity/rules/aws-aidlc-rules/`));
        console.log(chalk.gray(`     • Details: .antigravity/aws-aidlc-rule-details/`));
      }
      
      console.log();
      
      // 环境信息
      console.log(chalk.blue('🌍 Environment:'));
      console.log(chalk.gray(`   Node.js: ${environment.nodeVersion}`));
      console.log(chalk.gray(`   Platform: ${environment.platform}`));
      console.log(chalk.gray(`   Kiro CLI: ${environment.hasKiroCli ? '✅ Available' : '❌ Not found'}`));
      console.log(chalk.gray(`   Amazon Q: ${environment.hasAmazonQ ? '✅ Available' : '❌ Not found'}`));
      console.log(chalk.gray(`   Claude Code: ${environment.hasClaudeCode ? '✅ Available' : '❌ Not found'}`));
      console.log(chalk.gray(`   Cursor: ${environment.hasCursor ? '✅ Available' : '❌ Not found'}`));
      console.log(chalk.gray(`   Codex: ${environment.hasCodex ? '✅ Available' : '❌ Not found'}`));
      console.log(chalk.gray(`   Antigravity: ${environment.hasAntigravity ? '✅ Available' : '❌ Not found'}`));
      console.log(chalk.gray(`   Git Repository: ${environment.isGitRepo ? '✅ Yes' : '❌ No'}`));
      console.log();
      
      // 项目状态
      console.log(chalk.blue('📋 Project Status:'));
      
      // 检查 aidlc-docs 目录
      const hasAidlcDocs = await fileService.exists('aidlc-docs');
      console.log(chalk.gray(`   AI-DLC Docs: ${hasAidlcDocs ? '✅ Found' : '❌ Not found'}`));
      
      if (hasAidlcDocs) {
        // 检查状态文件
        const hasStateFile = await fileService.exists('aidlc-docs/aidlc-state.md');
        const hasAuditFile = await fileService.exists('aidlc-docs/audit.md');
        
        console.log(chalk.gray(`   State File: ${hasStateFile ? '✅ Found' : '❌ Not found'}`));
        console.log(chalk.gray(`   Audit Log: ${hasAuditFile ? '✅ Found' : '❌ Not found'}`));
        
        if (options.verbose && hasStateFile) {
          try {
            const stateContent = await fileService.readFile('aidlc-docs/aidlc-state.md');
            const phases = aidlcService.parseWorkflowState(stateContent);
            
            console.log(chalk.gray('\n   Workflow Progress:'));
            phases.forEach(phase => {
              const status = phase.completed ? '✅' : phase.inProgress ? '🔄' : '⏳';
              console.log(chalk.gray(`     ${status} ${phase.name}`));
            });
          } catch (error) {
            console.log(chalk.gray('     Unable to parse workflow state'));
          }
        }
      }
      
      console.log();
      
      // 验证状态
      const validation = await aidlcService.validateInstallation();
      console.log(chalk.blue('✅ Validation:'));
      
      if (validation.isValid) {
        console.log(chalk.green('   ✅ Installation is valid and ready to use'));
      } else {
        console.log(chalk.red('   ❌ Issues found:'));
        validation.issues.forEach(issue => {
          console.log(chalk.red(`     • ${issue}`));
        });
      }
      
      console.log();
      
      // 建议
      const recommendations = aidlcService.getStatusRecommendations(installation, environment);
      if (recommendations.length > 0) {
        console.log(chalk.yellow('💡 Recommendations:'));
        recommendations.forEach(rec => {
          console.log(chalk.yellow(`   • ${rec}`));
        });
        console.log();
      }
      
      // 快速操作
      console.log(chalk.cyan('🚀 Quick Actions:'));
      const hasAnyInstallation = installation.hasKiro || installation.hasAmazonQ || installation.hasClaudeCode || 
                                 installation.hasCursor || installation.hasCodex || installation.hasAntigravity;
      
      if (!hasAnyInstallation) {
        console.log(chalk.gray('   • Run `aidlc init` to set up AI-DLC'));
      } else {
        console.log(chalk.gray('   • Start development with: "Using AI-DLC, ..."'));
        console.log(chalk.gray('   • Run `aidlc validate` to check configuration'));
      }
      
    } catch (error) {
      console.error(chalk.red('\n❌ Error checking status:'));
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });