import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { AidlcService } from '../services/aidlc-service';
import { FileService } from '../services/file-service';

export const validateCommand = new Command('validate')
  .description('Validate AI-DLC installation and configuration')
  .option('--fix', 'Attempt to fix common issues automatically')
  .action(async (options) => {
    try {
      console.log(chalk.cyan.bold('🔍 AI-DLC Validation\n'));
      
      const aidlcService = new AidlcService();
      const fileService = new FileService();
      
      let hasErrors = false;
      let hasWarnings = false;
      
      // 1. 检查基本安装
      const spinner1 = ora('Checking installation...').start();
      const installation = await aidlcService.checkExistingInstallation();
      
      const hasAnyInstallation = installation.hasKiro || installation.hasAmazonQ || installation.hasClaudeCode || 
                                installation.hasCursor || installation.hasCodex || installation.hasAntigravity;
      
      if (!hasAnyInstallation) {
        spinner1.fail('No AI-DLC installation found');
        console.log(chalk.red('   ❌ Neither Kiro nor Amazon Q rules are installed'));
        console.log(chalk.yellow('   💡 Run `aidlc init` to set up AI-DLC\n'));
        hasErrors = true;
      } else {
        spinner1.succeed('Installation found');
        
        if (installation.hasKiro) {
          console.log(chalk.green('   ✅ Kiro rules installed'));
        }
        if (installation.hasAmazonQ) {
          console.log(chalk.green('   ✅ Amazon Q rules installed'));
        }
        if (installation.hasClaudeCode) {
          console.log(chalk.green('   ✅ Claude Code rules installed'));
        }
        if (installation.hasCursor) {
          console.log(chalk.green('   ✅ Cursor rules installed'));
        }
        if (installation.hasCodex) {
          console.log(chalk.green('   ✅ Codex rules installed'));
        }
        if (installation.hasAntigravity) {
          console.log(chalk.green('   ✅ Antigravity rules installed'));
        }
      }
      
      // 2. 检查文件完整性
      const spinner2 = ora('Validating rule files...').start();
      const validation = await aidlcService.validateRuleFiles();
      
      if (validation.missingFiles.length > 0) {
        spinner2.fail('Missing rule files detected');
        console.log(chalk.red('   ❌ Missing files:'));
        validation.missingFiles.forEach(file => {
          console.log(chalk.red(`     • ${file}`));
        });
        hasErrors = true;
        
        if (options.fix) {
          console.log(chalk.blue('\n   🔧 Attempting to fix missing files...'));
          try {
            await aidlcService.repairInstallation();
            console.log(chalk.green('   ✅ Files restored successfully'));
          } catch (error) {
            console.log(chalk.red('   ❌ Failed to restore files'));
            console.log(chalk.yellow('   💡 Try running `aidlc init --force`'));
          }
        }
      } else {
        spinner2.succeed('All rule files present');
      }
      
      // 3. 检查文件内容
      const spinner3 = ora('Validating file content...').start();
      const contentValidation = await aidlcService.validateFileContent();
      
      if (contentValidation.corruptedFiles.length > 0) {
        spinner3.fail('Corrupted files detected');
        console.log(chalk.red('   ❌ Corrupted files:'));
        contentValidation.corruptedFiles.forEach(file => {
          console.log(chalk.red(`     • ${file}`));
        });
        hasErrors = true;
      } else {
        spinner3.succeed('File content is valid');
      }
      
      // 4. 检查环境兼容性
      const spinner4 = ora('Checking environment compatibility...').start();
      const environment = await aidlcService.detectEnvironment();
      const compatibility = aidlcService.checkCompatibility(environment);
      
      if (compatibility.issues.length > 0) {
        spinner4.warn('Environment issues detected');
        console.log(chalk.yellow('   ⚠️  Compatibility issues:'));
        compatibility.issues.forEach(issue => {
          console.log(chalk.yellow(`     • ${issue}`));
        });
        hasWarnings = true;
      } else {
        spinner4.succeed('Environment is compatible');
      }
      
      // 5. 检查项目配置
      const spinner5 = ora('Validating project configuration...').start();
      const projectValidation = await aidlcService.validateProjectConfiguration();
      
      if (projectValidation.warnings.length > 0) {
        spinner5.warn('Project configuration warnings');
        console.log(chalk.yellow('   ⚠️  Configuration warnings:'));
        projectValidation.warnings.forEach(warning => {
          console.log(chalk.yellow(`     • ${warning}`));
        });
        hasWarnings = true;
      } else {
        spinner5.succeed('Project configuration is valid');
      }
      
      // 6. 检查工作流状态（如果存在）
      const hasAidlcDocs = await fileService.exists('aidlc-docs');
      if (hasAidlcDocs) {
        const spinner6 = ora('Checking workflow state...').start();
        try {
          const workflowValidation = await aidlcService.validateWorkflowState();
          
          if (workflowValidation.isValid) {
            spinner6.succeed('Workflow state is valid');
            if (workflowValidation.activePhase) {
              console.log(chalk.blue(`   📋 Active phase: ${workflowValidation.activePhase}`));
            }
          } else {
            spinner6.warn('Workflow state issues');
            console.log(chalk.yellow('   ⚠️  Workflow issues:'));
            workflowValidation.issues.forEach(issue => {
              console.log(chalk.yellow(`     • ${issue}`));
            });
            hasWarnings = true;
          }
        } catch (error) {
          spinner6.fail('Unable to validate workflow state');
          hasWarnings = true;
        }
      }
      
      // 总结
      console.log('\n' + '='.repeat(50));
      
      if (hasErrors) {
        console.log(chalk.red.bold('❌ VALIDATION FAILED'));
        console.log(chalk.red('Critical issues found that prevent AI-DLC from working properly.'));
        
        if (!options.fix) {
          console.log(chalk.yellow('\n💡 Try running with --fix to automatically repair issues:'));
          console.log(chalk.gray('   aidlc validate --fix'));
        }
        
        process.exit(1);
      } else if (hasWarnings) {
        console.log(chalk.yellow.bold('⚠️  VALIDATION PASSED WITH WARNINGS'));
        console.log(chalk.yellow('AI-DLC should work, but some optimizations are recommended.'));
      } else {
        console.log(chalk.green.bold('✅ VALIDATION PASSED'));
        console.log(chalk.green('AI-DLC is properly installed and ready to use!'));
      }
      
      // 下一步建议
      console.log(chalk.cyan('\n🎯 Next Steps:'));
      if (hasErrors) {
        console.log(chalk.gray('   • Fix the errors above'));
        console.log(chalk.gray('   • Run validation again'));
      } else {
        console.log(chalk.gray('   • Start development with: "Using AI-DLC, ..."'));
        console.log(chalk.gray('   • Check status with: aidlc status'));
      }
      
    } catch (error) {
      console.error(chalk.red('\n❌ Validation error:'));
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });