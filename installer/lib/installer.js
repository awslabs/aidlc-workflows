const { getPlatformHandler } = require('./platforms');
const fileManager = require('./file-manager');
const ui = require('./ui');

async function install(options) {
  const { targetDirectory, platform, force } = options;
  const handler = getPlatformHandler(platform);
  const paths = handler.getInstallPaths(targetDirectory);

  // Check for existing installation
  const isInstalled = await handler.isInstalled(targetDirectory);
  if (isInstalled && !force) {
    const choice = await ui.promptExistingInstallation(platform);
    if (choice === 'cancel') {
      return { success: false, cancelled: true };
    }
    // Remove existing installation
    await fileManager.removeAIDLCFiles(paths);
  }

  // Create parent directories
  const spinner = ui.startSpinner('Creating directories...');
  for (const dir of paths.parentDirectories) {
    await fileManager.ensureDirectory(dir);
  }

  // Copy rules
  spinner.message('Copying AI-DLC rules...');
  const rulesSource = fileManager.getBundledRulesPath();
  const rulesResult = await fileManager.copyDirectory(rulesSource, paths.rulesDestination);
  if (!rulesResult.success) {
    spinner.stop('Failed to copy rules');
    return {
      success: false,
      error: { message: 'Failed to copy rules', details: rulesResult.errors.join(', '), remediation: 'Check disk space and permissions' }
    };
  }

  // Copy rule details
  spinner.message('Copying AI-DLC rule details...');
  const detailsSource = fileManager.getBundledDetailsPath();
  const detailsResult = await fileManager.copyDirectory(detailsSource, paths.detailsDestination);
  if (!detailsResult.success) {
    spinner.stop('Failed to copy rule details');
    return {
      success: false,
      error: { message: 'Failed to copy rule details', details: detailsResult.errors.join(', '), remediation: 'Check disk space and permissions' }
    };
  }

  spinner.stop('Installation complete');

  return {
    success: true,
    platform,
    filesInstalled: rulesResult.filesCopied + detailsResult.filesCopied,
    targetDirectory
  };
}

async function uninstall(options) {
  const { targetDirectory, platform, force } = options;
  const handler = getPlatformHandler(platform);
  const paths = handler.getInstallPaths(targetDirectory);

  // Check if installed
  const isInstalled = await handler.isInstalled(targetDirectory);
  if (!isInstalled) {
    return { success: false, notInstalled: true };
  }

  // Confirm uninstall
  if (!force) {
    const confirmed = await ui.promptUninstallConfirmation(platform);
    if (!confirmed) {
      return { success: false, cancelled: true };
    }
  }

  // Remove files
  const spinner = ui.startSpinner('Removing AI-DLC files...');
  const result = await fileManager.removeAIDLCFiles(paths);
  spinner.stop('Uninstall complete');

  return result;
}

async function detectExistingInstallation(targetDir) {
  const { platforms } = require('./platforms');

  for (const [key, handler] of Object.entries(platforms)) {
    if (await handler.isInstalled(targetDir)) {
      const paths = handler.getInstallPaths(targetDir);
      return {
        platform: key,
        rulesPath: paths.rulesDestination,
        detailsPath: paths.detailsDestination
      };
    }
  }
  return null;
}

module.exports = {
  install,
  uninstall,
  detectExistingInstallation
};
