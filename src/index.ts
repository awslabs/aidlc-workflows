#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { initCommand } from './commands/init';
import { setupCommand } from './commands/setup';
import { statusCommand } from './commands/status';
import { validateCommand } from './commands/validate';
import { versionCommand } from './commands/version';

const program = new Command();

program
  .name('aidlc')
  .description('AI-Driven Development Life Cycle (AI-DLC) CLI tool')
  .version('1.0.0');

// 添加命令
program.addCommand(initCommand);
program.addCommand(setupCommand);
program.addCommand(statusCommand);
program.addCommand(validateCommand);
program.addCommand(versionCommand);

// 默认帮助信息
program
  .action(() => {
    console.log(chalk.cyan.bold('🚀 AI-DLC CLI Tool'));
    console.log(chalk.gray('Intelligent software development workflows\n'));
    program.help();
  });

// 错误处理
program.on('command:*', () => {
  console.error(chalk.red(`Invalid command: ${program.args.join(' ')}`));
  console.log(chalk.yellow('See --help for a list of available commands.'));
  process.exit(1);
});

// 解析命令行参数
program.parse(process.argv);

// 如果没有提供任何参数，显示帮助
if (!process.argv.slice(2).length) {
  program.outputHelp();
}