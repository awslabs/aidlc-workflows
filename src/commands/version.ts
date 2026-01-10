import { Command } from 'commander';
import chalk from 'chalk';
import boxen from 'boxen';
import * as fs from 'fs-extra';
import * as path from 'path';

export const versionCommand = new Command('version')
  .alias('v')
  .description('Show version information')
  .option('--json', 'Output version information as JSON')
  .action(async (options) => {
    try {
      // 读取 package.json
      const packageJsonPath = path.join(__dirname, '../../package.json');
      const packageJson = await fs.readJson(packageJsonPath);
      
      const versionInfo = {
        version: packageJson.version,
        name: packageJson.name,
        description: packageJson.description,
        author: packageJson.author,
        license: packageJson.license,
        homepage: packageJson.homepage,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch
      };
      
      if (options.json) {
        console.log(JSON.stringify(versionInfo, null, 2));
        return;
      }
      
      // 格式化输出
      console.log(boxen(
        chalk.cyan.bold(`🚀 ${versionInfo.name} v${versionInfo.version}\n`) +
        chalk.gray(versionInfo.description || ''),
        {
          padding: 1,
          margin: 1,
          borderStyle: 'round',
          borderColor: 'cyan'
        }
      ));
      
      console.log(chalk.blue('📦 Package Information:'));
      console.log(chalk.gray(`   Name: ${versionInfo.name}`));
      console.log(chalk.gray(`   Version: ${versionInfo.version}`));
      console.log(chalk.gray(`   License: ${versionInfo.license}`));
      if (versionInfo.author) {
        console.log(chalk.gray(`   Author: ${versionInfo.author}`));
      }
      if (versionInfo.homepage) {
        console.log(chalk.gray(`   Homepage: ${versionInfo.homepage}`));
      }
      
      console.log(chalk.blue('\n🌍 Environment:'));
      console.log(chalk.gray(`   Node.js: ${versionInfo.nodeVersion}`));
      console.log(chalk.gray(`   Platform: ${versionInfo.platform}`));
      console.log(chalk.gray(`   Architecture: ${versionInfo.arch}`));
      
      console.log(chalk.cyan('\n📚 Resources:'));
      console.log(chalk.gray('   • Documentation: https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/'));
      console.log(chalk.gray('   • Method Paper: https://prod.d13rzhkk8cj2z0.amplifyapp.com/'));
      console.log(chalk.gray('   • Kiro CLI: https://kiro.dev/cli/'));
      console.log(chalk.gray('   • Amazon Q: https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/'));
      
    } catch (error) {
      console.error(chalk.red('❌ Error reading version information:'));
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });