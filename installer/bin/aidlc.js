#!/usr/bin/env node

const { program } = require('commander');
const packageJson = require('../../package.json');
const { installCommand } = require('../commands/install');
const { uninstallCommand } = require('../commands/uninstall');

program
  .name('aidlc')
  .description('AI-DLC Installer - Install AI-DLC rules into your project')
  .version(packageJson.version);

program
  .command('install')
  .description('Install AI-DLC rules into your project')
  .option('-p, --path <directory>', 'Target directory (defaults to current directory)')
  .option('-f, --force', 'Skip confirmations and project validation')
  .action(installCommand);

program
  .command('uninstall')
  .description('Remove AI-DLC rules from your project')
  .option('-p, --path <directory>', 'Target directory (defaults to current directory)')
  .option('-f, --force', 'Skip confirmation prompt')
  .action(uninstallCommand);

// Show help if no command provided
if (process.argv.length === 2) {
  program.help();
}

program.parse();
