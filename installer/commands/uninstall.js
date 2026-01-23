const path = require('path');
const installer = require('../lib/installer');
const fileManager = require('../lib/file-manager');
const ui = require('../lib/ui');

async function uninstallCommand(options) {
  ui.displayIntro();

  // Resolve target directory
  const targetDirectory = options.path
    ? path.resolve(options.path)
    : process.cwd();

  // Validate target directory exists
  const exists = await fileManager.directoryExists(targetDirectory);
  if (!exists) {
    ui.displayError({
      message: `Directory not found: ${targetDirectory}`,
      remediation: 'Check the path and try again'
    });
    process.exit(1);
  }

  // Detect which platform is installed
  const existing = await installer.detectExistingInstallation(targetDirectory);
  if (!existing) {
    ui.displayError({
      message: 'No AI-DLC installation found in this directory',
      remediation: 'Make sure you are in the correct project directory'
    });
    process.exit(1);
  }

  // Run uninstall
  const result = await installer.uninstall({
    targetDirectory,
    platform: existing.platform,
    force: options.force
  });

  if (result.cancelled) {
    process.exit(0);
  }

  if (result.notInstalled) {
    ui.displayError({
      message: 'No AI-DLC installation found',
      remediation: 'Nothing to uninstall'
    });
    process.exit(1);
  }

  if (!result.success) {
    ui.displayError({
      message: 'Failed to uninstall AI-DLC',
      remediation: 'Check permissions and try again'
    });
    process.exit(1);
  }

  ui.displayUninstallSuccess(result);
}

module.exports = { uninstallCommand };
